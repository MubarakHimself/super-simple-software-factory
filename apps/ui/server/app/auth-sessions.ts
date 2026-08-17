/**
 * AUTH SESSIONS — "Sign in on <machine>", the only shape of it that works.
 *
 * ── THE OPERATOR'S RULING (this file exists because of it) ──────────────────
 * Copying an auth file or a token to the server DOES NOT WORK for Claude Code
 * or Codex. What works is the opposite direction: run the login command ON the
 * machine, over SSH; it prints a link (or a device code); the operator opens
 * that link in the browser on his own laptop; the sign-in completes ON THE
 * MACHINE, in the machine's own credential store. Nothing is ever carried from
 * this laptop: what crosses the wire is keystrokes going out, and the machine's
 * own output coming back — and where that output is itself a credential (see
 * `capture` below) it goes straight back onto the same machine and nowhere
 * else.
 *
 * `providers-v3.ts`'s sync path is untouched by this file. API-key providers
 * still sync exactly as they did — a key is a key and copying it is correct.
 * This module is only for the two subscription CLIs, plus the read that says
 * whether pi's own lane store knows the codex lane.
 *
 * ── THE COMMANDS, AND WHERE EACH ONE'S TRUTH LIVES ──────────────────────────
 *   grok      `grok login --device-auth`
 *                                 -> the machine's ~/.grok/auth.json
 *   claude    `claude setup-token` -> the machine's own
 *                                    ~/.sdl-factory/secrets.env (0600), as
 *                                    CLAUDE_CODE_OAUTH_TOKEN
 *   codex     `codex login`        -> the machine's ~/.codex/auth.json
 *   pi-xai        (no command)     -> pi's own "xai" lane credential
 *   pi-codex      (no command)     -> pi's own "openai-codex" lane credential
 *   opencode-go   (no command)     -> pi's own "opencode-go" lane credential
 *   ollama-cloud  (no command)     -> pi's own "ollama-cloud" lane credential
 *
 * The four `(no command)` rows are pi's own lanes. They are probe-only for a
 * measured reason, not a shrug — see THE PI-LANE QUESTION below — and each one
 * names the exact line the operator types to fix it.
 *
 * There is no `claude login` subcommand: Claude Code's own authentication doc
 * has exactly two paths, running `claude` (the TUI, which never exits and so
 * can never be "done") and `claude setup-token`, which *"opens the same browser
 * authorization flow as `/login`"* and prints a one-year token — *"it does not
 * save the token anywhere"*. So this file runs `setup-token` ON the machine and
 * finishes the job the command leaves undone: the token it prints is harvested
 * out of the stream, written straight back into that same machine's
 * `~/.sdl-factory/secrets.env` at mode 0600 — the file
 * `installer/steps.py:apply_oauth_token` already reads, and the one the
 * installer's own V8 check looks for — and redacted everywhere else. It is
 * never returned by a route, never written on this laptop, and never put on a
 * command line. The same doc names the pty prompt this flow needs: *"paste it
 * into the terminal at the `Paste code here if prompted` prompt... common in
 * WSL2, SSH sessions, and containers"* — which is exactly what the strip's
 * paste box writes to.
 *
 * `codex login` serves its OAuth callback on the machine's own
 * **127.0.0.1:1455** — that is why `installer/steps.py:AUTH_LANES` tells the
 * operator to "ssh -L the callback port" and why this file opens exactly that
 * forward, in-process, for exactly as long as the sign-in runs (see
 * `openCallbackForward`). The browser on the laptop hits its own
 * 127.0.0.1:1455; ssh2's `forwardOut` carries the bytes to the machine's.
 *
 * `grok login --device-auth` is the xAI lane, and it is the one login in this
 * table that was BUILT for this situation. `grok login --help` on the
 * operator's own machine lists it in these words: *"Use device-code
 * authentication for headless/remote environments"* — so there is no callback
 * port to forward at all. The command prints a URL and a short pairing code,
 * the operator opens the URL on his laptop and types the code, and the grok
 * CLI writes its own credential into the machine's `~/.grok/auth.json` under a
 * `https://auth.x.ai::<client-id>` key (`auth_mode: "oidc"`, an access token, a
 * refresh token and an expiry — read off the operator's real file, keys only).
 * Nothing is printed for this app to harvest and nothing is copied: `capture`
 * is null and the re-probe reads that file's existence and shape.
 *
 * ── THE PI-LANE QUESTION, ANSWERED (it was open; it is not any more) ─────────
 * The old text here said one live confirmation was owed: whether pi exposes a
 * non-TUI login. It was asked, on this laptop, read-only. The answer is NO, and
 * the proof is `pi auth --help`, which lists the WHOLE auth surface:
 *
 *     pi auth print-api-key    [--provider <p>] [--model <m>]
 *     pi auth print-bearer-token [--provider <p>] [--model <m>] [--min-expiry]
 *     pi auth check            [--provider <p>] [--model <m>] [--json] ...
 *
 * There is no `pi auth login`. pi's own shipped `docs/providers.md` says the
 * same from the other side — *"Use `/login` in interactive mode, then select a
 * provider"*, and for xAI specifically *"Run `/login xai`, then select **Use a
 * subscription**"*. So pi's lane login is genuinely TUI-only, this file still
 * will not fake typing it, and each pi-lane row carries the exact TUI line the
 * operator runs in a terminal instead of an apology.
 *
 * What that same help DID hand over is a real, non-interactive, read-only
 * PROBE, and every pi lane below now uses it in place of grepping JSON:
 *
 *     pi auth check --provider <lane> --json --no-refresh
 *       -> {"status":"ready","provider":"xai","authType":"oauth"}
 *       -> {"status":"not_ready","provider":"anthropic","reason":"credentials_not_configured"}
 *
 * Three properties of that command decide how it is used here. `--no-refresh`
 * is MANDATORY: without it the command refreshes expired OAuth credentials,
 * which is a WRITE, and a probe in this file never writes. `--credentials` is
 * never passed — it is the flag that emits the secret, and nothing here wants
 * it. And `ready` means *a credential is configured*, not *a credential is
 * valid*: measured on this laptop, the xai lane whose stored token expired on
 * 2026-08-10 still answered `ready` on 2026-08-17. That is the same trap
 * `providers-v3.ts`'s header already records ("reported ready on an expired
 * token"), so the detail sentence these probes print says *configured*, and
 * says that pi refreshes on first use, rather than over-claiming "working".
 * When pi is not on the machine's PATH at all the probe falls back to the
 * original read of `~/.pi/agent/auth.json` and says which of the two answered.
 *
 * ── WHAT NEVER LEAVES THIS PROCESS ──────────────────────────────────────────
 * A login command's own output can contain a token (`claude setup-token`
 * prints one outright; a callback URL carries an authorization code). Every
 * line is passed through `scrubSecrets` BEFORE it is stored, so the redaction
 * is in the record itself and not merely in the view — a future route that
 * reads `session.lines` cannot leak what this one refuses to. The probes are
 * read-only and print no file content: `grep -q` answers with an exit code.
 *
 * ── HONEST END STATES ───────────────────────────────────────────────────────
 * `completed` is never "the command exited 0". It is the RE-PROBE's answer,
 * asked over the same connection after the command exits: the credential file
 * is on the machine, or the row does not say signed in. Cancel kills the
 * remote command and still asks — a sign-in finished in the browser one second
 * before the operator clicked Cancel is still a sign-in.
 *
 * One session at a time per machine (two `codex login`s would fight over
 * 127.0.0.1:1455 on both ends).
 *
 *   GET  /api/app/auth-session?machine_id=   the flow table + the live session
 *   POST /api/app/auth-session/start         {machine_id, flow}
 *   POST /api/app/auth-session/input         {machine_id, text}   (paste-back)
 *   POST /api/app/auth-session/cancel        {machine_id}
 *   POST /api/app/auth-session/check         {machine_id, flow}   (probe only)
 * All static paths, no `:param` siblings — `machines.ts`'s own routing rule.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import type { Client, ClientChannel } from "ssh2";
import type { AuthFlowView, AuthProbeResponse, AuthSessionResponse, AuthSessionView } from "../../shared/types.ts";
import { appError, appJson, appSafely, csrfGuard } from "./guard.ts";
import { connect, execCapture, readRegistry, sftpWrite, shq, type MachineRecord } from "./machines.ts";
// The one function borrowed from the providers plane rather than re-derived:
// it is the port of `installer/steps.py:merge_env_text`, and the file it edits
// here is the same `~/.sdl-factory/secrets.env` that module's sync writes.
import { mergeEnvText } from "./providers-v3.ts";

// ── the flow table ──────────────────────────────────────────────────────────

export interface AuthFlow {
  /** also the id of the Providers-pane row this flow belongs to */
  id: string;
  label: string;
  /** The FIXED literal run on the machine. `null` = no non-interactive command
   * exists for this lane, and this app will not pretend one does.
   *
   * Sent through `remoteCommand`, which prefixes a fixed PATH so a CLI in a
   * per-user directory is found by a NON-LOGIN ssh exec. The literal itself is
   * what the row shows and what the transcript prints. */
  command: string | null;
  /** Read-only. Prints `SIGNEDIN <detail>` or `NO <detail>` and nothing else -
   * no file content, ever (`grep -q` answers with its exit code). */
  probe: string;
  /** what the probe looks at, in the operator's own words */
  probe_target: string;
  /** Set when the command PRINTS a credential instead of saving one
   * (`claude setup-token`). The value is harvested from the stream, written
   * into `~/<path>` on the machine as `<env_key>=…` at mode 0600, and redacted
   * from every line this app keeps. null = the command saves its own. */
  capture: { env_key: string; path: string } | null;
  /** the machine's own loopback port the CLI's OAuth callback listens on,
   * forwarded from this laptop for exactly as long as the session runs */
  callback_port: number | null;
  /** one line, shown under the row */
  note: string;
}

const CLAUDE_PROBE = [
  `if [ -f "$HOME/.claude/.credentials.json" ]; then printf 'SIGNEDIN %s\\n' "$HOME/.claude/.credentials.json is on the machine"`,
  `elif grep -q '^CLAUDE_CODE_OAUTH_TOKEN=.' "$HOME/.sdl-factory/secrets.env" 2>/dev/null; then printf 'SIGNEDIN %s\\n' "CLAUDE_CODE_OAUTH_TOKEN is set in $HOME/.sdl-factory/secrets.env"`,
  `else printf 'NO %s\\n' "no $HOME/.claude/.credentials.json, and no CLAUDE_CODE_OAUTH_TOKEN in $HOME/.sdl-factory/secrets.env"; fi`,
].join("; ");

const CODEX_PROBE =
  `if [ -f "$HOME/.codex/auth.json" ]; then printf 'SIGNEDIN %s\\n' "$HOME/.codex/auth.json is on the machine"; ` +
  `else printf 'NO %s\\n' "no $HOME/.codex/auth.json on the machine"; fi`;

const PI_CODEX_PROBE = [
  `if [ ! -f "$HOME/.pi/agent/auth.json" ]; then printf 'NO %s\\n' "the machine has no $HOME/.pi/agent/auth.json at all"`,
  `elif grep -q '"openai-codex"' "$HOME/.pi/agent/auth.json"; then printf 'SIGNEDIN %s\\n' "openai-codex has an entry in $HOME/.pi/agent/auth.json"`,
  `else printf 'NO %s\\n' "$HOME/.pi/agent/auth.json exists but has no openai-codex entry"; fi`,
].join("; ");

/**
 * The xAI lane's own store, written by the grok CLI's device login.
 *
 * Read off the operator's real `~/.grok/auth.json` (keys only, never a value):
 * the file is a map whose ONE key is `https://auth.x.ai::<oidc-client-id>` and
 * whose value carries `auth_mode: "oidc"`, `key`, `refresh_token`, `expires_at`
 * and the account's own identity fields. So `auth.x.ai` is the substring that
 * says a real xAI sign-in happened, and `grep -q` answers with an exit code
 * without printing a byte of it.
 */
const GROK_PROBE = [
  `if [ ! -f "$HOME/.grok/auth.json" ]; then printf 'NO %s\\n' "the machine has no $HOME/.grok/auth.json - the grok CLI has never signed in there"`,
  `elif grep -q 'auth\\.x\\.ai' "$HOME/.grok/auth.json"; then printf 'SIGNEDIN %s\\n' "the grok CLI has an auth.x.ai entry in $HOME/.grok/auth.json"`,
  `else printf 'NO %s\\n' "$HOME/.grok/auth.json is on the machine but carries no auth.x.ai entry"; fi`,
].join("; ");

/**
 * A pi LANE probe: `pi auth check` when pi is on the machine's PATH, the
 * original JSON read when it is not — and the answer always says which of the
 * two spoke, because "pi says ready" and "a key is in a file" are different
 * claims and a row that blurred them would be lying by omission.
 *
 * `--no-refresh` is not optional (without it the command WRITES a refreshed
 * token) and `--credentials` is never passed (it is the flag that prints the
 * secret). The word chosen for a `ready` answer is CONFIGURED, not working:
 * see the header's measurement of a `ready` answer on an expired token.
 */
function piLaneProbe(provider: string, fallback: string): string {
  return [
    `if command -v pi >/dev/null 2>&1; then out=$(pi auth check --provider ${provider} --json --no-refresh 2>/dev/null || true); else out=''; fi`,
    `case "$out" in`,
    `  *'"status":"ready"'*) printf 'SIGNEDIN %s\\n' "pi auth check says the ${provider} lane is configured on this machine - pi refreshes the token itself on first use" ;;`,
    `  *'"status":"not_ready"'*)`,
    `    why=$(printf '%s' "$out" | sed -n 's/.*"reason":"\\([^"]*\\)".*/\\1/p')`,
    `    if [ -n "$why" ]; then printf 'NO %s\\n' "pi auth check says the ${provider} lane is not ready on this machine ($why)"`,
    `    else printf 'NO %s\\n' "pi auth check says the ${provider} lane is not ready on this machine"; fi ;;`,
    `  *) ${fallback} ;;`,
    `esac`,
  ].join("\n");
}

/** The read used when pi itself is not on the machine — the original probe's
 * shape, with its sentence saying plainly that pi was not there to ask. */
function piAuthJsonFallback(provider: string): string {
  return [
    `if [ ! -f "$HOME/.pi/agent/auth.json" ]; then printf 'NO %s\\n' "no pi on this machine's PATH, and no $HOME/.pi/agent/auth.json to read either"`,
    `elif grep -q '"${provider}"' "$HOME/.pi/agent/auth.json"; then printf 'SIGNEDIN %s\\n' "${provider} has an entry in $HOME/.pi/agent/auth.json (read directly - pi is not on this machine's PATH to ask)"`,
    `else printf 'NO %s\\n' "$HOME/.pi/agent/auth.json is on the machine but has no ${provider} entry, and pi is not on PATH to ask"; fi`,
  ].join("; ");
}

/**
 * ollama-cloud is the one lane whose credential is NOT an `auth.json` entry:
 * `installer/steps.py` wires it as a provider block in `models.json` whose
 * `apiKey` is the shell escape `!python .../ollama-cloud-key.py`, and that
 * script reads OpenCode's own auth file. So the fallback reads the block, and
 * `pi auth check` — which resolves the `!` script and answered
 * `{"status":"ready","authType":"api_key"}` on this laptop — is the real check.
 */
const OLLAMA_MODELS_FALLBACK = [
  `if [ ! -f "$HOME/.pi/agent/models.json" ]; then printf 'NO %s\\n' "no pi on this machine's PATH, and no $HOME/.pi/agent/models.json to read either"`,
  `elif grep -q '"ollama-cloud"' "$HOME/.pi/agent/models.json"; then printf 'SIGNEDIN %s\\n' "an ollama-cloud provider block is in $HOME/.pi/agent/models.json (read directly - pi is not on PATH to resolve its key script)"`,
  `else printf 'NO %s\\n' "$HOME/.pi/agent/models.json has no ollama-cloud block, and pi is not on PATH to ask"; fi`,
].join("; ");

export const AUTH_FLOWS: AuthFlow[] = [
  // Grok is first in this list because it is first in the operator's morning:
  // the xAI lane is the workhorse, and this is the one row here whose vendor
  // shipped a login built for exactly this shape of remote sign-in.
  {
    id: "grok",
    label: "Grok (xAI)",
    // `grok login --help`, read on the operator's own machine: `--device-auth`
    // is *"device-code authentication for headless/remote environments"*. The
    // sibling `--oauth` is the browser-redirect flow and would need a callback
    // port forwarded; device auth needs none, which is why callback_port is
    // null below and why this is the flag chosen for a machine over SSH.
    command: "grok login --device-auth",
    probe: GROK_PROBE,
    probe_target: "~/.grok/auth.json on the machine",
    // The grok CLI saves its own credential. Nothing is printed for this app to
    // harvest, so nothing is harvested.
    capture: null,
    callback_port: null,
    // WHAT THIS ROW DOES AND DOES NOT BUY, said on the row itself. The grok
    // CLI's credential is read by the grok CLI. The roster's builder lane is
    // `xai/grok-4.5`, which is pi's OWN `xai` lane - a different store
    // (~/.pi/agent/auth.json), filled only by pi's TUI `/login xai`
    // (docs/research/provider-auth-map-2026-08-18.md section 3: pi does not
    // read the grok CLI's credentials, and nothing in adws/ shells the grok
    // CLI). The pi-xai row below is the one that fills the lane the engine
    // runs on; saying so here is the difference between a green row and a
    // working workhorse.
    note: "Runs `grok login --device-auth` on the machine - the flag xAI ships for headless and remote boxes. It prints a link and a short code: open the link here, type the code, and the grok CLI writes its own credential into that machine's ~/.grok/auth.json. Nothing is copied from this laptop and there is no port to forward. TWO THINGS TO KNOW: the deploy does NOT install the grok CLI (only claude and codex), so on a fresh box this exits 127 until you install it there; and this credential drives the grok CLI only - the roster's xai/grok-4.5 builder lane runs through pi, whose own xai store is filled by the \"pi lane: xai\" row below.",
  },
  {
    id: "claude",
    label: "Claude",
    command: "claude setup-token",
    probe: CLAUDE_PROBE,
    probe_target: "~/.claude/.credentials.json, or CLAUDE_CODE_OAUTH_TOKEN in ~/.sdl-factory/secrets.env, on the machine",
    capture: { env_key: "CLAUDE_CODE_OAUTH_TOKEN", path: ".sdl-factory/secrets.env" },
    callback_port: null,
    note: "Runs `claude setup-token` on the machine: it prints a link, and the token it prints at the end is written into that machine's own ~/.sdl-factory/secrets.env (0600). Nothing comes back here.",
  },
  {
    id: "codex",
    label: "Codex (OpenAI)",
    command: "codex login",
    probe: CODEX_PROBE,
    probe_target: "~/.codex/auth.json on the machine",
    capture: null,
    // installer/steps.py:AUTH_LANES - "browser; on a headless server, ssh -L
    // the callback port". This is that port, and this app opens the forward.
    callback_port: 1455,
    // Same shape as the grok row above, and it is named for the same reason:
    // `codex login` fills ~/.codex/auth.json, which the codex CLI reads.
    // Nothing in adws/ invokes the codex CLI, and with `defaults.coding_agent:
    // pi` a GPT lane resolves to pi's `openai-codex` lane - a separate entry in
    // ~/.pi/agent/auth.json with a TUI-only login (the pi-codex row below).
    note: "Runs `codex login` on the machine, with its 127.0.0.1:1455 callback forwarded from this laptop while it runs. This fills the codex CLI's own ~/.codex/auth.json. If your roster reaches GPT through pi (defaults.coding_agent: pi), that lane is pi's separate `openai-codex` store - use the \"pi lane: openai-codex\" row below for it.",
  },
  // ── pi's own lanes: probe-only, and each one names its TUI line ────────────
  // `pi auth --help` has no `login` subcommand and pi's shipped docs/providers.md
  // says the login is `/login` "in interactive mode". So these four rows check,
  // and tell the operator the exact line to type. None of them pretends.
  {
    id: "pi-xai",
    label: "pi lane: xai",
    command: null,
    probe: piLaneProbe("xai", piAuthJsonFallback("xai")),
    probe_target: "`pi auth check --provider xai` on the machine (or its xai entry in ~/.pi/agent/auth.json when pi is not on PATH)",
    capture: null,
    callback_port: null,
    // pi's own docs/providers.md, verbatim: "Run `/login xai`, then select
    // **Use a subscription**". The grok CLI's login above does NOT fill this
    // in - they are two separate credential stores on the same box.
    note: "The grok CLI's sign-in and pi's xai lane are two different stores, and signing into one does not sign into the other. pi has no non-TUI login, so to fill this one: run `pi` on the machine, type `/login xai`, and choose \"Use a subscription\". This row only checks.",
  },
  {
    id: "pi-codex",
    label: "pi lane: openai-codex",
    command: null,
    // The original JSON read is kept exactly as it was and becomes the fallback
    // for a machine with no pi on PATH; `pi auth check` is asked first.
    probe: piLaneProbe("openai-codex", PI_CODEX_PROBE),
    probe_target: "`pi auth check --provider openai-codex` on the machine (or its openai-codex entry in ~/.pi/agent/auth.json when pi is not on PATH)",
    capture: null,
    callback_port: null,
    note: "The codex CLI's login and pi's openai-codex lane are two different stores, and a machine can have one without the other. pi has no non-TUI login, so to fill this one: run `pi` on the machine and type `/login openai-codex`. This row only checks.",
  },
  {
    id: "opencode-go",
    label: "pi lane: opencode-go",
    command: null,
    probe: piLaneProbe("opencode-go", piAuthJsonFallback("opencode-go")),
    probe_target: "`pi auth check --provider opencode-go` on the machine (or its opencode-go entry in ~/.pi/agent/auth.json when pi is not on PATH)",
    capture: null,
    callback_port: null,
    // The key's real minting path, named rather than gestured at: it is a
    // browser sign-in on opencode.ai, and no command on any machine mints it.
    note: "The OpenCode Go key is minted by a browser sign-in at https://opencode.ai/auth - no command on the machine can fetch one. Once you have it, either paste it into the API-key list above (which syncs it to the machine) or run `pi` on the machine and type `/login opencode-go`. This row only checks.",
  },
  {
    id: "ollama-cloud",
    label: "pi lane: ollama-cloud",
    command: null,
    probe: piLaneProbe("ollama-cloud", OLLAMA_MODELS_FALLBACK),
    probe_target: "`pi auth check --provider ollama-cloud` on the machine (or the ollama-cloud block in ~/.pi/agent/models.json when pi is not on PATH)",
    capture: null,
    callback_port: null,
    // This lane's key does not live in auth.json at all - see
    // OLLAMA_MODELS_FALLBACK. The script named here is the one this repo ships.
    note: "This lane's key is not stored in pi's auth.json: installer/assets/pi/scripts/ollama-cloud-key.py reads it out of OpenCode's own auth file, and ~/.pi/agent/models.json calls that script. Mint the key by signing into OpenCode (`opencode auth login`, then ollama-cloud), and this row checks that pi can resolve it.",
  },
];

/**
 * The PATH a login command is run under, on the machine.
 *
 * `client.exec` is a NON-LOGIN, non-interactive shell: it sources no
 * `.profile`, and Ubuntu's stock `.bashrc` returns on its first line when the
 * shell is not interactive. So a CLI the operator installed into a per-user
 * directory is simply NOT FOUND, and the whole sign-in dies with exit 127 and
 * the shell's own "command not found" - which reads, on the strip, as "the
 * login failed" rather than "this box does not have that CLI on the exec PATH".
 *
 * The xAI CLI is exactly that shape: it is a self-updating native binary
 * (`installer = "internal"` in its own config.toml), and it lives in
 * `~/.grok/bin/grok`, not in a package manager's bin. `~/.local/bin` is where
 * uv, just and every astral-style installer put theirs; `/usr/local/bin` is
 * where a root npm global lands on some boxes. Naming the three costs nothing
 * and is the difference between the operator's FIRST click working and not.
 *
 * A fixed literal, exactly like the commands themselves: nothing here is built
 * from operator input, so nothing here can carry operator input onto a shell.
 */
export const REMOTE_PATH_PREFIX = 'PATH="$HOME/.grok/bin:$HOME/.local/bin:/usr/local/bin:$PATH"; export PATH; ';

/** The literal actually sent to the machine for `flow.command`. */
export function remoteCommand(command: string): string {
  return `${REMOTE_PATH_PREFIX}${command}`;
}

export function flowById(id: string): AuthFlow | null {
  return AUTH_FLOWS.find((flow) => flow.id === id) ?? null;
}

export function flowView(flow: AuthFlow): AuthFlowView {
  return {
    id: flow.id,
    label: flow.label,
    command: flow.command,
    probe_target: flow.probe_target,
    callback_port: flow.callback_port,
    note: flow.note,
  };
}

// ── what may never reach a response ─────────────────────────────────────────

/** A token printed outright (`sk-ant-oat01-…`, `sk-…`) or a JWT. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
];

/**
 * `access_token=…`, `code=…` and friends inside a URL.
 *
 * `user_code=` and `device_code=` are deliberately NOT matched: `\b` cannot
 * fire before the `code` in `user_code` (the underscore is a word character),
 * and a device flow's pairing code is the thing the operator has to be able to
 * read. An authorization `code=` in a callback URL is a secret and is redacted.
 */
const PARAM_PATTERN = /\b(access_token|refresh_token|id_token|client_secret|secret|api_key|apikey|token|code|key)=([^\s&"'<>]+)/gi;

/**
 * Values that are FLAGS, not credentials, and must survive the redaction.
 *
 * THE FIELD FAILURE this exists for: `claude setup-token`'s real authorize URL
 * carries a literal `code=true` parameter (the manual-code flow flag) ahead of
 * `client_id`, `redirect_uri`, `scope`, `code_challenge` and `state`. The
 * pattern above matched it, rewrote it to `code=[redacted]`, and because
 * `append` lifts the link out of the ALREADY-SCRUBBED line, `extractUrl` -
 * whose character class excludes `]` - then truncated the whole link at the
 * bracket. `session.url` became `https://claude.ai/oauth/authorize?code=[redacted`
 * and the strip's "open this in your browser" button, its copy-link and the
 * transcript line were all dead ends: the Claude sign-in could never be
 * completed from this app.
 *
 * Anchoring the redaction to values that CAN be secret is the fix, rather than
 * lifting the URL out before scrubbing - a callback URL's `code=` really is an
 * authorization code, and it must still be redacted (a test asserts both).
 * A boolean or an empty value is never a credential in any of these flows.
 */
const NON_SECRET_VALUES: ReadonlySet<string> = new Set(["true", "false", "1", "0", "yes", "no", "none", "null"]);

/** A long opaque blob on a line with no URL on it — the `claude setup-token`
 * shape, where the token is simply printed on a line of its own. Never applied
 * to a line carrying a URL, because a URL is exactly such a blob. */
const OPAQUE_PATTERN = /[A-Za-z0-9_-]{48,}/g;

export function scrubSecrets(text: string, known: readonly string[] = []): string {
  let out = text;
  // Anything the operator typed into this session (a pasted pairing code) is
  // known-secret by construction. The length floor stops a one-character reply
  // from redacting every "y" in the transcript.
  for (const secret of known) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "[redacted]");
  out = out.replace(PARAM_PATTERN, (match, key: string, value: string) =>
    NON_SECRET_VALUES.has(value.toLowerCase()) ? match : `${key}=[redacted]`,
  );
  if (!out.includes("://")) out = out.replace(OPAQUE_PATTERN, "[redacted]");
  return out;
}

/** A pty means colour, spinners and cursor moves. None of that is information
 * here, and an escape sequence in a JSON response is noise the pane would draw
 * literally. */
export function stripAnsi(text: string): string {
  return (
    text
      // OSC (a window title and friends): ESC ] ... BEL, or ESC ] ... ESC \
      .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
      // CSI - colour, cursor moves, erase-line: what a spinner is made of
      .replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, "")
      // the two-character escapes, and the bell itself
      .replace(/\u001B[@-Z\\-_]/g, "")
      .replace(/[\u0000-\u0006\u0007\u000B\u000C\u000E-\u001F]/g, "")
  );
}

/** The first https:// link in the text — the one the operator has to open.
 * Trailing punctuation is dropped: CLIs print "open https://x/y." often
 * enough that a trailing full stop in the href is a real broken link. */
export function extractUrl(text: string): string | null {
  const match = /https:\/\/[^\s"'<>\\)\]]+/.exec(text);
  if (!match) return null;
  return match[0].replace(/[.,;:)\]]+$/, "");
}

/**
 * The token `claude setup-token` prints at the end. Read from the RAW stream,
 * before `scrubSecrets` gets to it — this is the one place in the app that is
 * allowed to see it, and the only thing it is allowed to do with it is write
 * it back onto the machine it came from.
 */
export function extractToken(text: string): string | null {
  const match = /\bsk-ant-[A-Za-z0-9_-]{16,}/.exec(text);
  return match ? match[0] : null;
}

/**
 * A device / pairing code: `ABCD-EFGH`, with or without a label in front.
 *
 * The third pattern exists for `grok login --device-auth`, whose pairing code
 * this app has not seen printed and therefore does not assume the shape of. It
 * fires ONLY behind an explicit label ("your code: XKCD1234"), because an
 * unlabelled run of 6-10 capitals is a word, a hostname fragment or a git sha
 * far more often than it is a code — a bare match there would put nonsense in
 * front of the operator in large type. Hyphenated codes stay matchable bare,
 * as they were, because that shape is not otherwise printed by these CLIs.
 */
export function extractCode(text: string): string | null {
  const labelled = /(?:user[_ -]?code|device[_ -]?code|\bcode)\s*(?:is)?\s*[:=]?\s*["']?([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+)/i.exec(text);
  if (labelled) return labelled[1]!.toUpperCase();
  const bare = /\b([A-Z0-9]{4}-[A-Z0-9]{4,8})\b/.exec(text);
  if (bare) return bare[1]!.toUpperCase();
  const labelledBare = /(?:user[_ -]?code|device[_ -]?code|\bcode)\s*(?:is)?\s*[:=]\s*["']?([A-Z0-9]{6,10})\b/i.exec(text);
  return labelledBare ? labelledBare[1]!.toUpperCase() : null;
}

/** `SIGNEDIN <detail>` / `NO <detail>` — the probes' whole protocol. Anything
 * else is an answer this app does not understand, and it says so rather than
 * guessing either way. */
export function parseProbeAnswer(stdout: string): { signed_in: boolean | null; detail: string } {
  for (const raw of stdout.split("\n")) {
    const line = stripAnsi(raw).trim();
    if (line.startsWith("SIGNEDIN")) return { signed_in: true, detail: line.slice("SIGNEDIN".length).trim() };
    if (line.startsWith("NO ") || line === "NO") return { signed_in: false, detail: line.slice(2).trim() };
  }
  return { signed_in: null, detail: "the machine answered nothing this app could read" };
}

// ── the localhost callback forward (codex) ──────────────────────────────────

export interface CallbackForward {
  /** what was opened, in one sentence, or null when nothing was */
  detail: string | null;
  /** why nothing was opened — null when the forward is live */
  reason: string | null;
  close: () => Promise<void>;
}

/**
 * `ssh -L <port>:localhost:<port>`, in-process, for the life of one sign-in.
 *
 * Every connection the laptop's browser makes to 127.0.0.1:<port> becomes a
 * direct-tcpip channel to 127.0.0.1:<port> ON THE MACHINE, where the CLI's own
 * callback server is listening. The listener is bound to 127.0.0.1 only — no
 * other host on the network can reach it — and it is closed the moment the
 * session ends.
 *
 * A port already in use is NOT a failure of the sign-in: it is reported and
 * the session runs on, because the operator may already have his own `ssh -L`
 * open on it. What is never done is claiming a forward that is not there.
 */
export function openCallbackForward(client: Client, port: number): Promise<CallbackForward> {
  return new Promise((resolve) => {
    const sockets = new Set<Socket>();
    let settled = false;

    const server = createServer((socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());

      // MEASURED, not styled: under Bun on Windows the bytes a client has
      // already sent are LOST if the `data` listener is attached later than
      // this connection callback - `socket.pipe(channel)` inside the
      // forwardOut callback never sees the browser's request line, because the
      // browser writes it the instant the socket opens and the channel takes a
      // round trip to open. So the listener is attached synchronously here and
      // whatever arrives before the channel exists is queued.
      const pending: Buffer[] = [];
      let open: import("ssh2").ClientChannel | null = null;
      socket.on("data", (chunk: Buffer) => {
        if (open) open.write(chunk);
        else pending.push(chunk);
      });

      client.forwardOut("127.0.0.1", socket.remotePort ?? 0, "127.0.0.1", port, (error, channel) => {
        if (error) return socket.destroy();
        open = channel;
        for (const chunk of pending) channel.write(chunk);
        pending.length = 0;
        channel.on("data", (chunk: Buffer) => socket.write(chunk));
        channel.on("error", () => socket.destroy());
        channel.on("close", () => socket.end());
      });
    });

    server.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      resolve({
        detail: null,
        reason:
          `127.0.0.1:${port} on this laptop could not be opened (${error.message}), so the browser's callback has nothing to travel down. ` +
          `Close whatever is holding that port - an ssh -L you started yourself is the usual one - and start the sign-in again.`,
        close: async () => {},
      });
    });

    server.listen(port, "127.0.0.1", () => {
      if (settled) return;
      settled = true;
      resolve({
        detail: `127.0.0.1:${port} on this laptop is piped to 127.0.0.1:${port} on the machine, for as long as this sign-in runs`,
        reason: null,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close(() => done());
          }),
      });
    });
  });
}

// ── the session ─────────────────────────────────────────────────────────────

const MAX_LINES = 400;
/** A login nobody finishes must not hold an SSH connection and a loopback port
 * forever. Fifteen minutes is longer than any browser sign-in takes. */
const SESSION_TIMEOUT_MS = 15 * 60_000;

export interface AuthSession {
  id: string;
  machine_id: string;
  machine_name: string;
  flow: string;
  flow_label: string;
  state: "running" | "completed" | "failed" | "cancelled";
  /** already scrubbed, capped ring */
  lines: string[];
  dropped: number;
  url: string | null;
  code: string | null;
  /** the command is sitting at a prompt: the operator has something to paste */
  needs_input: boolean;
  forward: string | null;
  forward_reason: string | null;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  /** the RE-PROBE's answer, and the only thing that can make this completed */
  signed_in: boolean | null;
  signed_in_detail: string | null;
  error: string | null;
  // ── never in a view ──
  client: Client | null;
  stream: ClientChannel | null;
  secrets: string[];
  /** the credential a `capture` flow printed, held only long enough to write it
   * back onto the machine it came from */
  harvested: string | null;
  cancelled: boolean;
  cancelReason: string | null;
}

const sessions = new Map<string, AuthSession>();

export function getAuthSession(machineId: string): AuthSession | null {
  return sessions.get(machineId) ?? null;
}

export function authView(session: AuthSession): AuthSessionView {
  return {
    id: session.id,
    machine_id: session.machine_id,
    machine_name: session.machine_name,
    flow: session.flow,
    flow_label: session.flow_label,
    state: session.state,
    lines: session.lines,
    dropped: session.dropped,
    url: session.url,
    code: session.code,
    needs_input: session.needs_input,
    forward: session.forward,
    forward_reason: session.forward_reason,
    started_at: session.started_at,
    finished_at: session.finished_at,
    exit_code: session.exit_code,
    signed_in: session.signed_in,
    signed_in_detail: session.signed_in_detail,
    error: session.error,
  };
}

/** The read-only probe, over an already-open connection. */
async function runProbe(client: Client, flow: AuthFlow): Promise<{ signed_in: boolean | null; detail: string }> {
  const result = await execCapture(client, flow.probe);
  if (result.code !== 0 && result.stdout.trim() === "") {
    return {
      signed_in: null,
      detail: `the machine could not run the check (exit ${result.code}): ${
        scrubSecrets(result.stderr.trim().split("\n").slice(-1)[0] ?? "no output")
      }`,
    };
  }
  return parseProbeAnswer(result.stdout);
}

/** The same probe, on its own connection — what the pi-lane row's button and
 * every "Re-check on <machine>" runs. Opens nothing else and writes nothing. */
export async function probeSignedIn(
  record: MachineRecord,
  flow: AuthFlow,
): Promise<{ signed_in: boolean | null; detail: string }> {
  if (!existsSync(record.key_path)) {
    return {
      signed_in: null,
      detail: `this app has no private key at ${record.key_path} for ${record.name} - re-add the machine in Machines first`,
    };
  }
  let client: Client | null = null;
  try {
    client = await connect({
      host: record.host,
      port: record.port,
      user: record.user,
      privateKey: await readFile(record.key_path, "utf-8"),
      expectFingerprint: record.host_fingerprint,
      readyTimeoutMs: 10_000,
    });
    return await runProbe(client, flow);
  } catch (error) {
    return { signed_in: null, detail: `could not ask ${record.user}@${record.host}:${record.port} - ${(error as Error).message}` };
  } finally {
    client?.end();
  }
}

function finish(session: AuthSession): void {
  session.finished_at = new Date().toISOString();
  session.stream = null;
  session.client = null;
  session.needs_input = false;
  if (session.cancelled) {
    session.state = "cancelled";
    session.error = session.error ?? session.cancelReason ?? "this sign-in was cancelled";
    return;
  }
  if (session.signed_in === true) {
    session.state = "completed";
    return;
  }
  session.state = "failed";
  session.error =
    session.error ??
    (session.signed_in === false
      ? `the command exited ${session.exit_code} but ${session.machine_name} still has nothing signed in: ${session.signed_in_detail ?? "the check found no credential"}`
      : `the command exited ${session.exit_code} and this app could not check the machine afterwards: ${session.signed_in_detail ?? "no answer"}`);
}

/**
 * Starts the login and returns its record synchronously (`state: "running"`),
 * mutating it in place as the machine talks — `machines.ts:startDeploy`'s own
 * shape, so the pane's poll is the same poll.
 */
export function startAuthSession(record: MachineRecord, flow: AuthFlow): AuthSession {
  const existing = sessions.get(record.id);
  if (existing && existing.state === "running") return existing;

  const session: AuthSession = {
    id: crypto.randomUUID(),
    machine_id: record.id,
    machine_name: record.name,
    flow: flow.id,
    flow_label: flow.label,
    state: "running",
    lines: [],
    dropped: 0,
    url: null,
    code: null,
    needs_input: false,
    forward: null,
    forward_reason: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    exit_code: null,
    signed_in: null,
    signed_in_detail: null,
    error: null,
    client: null,
    stream: null,
    secrets: [],
    harvested: null,
    cancelled: false,
    cancelReason: null,
  };
  sessions.set(record.id, session);

  const append = (raw: string): void => {
    const line = scrubSecrets(stripAnsi(raw), session.secrets).replace(/\s+$/, "");
    if (line === "") return;
    if (session.lines[session.lines.length - 1] === line) return; // a spinner
    if (session.lines.length >= MAX_LINES) {
      session.lines.shift();
      session.dropped += 1;
    }
    session.lines.push(line);
    if (session.url === null) session.url = extractUrl(line);
    if (session.code === null) session.code = extractCode(line);
  };

  void (async () => {
    let forward: CallbackForward | null = null;
    const timer = setTimeout(() => {
      cancelAuthSession(record.id, `nothing finished this sign-in within ${Math.round(SESSION_TIMEOUT_MS / 60_000)} minutes, so it was stopped`);
    }, SESSION_TIMEOUT_MS);

    try {
      if (flow.command === null) throw new Error(`${flow.label} has no command this app can run on a machine`);
      if (!existsSync(record.key_path)) {
        throw new Error(`this app has no private key at ${record.key_path} for ${record.name} - re-add the machine in Machines first`);
      }
      append(`connecting to ${record.user}@${record.host}:${record.port}`);
      const client = await connect({
        host: record.host,
        port: record.port,
        user: record.user,
        privateKey: await readFile(record.key_path, "utf-8"),
        expectFingerprint: record.host_fingerprint,
        readyTimeoutMs: 20_000,
      });
      session.client = client;

      // Cancelled while the connect was still in flight: there was no stream to
      // kill when the button was pressed, so the stop happens here instead -
      // the login is simply never started, and the finally below still asks the
      // machine what is true on it.
      if (session.cancelled) {
        append("cancelled before the command was started");
        return;
      }

      if (flow.callback_port !== null) {
        forward = await openCallbackForward(client, flow.callback_port);
        session.forward = forward.detail;
        session.forward_reason = forward.reason;
        append(forward.detail ?? `no port forward: ${forward.reason ?? "unknown"}`);
      }

      append(`$ ${flow.command}`);
      session.exit_code = await runLogin(client, session, flow, append);

      // 127 is the shell saying "no such command", not the login saying "no".
      // Told apart here because the two need completely different actions from
      // the operator, and "exited 127 but nothing is signed in" names neither.
      // This is the state a bare Ubuntu box is in for `grok`: the deploy
      // installs the claude and codex CLIs and does not install that one.
      if (session.exit_code === 127 && !session.cancelled) {
        const binary = flow.command.split(" ")[0] ?? flow.command;
        session.error =
          `${record.name} has no \`${binary}\` command on it (the shell answered "command not found"), so this sign-in ` +
          `could not even start. Install ${binary} on that machine - the deploy installs the claude and codex CLIs and ` +
          `nothing else - and make sure it is on the PATH a non-login \`ssh <host> '<command>'\` sees ` +
          `(this app already looks in ~/.grok/bin, ~/.local/bin and /usr/local/bin).`;
        append(session.error);
      }

      // A `capture` flow's command saves nothing of its own: it printed the
      // credential and exited. Finishing the job means putting it on the
      // machine it came from, and nowhere else.
      if (flow.capture && !session.cancelled) {
        if (session.harvested) {
          append(await writeCaptured(client, flow.capture, session.harvested));
        } else if (session.exit_code === 0) {
          append(
            `the command exited 0 but printed nothing this app recognises as a token, so nothing was written on the machine`,
          );
        }
      }
    } catch (error) {
      session.error = scrubSecrets((error as Error).message, session.secrets);
      append(`error: ${session.error}`);
    } finally {
      clearTimeout(timer);
      await forward?.close().catch(() => {});
      // The re-probe. This, and nothing else, decides whether the row may say
      // the machine is signed in.
      if (session.client) {
        try {
          const answer = await runProbe(session.client, flow);
          session.signed_in = answer.signed_in;
          session.signed_in_detail = answer.detail;
          append(answer.signed_in === true ? `signed in: ${answer.detail}` : `not signed in: ${answer.detail}`);
        } catch (error) {
          session.signed_in = null;
          session.signed_in_detail = scrubSecrets((error as Error).message, session.secrets);
        }
      } else {
        session.signed_in_detail = session.signed_in_detail ?? "the machine was never reached, so nothing was checked on it";
      }
      session.client?.end();
      finish(session);
    }
  })();

  return session;
}

/**
 * Writes a harvested credential into the machine's own env file, the way
 * `providers-v3.ts` already writes that exact key on the sync path: by SFTP,
 * inside a file body, never on a command line where `ps` on the far end would
 * show it, and merged rather than replaced so every other line in the file
 * survives (`mergeEnvText`, ported from `installer/steps.py:merge_env_text`).
 * Returns the one line the strip prints about it.
 */
async function writeCaptured(client: Client, capture: { env_key: string; path: string }, value: string): Promise<string> {
  const home = await execCapture(client, `printf '%s\\n' "$HOME"`);
  const remoteHome = home.stdout.split("\n")[0]?.trim() ?? "";
  if (home.code !== 0 || !remoteHome.startsWith("/")) {
    throw new Error(`the machine did not report a usable home directory (exit ${home.code}), so nothing was written`);
  }
  const path = `${remoteHome}/${capture.path}`;
  const dir = path.slice(0, path.lastIndexOf("/"));
  const made = await execCapture(client, `mkdir -p ${shq(dir)} && chmod 700 ${shq(dir)}`);
  if (made.code !== 0) {
    throw new Error(`could not create ${dir} on the machine: ${made.stderr.trim() || `exit ${made.code}`}`);
  }
  // The existing file can hold other secrets, so its text is read into memory
  // and merged - never printed, never logged, never returned.
  const existing = await execCapture(client, `if [ -f ${shq(path)} ]; then cat ${shq(path)}; else printf ''; fi`);
  if (existing.code !== 0) {
    throw new Error(`could not read ${path} on the machine: ${existing.stderr.trim() || `exit ${existing.code}`}`);
  }
  await sftpWrite(client, path, mergeEnvText(existing.stdout, capture.env_key, value), 0o600);
  return `${capture.env_key} written into ${path} (0600) on the machine - every other line in that file was left in place`;
}

/** The login itself, on a pty because these CLIs draw one and because a login
 * that wants a code pasted back needs somewhere to read it from. The pty is
 * asked for 400 columns: an OAuth URL is long, and a pty wraps at its own
 * width, which would break the link the operator has to click into two lines. */
function runLogin(
  client: Client,
  session: AuthSession,
  flow: AuthFlow,
  append: (line: string) => void,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    client.exec(remoteCommand(flow.command!), { pty: { rows: 40, cols: 400, term: "xterm-256color", width: 3200, height: 640 } }, (error, stream) => {
      if (error) return reject(error);
      session.stream = stream;
      // Cancelled between `exec` and its callback - close what just opened.
      if (session.cancelled) stream.close();
      let code: number | null = null;
      let buffer = "";
      const push = (chunk: Buffer): void => {
        buffer += chunk.toString("utf-8");
        // A pty redraws with bare \r as often as it ends a line with \n, so
        // both are line breaks here; the tail is what the command is currently
        // sitting on, which is how "it is waiting for you" is known.
        const parts = buffer.split(/\r\n|\n|\r/);
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          // The harvest happens on the RAW line, before `append` scrubs it -
          // and pushing it onto `secrets` first is what makes that same line,
          // and every line after it, come back redacted.
          if (flow.capture && session.harvested === null) {
            const found = extractToken(stripAnsi(part));
            if (found) {
              session.harvested = found;
              session.secrets.push(found);
            }
          }
          append(part);
        }
        const tail = scrubSecrets(stripAnsi(buffer), session.secrets);
        if (session.url === null) session.url = extractUrl(tail);
        if (session.code === null) session.code = extractCode(tail);
        session.needs_input = /(code|paste|token|press|enter|continue|y\/n)[^\n]*[:>?]\s*$/i.test(tail);
      };
      stream.on("data", push);
      stream.stderr.on("data", push);
      stream.on("exit", (exitCode: number | null) => {
        code = exitCode;
      });
      stream.on("close", () => {
        if (buffer.length > 0) append(buffer);
        session.stream = null;
        session.needs_input = false;
        resolve(code);
      });
      stream.on("error", reject);
    });
  });
}

/** The paste-back: what the operator copied out of the browser, written to the
 * running command's own stdin. It is added to the session's secret list first,
 * so it can never appear in the transcript this app hands back. */
export function sendAuthInput(machineId: string, text: string): string | null {
  const session = sessions.get(machineId);
  if (!session || session.state !== "running") return `no sign-in is running on this machine`;
  const stream = session.stream;
  if (!stream) return `the sign-in on this machine is not waiting for anything right now`;
  const value = text.trim();
  if (value) session.secrets.push(value);
  stream.write(`${value}\n`);
  if (session.lines.length >= MAX_LINES) {
    session.lines.shift();
    session.dropped += 1;
  }
  session.lines.push("(sent what you pasted)");
  session.needs_input = false;
  return null;
}

/** Kills the remote command. The re-probe still runs afterwards, because a
 * sign-in that finished in the browser a second before this click is still a
 * sign-in and the row must say so. */
export function cancelAuthSession(machineId: string, reason?: string): AuthSession | null {
  const session = sessions.get(machineId);
  if (!session) return null;
  if (session.state !== "running") return session;
  session.cancelled = true;
  session.cancelReason = reason ?? "you cancelled this sign-in";
  const stream = session.stream;
  if (stream) {
    try {
      stream.signal("KILL");
    } catch {
      /* a server may refuse signals; the close below is the real stop */
    }
    try {
      stream.close();
    } catch {
      /* already gone */
    }
  } else {
    // No stream yet: the connect is still in flight. `startAuthSession` reads
    // `cancelled` the moment it has a client and stops there.
    session.client?.end();
  }
  // A far end that ignores both a signal and a channel close (sshd may refuse
  // signals outright) would leave the session "running" forever. Dropping the
  // connection is the stop that always works; the re-probe is the price, and a
  // cancelled session then says "not re-checked" rather than inventing one.
  setTimeout(() => {
    if (session.state === "running") session.client?.end();
  }, 3_000);
  return session;
}

// ── routes ──────────────────────────────────────────────────────────────────

async function findMachine(machineId: string): Promise<MachineRecord | null> {
  const registry = await readRegistry();
  return registry.machines.find((machine) => machine.id === machineId) ?? null;
}

async function getSession(req: Request): Promise<Response> {
  const machineId = (new URL(req.url).searchParams.get("machine_id") ?? "").trim();
  const session = machineId ? getAuthSession(machineId) : null;
  const response: AuthSessionResponse = {
    flows: AUTH_FLOWS.map(flowView),
    session: session ? authView(session) : null,
    reason: machineId
      ? session
        ? null
        : "no sign-in has been started on this machine from this app since it last started"
      : "no machine was named, so there is no session to report",
  };
  return appJson(response);
}

interface SessionBody {
  machine_id?: unknown;
  flow?: unknown;
  text?: unknown;
}

async function readBody(req: Request): Promise<SessionBody | Response> {
  try {
    return ((await req.json()) ?? {}) as SessionBody;
  } catch {
    return appError("invalid JSON body");
  }
}

async function postStart(req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const machineId = typeof body.machine_id === "string" ? body.machine_id.trim() : "";
  if (!machineId) return appError("machine_id is required - a sign-in happens on one named machine");
  const flow = flowById(typeof body.flow === "string" ? body.flow.trim() : "");
  if (!flow) return appError(`no such sign-in flow - this app knows ${AUTH_FLOWS.map((entry) => entry.id).join(", ")}`, 404);
  if (flow.command === null) {
    // Not an apology - the operator's next action, in one line. pi ships no
    // non-interactive login (`pi auth --help` has print-api-key,
    // print-bearer-token and check, and nothing else), so the honest answer to
    // "sign this in for me" is the exact line he types, which lives in `note`.
    return appError(`${flow.label} is check-only in this app. ${flow.note}`, 409);
  }
  const record = await findMachine(machineId);
  if (!record) return appError(`no machine ${machineId} in this app's registry - add it in Settings > Machines first`, 404);

  const running = getAuthSession(machineId);
  if (running && running.state === "running" && running.flow !== flow.id) {
    return appError(
      `${running.flow_label} is still signing in on ${record.name} - one sign-in at a time per machine. Cancel that one first.`,
      409,
    );
  }
  return appJson(authView(startAuthSession(record, flow)), 202);
}

async function postInput(req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const machineId = typeof body.machine_id === "string" ? body.machine_id.trim() : "";
  if (!machineId) return appError("machine_id is required");
  const text = typeof body.text === "string" ? body.text : "";
  const error = sendAuthInput(machineId, text);
  if (error) return appError(error, 409);
  const session = getAuthSession(machineId)!;
  return appJson(authView(session));
}

async function postCancel(req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const machineId = typeof body.machine_id === "string" ? body.machine_id.trim() : "";
  if (!machineId) return appError("machine_id is required");
  const session = cancelAuthSession(machineId);
  if (!session) return appError("no sign-in has been started on this machine from this app", 404);
  return appJson(authView(session));
}

async function postCheck(req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const machineId = typeof body.machine_id === "string" ? body.machine_id.trim() : "";
  if (!machineId) return appError("machine_id is required");
  const flow = flowById(typeof body.flow === "string" ? body.flow.trim() : "");
  if (!flow) return appError(`no such sign-in flow - this app knows ${AUTH_FLOWS.map((entry) => entry.id).join(", ")}`, 404);
  const record = await findMachine(machineId);
  if (!record) return appError(`no machine ${machineId} in this app's registry - add it in Settings > Machines first`, 404);
  const answer = await probeSignedIn(record, flow);
  const response: AuthProbeResponse = {
    machine_id: record.id,
    machine_name: record.name,
    flow: flow.id,
    signed_in: answer.signed_in,
    detail: answer.detail,
    checked_at: new Date().toISOString(),
  };
  return appJson(response);
}

export function authSessionRoutes(token: string, selfOrigins: ReadonlySet<string>) {
  return {
    "/api/app/auth-session": { GET: appSafely(getSession) },
    "/api/app/auth-session/start": { POST: csrfGuard(token, selfOrigins, postStart) },
    "/api/app/auth-session/input": { POST: csrfGuard(token, selfOrigins, postInput) },
    "/api/app/auth-session/cancel": { POST: csrfGuard(token, selfOrigins, postCancel) },
    "/api/app/auth-session/check": { POST: csrfGuard(token, selfOrigins, postCheck) },
  };
}
