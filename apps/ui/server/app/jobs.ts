/**
 * The init-jobs primitive (spec 1.3 table row `/api/app/jobs/:job_id`,
 * spec 4 chunk K3s) - an in-memory record of one spawned process's output,
 * queryable by the id handed back from the POST that created it.
 *
 * This file owns the ONLY function in the app plane that turns an argv
 * array into a running child process: `createJob`. It is deliberately a
 * generic primitive (any fixed argv + cwd), but it is not itself a route -
 * nothing here reads a request body or a URL. The only two importers of
 * `createJob` are `init.ts`'s `initGit` and `initFactory` handlers, each of
 * which passes a hardcoded argv it built itself, never anything derived
 * from request input. That is spec 1.3's "exactly two commands may ever
 * create a job", enforced by there being exactly two call sites, not by
 * runtime policing - a third call site would be a code-review catch, the
 * same way `grep -r createJob` would find it in one line.
 *
 * "Never a dead server" (spec 1.3) applies here too: output is kept as the
 * last 500 lines only, oldest dropped first, with a running count of how
 * many were dropped - an installer's real log can run long, and this app
 * plane must not grow unbounded memory for it.
 */
import { appError, appJson } from "./guard.ts";

export type JobState = "running" | "done" | "failed";

export interface JobRecord {
  id: string;
  state: JobState;
  exit_code: number | null;
  lines: string[];
  dropped: number;
  argv: string[];
  cwd: string;
  started_at: string;
}

const MAX_LINES = 500;

const jobs = new Map<string, JobRecord>();

function param(req: Request, key: string): string {
  return decodeURIComponent((req as Request & { params: Record<string, string> }).params[key] ?? "");
}

async function pumpLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let newlineAt: number;
    while ((newlineAt = buf.indexOf("\n")) !== -1) {
      onLine(buf.slice(0, newlineAt).replace(/\r$/, ""));
      buf = buf.slice(newlineAt + 1);
    }
  }
  buf += decoder.decode();
  if (buf.length > 0) onLine(buf.replace(/\r$/, ""));
}

/**
 * Spawns `argv` in `cwd` (no shell - `Bun.spawn` takes the argv array
 * directly, the same allowlisted-subprocess shape `gitro.ts#run` uses) and
 * starts capturing its merged stdout+stderr into the job record
 * immediately. Returns the record synchronously with `state: "running"`;
 * the record mutates in place as output arrives and again on exit, so every
 * `getJob(id)` call afterward sees current state - there is no separate
 * "await completion" path, matching `/api/app/jobs/:job_id` being a poll.
 */
export function createJob(argv: string[], cwd: string): JobRecord {
  const record: JobRecord = {
    id: crypto.randomUUID(),
    state: "running",
    exit_code: null,
    lines: [],
    dropped: 0,
    argv,
    cwd,
    started_at: new Date().toISOString(),
  };
  jobs.set(record.id, record);

  const appendLine = (line: string) => {
    if (record.lines.length >= MAX_LINES) {
      record.lines.shift();
      record.dropped += 1;
    }
    record.lines.push(line);
  };

  (async () => {
    try {
      const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const [, , code] = await Promise.all([
        pumpLines(proc.stdout, appendLine),
        pumpLines(proc.stderr, appendLine),
        proc.exited,
      ]);
      record.exit_code = code;
      record.state = code === 0 ? "done" : "failed";
    } catch (error) {
      record.state = "failed";
      appendLine(`error: ${(error as Error).message}`);
    }
  })();

  return record;
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id);
}

/** GET `/api/app/jobs/:job_id` (spec 1.3): the poll shape the init actions'
 * log strip reads - state, exit code, the capped line buffer, and how many
 * lines were dropped so the UI can render the one "log truncated" line the
 * spec calls for when `dropped > 0`. */
export async function getJobStatus(req: Request): Promise<Response> {
  const id = param(req, "job_id");
  if (!id) return appError("missing job id");
  const job = getJob(id);
  if (!job) return appError(`no job ${id}`, 404);
  return appJson({
    state: job.state,
    exit_code: job.exit_code,
    lines: job.lines,
    dropped: job.dropped,
  });
}
