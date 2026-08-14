/**
 * The pty host - one small Node process that owns every Terminal's pty and
 * speaks newline-delimited JSON over its own stdio.
 *
 * Why a separate process at all, when `sessions/pty.ts` already wraps
 * `@lydell/node-pty` in this same server: **the server runs on Bun, and a pty
 * WRITE under Bun on Windows is fatal.** `@lydell/node-pty`'s Windows agent
 * writes through `new net.Socket({ fd })`; under Bun 1.3.14 that socket is
 * never writable, the failure arrives out of band as `ERR_SOCKET_CLOSED`, no
 * try/catch on the call path can hold it, and the whole server dies. Verified
 * again on 2026-08-14 with a four-line script outside this repo (Bun: server
 * down; Node 24: `echo hello` round-trips perfectly). That is why `pty.ts`
 * refuses input on Windows and its Terminal view is read-only.
 *
 * A terminal you cannot type into is not a terminal, so the pty moves to the
 * one runtime that can write to it. Everything else is unchanged: same
 * node-pty, same repo, same node_modules (this file sits under `apps/ui/`
 * on purpose so its bare import resolves).
 *
 * Protocol - one JSON object per line, both directions:
 *
 *   in   {"t":"spawn","id","file","args","cwd","cols","rows"}
 *        {"t":"write","id","data"}
 *        {"t":"resize","id","cols","rows"}
 *        {"t":"kill","id"}
 *   out  {"t":"data","id","chunk"}
 *        {"t":"exit","id","code"}
 *
 * There is no scrollback here and no state worth keeping: the buffer, the
 * subscribers and the HTTP surface all live in `terminals.ts`. This process
 * is a pipe with a pty on the far end.
 */
import * as nodePty from "@lydell/node-pty";

const ptys = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function spawn(message) {
  try {
    const pty = nodePty.spawn(message.file, message.args ?? [], {
      name: "xterm-color",
      cols: message.cols ?? 80,
      rows: message.rows ?? 24,
      cwd: message.cwd,
      env: process.env,
    });
    ptys.set(message.id, pty);
    pty.onData((chunk) => send({ t: "data", id: message.id, chunk }));
    pty.onExit(({ exitCode }) => {
      ptys.delete(message.id);
      send({ t: "exit", id: message.id, code: exitCode });
    });
  } catch (error) {
    // Visible failure, never a silent one: the reason lands in the terminal
    // itself, then the terminal ends the way a shell ends a missing command.
    send({ t: "data", id: message.id, chunk: `${error.message}\r\n` });
    send({ t: "exit", id: message.id, code: 127 });
  }
}

function handle(message) {
  const pty = ptys.get(message.id);
  switch (message.t) {
    case "spawn":
      return spawn(message);
    case "write":
      try {
        pty?.write(message.data);
      } catch {
        /* the exit message is already on its way */
      }
      return;
    case "resize":
      try {
        pty?.resize(message.cols, message.rows);
      } catch {
        /* resizing a pty that has already exited throws; nothing to do */
      }
      return;
    case "kill":
      try {
        pty?.kill();
      } catch {
        /* already dead */
      }
      return;
    default:
      return;
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let split;
  while ((split = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, split);
    buffer = buffer.slice(split + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* a torn line - the next one carries its own object */
    }
  }
});

// The server closing our stdin means the server is gone; take the shells with
// us rather than leaving orphaned processes behind.
process.stdin.on("end", () => {
  for (const pty of ptys.values()) {
    try {
      pty.kill();
    } catch {
      /* already dead */
    }
  }
  process.exit(0);
});
