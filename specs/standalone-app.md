# specs/standalone-app.md - the standalone app

Builds MAP.md's **"Next front (operator-directed 2026-08-13 afternoon): the standalone app"**:
the desktop app becomes the whole roof, not a viewer. Three parts - a Terminal surface, the
install lens as first-run experience, and a Server lens.

Authority order: MAP.md > this spec > `specs/ui.md` (the read-only UI it extends) >
`specs/installer-wizard.md` (the wizard this app fronts). Parked material is archaeology.

ASCII only throughout - source, our console output, our UI strings. (Child-process output
rendered inside a terminal is the child's business; xterm renders whatever bytes arrive. The
rule binds what *we* write.)

---

## 0. The architectural line

One rule everything below obeys, stated once:

> **The web server / API stays GET-only, read-only, forever.** `just ui` is unchanged.
> **ALL action capability - terminals, setup, deploy, tunnels - lives ONLY in the Electron
> main process.** The desktop app is trusted. The web surface is not.

Consequences that are not negotiable:

1. `apps/ui/server/` gains **no new route, no new verb, no new file**. It already answers 405
   to anything but GET/HEAD; that stays the whole story.
2. No pty, no ssh child, no installer spawn ever runs in the Bun server process.
3. The same SPA is served to a plain browser *and* to the Electron window. Every action
   surface must therefore degrade to a **real empty state** in a browser (MAP rule 6: never
   mock data) - never a dead button, never a fake terminal.
4. Capability is detected by the presence of the preload bridge (`window.factory`), never by
   user-agent sniffing.
5. **Origin-gated IPC.** Every action IPC handler in main verifies the calling frame's origin
   is the local UI origin, and rejects otherwise. This is what keeps a *remote* server's SPA
   (section 5, reached over a tunnel on a different port) from ever reaching a local pty.

---

## 1. Scope

| In v1 | Out of v1 |
|---|---|
| Terminal: tabbed ptys in the Electron main process, xterm.js frontend | Any pty outside Electron main |
| Profiles: plain shell, claude, codex, pi | Arbitrary user-defined profile editor UI |
| First-run Setup screen fronting `installer/install.py` in a real pty | Any reimplementation of wizard logic |
| Server lens: host config, deploy-over-ssh, port-forward + connect | Remote db sync, fleets, auto-reconnect |
| Sessions die with the app | herdr / tmux-style session persistence |
| Local + one remote server | Multi-server switcher |

**Untouchable** (MAP standing rules): `adws/adw_modules/`, `adws/adw_*.py`, the
`.claude/skills/sssf/templates/` mirror. `installer/install.py` and `installer/steps.py` are
**read-only inputs to this spec** - the app *runs* the wizard, it never edits or forks it.
No git commit. No Anthropic model calls anywhere in this app.

---

## 2. The pty gate - PROVEN, not assumed

MAP flagged the landmine: *"node-pty on Windows needs prebuilt binaries for our Electron
version (no MSVC on this laptop - same wall as Skylos/Tauri; prebuilds usually exist, verify
before committing to the stack)."* The gate was run before a line of this spec was written.

**Method.** Scratch dir outside the repo. `bun add` each candidate, list the binaries that
actually landed, then spawn a real `cmd.exe` pty, write `echo HI_FROM_PTY_9137`, and require
the marker to come back out of the pty - under plain node *and* under a real Electron 43 main
process (not `ELECTRON_RUN_AS_NODE`).

### 2.1 Result

| | `@lydell/node-pty` **(chosen)** | `node-pty` (upstream) |
|---|---|---|
| Version | 1.2.0-beta.15 | 1.1.0 |
| Compile on install | **none** - no scripts at all (`scripts: null`) | `"install": "node scripts/prebuild.js \|\| node-gyp rebuild"` |
| node 24.18.0 (ABI 137) | **PASS** | PASS |
| Electron 43.4.0 (ABI 148) | **PASS** | PASS |
| Disk footprint | **11.71 MB** | 62.58 MB |
| Non-target-platform payload | none (per-platform optional deps, `os`/`cpu` gated) | 28.17 MB of darwin/arm64 prebuilds |

Binaries that landed for `@lydell/node-pty-win32-x64`, with no compiler invoked:

```
prebuilds/win32-x64/conpty.node                291,328 B
prebuilds/win32-x64/conpty_console_list.node   134,656 B
prebuilds/win32-x64/conpty/conpty.dll          110,152 B
prebuilds/win32-x64/conpty/OpenConsole.exe   1,062,472 B
```

Probe transcripts (verbatim):

```
[probe]  runtime: node 24.18.0  modules(ABI)=137
[probe]  PTY_OK marker seen in pty output
[probe]  resize ok -> cols=100 rows=30
[probe]  RESULT=PASS

[eprobe] electron=43.4.0 chrome=150.0.7871.224 node=24.18.1 modules(ABI)=148
[eprobe] require ok (no rebuild, no MSVC)
[eprobe] marker seen in pty output; pty is real
[eprobe] RESULT=PASS
```

### 2.2 Why `@lydell/node-pty`, and why the ABI numbers are the whole argument

The **same** `.node` file loaded at **ABI 137** (node) and **ABI 148** (Electron 43) with no
rebuild step between the two runs. That is only possible for a **Node-API** addon, and it is
the fact that closes the MSVC question: there is no `electron-rebuild` step, no node-gyp, no
toolchain, and an Electron upgrade cannot silently re-open the wall.

Upstream `node-pty` also passed both runtimes today, so it is a *viable* fallback - but it is
rejected for v1 on two counts that both bite exactly where this laptop is weak:

- Its install script's fallback branch is **literally `node-gyp rebuild`**. Any day the
  prebuild-copy step does not find a match, the install does not fail loudly - it silently
  tries to compile, and dies on the MSVC wall. `@lydell/node-pty` has *no* install script, so
  there is no branch that can ever reach a compiler.
- It ships every platform's prebuilds (5x the footprint) into an app we ship as a portable
  Windows binary.

**Recorded risk, honestly:** the chosen package is a `beta.15` prerelease. It is pinned
exactly (`1.2.0-beta.15`, no caret) so a bad prerelease cannot arrive on its own. If it ever
regresses, upstream `node-pty` is a proven, drop-in-compatible fallback (same API surface -
`spawn/onData/onExit/write/resize/kill`) and this table is the migration note.

### 2.3 Frontend and ssh deps - also proven, also no native code

- `@xterm/xterm@6.0.0` + `@xterm/addon-fit@0.11.0` installed clean; **zero** `.node` or
  `.gyp` files in the tree. Pure JS.
- `ssh` is already present at `C:\WINDOWS\System32\OpenSSH\ssh.exe`
  (`OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2`). Section 5 adds **no** ssh library - it drives
  this binary. No new native dependency anywhere in this spec.

### 2.4 New landmines, found by running the gate (add to MAP)

1. **`resize()` on an exited pty throws** - `Error: Cannot resize a pty that has already
   exited`. Hit for real in the first probe run. A `FitAddon` firing on a window resize just
   after a shell exits is exactly this crash. Every `term:resize` handler must look the
   session up and no-op if it is gone.
2. **`pty.pid` is `0` under Electron main** (it was a real pid, 19980/38004, under plain
   node). **Never key a session by pid and never kill by pid** - key by an app-generated id
   and call `pty.kill()`.
3. **The npm registry returned 503/522 intermittently** during the gate (`bun add` failed
   twice, succeeded on retry). Not our bug, but any CI that installs this must tolerate it.

### 2.5 Packaging proof - the gate does not end at `bun install` (fix round)

Section 2's gate proved `@lydell/node-pty` loads under Electron 43's dev process. It did not
yet prove the **packaged** `.exe` - asar-archived - carries and loads the same native
binaries; a `.node` file cannot be `dlopen()`'d from inside an asar archive at all, so this is
a real, separate failure mode a dev-only check cannot catch.

**Verified by actually running the packaged build**, not by inspecting config: `just app-build`
(`bunx electron-builder --win portable`), then `release/win-unpacked/SDL Factory.exe
--pty-smoke` against that exact packaged artifact - a real `conpty.node` loaded from
`app.asar.unpacked`, a real `cmd.exe` pty spawned, `echo` round-tripped, `PTY_SMOKE_OK`.

electron-builder 26.15.3's own native-module heuristic already unpacked
`@lydell/node-pty-win32-x64`'s whole package directory (the `.node` files plus their sibling
`conpty.dll`/`OpenConsole.exe`, which the module loads/spawns from disk at runtime)
automatically, with no `asarUnpack` entry at all - verified true by the smoke run above before
any config change. `electron-builder.yml` now states that contract **explicitly** anyway
(`asarUnpack: ["**/node_modules/@lydell/node-pty-*/**"]`), so it does not silently depend on an
undocumented heuristic that a future electron-builder or bun version could stop tripping - and
the packaged smoke run was repeated after adding it, with an identical result.

---

## 3. Terminal surface

The fifth surface: **Board / Trace / Gate / Settings / Terminal**.

### 3.1 Process shape

```
  renderer (xterm.js)                 preload                 MAIN PROCESS
  ------------------                  -------                 ------------
  Terminal surface      --IPC-->   contextBridge   -->   Map<sessionId, IPty>
  xterm + FitAddon      <--IPC--   window.factory  <--   @lydell/node-pty
                                                          spawns cmd.exe / claude / codex / pi

  apps/ui/server (Bun)  <-- NOT INVOLVED. Never sees a pty. GET-only, untouched. -->
```

`contextIsolation: true`, `nodeIntegration: false`, **`sandbox: true` all stay as they are
today**. A sandboxed preload still gets `ipcRenderer` and `contextBridge`, which is all the
bridge needs - so the Terminal surface costs us **no** security posture.

### 3.2 The bridge (the complete API - keep it this small)

```ts
window.factory = {
  isDesktop: true,
  term: {
    open(profileId: string, cwd?: string): Promise<{ sessionId: string }>,
    input(sessionId: string, data: string): void,          // send, not invoke: high frequency
    resize(sessionId: string, cols: number, rows: number): void,
    close(sessionId: string): void,
    attach(sessionId: string): void,   // fire-and-forget - see 3.4's replay-buffer fix
    onData(cb: (sessionId: string, chunk: string) => void): () => void,
    onExit(cb: (sessionId: string, exitCode: number) => void): () => void,
  },
  setup: { /* section 4 */ },
  server: { /* section 5 */ },
}
```

Rules for main's handlers, all of them:

- **Origin gate first, every handler.** Reject unless the sender frame's origin is one the
  handler legitimately serves. Exactly three gates exist, none may grow: dashboard-only
  (`term:open` — Setup never opens free shells; main opens Setup's pty itself via `setup:run`),
  dashboard-or-setup (`term:input/resize/close/attach`, the `setup:*` family — the shared PtyPane
  sends keystrokes from both pages; **correction 2026-08-13**: input/resize/close originally
  shipped dashboard-only, which silently dropped every keystroke typed into Setup's wizard pty),
  and dashboard-or-active-tunnel (`server:status`/`server:disconnect` only — without this the
  Disconnect button is unreachable once the window shows the remote origin; everything else stays
  denied to the tunnel, so the remote SPA still cannot open ptys, run setup, or reconfigure).
- `sessionId` is a `crypto.randomUUID()` minted in main. The renderer can only ever name a
  session main already told it about; unknown ids are dropped, not created.
- `profileId` is matched against a **fixed table** (3.3). A renderer can never supply a
  command line - only pick a profile. This is the difference between a terminal surface and a
  remote-code-execution hole in a page a browser can also load.
- Sessions are killed on `before-quit` and when their window closes.

### 3.3 Profiles - the operator's dailies

Four buttons. `cwd` defaults to **the repo root** for all of them.

| id | Launches | Note |
|---|---|---|
| `shell` | `cmd.exe` on win32, `$SHELL` elsewhere | the plain one |
| `claude` | `claude` | the operator's day harness |
| `codex` | `codex` | |
| `pi` | `node <PI_PATH>/cli.js` | **MAP landmine, absolute:** *never invoke `pi` by name.* Resolve via `PI_PATH`; forward slashes. |

A profile whose binary is not on PATH must **fail visibly in the tab** - the tab opens and
prints one plain line naming what was not found. It never silently closes and it never
pretends to have started. (Never mock.)

The table lives in main. If a `terminals.json` exists in `app.getPath("userData")` it may add
or override entries - that is the escape hatch, and it is a local file the operator writes by
hand, not a UI. No editor in v1.

### 3.4 Tabs and rendering

- Tab strip + one xterm instance per tab. `FitAddon` on container resize -> `term.resize`
  (guarded per landmine 2.4.1).
- `scrollback: 5000`. Closing a tab kills its pty; switching tabs **hides the DOM node but
  keeps the xterm object alive**, so backscroll survives a tab switch without main buffering
  anything.

**Changelog correction - the replay buffer (fix round, was wrong before):** this section used
to say "data is forwarded main -> renderer as it arrives, no buffering layer, no replay in
v1." That was wrong, and not a theoretical gap: main starts emitting `term:data` (real pty
output, or `spawnNotFound`'s one honest not-found line) the instant `term:open` mints a
session - which is *before* `TerminalSurface`'s `await term.open()` round trip resolves and
`PtyPane`'s own mount effect subscribes `onData`/`onExit`. Early bytes were silently lost, and
`spawnNotFound`'s line (scheduled with `queueMicrotask`, i.e. essentially immediately) lost
the race often enough that a dead profile's tab just opened blank.

The fix: `electron/pty.ts`'s `PtyManager` keeps a per-session ring buffer (256KB cap) of
everything emitted - data and the eventual exit alike - until a renderer actually attaches.
`PtyPane` calls the bridge's new `term.attach(sessionId)` once, right after subscribing
`onData`/`onExit`; main replays the backlog in order (data first, exit last, if the pty had
already exited too), then streams live from there. This is hermetically tested at the
`pty.ts` level (`electron/pty.test.ts`, `bun test`: a fake injected pty, no real OS process -
"emit before attach, attach, assert replay order") and end to end by `--pty-smoke`, which now
also proves a not-found profile's line survives the identical race through a real
`resolveProfile()` + `spawnNotFound()` call.

### 3.5 Sessions die with the app (v1), and why that is probably right

On quit, every pty is killed. There is no reattach.

`herdr` / tmux-style persistence is **researched-later**, and the operator's suspicion that it
is not needed has a concrete argument behind it: **the factory already owns the persistence
problem for the work that matters.** Long-running factory jobs are ADW runs - traced to
`sssf.db`, parked on their own branch and worktree, and resumable with `--adw-id` without
redoing finished phases. The Terminal surface is for *interactive* tools sitting next to the
board, not for the long jobs. Persistence would be re-solving, in a second place, a problem
that is already solved in the right place.

**The one fact that would overturn this:** the operator repeatedly losing a live interactive
session (a long `claude` conversation) to an app restart or crash. If that shows up, revisit;
until it does, this is a non-feature.

### 3.6 In a browser

`window.factory` is undefined. The Terminal nav item still renders, and the surface shows a
real empty state:

```
Terminal is desktop-only.
Terminals run in the SDL Factory desktop app, never in this read-only web UI.
Open the desktop app to use them.
```

---

## 4. First-run setup - the wizard is the engine, the app is its face

### 4.1 Detection uses the installer's own answer, not ours

Main runs the wizard's existing drift check:

```
uv run installer/install.py --verify-only --json --target <detected>
```

and reads **its exit code**, which the wizard already defines. **This is the real,
authoritative check - it always runs. What changed (4.4) is only *when*: for a machine that
already looks converged, it runs after the window is already showing, never before.**

| exit | meaning | app behaviour |
|---|---|---|
| 0 | converged, verification passed | boot straight to the dashboard |
| 1 | a required check failed | Setup screen |
| 2 | done what it can, needs a human | Setup screen |
| spawn failure | `uv` itself is missing | Setup screen, with `uv` named as the one prerequisite |

The `--json` payload is parsed for the **`verify[]` array** (`{id, outcome, message}` -
V1..V8) and rendered verbatim as the checklist. Those strings come from the wizard. The app
invents no check, no wording, and no ordering of its own.

### 4.2 Running it - a real pty, real prompts

The Setup screen's action opens an **embedded pty pane** - the same component as section 3 -
running the wizard **interactively**:

```
uv run installer/install.py --target <chosen>
```

Note what is *absent*: **no `--yes`**. The wizard's confirm pass (`Press Enter to converge, or
Ctrl-C to abort:`) is a real prompt in a real pty, so it works, and Ctrl-C really aborts. The
operator picks the target (laptop / server / container) in the app; that is the only argument
the app contributes.

When the pty exits, main re-runs 4.1 and the checklist updates from the new JSON. Exit 0 ->
the app moves on. **No wizard rewrite, no parallel logic, no second source of truth about what
"installed" means.**

### 4.3 The bootstrap problem, and the honest fix

Today `electron/main.ts` finds the repo by requiring **both** `justfile` **and**
`adws/adw_data/sssf.db`, then spawns the Bun server and loads `http://127.0.0.1:4700`. On a
genuinely fresh machine none of that exists yet - no `sssf.db`, possibly no built `dist/`. The
Setup screen therefore **cannot be served by the Bun server it is supposed to bring into
existence.**

So:

1. **Setup is a local `loadFile()`-style page** in the app bundle (`setup.html`, loaded via
   `loadURL(pathToFileURL(...))` - its own tiny bundle, xterm plus the checklist, no server, no
   network). It is not a route on the SPA.
2. **Loosen repo detection** in `main.ts` to `justfile` + `installer/install.py` - both
   present in a fresh clone. `sssf.db` stops being a *findRepoRoot* precondition and becomes
   what it actually is: one of the things setup produces.
3. Once verification exits 0 and `/api/health` answers, main swaps the window to the dashboard
   URL. Setup is never shown again unless detection says otherwise.

This keeps the goal experience - *install the desktop app, done* - while the clone-then-`uv
run` path stays exactly as the README documents it for the developer/server route.

**Changelog correction - SETUP.HTML SURVIVAL (fix round, was wrong before):** Setup's build
used to land in the *same* `dist/` as the dashboard SPA (`vite.setup.config.ts`,
`emptyOutDir: false`, run *after* `vite build`) - a survival story that depended entirely on
build **ordering**. `just app`/`app-build` always ran both builds in that order, so it worked
there, but `just ui` (section 0: unchanged, GET-only, forever) runs `vite.config.ts`'s build
*alone*, and that config's `emptyOutDir: true` empties the *whole* `dist/` directory first -
taking `setup.html` down with it. Running `just ui` after `just app` silently deleted the
Setup page.

The fix: Setup now builds into its **own** output directory, `apps/ui/dist-setup/` (sibling of
`dist/` and `dist-electron/`), which neither `just ui` nor `vite.config.ts`'s build ever
touches. `electron/main.ts`'s `enterSetup()` loads `dist-setup/setup.html`. `.gitignore` gained
a `dist-setup/` entry alongside its existing `dist-electron/`. `just ui` and `just app`/
`app-build` now each rebuild only the directory they own, in either order, any number of
times, without touching the other's output.

### 4.4 Instant launch (fix round changelog - the previous design was wrong)

**This section corrects 4.1's original design, which was wrong in practice.** As first built,
`boot()` ran 4.1's `--verify-only --json` check **unconditionally, before the window was ever
shown** - a real `uv run` subprocess round trip that can take on the order of 27 seconds
(environment resolution, not network, but blocking all the same). Every launch, on every
machine, including one that had converged an hour ago and changed nothing, paid that cost
before the operator saw a single pixel. That is a launch-time regression this app should never
have shipped, and the honest fix is a instant, local, network-free heuristic in front of it -
not a shorter timeout, not a spinner.

**The heuristic:** `looksAlreadySetUp(repoRoot)` - `existsSync(.env) && existsSync(adws/
adw_data)`. Both are things `install.py` itself produces and nothing else does; neither exists
on a genuinely fresh clone. Pure filesystem, no subprocess, no network - effectively instant.

**The new sequence, in `boot()`:**

1. A machine that **fails** the heuristic gets exactly 4.1's original behaviour: the blocking
   `--verify-only` round trip runs before the window shows, and the result decides Setup vs.
   dashboard, same as always. This is the *only* case that still blocks first paint on the
   real check - a machine that has never converged has nothing to show early anyway.
2. A machine that **passes** the heuristic skips the blocking check entirely and opens the
   dashboard immediately (the server still has to actually be spawned-or-reused and answer
   `/api/health` - that is inherent to showing anything at all, not the setup-verification
   round trip this fix removes). The window shows. **No network call, and no blocking
   subprocess call, happens before that first paint - ever.**
3. Only *after* the window has actually shown (`win.once("show", ...)`) does the real
   `--verify-only --json` check run, in the background, via
   `runBackgroundSetupCheck()`. A converged result is silent - nothing to tell the operator.
   An unconverged one sends a `setup:drift` event to the renderer instead of hijacking the
   launch back to Setup; the dashboard (`Shell.tsx`'s `SetupDriftBanner`) shows a small,
   dismissible strip - *"Setup found N issues on this machine"* - with an **Open Setup**
   button (`setup:open`, the dashboard-only, on-demand mirror of `setup:proceed`, swapping the
   window to the same Setup page 4.3 describes) and a **Dismiss**. The operator decides
   whether to act on it now or keep working; nothing installs, nothing is forced.

The bridge gained two members for this (both dashboard-origin-gated): `setup.open(): Promise<{
ok, error? }>` and `setup.onDrift(cb): () => void`.

---

## 5. Server lens v1

A **Server** pane in Settings. Configuration is written and read by **main** (a `server.json`
in `userData`), never by the Bun server, which stays GET-only and never learns this file
exists. In a browser the pane renders the same desktop-only empty state as 3.6.

### 5.1 Configuration

| field | example | note |
|---|---|---|
| `host` | `root@203.0.113.10` | ssh destination |
| `keyPath` | `C:/Users/.../.ssh/id_ed25519` | path only |
| `remotePort` | `4700` | the server's **loopback** UI port |
| `localPort` | `4701` | deliberately not 4700 - see 5.4 |

**No password field, no passphrase field, no token, ever.** If a key has a passphrase, ssh
prompts for it *in the pty* where it belongs. Nothing secret is stored by this app.

### 5.2 "Deploy factory to server" = the wizard, over ssh, in a visible tab

Opens a **Terminal tab** (section 3 - so it is visible, scrollable and interruptible) running:

```
ssh -tt -i <keyPath> <host> "cd ~/sdl-factory && uv run installer/install.py --target server"
```

`-tt` forces a remote tty, so the wizard's prompts and Ctrl-C both work end to end. It is the
**same wizard, the same server target** - no bespoke deploy logic, nothing the app knows about
installing that the wizard does not. This is MAP's ruling made literal: *"run the wizard on
any host and the SAME factory comes up."*

**Precondition v1 does not paper over:** the repo must already exist on the server. The app
does **not** clone it. If the path is missing, the tab shows ssh's real error and the pane
says so in one line. A one-click that silently guesses at `git clone`, branches and remotes
would be exactly the "parallel logic" this spec refuses.

### 5.3 "Connect" = an app-managed ssh port-forward

Main spawns and owns:

```
ssh -N -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort> -i <keyPath> <host>
```

then polls `http://127.0.0.1:<localPort>/api/health` and, when it answers, navigates the
dashboard window to that URL. Disconnect kills the child and navigates back to local.

**Connect status honesty (fix round correction):** a connect attempt that spawns ssh fine but
never sees the forwarded port answer health within budget used to call the same `stop()` that
Disconnect uses - which resets the tunnel to `"idle"` ("not connected") **unconditionally**,
discarding whatever real error the ssh child had already reported. The next status poll (or a
reload of the Server pane) then showed "not connected" with a plain **Connect** button, as if
nothing had ever been tried - the opposite of spec 5.5's "a dead tunnel is visible, never
papered over." `ServerTunnel` now has a separate `fail(message)`: it kills the child if one is
still running, but lands the tunnel in `"error"` with an honest reason - the ssh child's own
stderr tail if it already exited with one, the timeout message otherwise - never `"idle"`.
`server:connect`'s handler calls `fail()`, not `stop()`, on a failed attempt. `stop()` itself is
unchanged and still means exactly "not connected" - the *operator-initiated* Disconnect path,
where nothing failed.

**Read-only remains read-only across the tunnel** - and not by our good manners. The thing on
the far end of the tunnel *is* the same GET-only Bun process, answering 405 to every non-GET.
A tunnel changes transport, never authorization. There is no proxy in the middle adding verbs.

This honors the loopback + Tailscale-optional landmine exactly: the remote UI keeps binding
`127.0.0.1` (never the shipped visualizer's `0.0.0.0`), the tunnel is what reaches it, and
Tailscale stays a convenience rather than a dependency.

### 5.4 Why `localPort` is not 4700 - the security point

The tunnel's local port is a **different origin** from the local UI. The origin gate in 3.2
therefore denies terminal/setup/server IPC to the remote SPA **automatically**, as a
consequence of the port choice rather than as a rule someone has to remember. The remote
server is a different trust domain and is treated as one.

The honest cost: **while connected to a server, the Terminal surface is unavailable** (it is
origin-denied, and says so plainly). Disconnect to use it, or open an ssh tab *before*
connecting. v2 note: lift the terminal out of the web origin into its own always-local window
and this restriction disappears.

### 5.5 What v1 does NOT do - stated plainly

- **No remote db sync.** Nothing is copied, ever. Connect shows the server's live db through
  the tunnel; disconnect and it is simply gone from view.
- **No fleet.** Exactly one server config. No list, no switcher, no profiles.
- **No auto-reconnect.** If the tunnel drops, the app shows `tunnel closed` and one
  **Reconnect** button. No retry loop, no backoff, no silent reconnection - a dead tunnel is
  visible, never papered over. **This applies just as much to a connect attempt that never
  came up in the first place** (5.3's fix-round correction) - it lands on `error` with the
  real reason and a **Reconnect** button, never silently back on "not connected".
- **No repo bootstrap on the server** (5.2), **no key generation or management**, no
  ssh-agent handling, no `known_hosts` automation - ssh's own prompts stand.
- **No writes over the tunnel.** There is no write path to enable; see section 0.
- **No terminal while connected** (5.4).

---

## 6. Acceptance

1. `bun install` in `apps/ui` completes on this laptop with **no compiler invoked**, and
   `@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty.node` exists afterwards.
2. Launching the app on a machine that passes the instant heuristic (4.4) opens the dashboard
   with **five** surfaces immediately - no blocking `--verify-only` round trip before first
   paint.
3. Terminal: open a `shell` tab, type `echo hi`, see `hi`, **reliably** - not "about half the
   time" (3.4's replay-buffer fix). Open all four profiles; each either runs or prints one
   honest not-found line, every time, regardless of how fast that line arrives relative to the
   tab mounting. Resize the window mid-session and after a shell has exited - **no crash**
   (landmine 2.4.1).
4. Every pty dies when the app quits - verified with no orphan `cmd.exe`/`conhost` left.
5. Loading `http://127.0.0.1:4700` in a plain browser shows the Terminal surface's
   desktop-only empty state and **no** functioning bridge.
6. `apps/ui/server/` has **zero** diff in this phase, and still answers 405 to `POST /api/*`.
7. On a machine where `install.py --verify-only` exits non-zero, the app opens Setup, lists
   the wizard's own `verify[]` messages, and its action runs the wizard in a pty where
   `Press Enter to converge` genuinely waits for Enter. A machine that instead passes 4.4's
   instant heuristic but is *actually* still drifted gets the dashboard first and a
   non-blocking banner second, with the same **Open Setup** destination.
8. Server lens: Deploy opens a visible tab whose Ctrl-C reaches the remote; Connect forwards
   the port and the dashboard renders the server's data; `POST` to the tunneled API returns
   405; Disconnect kills the ssh child (no orphan). A Connect attempt that never comes up
   (bad host, closed port) lands on `error` with the real reason and a **Reconnect** button -
   never silently back on "not connected" (5.3's fix-round correction).
9. `just app-build`'s packaged `.exe` actually loads `@lydell/node-pty`'s native binaries and
   spawns a real pty at runtime - proven by running, not just inspecting config (2.5).
10. `just ui` followed by `just app` (either order, repeated) never deletes the other's build
    output - `dist/index.html` and `dist-setup/setup.html` both survive every combination
    (4.3's fix-round correction).

---

## 7. Provenance

The section 2 gate was run 2026-08-13 in a scratch directory outside the repo
(`.../scratchpad/ptygate/`), against Electron 43.4.0 as installed at
`apps/ui/node_modules/electron`. Nothing was installed into the repo to produce it. The
probe scripts (`probe.cjs`, `electron-app/main.cjs`) are scratch artifacts, not repo files -
the transcripts in 2.1 are the record.
