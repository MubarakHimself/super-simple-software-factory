# T3 Code — codebase study

**What this is.** A standalone, code-grounded description of how T3 Code is built: its product
shape, its architecture, every feature it ships and the mechanism behind it, and the concrete
values of its UI design system. It is written so a reader who never opens the T3 repository can
work from it directly.

**Source.** `github.com/pingdotgg/t3code`, MIT. Full clone read at commit **`9e201941`**
(`9e201941aaa9cfece3e0ffaa4cc24bbe880d1be4`), which reports version **0.0.33** in
`apps/desktop/package.json`, `apps/server/package.json`, `apps/web/package.json`,
`packages/contracts/package.json`.

**Study date.** 2026-08-13.

**Method.** A workflow of parallel code readers, one per area (design system, orchestration and
provider runtime, composer, timeline and markdown, subagents, git/worktrees/checkpointing,
terminals, workspace files, MCP/preview automation, usage and limits, connections and auth,
environments and connectivity, agent-awareness push, desktop shell, settings/health/distribution),
each reading source files in the clone and recording claims with repo-relative file and line
citations plus an explicit list of what it could not verify. This document merges and reorganises
those notes by feature. Every value quoted below — colour, size, constant, string — is quoted from
code; nothing is estimated. Where a claim rests on reading rather than running, or where a reader
did not finish a file, it appears in the honest-gaps appendix at the end.

**Cross-check.** The existing video teardown at `docs/research/t3code-ui-notes.md` (a frame-by-frame
read of v0.0.31 from the outside) was checked against the code. Where they disagree, the code wins;
the disagreements are listed in "Where the video teardown was wrong or stale".

---

## 1. What T3 Code is

### 1.1 Product shape

T3 Code calls itself an "agent harness control surface" (`README.md`). It is not a model client and
not an editor. It drives **agent CLIs that are already installed and authenticated on your machine**
— Codex, Claude Code, Cursor, Grok Build, OpenCode — and gives them a supervisory shell: threads,
git worktrees, per-turn checkpoints and diffs, terminals, a file browser and editor, a browser
preview the agent can also drive, and a mobile app that can watch and steer runs from a phone.

Three clients ship: an Electron desktop app (`apps/desktop`), a web app (`apps/web`, also served by
the CLI and hosted at `app.t3.codes`), and a React Native/Expo mobile app (`apps/mobile`, iOS and
Android). All three are clients of the same server.

Installation is `npx t3@latest` (server + local web app), or the desktop app from GitHub Releases,
`winget install T3Tools.T3Code`, `brew install --cask t3-code`, `yay -S t3code-bin` (`README.md`).

### 1.2 The environment-vs-client architecture

This is the single structural idea the whole codebase is organised around, and
`docs/internals/remote.md` states it as the invariant:

- An **ExecutionEnvironment** is one running `t3` server process. It owns everything expensive and
  stateful: the orchestration event log, the provider CLI child processes, git, terminals, the
  filesystem index, and auth. Its identity is a stable `environmentId` — a UUID generated on first
  boot and persisted as a single trimmed line at `<stateDir>/environment-id`
  (`apps/server/src/environment/ServerEnvironment.ts:73-124`).
- A **client** (web, desktop renderer, mobile) talks HTTP plus **one authenticated WebSocket** to an
  environment. Clients hold UI state and nothing else authoritative.
- "Remote" is never a different runtime shape. It is only a different way of *reaching* the same
  server. Direct pairing, Tailscale, desktop-managed SSH, and the T3 Connect relay all converge on
  the same value — `{httpBaseUrl, socketUrl, httpAuthorization, environmentId, label}` — which is fed
  into one `ConnectionDriver` (`packages/client-runtime/src/connection/driver.ts`).
- **A client can be attached to several environments at once.** The Usage page, the environment
  picker in the composer's branch strip, and the connection registry are all built around a list of
  environments, not a single one.

The server is one Node process written in **Effect** (services as `Context.Service`, wiring as
`Layer`s) with a single SQLite database. Every state change funnels through one totally-ordered
command queue (§2.1). The typed RPC surface — one `RpcGroup` served at `GET /ws` — is declared once
in `packages/contracts` and shared verbatim by server and all clients.

### 1.3 Monorepo layout

pnpm workspace (`pnpm-workspace.yaml`: `apps/*`, `infra/*`, `oxlint-plugin-t3code`, `packages/*`,
`scripts`), Vite / Vite+ (`vp`) tooling, TypeScript throughout.

**Apps**

| Path | Role |
|---|---|
| `apps/server` | The ExecutionEnvironment. Orchestration engine, decider/projector, provider drivers, git/VCS, terminals, workspace index, MCP server, auth, cloud/relay client, CLI (`t3 serve`, `t3 connect`, `t3 auth pairing`), SQLite persistence with 40 migrations. |
| `apps/web` | The React 19 client bundle. Served by the CLI, by the hosted web app, and by the desktop shell through a custom protocol. Contains all visible app chrome: sidebar, chat timeline, composer, right panel, terminal renderer, file browser/editor, settings, theme engine. |
| `apps/desktop` | Electron 41 main process, written in Effect. Window chrome, custom `t3code://app` protocol, backend supervision, native menus, auto-update, SSH/WSL/Tailscale plumbing, `<webview>` browser preview + CDP automation. |
| `apps/mobile` | Expo / React Native client (iOS + Android). Its own design tokens, its own timeline derivation, a native Objective-C++ markdown renderer, native terminal modules, push notifications and iOS Live Activities. |
| `apps/marketing` | Astro 7 marketing site (`@t3tools/marketing`, private, version 0.0.0). |

**Packages**

| Path | Role |
|---|---|
| `packages/contracts` | The single source of truth for every wire shape: orchestration commands/events, RPC group and method names, provider runtime events, settings, keybindings, terminal, project/workspace, usage, preview automation, relay API, and the Electron `DesktopBridge` IPC interface. All Effect `Schema`. |
| `packages/client-runtime` | Shared client engine used identically by web and mobile: connection registry/supervisor/driver/resolver, authorization (bearer + DPoP), relay client, RPC atom families, thread reducer, subagent fold, operations/commands. |
| `packages/shared` | Framework-free logic shared by server and clients: composer token grammar, search ranking, keybinding parser, agent-awareness projection, DPoP, relay JWT/signing, usage merge and formatting, `DrainableWorker`, `KeyedCoalescingWorker`, chat-list math, terminal labels. |
| `packages/effect-acp` | Agent Client Protocol client over stdio (used by the Cursor and Grok drivers). |
| `packages/effect-codex-app-server` | JSON-RPC client for `codex app-server` over a spawned child process's stdio. |
| `packages/ssh` | `SshEnvironmentManager`: remote launch script, port forwarding, auth prompting. |
| `packages/tailscale` | Wrapper around the `tailscale` CLI (`status --json`, `serve`). |
| `oxlint-plugin-t3code` | Four repo-local lint rules (node imports, Effect runtime, Schema compilation). No design-system rules. |

**Other**

| Path | Role |
|---|---|
| `infra/relay` | A **separate deployable**: `t3code-relay`, a Cloudflare Worker with Postgres (Hyperdrive), Cloudflare Queues, Alchemy IaC. Brokers credentials, provisions Cloudflare Tunnels, and fans agent-activity out to APNs. |
| `native/libghostty-vt` | Pinned upstream Ghostty revision (`VERSION` = `9f62873bf195e4d8a762d768a1405a5f2f7b1697`) plus the C headers, shared by the web WASM build and the Android JNI build. |
| `native/resource-monitor` | Rust binary `t3-resource-monitor`, built per target triple in CI and bundled into the npm package for CPU/RSS diagnostics. |
| `experiments/messages-glass-lab` | A native Xcode project used as a glass/material lab. Not shipped. |
| `scripts/` | Release and build tooling: `build-desktop-artifact.ts`, `merge-update-manifests.ts`, `dev-runner.ts`, mobile static checks, Discord release announcer. |
| `patches/` | Three load-bearing patches: `@pierre/diffs@1.3.0-beta.10` (85 lines — see §11), `@legendapp/list@3.3.5`, `@ff-labs/fff-node@0.9.4`. |

---

## 2. Feature: running an agent turn (the orchestration core)

Everything the product does to a thread passes through one event-sourced loop. This section is the
substrate for every feature below it.

### 2.1 One command queue, one decider, two projections

`OrchestrationEngine` (`apps/server/src/orchestration/Layers/OrchestrationEngine.ts`, 343 lines) is
a `Queue.unbounded<CommandEnvelope>()` plus a single `Effect.forever(Queue.take ⇒ processEnvelope)`
fiber forked once at layer construction (line 304). **All commands are processed strictly one at a
time**, which is what makes an in-memory read model safe to mutate without locks. `dispatch(command)`
offers an envelope carrying a `Deferred` and awaits it, so callers get request/response semantics
over what is internally a queue.

`decideOrchestrationCommand` (`apps/server/src/orchestration/decider.ts`, 1402 lines) is a pure
function `{command, readModel} → event | event[]`. It validates invariants against the in-memory read
model (`commandInvariants.ts`), stamps each event with a fresh `eventId`, `commandId`,
`correlationId = commandId`, and `causationEventId`, and can emit several events for one command —
`thread.turn.start` (decider.ts:914-1025) emits optional `thread.unsettled`/`thread.unsnoozed`
lifecycle-reset events, then `thread.message-sent`, then `thread.turn-start-requested`.

The decider is **idempotent by re-emission**: `thread.settle` on an already-settled thread re-emits
the same `settledAt`/`updatedAt` so a duplicate command becomes a no-op when projected
(decider.ts:494-511). The same pattern recurs for unsettle/snooze/unsnooze/pin/unpin/pin-reorder.

There are **two independent projections of the same event stream**, easy to miss:

1. `apps/server/src/orchestration/projector.ts` (806 lines) — a pure synchronous reducer,
   **in-memory only**, held as a closure variable inside the engine and rebuilt at boot by replaying
   the event store. This is what the *decider* reads.
2. `OrchestrationProjectionPipeline` (`Layers/ProjectionPipeline.ts`) — writes **9 SQL projection
   tables**: `projection.projects`, `.threads`, `.thread-messages`, `.thread-proposed-plans`,
   `.thread-activities`, `.thread-sessions`, `.thread-turns`, `.checkpoints`, `.pending-approvals`
   (`ORCHESTRATION_PROJECTOR_NAMES`, ProjectionPipeline.ts:58-68). This is what every *read* — RPC
   handlers, both reactors — actually queries.

Both run back to back inside the same SQL transaction (OrchestrationEngine.ts:176-179). There is no
shared reducer between them; each independently switches on `event.type` and independently re-derives
things like pending-approval counts (`derivePendingUserInputCountFromActivities`,
ProjectionPipeline.ts:133-177).

**One transaction per command.** `eventStore.append` (assigns `sequence`), the in-memory fold, the
SQL projection write, and the command receipt (`accepted`, `resultSequence`) all commit together
(OrchestrationEngine.ts:169-213). Events are published on `PubSub.unbounded<OrchestrationEvent>()`
**only after commit** (lines 215-230), so no subscriber can observe a non-durable event.

**Idempotency** is a table, not a retry policy. `orchestration_command_receipts` (Migration 002,
`command_id TEXT PRIMARY KEY`) is consulted before deciding: an existing `"accepted"` receipt
short-circuits to the previously-committed sequence; an existing `"rejected"` receipt fails fast with
`OrchestrationCommandPreviouslyRejectedError` and is *not* retried against fresh state
(lines 138-151). Only `OrchestrationCommandInvariantError`s get a `"rejected"` receipt written — a
`SqlError` does not, so a genuine retry is not blocked by a permanent-looking rejection.

**Failure reconciliation** (lines 113-126, 259-297): if the transaction fails after some events might
have landed, the engine re-reads the event store from the dispatch-start sequence and re-folds
whatever did land, so the in-memory model cannot drift from the DB.

`streamDomainEvents` and `providerService.streamEvents` are **cold per subscription** —
`Stream.fromPubSub` is called freshly for every read (OrchestrationEngine.ts:326-331,
ProviderService.ts:1139-1144) — so every consumer (ws server, `ProviderRuntimeIngestion`,
`ProviderCommandReactor`, `CheckpointReactor`) sees every event rather than competing for them.

### 2.2 Persistence

One SQLite database. `apps/server/src/persistence/NodeSqliteClient.ts` is a **hand-rolled port of
`@effect/sql-sqlite-node` that swaps `better-sqlite3` for Node's native `node:sqlite`**, asserting
Node ≥22.16, ≥23.11, or ≥24 at connection time (`checkNodeSqliteCompat`, lines 77-92) because it
depends on `StatementSync.columns()`. Writes serialize through a `Semaphore.make(1)`; there is no
connection pool.

`orchestration_events` (Migration 001) is the append-only log: `sequence INTEGER PRIMARY KEY
AUTOINCREMENT` is the single global cursor, and `(aggregate_kind, stream_id, stream_version)` is a
separate unique index giving per-aggregate versioning. **`actor_kind` (`client`/`server`/`provider`)
is not a structural field on the command** — it is inferred at persistence time from the `commandId`
string prefix (`inferActorKind`, NodeSqliteClient.ts:70-90: `provider:` / `server:` prefixes, else
metadata hints, else `client`).

40 sequentially numbered migrations run automatically at boot via `effect/unstable/sql/Migrator`; no
down-migrations. Migrations 033-038 added `settled`/`snoozed`/`pinned`/`pinOrderKey` to
`projection_threads`, i.e. thread-inbox state is a late addition.

Bounded retention lives in the projector: `MAX_THREAD_MESSAGES = 2_000`,
`MAX_THREAD_CHECKPOINTS = 500`, proposed plans capped at 200, activities capped at 500
(projector.ts:39-40, 636, 791).

### 2.3 The RPC boundary

`packages/contracts/src/rpc.ts` assembles one Effect `RpcGroup` (`WsRpcGroup`) served at `GET /ws`
(`apps/server/src/ws.ts`). Members are unary or server-streamed. The orchestration surface
(`ORCHESTRATION_WS_METHODS`, `packages/contracts/src/orchestration.ts:26-35`) is:

- `orchestration.dispatchCommand` — the **single write entrypoint**.
- `orchestration.subscribeShell` / `orchestration.subscribeThread` — server-streamed reads. A client
  subscribes to exactly the thread list or the one thread it is looking at.
- `orchestration.getWorkflowScript`, `getTurnDiff`, `getFullThreadDiff`, `searchThreads`,
  `getArchivedShellSnapshot` — unary reads.

**Authorization is per method and compiler-enforced.** `RPC_REQUIRED_SCOPES`
(`apps/server/src/auth/RpcAuthorization.ts:23-126`) is a `satisfies Record<WsRpcMethod,
AuthEnvironmentScope>`, so adding an RPC without picking a scope is a compile error; a test also
asserts the map covers every key in `WsRpcGroup.requests` (`RpcAuthorization.test.ts:15`). Holding a
valid socket is necessary but not sufficient — every call is re-authorized against
`currentSession.scopes` captured at handshake (`ws.ts:420-472`).

Not every command constructor is client-dispatchable. The client-facing provider subset is
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, `thread.session.stop`,
`thread.runtime-mode.set`, `thread.interaction-mode.set`. Everything else that touches provider state
(`thread.message.assistant.delta`, `thread.session.set`, `thread.turn.diff.complete`, …) is
server-internal, produced only by the reactors.

The engine is a plain Effect service, not RPC-only: `apps/server/src/cli/project.ts:428` and
`serverRuntimeStartup.ts` dispatch in-process, so headless/CLI usage bypasses the WebSocket entirely.

### 2.4 Transport shaping

`apps/server/src/ws.ts`:

- `isThreadDetailEvent` (`:273-291`) — only `thread.message-sent`, `thread.proposed-plan-upserted`,
  `thread.activity-appended`, `thread.turn-diff-completed`, `thread.reverted`, `thread.session-set`
  reach a thread subscription.
- The **shell** stream coalesces: `coalesceShellEvents` (`:683-704`) keeps only the latest event per
  aggregate within `SHELL_COALESCE_WINDOW = Duration.millis(50)` / `SHELL_COALESCE_MAX_CHUNK = 512`,
  so a burst of streaming deltas for one thread collapses into a single sidebar refetch. The thread
  detail stream is **not** coalesced.
- Resume: a cursor more than `SHELL_RESUME_MAX_GAP` / `THREAD_RESUME_MAX_GAP = 1_000` events behind
  gets a fresh snapshot instead of a replay.

### 2.5 Shared async primitive

`packages/shared/src/DrainableWorker.ts` (71 lines) backs `ProviderRuntimeIngestion`,
`ProviderCommandReactor`, `CheckpointReactor`, the thread-title regeneration sub-worker, and the
agent-awareness relay publisher. It pairs a `TxQueue.unbounded` with a `TxRef<number>`
outstanding-count updated transactionally. Its `drain` is explicitly a **test-only** synchronisation
primitive ("lets a test await 'queue empty and current item finished' instead of sleeping"), not
production backpressure.

Related and worth knowing: `RuntimeReceiptBus` emits typed milestone signals
(`checkpoint.baseline.captured`, `turn.processing.quiesced`, …) — and **the production
`RuntimeReceiptBusLive.publish` is a documented no-op**. Only the test layer is PubSub-backed. Both
`docs/internals/overview.md` and the glossary say "do not build production behavior on receipts."

---

## 3. Feature: five agent CLIs behind one interface

### 3.1 Instances, not drivers

The routing key everywhere is a **`ProviderInstanceId`** — a user-defined slug such as
`codex_personal` — not a driver kind. `ProviderInstanceRegistry` keys configured instances by that
id, decodes each entry's config with its driver's schema, opens a child scope, and calls
`driver.create(...)`; `ProviderAdapterRegistry` resolves `instanceId → live adapter`. This is what
lets two Codex instances with different `homePath` (`CODEX_HOME`) run as fully independent processes
with independent credentials and environments. The wire carries **one `ServerProvider` snapshot per
configured instance**, not per driver.

`subscribedAdapters` (`ProviderService.ts:311-349`) is reconciled whenever the registry's instance
list changes; new instances get a forked `Stream.runForEach(adapter.streamEvents, …)`, and torn-down
instances' fibers exit on their own because the adapter's stream terminates with its scope — no
unsubscribe bookkeeping.

### 3.2 Four transports, one event union

`apps/server/src/provider/builtInDrivers.ts` lists `BUILT_IN_DRIVERS`: `CodexDriver`, `ClaudeDriver`,
`CursorDriver`, `GrokDriver`, `OpenCodeDriver` (kinds `codex`, `claudeAgent`, `cursor`, `grok`,
`opencode`). Each `create()` returns a `ProviderInstance` bundling a live `snapshot` (health/version),
an `adapter` implementing `ProviderAdapterShape` (`startSession`, `sendTurn`, `interruptTurn`,
`respondToRequest`, `respondToUserInput`, `stopSession`, `readThread`, `rollbackThread`,
`streamEvents`), and sometimes a `textGeneration` one-shot helper.

| Driver | Transport | Package |
|---|---|---|
| Codex | spawns `<binaryPath> app-server` as a **child process per thread session**, JSON-RPC over its stdio | `packages/effect-codex-app-server` |
| Claude | wraps `@anthropic-ai/claude-agent-sdk`'s `query()` — an in-process SDK that itself manages a `claude` CLI subprocess (`pathToClaudeCodeExecutable`); resume via `{resume: sessionId, resumeSessionAt: lastAssistantUuid}` | vendor dependency, not an in-repo package |
| Cursor | Agent Client Protocol over stdio, launching the vendor CLI's `agent acp` subcommand | `packages/effect-acp` |
| Grok | ACP over stdio, same shared runtime as Cursor, plus xAI extension handling (`GrokAcpSupport.ts`, `XAiAcpExtension`) | `packages/effect-acp` |
| OpenCode | HTTP to a **local OpenCode server process** the runtime starts and owns (`OpenCodeRuntime`, `baseUrl: server.url`) | in-repo `provider/opencodeRuntime.ts` + OpenCode SDK |

Every adapter normalises its vendor protocol into one canonical `ProviderRuntimeEvent` union
(`packages/contracts`) before anything reaches `ProviderService` or the orchestration layer. That
normalisation step is the entire answer to "how do five different CLIs look like one thing".

`CodexDriverEnv`/`ClaudeDriverEnv`/etc. union into `BuiltInDriversEnv` (`builtInDrivers.ts:35-40`), so
the concrete runtime layer must satisfy the union of every driver's requirements even though only one
driver serves a given call.

### 3.3 Sessions, binding, and recovery

`ProviderSessionDirectory` persists `threadId → {provider, providerInstanceId, runtimeMode, status,
resumeCursor, runtimePayload}` in table `provider_session_runtime`
(`persistence/ProviderSessionRuntime.ts`, Migrations 004, 009, 027). `resumeCursor` is an opaque
per-provider blob (session id plus a provider-specific position marker) and is what lets a restarted
server, or a client reconnecting days later, resume the exact same provider-side conversation.

`recoverSessionForThread` (`ProviderService.ts:358-441`): when a routed call finds no live adapter
session but a persisted binding with a `resumeCursor`, it calls `adapter.startSession` with that
cursor. With no persisted resume state it fails with a validation error rather than silently starting
a new conversation. `stopStaleSessionsForThread` (lines 493-526) stops a prior session on another
instance — a thread can have only one live provider session at a time.

Mid-thread model switching is validated: some providers declare `requiresNewThreadForModelChange`, and
`rejectStartedThreadModelChangeIfRequired` (`ProviderCommandReactor.ts:449-479`) rejects the switch
with a message telling the user to start a new thread.

Every state-changing method is metered with OTel-style counters and timers: `providerSessionsTotal`,
`providerTurnsTotal`, `providerTurnDuration`, `providerRuntimeEventsTotal`.

### 3.4 The two reactors

**`ProviderCommandReactor`** (1453 lines) subscribes to `streamDomainEvents` and reacts to a fixed set
of intent events (`ProviderIntentEvent`, lines 51-63): `thread.meta-updated` (only when
`regenerateTitle === true`), `thread.runtime-mode-set`, `thread.turn-start-requested`,
`thread.turn-interrupt-requested`, `thread.approval-response-requested`,
`thread.user-input-response-requested`, `thread.session-stop-requested`. Each is enqueued onto a
`DrainableWorker` rather than processed inline. It also:

- de-dups turn starts through `handledTurnStartKeys` (`Cache.make`, 30-minute TTL, key
  `command:<commandId>` else `event:<eventId>`);
- runs **thread-title regeneration** on a second, separate worker, feeding recent thread context to
  `TextGeneration` with an explicit character budget (lines 96-213);
- turns provider failures into visible `thread.activity.append` commands with `tone: "error"`
  (`appendProviderFailureActivity`, lines 341-379), so a provider call failure appears in the timeline
  the same way an approval request does;
- string-matches the adapter's error detail to detect "unknown/stale pending approval or user-input
  request" (lines 249-281), which is how a resumed session with no memory of a mid-flight approval
  callback clears its blocking state instead of wedging forever.

**`ProviderRuntimeIngestion`** (2071 lines, the largest file read) subscribes to *two* streams:
`providerService.streamEvents`, and `streamDomainEvents` filtered to `thread.turn-start-requested`
(the latter is currently a documented no-op hook, line 2023). Its mechanisms appear where they are
visible: buffered assistant delivery and activity translation in §5, subagent stamping in §7,
checkpoint placeholders in §8.

One defensive mechanism belongs here: **`STRICT_PROVIDER_LIFECYCLE_GUARD`** (env var
`T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD`, default **on**, line 100) is an accept/reject state machine
(lines 1515-1546) that refuses a provider lifecycle event conflicting with the tracked active turn —
e.g. a `turn.completed` for a turn that is not the active one, or a `turn.started` conflicting with
the active turn *unless* it matches a server-pending turn start. The named exception: steering a
running turn makes OpenCode open a new turn without ever completing the superseded one.

### 3.5 Failure handling

- **No automatic retry inside the server** for command dispatch; idempotency comes from the receipt
  table, so a *client-initiated* retry with the same `commandId` is safe.
- **No visible automatic reconnect or respawn loop for a provider CLI process that dies mid-session**
  was found. A session leaving `running` surfaces as `thread.session.set{status: "error"|"stopped"}`
  plus a `lastError` string; recovery is user-initiated — the next turn triggers
  `ensureSessionForThread` → `recoverSessionForThread`.
- `RpcSessionFactory` "performs one attempt and does not retry" (`docs/internals/overview.md:48`);
  retry is entirely the client-side supervisor's job (§13).

### 3.6 Skills and slash commands

Each `ServerProvider` snapshot carries `slashCommands[]` and `skills[]`.
`ServerProviderSkill = {name, description?, path, scope?, enabled, displayName?, shortDescription?}`
(`packages/contracts/src/server.ts:88-97`). Discovery differs per provider:

- **Claude** — the server reads the filesystem directly
  (`apps/server/src/provider/Drivers/ClaudeSkills.ts`): `<configDir>/skills` (scope `user`) and
  `<cwd>/.claude/skills` (scope `project`), one directory per skill containing **`SKILL.md`** with
  YAML frontmatter (`FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/`, parsed by the `yaml`
  package). Malformed frontmatter is skipped; project scope wins name collisions. The module comment
  explains why the filesystem rather than the CLI: "The Agent SDK init handshake surfaces skills only
  as slash commands without their filesystem paths."
- **Codex** — an app-server JSON-RPC request `skills/list`
  (`apps/server/src/provider/Layers/CodexProvider.ts:398-414`), parsed by
  `parseCodexSkillsListResponse`, preferring the entry whose `cwd` matches.

`formatProviderSkillInstallSource` (`providerSkillPresentation.ts`) produces the right-aligned source
tag in the menu: a path containing `/.codex/plugins/` or `/.agents/plugins/` → **"App"**; scope
`system` → "System"; `project|workspace|local` → "Project"; `user|personal` → "Personal".

---

## 4. Feature: the composer

The composer is where a turn is written and configured. It is a **controlled Lexical plain-text
editor whose value is a plain string**, held in a persisted Zustand store and keyed by either a
`ScopedThreadRef` (a real server thread) or a `DraftId` (a pre-thread draft session).

### 4.1 The prompt is a string, not a document

Three token syntaxes are embedded *in that string*
(`packages/shared/src/composerInlineTokens.ts`, shared with mobile):

```
SKILL_TOKEN_REGEX     = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s)/g
MENTION_TOKEN_REGEX   = /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s@"]+))(?=\s)/g
FILE_LINK_TOKEN_REGEX = (^|\s)\[label{0,512}\]\((dest)\)(?=\s)
```

- an `@`-mention serialises to a literal markdown file link,
  `serializeComposerFileLink(path)` = `` `[${escapedBasename}](${encodeURI(path)})` `` with
  `( ) # ? ` percent-escaped (`packages/shared/src/composerTrigger.ts`);
- a skill is a literal `$skill-name`;
- a terminal-context snippet is a single `U+FFFC` OBJECT REPLACEMENT CHARACTER.

Defences in that file: the markdown-link label body is bounded at
`MAX_FILE_LINK_LABEL_LENGTH = 512` explicitly to avoid quadratic backtracking on input like
`" [[[[["`; a link only counts as a mention if `label === basename(path)`, so ordinary markdown links
in a prompt are not hijacked; `SCOPED_PACKAGE_REFERENCE_REGEX` keeps bare `@scope/package` text from
reading as a file mention.

Lexical is used purely as a **chip renderer over that string**. Three `DecoratorNode`s
(`ComposerPromptEditor.tsx`) — `ComposerMentionNode` (`composer-mention`), `ComposerSkillNode`
(`composer-skill`), `ComposerTerminalContextNode` (`composer-terminal-context`) — each return the raw
source from `getTextContent()`, so `$getRoot().getTextContent()` round-trips the prompt byte for
byte. All three are `isInline() → true`, `updateDOM() → false`, and their host `<span>` carries
`class="composer-inline-chip relative inline-flex align-[-0.125em] leading-none"`.

### 4.2 The dual cursor coordinate system

Because a chip is one visual glyph but N raw characters, `composer-logic.ts` exports a pair of
bijections used by every keyboard, selection, and replacement path:
`expandCollapsedComposerCursor(text, cursor)` (visual → raw, lines 52-99),
`collapseExpandedComposerCursor` (raw → visual, lines 140-193), `clampCollapsedComposerCursor`,
`isCollapsedCursorAdjacentToInlineToken`. `ComposerPromptEditor`'s `onChange` signature ships **both**
numbers: `(nextValue, nextCursor /*collapsed*/, expandedCursor, cursorAdjacentToMention,
terminalContextIds)` (`ComposerPromptEditor.tsx:888-894`). Trigger detection always runs on the
expanded cursor; menu positioning and `focusAt()` use the collapsed one. Lexical's offset walk is
reimplemented twice, once per coordinate space (`getComposerNodeTextLength` /
`getComposerNodeExpandedTextLength`, lines 531-563; `getAbsoluteOffsetForPoint` /
`getExpandedAbsoluteOffsetForPoint`, lines 565-651).

### 4.3 Eight custom Lexical plugins

The editor mounts `PlainTextPlugin` (never RichText), `OnChangePlugin`, `HistoryPlugin`,
`LexicalErrorBoundary`, plus:

1. **`ComposerCommandKeyPlugin`** — `KEY_ARROW_DOWN/UP/ENTER/TAB` at `COMMAND_PRIORITY_HIGH`,
   forwarded to the menu. IME guard: `Enter` while `event.isComposing || event.keyCode === 229` is
   swallowed.
2. **`ComposerInlineTokenArrowPlugin`** — arrows adjacent to a chip jump the whole chip in one press.
3. **`ComposerHomeEndKeyPlugin`** — macOS only; Home/End reimplemented with
   `window.getSelection().modify(move|extend, backward|forward, "lineboundary")` then re-synced via
   `$createRangeSelectionFromDom`.
4. **`ComposerInlineTokenSelectionNormalizePlugin`** — a caret landing inside a decorator is bumped to
   the far side in a `queueMicrotask`.
5. **`ComposerInlineTokenBackspacePlugin`** — Backspace deletes a whole chip; for a terminal-context
   chip it also calls `onRemoveTerminalContext(contextId)` so the draft store drops the context too.
6. **`ComposerChipSelectionPlugin`** — browsers will not paint native selection over
   `contentEditable={false}` decorators, so the range selection is mirrored onto chips as
   `data-composer-chip-selected="true"`, with explicit `FOCUS_COMMAND`/`BLUR_COMMAND` bookkeeping
   because Lexical retains the selection on blur.
7. **`ComposerInlineTokenPastePlugin`** — on `PASTE_COMMAND`, plain text is scanned with
   `collectComposerInlineTokens(text + "\n")` (the virtual newline lets a trailing mention parse) and
   mentions are inserted as real nodes rather than literal markdown.
8. **`ComposerSurroundSelectionPlugin`** (lines 1262-1526, the largest) — with a non-empty selection,
   typing one of `( [ { ' " " ` < « * _` (`SURROUND_SYMBOLS`) wraps rather than replaces. Implemented
   on raw DOM `keydown` / capture-phase `beforeinput` / `input` / `compositionend` via
   `editor.registerRootListener`, with a **dedicated dead-key path**: on layouts where `` ` `` is a
   dead key the browser emits `insertCompositionText`, so the pending selection is stashed and
   re-applied in a `queueMicrotask` + `editor.update(…, {tag: HISTORY_MERGE_TAG})` after verifying the
   document matches the expected post-dead-key value. Wrapping is refused when the selection touches a
   chip or a mention's whitespace boundary.

Controlled sync (`useLayoutEffect`, lines 1574-1617) compares incoming `value` / `cursor` /
`terminalContextSignature` / `skillSignature` (cheap `\u001f`/`\u001e`-joined digests) and rewrites
the whole editor state when they differ, guarded by `isApplyingControlledUpdateRef` so the resulting
`OnChangePlugin` callback does not echo back. A cursor-only change is applied **only when the editor
is focused** (line 1599).

### 4.4 Draft storage

`composerDraftStore.ts` (3767 lines) is Zustand + `persist` + `createJSONStorage`, localStorage key
**`t3code:composer-drafts:v1`**, schema `version: 8` with a migration chain walking legacy shapes.
Writes go through `createDebouncedStorage(localStorage, 300ms)`
(`COMPOSER_PERSIST_DEBOUNCE_MS = 300`) with a `beforeunload` flush. Every persisted shape is an
**Effect `Schema`**, not zod.

The store models two domains at once: `draftsByThreadKey` (editable payload) and
`draftThreadsByThreadKey` (pre-thread *session* metadata: environmentId, projectId, branch,
worktreePath, `envMode: "local"|"worktree"`, `startFromOrigin`, `promotedTo`), plus
`logicalProjectDraftThreadKeyByLogicalProjectKey` ("which draft session is the current new-thread
draft for this project").

`partializeComposerDraftStoreState` garbage-collects: a draft session persists only if it is mapped to
a project, promoting mid-send, or holds real user content, and a composer blob keyed to a dropped
session is dropped with it. **Terminal contexts are persisted without their `text`** — the snippet is
re-derived from the live terminal, and an empty one is "expired" at send time. **Element contexts are
persisted whole** "because — unlike terminal contexts — there's no live session to re-derive the
snapshot from on reload".

Image attachments get two-phase persistence *with verification*: an effect reads every `File` to a
data URL and calls `syncPersistedAttachments`; the store then flushes the debounced write, **re-reads
localStorage and diffs** to compute `nonPersistedImageIds` (`verifyPersistedAttachments`, lines
2083-2131). Any image whose id did not survive the quota gets an amber `CircleAlertIcon` badge with
the tooltip "Draft attachment could not be saved locally and may be lost on navigation".

### 4.5 Trigger menu: `@`, `/`, `$`

`detectComposerTrigger(text, cursor)` (`composer-logic.ts:225-263`): if the current **line prefix**
matches `/^\/(\S*)$/` it is a `slash-command` trigger spanning the line prefix (so `/` only opens a
menu at line start); otherwise it walks back to the token start (whitespace **or `U+FFFC`** counts as
a boundary) and returns `skill` for `$…`, `path` for `@…`, else `null`.

Item sources (`ChatComposer.tsx:1027-1106`):

- **path** — `useComposerPathSearch` → RPC `projects.searchEntries` with
  `COMPOSER_PATH_SEARCH_LIMIT = 80` and a 120 ms debounce, `staleTimeMs: 15_000`, gated by
  `AuthOrchestrationReadScope`;
- **slash-command** — `/model` always, plus `/plan` and `/default` only when
  `settings.planModeEnabled` (a Settings → Beta flag; the code calls plan mode "a legacy feature");
- **provider-slash-command** — `selectedProviderStatus?.slashCommands ?? []`, i.e. the selected
  *instance's* snapshot;
- **skill** — `searchProviderSkills(selectedProviderStatus?.skills ?? [], query)`; only
  `skill.enabled` skills are offered.

Ranking uses `@t3tools/shared/searchRanking` with **lower-is-better tiers**: for a skill, name
exact/prefix/boundary/includes = 0/2/4/6 and fuzzy = 100; display label 1/3/5/7, fuzzy 110;
shortDescription 20/22/24/26; description 30/32/34/36; scope 40/42/44. `Math.min` of all fields wins;
ties break on `${label}\u0000${name}`. `normalizeSearchQuery` strips the leading sigil
(`/^\$+/` for skills, `/^\/+/` for slash commands).

Selection replaces the trigger range with `` `${serializeComposerFileLink(path)} ` `` /
`` `/${name} ` `` / `` `$${name} ` ``, or with `""` plus a side effect for `/model`, `/plan`,
`/default`. Two guards: `composerSelectLockRef` swallows a duplicate selection within the same
animation frame (click + Enter double-fire), and **`applyPromptReplacement` takes an `expectedText`
and refuses the edit if the text under the range changed** — an optimistic-concurrency check against
the editor having moved on.

The menu is **portalled to `document.body`** at `position: fixed; z-index: 70`, anchored above the
composer (`bottom = innerHeight - rect.top + 8`, `left = rect.left`, `width = rect.width`,
`maxHeight = max(96, rect.top - 24)`). It re-measures on `resize`, capture-phase `scroll`, **and a
`ResizeObserver` attached to the anchor and every ancestor** — because the composer is centered and
max-width capped, so opening a side panel slides it without resizing it.

Keyboard: Shift+Tab toggles plan mode; ArrowUp/Down move the highlight with wraparound; Enter/Tab
select; otherwise Enter submits when `shouldSubmitComposerOnEnter({isMobileViewport, shiftKey})` —
i.e. **Enter never submits on a mobile viewport**, decided by one three-line pure function
(`composer-logic.ts:14-19`).

### 4.6 Model, traits, permission

**Instance resolution** is a 5-step chain (`ChatComposer.tsx:772-819`): the draft's `activeProvider`
(the user's unsaved pick, which "must win, otherwise the UI appears to ignore picker selections") →
`activeThread.session.providerInstanceId` → the thread's saved model selection → the project default →
the first enabled+available entry of the requested driver kind, then any compatible entry, then
`NO_PROVIDER_MODEL_SELECTION` (instance id `t3code_no_provider`, which "must never be persisted or
dispatched"). Every candidate must be `enabled && isAvailable` and is skipped if it violates
`lockedProvider` (the driver that already served this thread) or `lockedContinuationGroupKey`.

Model list per instance = the instance's own `entry.models` plus that instance's
`providerInstances[id].config.customModels` (falling back to the legacy kind-level `customModels`
**only for default instances**, so one custom model on `claude_openrouter` cannot leak onto stock
`claudeAgent`), filtered by `hiddenModels` and ordered by `modelOrder`. Custom slugs are capped at
`MAX_CUSTOM_MODEL_COUNT = 32`, `MAX_CUSTOM_MODEL_LENGTH = 256`.

`ModelPickerContent.tsx` (799 lines) is a two-pane surface:
`dropdown-glass model-picker-surface relative flex h-screen max-h-86.5 w-screen max-w-90 flex-row
overflow-hidden rounded-lg text-popover-foreground [clip-path:inset(0_round_var(--radius-lg))]` —
**346 px tall × 360 px wide**, clipped so the virtualised list cannot bleed past the radius. The left
rail is one icon button per *visible instance* plus a Favorites star, with the selected state drawn as
an `h-5 w-0.75 rounded-l-full bg-primary` bar animated to the row's measured offset and tooltips
opening to the **left** so they never cover model names. The right pane is a Base UI `Combobox` in
`inline` / `filter={null}` / `virtualized` / `open` mode driving a `@legendapp/list` `LegendList`
(`estimatedItemSize={52}`, `drawDistance={480}`, `recycleItems`), with a fake row keyed
`modelPickerLegacySectionKey(instanceId)` spliced in as an expandable "Legacy models" disclosure.
Favorites are client settings keyed `` `${instanceId}:${slug}` ``. `mod+1..9` jumps to the *n*-th
selectable row while open; `mod+shift+m` toggles the picker.

The picker **locks background scroll by hand** (lines 82-128): `documentElement.style.overscrollBehavior
= "contain"`, `body.style.overflow = "hidden"`, `body.paddingRight = scrollbarWidth`, plus capture-phase
non-passive `wheel` and `touchmove` preventers that allow through anything inside
`[data-model-picker-content]`.

**Traits** (`TraitsPicker.tsx`) render whatever the model's capabilities declare, through a
provider-neutral descriptor system in `@t3tools/shared/model`: `getProviderOptionDescriptors({caps,
selections})` returns `select` and `boolean` descriptors with well-known ids `contextWindow`, `agent`,
`fastMode`, `thinking`, plus a "primary" select (effort). The trigger label joins current labels with
`" · "`, except fast mode which renders as a `ZapIcon` (`fill-current`, `#d97757` for `claudeAgent`)
and is omitted when off.

**Ultrathink is prompt text, not state.** Choosing the ultrathink effort rewrites the prompt with the
prefix `"Ultrathink:\n"` (`ULTRATHINK_PROMPT_PREFIX`) via `applyClaudePromptEffortPrefix`; conversely
`isClaudeUltrathinkPrompt(prompt)` reading true flips the composer into its animated rainbow state.
If the word "ultrathink" appears in the *body* rather than the prefix, the effort control is disabled
with *"Your prompt contains "ultrathink" in the text. Remove it to change this option."*

**Runtime mode** (permissions) is four values with exact copy (`ChatComposer.tsx:230-254`):

| value | label | description | icon |
|---|---|---|---|
| `approval-required` | Supervised | Ask before commands and file changes. | `LockIcon` |
| `auto-accept-edits` | Auto-accept edits | Auto-approve edits, ask before other actions. | `PenLineIcon` |
| `auto` | Auto | Supported providers approve routine actions; others still ask. | `SparklesIcon` |
| `full-access` | Full access | Allow commands and edits without prompts. | `LockOpenIcon` |

Interaction mode (`plan` vs `default`) is a single toggle, shown only when
`settings.planModeEnabled && getProviderInteractionModeToggle(...)`: `PencilRulerIcon` with an accent
background in plan, `BotIcon` in build.

### 4.7 Submit path

`submitComposer` blocks with no provider, blocks with an info toast (*"Still compressing a pasted
image."*) while `pendingImageCompressionsRef` is non-zero, then calls `onSend` and — on mobile only,
and only when the send actually goes through — blurs the composer.

`ChatView.onSend` then: reads an imperative snapshot via `getSendContext()`; runs
`deriveComposerSendState` to strip `U+FFFC` placeholders and drop expired terminal contexts; appends
context blocks in order `appendTerminalContextsToPrompt` → `appendElementContextsToPrompt` →
`appendPreviewAnnotationPrompt` (per annotation) → `appendReviewCommentsToPrompt`, landing as trailing
`<terminal_context>…</terminal_context>` and `<element_context>` blocks; applies the provider prompt
prefix via `formatOutgoingPrompt`; converts images to data URLs as turn attachments; pushes an
optimistic user message; clears the composer; derives a title seed (trimmed prompt, else
`Image: <name>`, else the terminal-context label, else the element-context label, else "New thread");
requires an explicit base branch in worktree mode (*"Select a base branch before sending in New
worktree mode."*); and falls back to `IMAGE_ONLY_BOOTSTRAP_PROMPT` for an image-only send.

Image limits come from contracts: `PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8`,
`PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024`. Validation is deliberately synchronous before
the first `await` so concurrent pastes reserve slots. Oversized images are **downscaled rather than
refused** (`lib/imageCompression.ts`: `MAX_DIMENSION = 2048`,
`QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68]`, `FALLBACK_SCALE_STEPS = [0.75, 0.55]`,
`MAX_COMPRESSIBLE_SOURCE_BYTES = 50MB`, OffscreenCanvas when available).

### 4.8 Prompt stash (`mod+s`)

`promptStashStore.ts`, key **`t3code:prompt-stash:v2`**, `MAX_STASH_ENTRIES = 20`,
`MAX_STASH_ENTRY_ATTACHMENT_CHARS = 2_700_000`. v1 is deleted rather than migrated. The stash is one
global queue and **provider-agnostic on purpose** — an entry carries only text and images, never a
model selection, so a prompt can move between threads and providers.

`stashCurrentPrompt` is a careful two-phase write: strip `U+FFFC` placeholders, write the text-only
entry **first**, clear the composer only if the write actually landed (the store reports
`{written, durable, evicted}` so quota failures produce distinct toasts and leave the composer
intact), then re-compress images for the stash (localStorage is ~5 MB origin-wide vs the composer's
10 MB per image) and `finalizeEntryImages`. Only prompt and images are cleared — terminal/element
contexts, preview annotations and review comments are not stashable, so destroying them would be
unrecoverable. The `mod+s` listener is registered **capture-phase on `window`** and always
`preventDefault()`s "so the browser save dialog never opens, even when the composer is in a state that
can't stash".

### 4.9 Workspace / base-branch strip

`BranchToolbar.tsx` is a physically separate element that CSS stitches onto the composer's bottom edge
(§19.6). Three controls:

- **Run on** — the environment. `MonitorIcon` for primary, `CloudIcon` for remote. Rendered as a
  *static label* when there is only one environment or the env is locked, and that static span
  deliberately carries the same `h-7 sm:h-6` and padding as the control "because the glass seam joining
  it to the composer assumes a fixed strip height".
- **Workspace** — `local` = "Current checkout" (or "Current worktree" when one is attached),
  `worktree` = "New worktree", plus a third **"Previous worktree (branch)"** entry computed by
  `resolvePreviousWorktreeSeed` (the most recently `updatedAt` non-archived thread in the project with
  a different `worktreePath`). Only drafts can hop; a started server thread has its workspace pinned.
- **Base branch**, plus a "start from origin" toggle and an optional "check out a PR" hook.

On mobile the three collapse into one `MobileRunContextSelector` menu with `Run on` / `Workspace`
radio groups. All writes go to the same draft store.

---

## 5. Feature: the thread timeline (the work log)

The centre pane is not a chat transcript; it is a derived, collapsed narrative log. The pipeline runs
server → wire → client fold → row derivation → virtualised list.

### 5.1 Assistant text is buffered, not streamed

By default the server **accumulates the whole assistant message in memory** and emits nothing until a
boundary. `bufferedAssistantTextByMessageId` is an Effect `Cache` (capacity 20 000, TTL 120 min,
`ProviderRuntimeIngestion.ts:884-888`). Boundaries:

- `request.opened` / `user-input.requested` → `flushBufferedAssistantMessagesForTurn` (lines
  1697-1730) — the agent is about to ask a question, so show what it said first;
- turn end or segment end → `finalizeAssistantMessage`, which dispatches the whole buffered text as
  one delta then a completion;
- **safety valve**: `MAX_BUFFERED_ASSISTANT_CHARS = 24_000` (line 99); past that the buffer is
  invalidated and spills as one delta rather than being dropped or truncated.

Token-by-token painting is the opt-in legacy path, `ServerSettings.enableLegacyTokenStreaming`,
default `false` (`packages/contracts/src/settings.ts:540-546`). The key was deliberately renamed from
`enableAssistantStreaming` so prior opt-ins reset to buffered, and the settings UI makes turning it
**on** require a native confirm dialog with the copy: *"Paints assistant output token by token instead
of in complete chunks. Not recommended: it is significantly slower, and long responses become harder
to follow."*

**There is no delta event type.** A `thread.message.assistant.delta` command becomes a
`thread.message-sent` event with `streaming: true`; `…assistant.complete` becomes `thread.message-sent`
with `text: ""`, `streaming: false`. The append rule is duplicated verbatim in three places — server
projector (`projector.ts:519-535`), SQL projection pipeline (`ProjectionPipeline.ts:952-985`), client
reducer (`packages/client-runtime/src/state/threadReducer.ts:284-317`):

```ts
text: message.streaming ? `${entry.text}${message.text}`
                        : message.text.length > 0 ? message.text : entry.text
```

One turn can produce several assistant messages (commentary between tool calls);
`startAssistantSegmentForTurn` mints `messageId`s per segment from a base key plus an incrementing
index, which is why the client needs a "terminal assistant message per turn" concept (§5.4).

### 5.2 Activities

`OrchestrationThreadActivity` (`packages/contracts/src/orchestration.ts:327-337`) is
`{id, tone: "info"|"tool"|"approval"|"error", kind, summary, payload: Schema.Unknown, turnId,
sequence?, createdAt}`. **`kind` and `payload` are deliberately untyped** — the whole activity
vocabulary (`tool.updated`, `task.progress`, `approval.requested`, `turn.plan.updated`,
`context-window.updated`, `runtime.warning`, …) is a client-side convention, not a schema, and every
client parses `payload` defensively.

`runtimeEventToActivities` (`ProviderRuntimeIngestion.ts:360-867`) is a large pure switch mapping ~18
runtime event types to activities. Some map to **stable, replace-in-place ids** rather than history
rows: `task.progress` and `tool.progress` use `EventId.make(`task-progress:${threadId}:${taskId}`)`
so a busy sub-agent does not flood the feed; only completions get unique ids and become permanent
history. All free text is clipped by `truncateDetail(value, limit = 180)`, with 120-char limits for
titles and summaries.

`ThreadPlanProgressService` is an explicitly **non-persisted, in-memory** side channel: it eats
`turn.plan.updated` payloads and keeps `{step, completedSteps, totalSteps}` per thread for the shell's
"Working…" indicators. An all-completed plan deletes the entry; the entry is cleared when the turn
settles. Its header states the intent: *"Plans are a progress annotation, not a surface of their own…
no persistence, no migration."*

### 5.3 Payload slimming before the wire

`ActivityPayloadProjection.ts` runs on snapshots and on live events; full payloads stay in
`orchestration_events`. Three mechanisms:

1. **`projectActivityPayload`** rebuilds `payload.data` from a whitelist: `item` (command fields
   only), `command`, discovered `files`, `toolCallId`, `kind`, and a summarised `rawOutput`.
   `collectChangedFiles` walks up to depth 4 / 12 files across keys
   `path|filePath|relativePath|filename|newPath|oldPath` nested under
   `item|result|input|data|changes|files|edits|patch|patches|operations` — and the *exact same
   function body* is duplicated client-side in `apps/web/src/session-logic.ts:1477-1530`. MCP tool
   calls keep `MCP_ITEM_KEPT_FIELDS = ["type","id","tool","server","status","arguments","appContext",
   "error","durationMs"]`.
2. **`dropStaleContextWindowActivities`** keeps only the last resolvable `context-window.updated`
   **per turn** (not per thread, because a live `thread.reverted` discards whole turns).
3. **`dropSupersededToolUpdatedActivities`** drops `tool.updated` rows superseded by a later
   `tool.completed` in the same turn. The doc comment quotes measured numbers: *"47k such rows exist
   in one real database, and a single thread carries 2,291 of them totalling ~1MB post-slimming"* —
   and admits the deliberate divergence from the client's adjacency-only collapse affects *"1.5% of
   dropped rows (553 of 36,581)"*.

### 5.4 Client derivation

`apps/web/src/session-logic.ts` (1633 lines) folds the raw activity array into `WorkLogEntry[]`.

Ordering (`compareActivitiesByOrder`): by `sequence` when both have one, else `createdAt`, else a
**lifecycle rank** (`*.started` → 0, `*.progress`/`*.updated` → 1, `*.completed`/`*.resolved` → 2),
ties on `id`; activities with a sequence sort after ones without.

`deriveWorkLogEntries` drops outright: `tool.started` (the update/complete pair carries everything);
`task.started` unless it is a real agent spawn; `task.updated` ("status patches are not narrative");
`tool.progress`; `context-window.updated`; anything whose summary is `"Checkpoint captured"`;
plan-boundary tool rows (`detail` starting `"ExitPlanMode:"`); and `isAgentInternalActivity` — the
**quiet-timeline guarantee** (§7.4).

**Command unwrapping**: `SHELL_WRAPPER_SPECS` recognises `pwsh|powershell -Command`, `cmd /c`,
`bash|sh|zsh -c` (and `-lc`) and strips the wrapper so the row shows the real command; the original
survives as `rawCommand` in the expanded body.

**Status classification** is partly heuristic and honest about it.
`workEntryIndicatesToolFailure` uses explicit tone/status **or** `toolDetailTextLooksLikeFailure`, a
string scan over `detail + command` for `file not found`, `ENOENT`, `CommandNotFoundException`,
`is not recognized as the name of a cmdlet`, `<exited with exit code N>`, `exit code: N`, … The
comment: *"providers often emit successful lifecycle status while error text lives in `detail` /
`command`."* The three-way ✓ / ✕ / — affordance comes from
`workEntryIndicatesToolSuccess` / `…NeutralStatus`; neutral rows are hidden entirely by the row
derivation, except spawn CTA rows which are explicitly exempted.

Approvals and user input are `Map<requestId, …>` folds opened by `*.requested` and closed by
`*.resolved` **or** by `provider.approval.respond.failed` when the detail matches
`isStalePendingRequestFailureDetail` (a list of literal substrings such as `"stale pending approval
request"`). `deriveTurnPlans` produces one entry per turn that produced plan steps, whose `createdAt`
is the turn's **first** plan snapshot (so the chip renders where planning began) but whose `plan` is
mutated in place to the latest; a later snapshot with zero steps deletes the entry so a withdrawn plan
does not freeze on screen. `formatDuration`: `<1s` → ms, `<10s` → one decimal (with the explicit
`9.95s → "10s"` bucket fix), `<60s` → whole seconds, then `Xm` / `Xm Ys`.

### 5.5 Row derivation and the fold

`MessagesTimeline.logic.ts`'s `deriveMessagesTimelineRows` produces variants `work`, `work-toggle`,
`turn-fold`, `message`, `proposed-plan`, `turn-plan`, `working`.

**Turn folds.** `deriveUnsettledTurnId`: the session's `runningTurnId` wins outright; otherwise
`latestTurn` is unsettled unless `completedAt !== null && state !== "running"` — this prevents the
flicker right after a send where the previous turn is still "active" until the server creates the new
one. `deriveTurnFolds` groups by `turnId`, records the `startBoundary` as the **preceding user
message's `createdAt`** (entry timestamps alone undercount, since the first entry only appears once
the provider produces output), and for every settled non-streaming turn hides everything except the
terminal assistant message. **Agent-spawn CTA rows never fold** because *"workflows outlive their
launching turn."* Label: `"Worked for ${duration}"` / `"Worked"`, or for an interrupted latest turn
`"You stopped after ${duration}"` / `"You stopped this response"`. The fold row is inserted at the
anchor entry's position.

**Terminal assistant message.** `deriveTerminalAssistantMessageIds` keys by `turn:${turnId}`, falling
back to `unkeyed:${n}` counted off user messages. Only the last assistant message per key is
"terminal", and only terminal messages get the metadata row (timestamp + copy) — and only once the
turn settles, *"so commentary doesn't flash timestamps mid-work"*.

**Work grouping.** `MAX_VISIBLE_WORK_LOG_ENTRIES = 1`. Consecutive `work` entries are gathered,
neutral-status entries filtered out, and if more than one survives, all but the last (plus any spawn
CTA rows, always visible) go behind a `work-toggle` row rendering `"+N previous tool calls"` /
`"Show fewer tool calls"`. Selection is by *membership*, not concatenation — a code comment records
the review finding that concatenating two filtered lists moved a mid-group spawn row above earlier
tool rows.

**Structural sharing.** `computeStableMessagesTimelineRows` + `isRowUnchanged` reuse previous row
object references when content is unchanged, per-variant shallow comparison, with `Equal.equals` from
`effect/Equal` for grouped work arrays. This is what keeps LegendList and React from re-rendering the
whole log on every delta.

### 5.6 The list

`@legendapp/list` 3.3.5, patched in-tree (`patches/@legendapp__list@3.3.5.patch` adds
`heightAdjustment` / `contentInsetEndStaticAdjustment` for the keyboard-aware mobile chat list).

- `keyExtractor = item.id`; `getItemType = item.kind === "message" ? `message:${role}` : item.kind` —
  recycling pools are per row kind and per message role.
- `estimatedItemSize={90}`, `initialScrollAtEnd`.
- `maintainScrollAtEnd` is `{animated: false, on: {dataChange: true, itemLayout: true, layout: true}}`
  but is switched **off** whenever anchored end space is active, live-follow is disabled, or a
  disclosure toggle is settling.
- `maintainVisibleContentPosition` with a `shouldRestorePosition(row)` predicate that only restores the
  row currently being expanded or collapsed.
- `className = "scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain px-3
  [overflow-anchor:none] sm:px-5"`.
- `renderItem` is a stable `useCallback` with **no closure deps**; everything shared flows through two
  React contexts read with React 19's `use()`. `nowIso` is deliberately kept out so the list does not
  commit every second.
- Row wrapper: `mx-auto w-full min-w-0 max-w-3xl overflow-x-clip` — the content column is
  **`max-w-3xl` = 48 rem = 768 px**, matching `TIMELINE_CONTENT_MAX_WIDTH = 768`.

**The disclosure/scroll dance.** Toggling a fold calls
`suspendEndScrollMaintenanceForDisclosure(anchorKey)`, which kills `maintainScrollAtEnd` and pins
`maintainVisibleContentPosition` to the toggled row, then clears both after **two**
`requestAnimationFrame`s. An in-session interrupt auto-expands its turn (a `running → interrupted`
transition for the same turnId adds it to `expandedTurnIds`); this state is component-local, so a
reload re-folds.

**Scroll state machine.** `timelineScrollAnchoring.ts` defines
`TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling"`, plus
`getAnchoredTurnMetrics` computing `usableViewportHeight = scrollLength - composerOverlayHeight -
anchorOffset`, `turnHeight`, `overflowsUsableViewport`, `scrollDeltaToRevealEnd`.
`packages/shared/src/chatList.ts` exports `CHAT_LIST_ANCHOR_OFFSET = 16`. On send, the mode becomes
`"anchoring-new-turn"` and the just-sent user message is scrolled to the **top** of the viewport
(`scrollToIndex` with `viewPosition: 0, viewOffset: 16`), with anchored end space keeping it there
while the response grows underneath; a double-`requestAnimationFrame` effect nudges scroll by
`scrollDeltaToRevealEnd`. The opt-out listeners are deliberately careful: an **upward** wheel only
breaks follow if `timelineRealContentOverflowsViewport()`, and touchmove only breaks follow once
`resolveTimelineIsAtEnd(...) === false` — both guarding the documented failure mode where a spurious
break while pinned at the end produces no scroll event, never re-arms, and *"streaming silently stops
following."* The "Scroll to end" pill is debounced on show (`new Debouncer(…, {wait: 150})` from
`@tanstack/react-pacer`) but hidden immediately, so it does not flash during thread switches.

`resolveTimelineIsAtEnd` computes `contentLength - scroll - scrollLength - endInset <= 40`
(`TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40`). The comment explains why a pixel band rather than
LegendList's own `isNearEnd`: *"isNearEnd fires within half a viewport, which re-armed live-follow
while the user was reading history and yanked them back down on the next stream chunk."*

### 5.7 Row components

| Row kind | Presentation |
|---|---|
| user message | Right-aligned bubble `max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground`. Footer (timestamp, revert, copy) `opacity-0 … group-hover:opacity-100 transition-opacity duration-200`. |
| assistant message | No bubble — bare `ChatMarkdown` in `relative min-w-0 px-1 py-0.5`. Empty non-streaming text renders literally `"(empty response)"`. |
| `turn-fold` | `border-b border-border/60 pb-2 pt-1`, a `text-xs text-muted-foreground tabular-nums` button with a chevron. |
| `turn-plan` | Collapsed: chevron + segment bar (`h-[3px] w-2.5 rounded-full`, `bg-success` / `bg-primary` / `bg-muted-foreground/25`) + current step label + `completed/total`. Expanded: `✓ / ● / ○` glyphs in a `w-3 font-mono text-[10px]` column. |
| `work-toggle` | `"+N previous tool calls"` / `"Show fewer tool calls"`. |
| `working` | Three 1 px dots with `animate-status-pulse` and `[animation-delay:200ms]`/`400ms`, "Working for <timer>", plus the plan step label. |
| `proposed-plan` | Separate `ProposedPlanCard`; collapses past 900 chars or 20 lines. |

**`PlainWorkEntryRow`** is the workhorse. `heading` is
`capitalizePhrase(normalizeCompactToolLabel(toolTitle ?? label))`; `preview` is command → detail →
first changed file (`+N more`), suppressed when it equals the heading. Icon choice maps
`user-input.*` → message-circle, requestKind command/file-read/file-change → terminal/eye/square-pen,
itemType `command_execution` → terminal, `file_change` → square-pen, `web_search` → globe,
`image_view` → eye, `mcp_tool_call` → wrench, `dynamic_tool_call` → hammer,
`collab_agent_tool_call` → bot, taskId → bot, else the tone icon (error → circle-alert,
thinking → bot, info → check, tool → zap). The trailing status glyph is ✕ `text-destructive` / ✓ /
`MinusIcon` "Empty", each in a Tooltip. Expanding shows `buildToolCallExpandedBody` (MCP JSON, raw
command, detail, changed files, joined by blank lines) in a
`max-h-64 overflow-auto whitespace-pre-wrap font-mono text-secondary-label text-[11px]` `<pre>` inside
`mt-1 ms-7 border-s border-border/45 ps-3`.

**Self-ticking labels.** `WorkingTimer` writes `textRef.current.textContent` from a
`setInterval(…, 1000)` — explicitly *"so elapsed-time display does not create a React commit every
second while a response is streaming."*

**User message body** is genuinely complicated: it collapses past
`MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600` chars or `MAX_COLLAPSED_USER_MESSAGE_LINES = 8` lines behind
`max-h-44` plus a CSS mask `linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)`.
Before rendering, the text is peeled apart into terminal contexts, preview annotations, element
contexts and review-comment segments, each rendered as its own chip or card, with the remaining prose
split into interleaved `ChatMarkdown` segments.

### 5.8 The minimap

`TimelineMinimap` renders **one 2 px-tall dash per user message** in the left gutter.

- Container: `group/minimap pointer-events-none absolute inset-y-0 left-0 z-40 hidden w-18
  [@media(pointer:fine)]:block` — desktop pointers only.
- Visible always when the side gutter is ≥ 48 px (`TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48`),
  otherwise `opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100`.
- Rail: `absolute top-0 left-3 h-full w-px bg-border/15`.
- Each dash: `h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35
  transition-[background-color,width] duration-150 data-[in-view=true]:bg-foreground/90`, with a
  proximity width ramp — `w-6 bg-muted-foreground/75` at the hovered index, then `w-4`, `w-2.5`, `w-2`
  at distances 1, 2, 3+.
- `in-view` is written **imperatively** in `handleScroll` (the component keeps a
  `Map<id, HTMLSpanElement>` and sets `strip.dataset.inView` directly rather than re-rendering).
- Hover card: `dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl
  shadow-black/25`, `w-80`, showing the user message on one line (`text-sm font-medium leading-5`,
  ellipsised) plus a 3-line `-webkit-line-clamp: 3` clamp of the turn's final assistant text.
- `resolveTimelineMinimapHitStripWidth` caps the invisible hover strip
  (`TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12`, `…MAX_WIDTH = 40`,
  `…EXPANDED_HIT_STRIP_WIDTH = "22rem"`) to the side gutter so it can never sit on the centred text
  column and swallow text selection.
- Keyboard: ArrowUp/Down/Home/End/Enter/Space on a single focusable button.

### 5.9 Windowed history

`OrchestrationThreadDetailWindow` / `…Page` (`packages/contracts/src/orchestration.ts:583-611`):
`turnLimit` counts **turns with a user pending message**, so a window always contains the last N user
prompts and any subagent/fan-out turns ride along. `beforeCursor` is opaque and exclusive.
`page.threadSequence` is a per-thread watermark a client must have applied before merging an older
page — otherwise *"a streaming turn outside the loaded window could have deltas replayed on top of
page content that already includes them, duplicating text."* The UI end is `TimelineLoadEarlierHeader`,
whose label flips to `"Loading earlier turns…"` with no spinner — *"the label change is the loading
indicator"*.

---

## 6. Feature: markdown rendering

`apps/web/src/components/ChatMarkdown.tsx` (1721 lines), `react-markdown` ^10.1.0.

### 6.1 Pipeline

```
remark: remarkGfm, remarkGithubAlerts, remarkNormalizeListItemIndentation,
        [remarkBreaks — only when lineBreaks=true], remarkPreserveCodeMeta, remarkTagInlineCode
rehype: rehypeRaw, [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA]
```

`lineBreaks` is on for **user** messages (chat-style single-newline hard breaks) and off for assistant
output. The sanitize schema forks `rehype-sanitize`'s `defaultSchema` to **remove the `title`
attribute globally** (markdown cannot inject native tooltips), allow `dataCodeMeta` / `dataInlineCode`
on `code` and `dataAlert` on `blockquote`, and add `file` to the allowed `href` protocols.

### 6.2 The four custom remark plugins

- **`remarkGithubAlerts`** (`markdown-github-alerts.ts`) — GitHub's `> [!NOTE]` callouts, which GFM
  does not cover. Regex `^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i`; it lifts the marker
  into `node.data.hProperties.dataAlert` and removes the marker line. It correctly implements GitHub's
  rule that `> [!NOTE] aside` is an ordinary quote, using `markerEndsItsLine` to disambiguate
  `[!NOTE]\n**bold**` from `[!NOTE]*aside*` (which parse to the same mdast minus a newline).
- **`remarkNormalizeListItemIndentation`** — the cleverest of the set. CommonMark turns `-       text`
  into an indented code block; agents produce that accidentally all the time. The plugin finds `code`
  nodes that are direct children of a `listItem`, start on the marker's own line, and whose source
  char is not a fence character, then **re-parses the code text through the same processor with a
  sentinel prefix `"t3-markdown-inline-prefix:"`** that forces block-looking input into a paragraph
  while keeping GFM inline extensions alive, then strips the prefix back off. It is a
  `function(this: MarkdownParser)` attacher so it can call `this.parse`.
- **`remarkPreserveCodeMeta`** — copies `node.meta` into `hProperties.dataCodeMeta` so fence info
  survives to hast.
- **`remarkTagInlineCode`** — tags inline code with `dataInlineCode`, because once inline and fenced
  code render through the same `code` component the distinction is gone. Code **inside a link label
  stays untagged**, so linkifying it cannot nest an anchor inside an anchor.

### 6.3 Component overrides

**GitHub alerts** render as `<div role="note" className="my-1 border-l-2 pl-3 …">` rather than a
blockquote, because *"the stylesheet mutes those, and an alert's body is ordinary text under a colored
title."* Exact values (`GITHUB_ALERT_PRESENTATIONS`):

| alert | icon (lucide) | border | title colour |
|---|---|---|---|
| note | `InfoIcon` | `border-blue-500/70` | `text-blue-600 dark:text-blue-400` |
| tip | `LightbulbIcon` | `border-emerald-500/70` | `text-emerald-600 dark:text-emerald-400` |
| important | `MessageSquareWarningIcon` | `border-purple-500/70` | `text-purple-600 dark:text-purple-400` |
| warning | `TriangleAlertIcon` | `border-amber-500/70` | `text-amber-600 dark:text-amber-500` |
| caution | `OctagonAlertIcon` | `border-red-500/70` | `text-red-600 dark:text-red-400` |

**Task-list checkboxes are live.** `findTaskListMarkerOffset` locates the `[ ]`/`[x]` in the *original
markdown source string* by byte offset from the mdast node's `position.start.offset`, stashes it as
`data-task-marker-offset` on the `<li>`, and `onChange` reports `{markerOffset, checked}` back through
`onTaskListChange`. Without a handler the checkbox is `readOnly`. (In the file editor this writes the
file — §9.6.)

**Links** have three paths: file links become chips (§6.5); same-document `#fragment` links resolve
the target *inside the nearest `.chat-markdown` root first* and un-prefix rehype-sanitize's
`user-content-` id mangling before `pushState` + `scrollIntoView({block: "nearest"})`; external links
get `target="_blank" rel="noopener noreferrer"`, a favicon, a URL tooltip, and a native context menu
offering open-in-preview / open-external / copy. Favicons come from
`https://www.google.com/s2/favicons?domain=<host>&sz=32` with a module-level `failedFaviconHosts` set
so a host that 404s once falls back to `GlobeIcon` for the rest of the session, and are only added when
the anchor has text (an image-only anchor — a badge, a "Fix in Cursor" button — does not get one).
External link text is made breakable by interleaving `<wbr/>` **after every character**, except a
non-breaking leading run (`https://` or the first char) that stays glued to the favicon.

**Tables** render through `MarkdownTable`: a `ScrollArea` with `chainVerticalScroll scrollFade
hideScrollbars`, plus a footer with an expand/collapse-cells toggle and a copy menu offering **"Copy as
Markdown"** and **"Copy as CSV"**. Expanding first measures every column's rendered width and pins
`minWidth` on the header cells so the layout does not jump. **`details`** becomes a Base UI
`Collapsible` with a rotating `ChevronRightIcon` (`data-panel-open:[&_svg]:rotate-90`).

### 6.4 Syntax highlighting

`getSharedHighlighter` from **`@pierre/diffs`** with `preferredHighlighter: "shiki-js"`, themes
`[resolveDiffThemeName("dark"), resolveDiffThemeName("light")]` = `pierre-dark` / `pierre-light`, and a
per-language promise cache. A language Shiki does not know recursively falls back to `"text"`; if
`"text"` itself fails the error propagates (Shiki cannot initialise at all).

Three layers of fallback for one code fence: `UncachedShikiCodeBlock` uses React 19's `use(promise)`
inside a `<Suspense>` whose fallback is the plain `<pre>`, wrapped in a `RenderErrorBoundary` with the
same fallback. Results go into an `LRUCache<string>` with `MAX_HIGHLIGHT_CACHE_ENTRIES = 500` and
`MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024`, keyed
`${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}` — and **caching is skipped
entirely while `isStreaming`**, because mid-stream code is incomplete and would poison the cache.

`extractFenceLanguage` has one hardcoded remap: `gitignore → ini`, *"Shiki doesn't bundle a gitignore
grammar; ini is a close match (#685)"*. `extractFenceTitle` accepts `title="x.ts"` / `file=…` /
`filename=…` or a bare filename-looking token in the fence meta; the header shows a Pierre file icon
for the filename, or for a language-only block just the icon with the language name in a tooltip.
Code-block chrome is a wrap-lines toggle (`WrapTextIcon`, `aria-pressed`) and a copy button that flips
to `CheckIcon` for exactly **1200 ms**; both default from `getClientSettings().wordWrap`.

### 6.5 File links

`apps/web/src/markdown-links.ts` (404 lines) decides whether a link destination or an inline-code span
is a *file*:

- `POSIX_FILE_ROOT_PREFIXES` — 24 OS/dev-container roots, *"deliberately excludes app-route-ish
  prefixes like /app/ or /chat/ so SPA routes never read as files."*
- `resolveMarkdownFileLinkTarget` handles `file:` URLs (including the browser's `/C:/foo` mangling of
  Windows drive paths), `#L12C4` fragments turned into `:12:4` suffixes, and cwd-relative resolution.
- `resolveInlineCodeFileLinkMeta` demands **stronger** evidence because inline code is mostly
  identifiers: an explicit path prefix, a file extension, or a `:line` suffix. It rejects hostnames via
  two allowlists — `GENERIC_HOSTNAME_TLDS` (26 entries) and `COUNTRY_HOSTNAME_TLDS` (31 entries) —
  with the rule that country codes only count as host evidence when there is **no** `:line` suffix
  (because `.pl`, `.pt`, `.es` are also file extensions). `EXTENSIONLESS_FILE_NAMES` is a 25-name
  allowlist (`Makefile`, `Dockerfile`, `Justfile`, `CODEOWNERS`, …) that can link only when a `:line`
  suffix is present.
- `buildFileLinkParentSuffixByPath` disambiguates chips sharing a basename by computing the minimum
  unique parent-directory suffix per path, floored at 2 segments. Chip label =
  `basename · parentSuffix · L12:C4`, joined with `" · "`.
- The chip is an `<a>` with the shared `CHAT_FILE_TAG_CHIP_CLASS_NAME` plus
  `"chat-markdown-file-link cursor-pointer transition-colors hover:bg-accent/70"`, a
  `font-mono text-[11px]` path tooltip, and a native context menu (Open in editor / Open in integrated
  browser / Copy relative path / Copy full path). **Left-click opens the file preview panel**, not the
  editor.

### 6.6 Skill chips and copy-out

`SkillInlineText.tsx` matches `$skill-name` with
`/(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g` and renders fuchsia chips — but **only when the name
matches a known `ServerProviderSkill`**. `renderSkillInlineMarkdownChildren` recurses through rendered
React children, skipping `code` and `a` elements (checking `child.props.node?.tagName` because custom
components replace the intrinsic type).

`apps/web/src/markdown-clipboard.ts` **reverses the render**: a `copy` handler on the `.chat-markdown`
root walks the DOM `Selection` and re-emits **markdown source** into `text/plain` plus a sanitised HTML
fragment into `text/html`. It handles lists, blockquotes, tables (with alignment markers from
`style.textAlign`/`align`), code fences (re-deriving the language from `[data-language]`), `<details>`,
and anchors; it skips `BUTTON/INPUT/SCRIPT/STYLE/TEMPLATE`, `svg`, `[aria-hidden="true"]`,
`.select-none`, `.sr-only`. Elements override their serialisation via a `data-markdown-copy`
attribute — used by file chips (`[basename](path)`) and skill chips (`$name`).

---

## 7. Feature: subagents and workflow runs (the Agents surface)

**There is no server-side subagent read model.** No projection, no table, no dedicated RPC. The
server's only contributions are: normalising five providers' heterogeneous child-agent signals into
shared `task.*` / `tool.progress` runtime events; stamping each persisted row with an `agentKind`
classification; an in-memory per-thread *liveness registry* used only for a sidebar pill and to stop
the session reaper killing background fleets; and one hardened file-read RPC for workflow scripts.
Everything else — identity, status, usage, phase grouping, ordering, retention — is a **pure
client-side fold over persisted thread activities**
(`packages/client-runtime/src/state/subagentRuntime.ts`, 941 lines), recomputed in a `useMemo` on
every activity-list change. The panel that renders it (`apps/web/src/components/AgentsPanel.tsx`, 581
lines) holds no data state at all — only expansion booleans.

### 7.1 Provider → runtime events

**Claude.** The Agent SDK emits `system` messages with subtypes `task_started`, `task_progress`,
`task_updated`, `task_notification`, mapped 1:1 to `task.started` / `task.progress` / `task.updated` /
`task.completed` (`ClaudeAdapter.ts:3150, 3207, 3243, 3277`). Around that:

- **Identity memo.** `context.taskAgents` (a `Map<taskId, …>`) remembers description,
  `subagent_type`, `task_type`, `workflow_name`, model, effort, `owningAgentId`, `runHandles`, and
  `taskLinkageFor()` re-stamps that bundle onto *every* later `task.*` payload — explicitly so the
  client fold can reconstruct an agent whose `task.started` row has aged out of retention.
- **Model attribution.** Launch-time values come from the Agent tool's input, falling back to the
  session model; a later subagent assistant snapshot (carrying `parent_tool_use_id`) *refines*
  `owningAgent.model` with the authoritative API model id, and those snapshots are otherwise suppressed
  from the parent timeline.
- **Workflow member synthesis.** `emitWorkflowMemberProgress` parses the SDK's
  *undeclared-but-real* `workflow_progress` array on `task_progress` messages (`parseWorkflowProgress`
  — "wire-confirmed; absent from sdk.d.ts") and emits one synthetic `task.progress` per member. Member
  identity is the **stable slot** `` `${coordinatorTaskId}:wf:${entry.index}` `` — deliberately not the
  per-attempt agent id, which changes on retry. Caps: `WORKFLOW_PHASE_CAP = 64`,
  `WORKFLOW_AGENT_CAP = 100`.
- **Material-transition filter.** The wire repeats every member every tick, so the adapter fingerprints
  `[status,label,model,lastToolName,error,tokens,toolCalls,phaseIndex,phaseTitle,attempt]` and skips
  unchanged members — *"a 100-agent fleet costs ~1 event per changed member instead of 100 per tick"*.

**Codex** is completely different: under native multi-agent v2 a subagent is a *full app-server
thread*. `CodexSessionRuntime.ts:602-1245` intercepts the child threads' own JSON-RPC notifications
before they reach parent-timeline mapping and re-emits them as synthetic `collabAgent/*` events. A
routing table `routeCodexChildNotification` decides per method: `agent-event`
(turn/started, turn/completed, thread/status/changed, thread/tokenUsage/updated, item/started,
item/completed, thread/closed, error), `drop` (an enumerated chatter list), or **`parent` for anything
unrecognised** — *"two shipped bugs came from a catch-all that swallowed everything"*.
`mapCollabAgentEvent` then produces `task.*`: `statusChanged` with `active` + waiting flags →
`status: "waiting"`; `turnCompleted` → **`idle`, not terminal** (*"the identity is resumable via
sendInput/resume"*); `tokenUsage` → `task.progress` with usage built from `tokenUsage.total` only
(never `last`, *"which shrinks on follow-ups"*); `closed` → `interrupted`. Every one of these rows
carries `timelineBypass: true`.

Codex also implements **fleet-wide stop**: `interruptTurn` first interrupts every live child turn with
`concurrency: 8`, a 3-second per-child timeout and a 10-second overall bound, *then* interrupts the
parent — bounded precisely because the runaway-fleet case is when Stop matters most.

### 7.2 Ingestion and stable ids

`taskLinkageActivityFields()` copies the linkage bundle onto the persisted payload and **stamps
`agentKind`** via `classifyTaskAgentKind`. Activities are written under deterministic ids —
`task-progress:<threadId>:<taskId>`, a second `task-usage:<threadId>:<taskId>` row flagged
`usageSnapshot: true` when typed usage is present, and `tool-progress:<threadId>:<taskId>`. Because
`projection_thread_activities` upserts on `activity_id`
(`INSERT … ON CONFLICT (activity_id) DO UPDATE`), this bounds a fleet to **~3 rows per agent**
regardless of tick volume. Splitting usage into its own id prevents *"a command/reasoning update
replacing the last known token count"* and vice versa. `tool.progress` events **without** a `taskId`
are dropped entirely — only agent-owned heartbeats are persisted.

The classifier lives once, in contracts (`packages/contracts/src/providerRuntime.ts:509-527`):

```ts
MONITOR_TASK_TYPES = new Set(["monitor", "monitor_mcp", "local_bash", "shell"]);
INERT_TASK_TYPES   = new Set(["plan", "dream"]);
```

`classifyTaskAgentKind` is a **denylist, not an allowlist** — *"the SDK's agent-flavored type names
drift (subagent, local_agent, local_workflow, …) and an allowlist silently dropped real subagents when
'local_agent' appeared"*.

### 7.3 The client fold

Eight statuses: `pending | running | waiting | idle | completed | failed | cancelled | interrupted`.
Terminal = the last four. Active = pending, running, waiting — *"waiting counts as active because it
needs the user"*; **idle is deliberately neither**: "settled-ish but resumable". Constants:
`RECENT_ACTIVITY_LIMIT = 6`, `SUMMARY_CHAR_LIMIT = 180`, `ROSTER_LIMIT = 100`.

Membership: `isBackgroundTaskActivity(payload)` is literally `payload.agentKind !== "agent"` — rows
without a stamp (legacy threads, pre-stamp servers) are background *by definition*. Membership is
**sticky**: only `task.started` re-judges classification, because terminal rows often carry only
`taskId + status` and re-judging them would drop the agent.

The fold's order-robustness invariants are each commented in-file with the bug that produced them:

| Invariant | Rationale in code |
|---|---|
| Completion can create an agent | its start may have aged out of retention |
| A late `task.started` after a terminal state only fills metadata | guarded on `!isTerminalSubagentStatus(status)`, *not* on `activationCount` — "a task first seen via a terminal task.updated has zero activations but is still settled" |
| Duplicate terminal events are idempotent, first write wins | "timestamps don't slide" |
| Reactivation (terminal\|idle → running\|pending) bumps `activationCount` and clears result/error/completedAt | "a live card never shows the prior run's output" |
| An `attempt` bump on a workflow slot clears terminal detail but does **not** bump the count | "bumping here too counted every retry twice — two attempts read 'run 3'" |
| A terminal `task.completed` still *enriches* an already-terminal agent | Claude commonly emits terminal `task.updated` before `task.completed`; the completion carries result + final usage |
| Provider `endedAt` beats ingestion time | checked on the *transition*, not on `completedAt === null` |
| Metadata fill never downgrades a known value to null | |
| Status lookup uses `Map`/`Set`, not object literals | "a status like `toString` must miss instead of resolving an inherited Function through the prototype chain" — payloads are *not* schema-validated on the read path |
| `sessionUrl` re-validated `/^https?:\/\//i` at the fold | "defense-in-depth… shipped XSS lesson" |
| Usage-only ticks don't fake liveness | `usageSnapshot === true` on an existing agent does not force `running` |

**Usage merge** is a field-wise maximum across `totalTokens, inputTokens, cachedInputTokens,
outputTokens, reasoningOutputTokens, toolUses, durationMs`: Codex frames are cumulative so max-merge is
idempotent under duplicate/late frames, and Claude's `task_progress` usage is cumulative per task too.
Field-wise so *"a terminal payload carrying only totalTokens must not wipe a known breakdown"*.

Two consistency passes and a retention rank:

1. **Coordinator settle cascade** — when a `workflow` agent is terminal, any member whose
   `parentAgentId` matches and is neither terminal nor idle inherits `completed` or `interrupted`.
2. **Session-death interruption** — with `sessionLive: false`, every active agent becomes
   `interrupted`; idle is preserved. This mirrors the server clearing its liveness registry on
   `session.exited`, *"so panel and sidebar can never disagree"*.
3. **Roster cap** — above 100 agents, rank live(0) → idle(1) → settled(2), then newest `updatedAt`
   first, keep 100. The panel model then re-sorts survivors by `firstSeenAt` so *"updates and the
   >100-agent retention ranking must never reshuffle rows that remain visible"*.

`deriveAgentPanelModel` groups: `kind === "workflow"` agents sort by `firstSeenAt || id`; non-workflow
agents with a matching `parentAgentId` become members; everything else (including orphans whose
coordinator aged out) falls into `directAgents`. Phases use `workflow.phases` if present, else derive
from members' `phaseIndex` with a `"Phase ${index+1}"` fallback; per phase, `activeCount` counts active
**plus idle** (*"a resumable Codex member has not finished the phase"*). Members whose `phaseIndex` is
null or unknown land in `unphasedMembers` — *"a member must never vanish just because its phase row was
lost"*. Footer counters: `runningCount` (running+pending), `waitingCount`, `idleCount`, `settledCount`,
`totalTokens`, `liveCount = running + waiting`; the token sum skips a workflow coordinator when it has
members, because *"workflow coordinators aggregate member usage upstream in some providers"*.

Formatters: `formatSubagentModelLabel` strips `^claude-`, `-\d{8}$`, `-latest$` and appends
`" · effort"`; `formatSubagentTokenCount` renders `<1000` raw, `k` with one decimal below 100k then
rounded, `M` with one decimal.

### 7.4 The quiet-timeline guarantee

The chat gets **at most one row per spawn batch**. `isAgentInternalActivity` hides rows stamped
`payload.timelineBypass === true` and rows attributed to an owning `payload.agentId` — but a *nested
agent's* own task rows stay visible, because they anchor a CTA (review finding: *"hiding on agentId
alone removed nested agents and their anchors"*).

`collapseDerivedWorkLogEntries` collapses subagent rows **by spawn group, not adjacency**.
`agentSpawnGroupKey`: a `":wf:"` in the taskId → `wf:<coordinator>`; an explicit workflowId →
`wf:<id>`; a coordinator row → `wf:<taskId>`; otherwise `direct:<turnId>`, falling back to
`direct:task:<taskId>` when there is no turn — explicitly so turn-less spawns do not *"collapse into
one immortal 'direct:no-turn' CTA accumulating every agent the thread ever ran"*. Group membership is
decided **once, at the first row seen for a taskId**, because Claude background subagents settle
between turns under fresh synthetic turn ids, which previously *"splintered one batch into a stream of
'Kicked off N subagents' rows (live-test finding, thread 7ac7ef05)"*. The merged CTA keeps the
**anchor** identity (`id`, `createdAt`, `turnId`, `label` of the first row) so it renders where the run
launched — *"mid-run it drifted below the whole conversation, reading as 'no visualization'"*.

`AgentSpawnCtaRow` derives its live status from the shared panel model at render time and never
renders a roster. A workflow's liveness comes from **the coordinator's own status, not its members**,
because dynamic spawns can leave the member list momentarily all-settled (*"the 'completed' lie from
live testing"*). Copy: `Kicked off N subagents` while live / `Ran N subagents` when settled, optional
` · workflowName`; right side `<phase> · N working` / `N working` / `N failed` / `✓ completed`; a
`size-1.5 rounded-full` dot in `bg-info` / `bg-destructive` / `bg-success`; token total as
`Σ <count>`; trailing `Open Agents ▸` / `View ▸` in `text-info-foreground`.

### 7.5 The Agents panel

Root: `flex h-full min-h-0 flex-col` → `ScrollArea min-h-0 flex-1` → `flex flex-col gap-2 p-2` →
workflow sections, then a `Direct spawns` section, then a sticky footer.

**Status visuals** — one steady in-flight state by design (*"detail belongs in the activity sub-line,
and a stalled/waiting/queued subagent is still the fleet doing its job, not a user problem"*):

```
pending/running/waiting → bg-info,                 "Working"
idle                    → bg-muted-foreground/50,  "Idle · resumable"
completed               → bg-success,              "Completed"
failed                  → bg-destructive,          "Failed"
cancelled/interrupted   → bg-muted-foreground/60,  "Stopped"
```

Idle is muted rather than sky on purpose: *"live-test: sky idle dots read as stuck in-progress"*.
`StatusDot` is `size-1.5 shrink-0 rounded-full` with `aria-hidden`. **There is no animation anywhere
in the panel** — the only pulses in the area are the composer's background-work banner dot
(`animate-status-pulse`) and the sidebar pill.

**`AgentRow` is a fixed-height CSS grid** — the one hard layout rule of the surface (*"agent rows
reserve three fixed lines for identity, activity, and metrics; changing data must never change their
height"*):

```
grid h-[3.875rem]
grid-cols-[0.375rem_minmax(0,1fr)_auto]
grid-rows-[1.25rem_1.125rem_1rem]
items-center gap-x-2 rounded-md px-1.5 py-1
```

- Row 1: dot; `text-sm font-medium` truncating title; optional role chip
  `max-w-28 truncate rounded-sm border border-border/60 px-1 font-mono text-[.65rem]
  text-muted-foreground` (suppressed when role equals title case-insensitively); right column
  `min-w-14 text-right font-mono text-[.7rem] text-muted-foreground/80` holding the elapsed timer plus
  a `Check size-3 text-success` on completion.
- Row 2: activity line, `truncate text-xs`, `text-destructive-foreground` when failed else
  `text-muted-foreground`. Content order flips with liveness: live rows lead with
  `progress → ▸ tool → result → error`; settled rows lead with `error → result → progress → ▸ tool`.
- Row 3: metadata, `truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70`, joined with
  `" · "`: model label, `"12.4k tok"` (or `"— tok"`), `"N tools"`, `"run N"` when `activationCount > 1`.
- A visually hidden `<span class="sr-only">` carries the status label, since the dot is `aria-hidden`.

**Elapsed timer** writes `textRef.current.textContent` from a 1 s `setInterval` — zero React commits
per tick. Settled rows freeze at `completedAt`. Format: `"45s"`, `"3m 07s"`, `"1h 04m"`, rendered
`tabular-nums`.

**PhaseRail**: `flex flex-wrap items-center gap-x-1 gap-y-1 px-1.5 pb-1 pt-1.5`, one segment per phase
separated by `ChevronRight size-3 text-muted-foreground/40`. Segment border `border-info/40` (running)
/ `border-success/30` (done) / `border-border/50`; label `font-mono text-[.65rem]` in
`text-info-foreground` / `text-success-foreground` / `text-muted-foreground/70`, prefixed `"✓ "` when
done, followed by one `StatusDot` per member (or an en-dash `–` at
`text-[.6rem] text-muted-foreground/50` when empty).

**PhaseSection** header: `mt-2 flex w-full items-center gap-1.5 rounded-sm px-1.5 text-left
text-[.65rem] font-medium uppercase tracking-wider hover:bg-accent/40`; counts read `"pending"` /
`"N done"` / `"N active · N done"`. It opens when the phase *becomes* running and then **keeps that
shape as it settles** — *"completion never yanks rows out from under the user"*.

**ExpandedWorkflowSection**: `rounded-lg border border-border/50 bg-card/30 p-1.5`; header line
`text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground` with the coordinator dot,
the workflow name, the `{}` script toggle (`rounded-sm border border-border/60 px-1 font-mono
normal-case`), a right-aligned `{settled}/{members.length} settled`, and a collapse chevron.
**CollapsedWorkflowSection** is a single button row: dot (red if any member failed), name, then
`font-mono text-[.7rem] text-muted-foreground/80` with `N failed`, `N agents`, `· Σ tok`,
`· elapsed`, `ChevronRight`. Whether a workflow starts open is *presentation state* seeded once from
`workflowIsLive(group)` — a live run stays expanded when it settles.

**Footer**: `flex items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono
text-[.7rem] text-muted-foreground`; left `● N working` in `text-info-foreground` plus `N idle` /
`N settled`; right `Σ 1.2M tok` in `tabular-nums`. **Empty state**: centred
`Bot size-6 text-muted-foreground/60`, `text-sm font-medium` "No agents yet", `max-w-56 text-xs
text-muted-foreground` explainer.

The Agents surface is a **singleton tab** in the right panel (`{id: "agents", kind: "agents"}`), label
"Agents", icon `Bot`, launcher shortcut letter **A**, launcher description *"Follow subagents and
workflows."*, unavailable hint *"Available from a thread."*. Live-count badges are identical in two
places: `absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info
px-1 text-[9px] font-semibold tabular-nums text-white`, and the panel-toggle badge is suppressed while
the Agents surface is already on screen.

### 7.6 Server-side liveness and the session reaper

`apps/server/src/orchestration/ThreadBackgroundLiveness.ts` holds
`Map<threadId, {agents: Set<taskId>, monitors: Set<taskId>}>`. **No persistence, no migration**:
*"after a server restart the registry is empty until new task events arrive, which matches reality:
orphaned background work is not live."* It is fed on every `task.*` and cleared wholesale on
`session.exited`. Classification is **per-transition, not sticky** — every path first drops any prior
entry for the taskId, *"so a stale bucket assignment can't pin the thread's status"*. `INERT_TASK_TYPES`
are dropped; `agentId` + (no taskType | monitor taskType) is dropped (covered by the owning agent);
`status === "idle"` counts as **not live** — *"an all-idle fleet must not pin Working"*. Two-state
vocabulary: any live agent → `"working"`; `"monitoring"` only when watch loops are the only live work.

It surfaces on `OrchestrationThreadShell.backgroundLiveness` and drives:

- **Sidebar status** — label `"Working"`, `text-sky-600 dark:text-sky-300/80`,
  `bg-sky-500 dark:bg-sky-300/80`, `pulse: true`; `"Monitoring"` same colours, `pulse: false`. A
  session `status === "error"` outranks both.
- **Composer banner** — title `"${liveCount} agents working in the background"` (falling back to
  `"Background work running"` when the fold sees no agents), with a `Stop` button that dispatches a
  turn interrupt.
- **Provider session reaper** (`ProviderSessionReaper.ts`) — sweeps every 5 min
  (`DEFAULT_SWEEP_INTERVAL_MS`), stops sessions idle 30 min (`DEFAULT_INACTIVITY_THRESHOLD_MS`), but
  skips any thread with an active turn *or* `backgroundLiveness != null`, because *"those live inside
  the provider process, so stopping the session would kill them silently, and nothing bumps lastSeenAt
  between turns."*

### 7.7 The `{}` workflow-script viewer

RPC `orchestration.getWorkflowScript`, scope `AuthOrchestrationReadScope`, handled by
`apps/server/src/orchestration/workflowScriptQuery.ts`. Client-side the atom family caches with
`staleTimeMs: 300_000, idleTtlMs: 300_000` (*"scripts are immutable per run: cache generously"*).

The read is hardened: reject non-absolute paths and any extension other than `.js`; `realpath` the root
`~/.claude/projects` **and** the requested file (*"a symlink named like a script inside a contained
directory must not escape"*); containment check `resolved === root || resolved.startsWith(root + sep)`;
re-check `.js` on the resolved path; then a **TOCTOU-safe read** — `open()` first, then
`handle.stat()`, then `lstat(resolved)` and compare `ino`/`dev` (*"a process swapping the path between
realpath and open changes the inode, which this comparison catches"*). `SCRIPT_BYTE_CAP = 256 * 1024`;
oversize reads are **truncated, not failed**, flagged `truncated: true`, and the UI appends
`"\n… (truncated)"`. Failure reasons are a closed set: `invalid-path | root-unavailable | not-found |
outside-root | not-js | not-regular-file | changed-during-read | read-failed`. Its test creates a real
symlink inside the root pointing at `os.tmpdir()` and asserts the reason is specifically
`"outside-root"` — *"a 'not-found' would mean the link was never exercised and the assertion proves
nothing"*.

**Stated plainly in the notes:** `threadId` is in the input schema and is *never used* by the handler.
There is no check that the requested script belongs to the requesting thread. Any client with
`orchestration:read` on the environment can read any `.js` file under `~/.claude/projects`, truncated
at 256 KB. The realpath containment is the only boundary.

Script viewer UI: `mx-1.5 mb-1 rounded-md border border-border/60 bg-background/60`, header
`Braces size-3` + basename in `font-mono text-[.65rem]`, body `max-h-72 overflow-auto p-2` with
`pre whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed text-foreground/90`.

---

## 8. Feature: worktrees, checkpoints, and per-turn diffs

Every T3 thread runs inside a dedicated git worktree, and every agent turn is bracketed by a
"checkpoint" — a parentless commit object pointed to by a hidden git ref under `refs/t3/checkpoints/`.
Checkpoints are never on a real branch and never touch the working tree's actual history; they exist
so the server can diff any two points in a thread's timeline, or snap the filesystem back to one,
using plain git plumbing.

### 8.1 Two independent "shell out to git" code paths

The single most surprising structural fact in this area: **there are two separate, non-sharing
implementations that both spawn the `git` binary.**

1. **`GitVcsDriverCore.ts`** (3194 lines) — the rich, git-specific API: status
   (`statusDetailsLocal`/`statusDetailsRemote`), branch listing/pagination,
   `createWorktree`/`removeWorktree`/`switchRef`/`createRef`/`renameBranch`, PR-branch materialisation
   helpers, and diff-preview machinery for review. It executes `git` via `effect/unstable/process`'s
   `ChildProcessSpawner` with its own timeout/output-limit and a `GIT_TRACE2` hook monitor
   (`createTrace2Monitor`, lines 462-619). Exposed as the `GitVcsDriver` tag; used by `GitManager.ts`
   and `GitWorkflowService.ts`.
2. **`makeVcsDriverShape`** (`GitVcsDriver.ts:446-916`) — a *second*, independent implementation of a
   smaller surface (`execute`, `detectRepository`, `isInsideWorkTree`, `listWorkspaceFiles`,
   `listRemotes`, `filterIgnoredPaths`, `initRepository`, and — critically — `checkpoints`). It shells
   through a different stack: `VcsProcess` → `ProcessRunner` → the same spawner, with its own
   timeout/output collection and its own failure classification (`classifyNonZeroExit`, which
   recognises `gh`/`glab`/`az` auth and rate-limit stderr text). Exposed as the generic multi-VCS
   `VcsDriver` tag, resolved through `VcsDriverRegistry.resolve({cwd})` — the seam where a non-git
   backend would plug in (`VcsDriverKind` currently registers only `"git"`).

The two paths never call each other. Worktree/status/PR work uses path 1; `CheckpointStore` uses
path 2.

Both stacks default to a **30 s timeout** (`DEFAULT_TIMEOUT_MS`) and a **1 MB** stdout/stderr cap
(`DEFAULT_MAX_OUTPUT_BYTES`), with per-call overrides — checkpoint diffs use a larger
`CHECKPOINT_DIFF_MAX_OUTPUT_BYTES`, review diff patches go to 120 KB via
`REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES`.

### 8.2 Worktree lifecycle

**Creation** (`GitVcsDriverCore.createWorktree`, lines 2751-2786): the target path defaults to
`<worktreesDir>/<repoBasename>/<branchName-with-slashes-as-dashes>`, where `worktreesDir` is
`<baseDir>/worktrees` (`apps/server/src/config.ts:120`, created recursively at startup). It runs
`git worktree add [-b <newRefName>] <path> <refName>`, and when both a new ref and a base ref are
given it also writes `branch.<newRefName>.gh-merge-base = <baseBranch>` into git config — **this is how
the base branch for a thread's stacked commit/push/PR flow is remembered without a database row.**

The caller is the turn-start handler's `bootstrap.prepareWorktree` (`ws.ts:913-952`). Before creating
the worktree it optionally does "start from origin": check `origin` exists, fetch it, and resolve the
remote-tracking commit for the base branch so the worktree starts from the freshest upstream state
rather than a stale local branch. After creation it dispatches `thread.meta.update` with the new
`branch`/`worktreePath` and calls `refreshGitStatus(targetWorktreePath)`.

**Removal** is `git worktree remove [--force] <path>`, exposed as RPC `vcsRemoveWorktree`. It does
**not** sweep the thread's checkpoint refs.

**Isolation guard**: `ReviewService.assertWorkspaceBoundCwd` canonicalises a requested `cwd` and
requires it to be inside either the main project root (`config.cwd`) or `config.worktreesDir` before
serving a diff preview or file-contents read — the one place `worktreesDir` is enforced as a security
boundary rather than a naming convention.

### 8.3 The checkpoint mechanism

Ref naming (`checkpointing/Utils.ts:4-9`):

```
refs/t3/checkpoints/<base64url(threadId)>/turn/<turnCount>
```

Being under `refs/t3/…` keeps checkpoints invisible to `git branch`, casual `git log --all`, GitHub
pushes, and so on — they only appear to someone running `git for-each-ref refs/t3`.

**Capture** (`GitVcsDriver.ts:703-782`) is the trick that makes this cheap and side-effect-free:

1. allocate a scratch index path inside the git common dir: `<gitCommonDir>/t3-checkpoint-index-<uuid>`;
2. set `GIT_INDEX_FILE` to that scratch path for every git invocation in this step, plus a fixed commit
   identity (`GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` = "T3 Code",
   `t3code@users.noreply.github.com`) — **never the user's own git identity**, since these commits are
   not meant to be pushed or shown as authored history;
3. if `HEAD` exists, `git read-tree HEAD` seeds the scratch index;
4. `git add -A -- .` stages the **entire current working tree, including untracked files**;
5. `git write-tree` → tree oid; `git commit-tree <tree> -m "t3 checkpoint ref=<ref>"` → commit oid,
   **parentless** — checkpoint commits are not chained; each is an independent snapshot;
6. `git update-ref <checkpointRef> <commitOid>`;
7. the scratch index file is removed in an `Effect.ensuring` finalizer regardless of outcome.

Because the scratch index is a distinct file and the commit has no parent, capture never mutates
`.git/index`, `HEAD`, or any branch, so it is safe to run while the agent is actively editing files.

**Restore** (lines 789-823): resolve the ref (falling back to `HEAD` when `fallbackToHead: true`);
`git restore --source <commit> --worktree --staged -- .`; `git clean -fd -- .` (which is why capture's
`git add -A` matters — untracked-at-capture files survive, anything untracked *since* is deleted); then
`git reset --quiet -- .` to unstage. Net effect: the working tree becomes byte-identical to the
snapshot, with `HEAD` and the current branch untouched.

**Diff**: `git diff --patch --no-color --no-ext-diff --no-textconv [--ignore-all-space]
<from>^{commit} <to>^{commit}`, output capped. `fallbackFromToHead` lets the "from" side degrade to
`HEAD` when a baseline ref is missing.

**Delete**: best-effort `git update-ref -d <ref>` per ref, non-zero exits swallowed.

`CheckpointStore` deliberately stores **no** metadata itself — it resolves the active `VcsDriver` for a
cwd and forwards. The read-model side lives in the orchestration projector.

### 8.4 `CheckpointReactor` — the process manager

`orchestration/Layers/CheckpointReactor.ts` (947 lines) is the single place that turns events into git
operations. The pure decider never touches git: `thread.checkpoint.revert` becomes a
`thread.checkpoint-revert-requested` **domain event** with no I/O; all git work happens later, outside
the decide/persist transaction.

It subscribes to domain events (`thread.turn-start-requested`, `thread.message-sent`,
`thread.checkpoint-revert-requested`, `thread.turn-diff-completed`) and provider runtime events
(`turn.started`, `turn.completed`), both feeding a single `DrainableWorker` queue so checkpoint
operations never race each other on the same worktree.

**Baseline capture** fires from *both* the provider's `turn.started` and the domain's
`turn-start-requested`/`message-sent` — belt and braces against ordering races — capturing a checkpoint
at the current max turn count if one does not already exist, so turn 0's "before anything happened"
snapshot exists even if the agent never gets scheduled.

**Turn-completion capture** has two paths that intentionally race and de-duplicate:
`captureCheckpointFromTurnCompletion` on the provider's `turn.completed`, and
`captureCheckpointFromPlaceholder` on the domain's `thread.turn-diff-completed` when its
`status === "missing"` — a *placeholder* checkpoint that `ProviderRuntimeIngestion` inserts from
Codex's own `turn.diff.updated` event. The comment explains why both exist: the cold-per-subscription
PubSub caveat means `turn.completed` is not reliably delivered here, so the domain-event path is the
reliable one and the runtime path is a fast path.

Both converge on `captureAndDispatchCheckpoint`, which: verifies (log-only) that the previous turn's
baseline ref exists; captures; calls **`workspaceEntries.refresh(cwd)`** so the `@`-mention picker
reflects files created or deleted this turn; diffs `prevTurn → thisTurn` and parses the unified diff
into a per-file additions/deletions summary via `parseTurnDiffFilesFromUnifiedDiff`, which uses
**`@pierre/diffs`' `parsePatchFiles`** — the same library the client uses, so diff parsing is
consistent end to end; dispatches `thread.turn.diff.complete`; and appends an info-level "Checkpoint
captured" activity. If only the diff-summary step fails, an error activity is appended
("Checkpoint captured, but turn diff summary is unavailable…") but **the checkpoint is not rolled
back** — a checkpoint with no readable diff summary is still a valid revert target.

The projector carries a matching **anti-regression guard**: a placeholder checkpoint
(`status: "missing"`) must never clobber a checkpoint already captured with a real git ref
(`status: "ready"`), because the reactor can legitimately emit several diff-completed events per turn.

**Revert** (`handleRevertRequested`, lines 690-818): resolve the thread and its active session's cwd
(revert only targets a thread with a live, cwd-bound session); guard that the requested `turnCount`
does not exceed the current max; resolve the target ref (turn 0 is *synthesised* rather than looked
up); `restoreCheckpoint(…, fallbackToHead: turnCount === 0)`; `workspaceEntries.refresh(cwd)`; then —
the one place checkpointing reaches outside git —
`providerService.rollbackConversation({threadId, numTurns: currentTurnCount - turnCount})`, which calls
`adapter.rollbackThread` to rewind the underlying CLI's own conversation state. Without it the
filesystem and the agent's memory of "what happened" would drift apart. Finally it deletes every
checkpoint ref *after* the target (the only place ref cleanup happens) and dispatches
`thread.revert.complete`, whose projection trims `thread.checkpoints[]`, `messages` and `activities`
down to what is reachable from the retained turn ids. Every failure branch appends a
`checkpoint.revert.failed` activity with human-readable detail rather than surfacing a raw error.

**Worktree-branch-drift follow** rides the same `turn.completed` handler: if an agent or the user runs
a bare `git checkout` inside a thread's worktree, bypassing T3's own RPCs, the thread's recorded branch
goes stale, which (per the comment, referencing issue #4460) silently orphans the thread's PR
association. The handler detects drift via `vcsStatusBroadcaster.refreshLocalStatus` and adopts the
checked-out branch — but only when the worktree is exclusively owned by one thread, and via a
compare-and-swap dispatch (`expectedBranch: thread.branch`) so a concurrent rename cannot be clobbered.

### 8.5 The read side

`CheckpointDiffQuery.ts` answers two RPCs:

- `getTurnDiff({threadId, fromTurnCount, toTurnCount})` — short-circuits to an empty diff if from ==
  to; otherwise reads the thread's checkpoint list from `ProjectionSnapshotQuery`, validates
  `toTurnCount`, resolves both refs, and diffs with `fallbackFromToHead: false` (a missing ref here is
  a hard `CheckpointRefUnavailableError`, unlike the capture path).
- `getFullThreadDiff({threadId, toTurnCount})` — same, with `from` always the synthesised turn-0 ref.

Both **validate their own output against the RPC's Schema before returning**, failing closed with
`CheckpointDiffResultInvalidError` rather than shipping a malformed payload.

The `ignoreWhitespace` flag defaults to `true` for both reads but `false` in the capture-time diff — so
the inline file-summary stats count whitespace-only changes while the diff *panel* defaults to hiding
them.

Client side: `ChangedFilesTree.tsx` renders the **precomputed** file list already sitting in the
projected `thread.checkpoints[].files`; only the "Open diff" button calls the diff RPC. Reverting has
no dedicated RPC — `revertThreadCheckpoint` wraps a `thread.checkpoint.revert` command through the same
generic `dispatchCommand`.

Persistence split: checkpoint *content* lives only in the git object database; SQLite stores only the
metadata the projector folds from events (`{turnId, checkpointTurnCount, checkpointRef, status, files[],
assistantMessageId, completedAt}`), capped at 500 per thread. Losing the DB loses the turn→ref mapping,
not the objects.

### 8.6 Live git status streaming

`vcs/VcsStatusBroadcaster.ts` is what the toolbar and branch UI watch, and it re-triggers after every
git action. Per-cwd cache of `{local, remote}` status parts, each fingerprinted via `JSON.stringify` so
a refresh producing byte-identical output does not re-publish. `streamStatus(cwd)` returns an immediate
snapshot from cache, then live updates from an internal `PubSub`. Local refresh is triggered
synchronously by `CheckpointReactor` after every `turn.completed`. Remote status (ahead/behind, PR
lookup) runs on a **per-cwd, ref-counted background fiber** started only while at least one subscriber
is watching, default interval 30 s (`DEFAULT_VCS_STATUS_REFRESH_INTERVAL`), additionally gated by
`BackgroundPolicy.shouldRunScopeWork`. On failure the poll interval backs off exponentially from 30 s
to a **15-minute cap** — the same doubling-backoff shape appears independently in three places in this
area (`GitManager`'s PR-lookup cache, `GitVcsDriverCore`'s upstream-fetch cache, and here).

**Failure philosophy throughout:** log plus a user-visible activity, do not crash the turn. Checkpoint
capture/restore/diff failures become `checkpoint.capture.failed` / `checkpoint.revert.failed` thread
activities with human-readable `detail`, not thrown RPC errors that would break the chat UI.

---

## 9. Feature: source control (commit, push, PR)

These adapters sit alongside checkpointing, not underneath it, sharing only the git plumbing and the
`worktreesDir` convention.

**Port.** `pullRequest/PullRequestProvider.ts` defines `PullRequestProviderApi`, a large
capability-flagged interface (`PullRequestCapabilities`). Every optional method
(`listChangeRequestsAcross`, `getDiffFileContents`, `updateChangeRequest`, `updateComment`, reviewer /
reaction / thread-resolution ops) is only called when the provider *declared* support — unsupported
operations are declared, not runtime-probed.

**Registry.** Four concrete providers: GitHub, GitLab, Bitbucket, Azure DevOps, each built from a
`*Cli.ts`/`*Api.ts` transport plus a `*Provider.ts` adapter and a `*Json.ts` decoder. A
`SourceControlProviderKind` with no registered provider still appears in listings as "unimplemented"
rather than being hidden.

**Two entirely different transports:**

- **GitHub / GitLab / Azure DevOps** shell out to the vendor's own CLI (`gh`, `glab`, `az devops`) via
  `VcsProcess`/`ProcessRunner`. **Auth is whatever `gh auth login` / `glab auth login` / `az login`
  already set up on the machine running the T3 server — T3 never handles OAuth for these three.**
  `sourceControl/gitHubAuthStatus.ts` parses `gh auth status --json` to answer the settings page's
  "which providers are connected" query, and `classifyNonZeroExit` pattern-matches stderr text
  ("gh auth login", "not logged in", "api rate limit exceeded", …) to turn a bare non-zero exit into a
  typed `authentication` / `rate-limited` / `not-found` / `command-failed` reason.
- **Bitbucket** is the odd one out — a direct `HttpClient` against Bitbucket's REST API, authenticated
  via environment variables read through `effect/Config`: `T3CODE_BITBUCKET_ACCESS_TOKEN` (bearer,
  preferred) or `T3CODE_BITBUCKET_EMAIL` + `T3CODE_BITBUCKET_API_TOKEN` (HTTP basic). No CLI, no
  interactive login inside T3.

**Provider detection** is separate from the PR-provider registry:
`sourceControl/SourceControlProviderRegistry.ts` resolves a `cwd` by reading its git remotes and
matching the remote URL, preferring `origin`, caching for 5 s. An unrecognised host falls through to
`refineUnknownRemoteProvider`/`probeSourceControlProvider`, which shells out to each candidate CLI to
see which one recognises the repo (the self-hosted Enterprise case).

**`GitManager.ts`** (2335 lines) is the stacked-action orchestrator behind the toolbar's buttons:
`GitStackedAction` = `commit` / `commit_push` / `commit_push_pr` / `push` / `create_pr`. It layers
`GitVcsDriver` plus `TextGeneration` (LLM-generated commit messages and PR titles, per configured
writing style — conventional-commits, repo-conventions-inferred-from-recent-log, or custom
instructions) plus the PR-provider lookup. It keeps its own short-TTL caches (status 1 s, PR lookup 2
minutes with exponential per-branch backoff on failure) and a cross-repository / forked-PR head-matching
algorithm (`matchesBranchHeadContext`) to answer "does this branch already have an open PR" even when
the head lives in a fork.

A `pull-request` surface is one of the right panel's kinds; the PR tab's colour tone by state is
merged `text-violet-600 dark:text-violet-300/90`, closed `text-red-600 dark:text-red-300/90`, draft
`text-zinc-500 dark:text-zinc-400/80`, open `text-emerald-600 dark:text-emerald-300/90`.

---

## 10. Feature: terminals

The server owns every PTY. Clients reach them only over the one authenticated RPC WebSocket, and
**the renderer choice never crosses the wire** — every client receives the same raw byte stream and
sends back raw bytes.

### 10.1 The wire contract

`packages/contracts/src/terminal.ts`. **Terminal ids are always chosen by the client** — line 32 says
so explicitly: *"Terminal ids are ALWAYS chosen by the client and sent explicitly — no server-side
allocation."* `DEFAULT_TERMINAL_ID = "term-1"`; the allocator is `nextTerminalId()` in
`packages/shared/src/terminalLabels.ts` (lowest unused `term-N`).

Bounds: cols `1..1000`, rows `1..500`; terminal id ≤ 128 chars; a `write` payload is 1..65 536 chars;
`env` is `Record<[A-Za-z_][A-Za-z0-9_]*, string ≤ 8192>` with ≤ 128 properties.

Two read shapes: `TerminalSessionSnapshot` (heavy — includes the full `history` string plus
`status | pid | exitCode | exitSignal | label | updatedAt | sequence`) and `TerminalSummary` (light —
same minus history, plus `hasRunningSubprocess`). Two stream unions:
`TerminalEvent = started | output | exited | closed | error | cleared | restarted | activity` and
`TerminalAttachStreamEvent` (same with `started` replaced by `snapshot`), plus
`TerminalMetadataStreamEvent = snapshot | upsert | remove`. Every event carries an optional monotonic
`sequence`.

Nine RPC methods — `terminal.open`, `terminal.attach` (stream), `.write`, `.resize`, `.clear`,
`.restart`, `.close`, `subscribeTerminalEvents`, `subscribeTerminalMetadata` — all mapped to
`AuthTerminalOperateScope = "terminal:operate"`.

### 10.2 Server: `TerminalManager`

`apps/server/src/terminal/Manager.ts` (2707 lines). Constants:

```
DEFAULT_HISTORY_LINE_LIMIT              5_000
DEFAULT_PERSIST_DEBOUNCE_MS                40
DEFAULT_SUBPROCESS_POLL_INTERVAL_MS     1_000
DEFAULT_PROCESS_KILL_GRACE_MS           1_000
DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS    128
DEFAULT_OPEN_COLS / ROWS               120 / 30
TERMINAL_ENV_BLOCKLIST  = {PORT, ELECTRON_RENDERER_PORT, ELECTRON_RUN_AS_NODE}
MAX_TERMINAL_LABEL_LENGTH                 128
```

Session key is `` `${threadId}\u0000${terminalId}` ``. A per-thread `Semaphore(1)` serialises
`open/resize/clear/restart/close`; `write` is deliberately **not** locked. PTY callbacks push into a
per-session `pendingProcessEvents` array and fork a drain if none is running; the drain is a
synchronous state machine returning one action per turn, so output and exit ordering stay exact even
though `onData`/`onExit` fire from outside the Effect runtime.

**Shell resolution**: `pwsh.exe` on win32, else `$SHELL ?? "bash"`, with an ordered fallback list
walked by `trySpawn`, retrying **only** on errors that look like "not found"
(`posix_spawnp failed | enoent | not found | file not found | no such file`). win32 order: requested →
`pwsh.exe` → `…\WindowsPowerShell\v1.0\powershell.exe` → `powershell.exe` → `%ComSpec%` →
`…\System32\cmd.exe` → `cmd.exe`. posix order: requested → `$SHELL` → `/bin/zsh` → `/bin/bash` →
`/bin/sh` → `zsh` → `bash` → `sh`. Per-shell arg tweaks: PowerShell gets `-NoLogo`; zsh gets
`-o nopromptsp`.

**Environment scrubbing** inherits the *full* server environment minus a blocklist. The comment
explicitly rejects an allowlist ("would silently strip PSModulePath, DISPLAY, proxies, toolchain
variables"). Excluded: anything starting `T3CODE_` or `VITE_`, plus the three blocklist names. There is
a dedicated **AppImage scrub** (issues #1699, #5059) that drops `APPIMAGE/APPDIR/ARGV0/OWD` and strips
`$APPDIR`-rooted segments out of `PATH`/`LD_LIBRARY_PATH`/`XDG_DATA_DIRS`/`GSETTINGS_SCHEMA_DIR`,
deleting a variable entirely if nothing survives.

**History is not the byte stream.** Scrollback persists as plain files under
`ServerConfig.terminalLogsDir` = `join(logsDir, "terminals")`, named
`terminal_<base64url(threadId)>.log` for `term-1` and
`terminal_<base64url(threadId)>_<base64url(terminalId)>.log` otherwise, with a legacy path migrated on
first read and then deleted. Writes go through `makeKeyedCoalescingWorker` keyed by session, merging
queued requests and sleeping 40 ms unless `immediate`; `capHistory` keeps the last 5000 lines.
`sanitizeTerminalHistoryChunk` (lines 867-1067) is a **VT-aware filter that strips query/response
control sequences** while keeping everything visual — it maintains a pending-sequence buffer across
chunk boundaries, understands both 7-bit and 8-bit forms, and drops CSI `n` (DSR), CSI `R` (CPR), DA
(`>…c` / `…c`), DECRQM/DECRPM (`…$p` / `…$y` — the `$` guard deliberately preserves DECSTR `!p` and
DECSCL `"p`), XTVERSION (`>…q`, while DECSCUSR with a space intermediate survives), Kitty keyboard
query (`?…u`, while bare `u` restore-cursor survives), DCS `[01]?[$+][qr]` (DECRQSS/XTGETTCAP), and OSC
`10;`/`11;`/`12;` with `?` or `rgb:`. The rationale: replaying a stored query makes the *live* terminal
answer again and the shell echoes the answer as junk at the prompt.

**Subprocess activity polling** runs every 1000 ms while any session is running: on win32 one
`powershell.exe -NoProfile -NonInteractive -Command 'Get-CimInstance Win32_Process …'` producing
`pid|ppid|name` lines (1500 ms timeout, 32 KiB cap); on posix `pgrep -P <pid>` falling back to
`ps -eo pid=,ppid=` plus `ps -p <child> -o comm=`/`-o args=`. It produces both a `hasRunningSubprocess`
flag with a normalised child-command label **and the full transitive pid set** of the terminal's
process tree, handed to `PortDiscovery.registerTerminalProcesses` — this is how browser preview learns
which listening ports belong to which terminal. `terminalWireLabel`: if a subprocess is running and has
a label, **the tab title is that command name** (e.g. `vim`, `pnpm`); otherwise "Terminal 1".

Lifecycle details: `open` on an existing session compares launch context (`cwd`, sorted `runtimeEnv`,
`worktreePath`) and, if it changed, stops the process and **wipes history**. Kill escalates SIGTERM →
1000 ms → SIGKILL on a fiber registered in `killFibers` so a fast restart can interrupt it. Inactive
sessions above 128 are evicted oldest-first. `write` to an exited session is a silent no-op; `resize`
on a missing session is a no-op "because ResizeObserver traffic can already be in flight when the UI
closes the session". `attachStream` subscribes **first**, buffers, then opens/attaches, emits the
initial snapshot, replays buffered events skipping duplicates by `sequence`, then goes live.

**PTY adapter seam**: `PtyProcess {pid, write, resize, kill, onData, onExit}`. `NodePtyAdapter` wraps
`node-pty` with two platform hacks — it chmods node-pty's `spawn-helper` to `0755` once per process
because packaged builds lose the bit, and on Windows injects `TERM=xterm-256color` because "the ConPTY
path leaves the environment untouched". `BunPtyAdapter` uses `Bun.spawn(cmd, {terminal: {…}})` and
**dies at layer construction on win32** with a user-facing message telling the user to run `npx t3`.

### 10.3 The web renderer: Ghostty via WebAssembly

`apps/web/src/terminal/ghostty/` is a browser adapter over the **official `libghostty-vt` C ABI**,
explicitly *not* an xterm compatibility layer (it replaced xterm.js).

- **`runtime.ts`** loads `vendor/ghostty-vt.wasm` with a single import `env.log`. **Struct layouts are
  discovered at runtime, not hardcoded**: `ghostty_type_json()` returns a JSON blob of
  `{TypeName: {size, align, fields: {name: {offset, size, type}}}}`, and `setField`/`readField`
  dispatch on the declared field type. Exactly one size escapes this:
  `SELECTION_FORMAT_OPTIONS_SIZE = 16`. A **second, 112-byte WASM module**
  (`ghostty-write-pty.wasm`, four lines of Zig) exists purely as a function-pointer trampoline: WASM
  cannot call back into JS through a C function pointer, so the trampoline is installed into the main
  module's `__indirect_function_table` and passed as the terminal's write-pty option, with the JS-side
  writer keyed by an integer userdata id. The install comment records a real browser bug: *"grow-then-set
  instead of grow(1, fn): WebKit stores a grow init value with broken type information and every later
  call_indirect through the entry traps with a signature mismatch."* `loadGhosttyRuntime()` memoises a
  module-level promise → **one compiled module and one linear memory per browser tab**, shared by all
  split terminals.
- **`core.ts`** (1207 lines) owns one Ghostty terminal per surface, `MAX_SCROLLBACK_ROWS = 10_000`.
  `resetAndWrite()` (used for buffer replay) calls `ghostty_terminal_reset` (RIS), **detaches the PTY
  writer**, replays, then reattaches — *"Restoring captured scrollback temporarily detaches the PTY
  callback so historical device queries cannot emit replies into the current shell."* RIS also resets
  the cursor, so `applyDefaultCursorBlink()` re-applies embedder option 23 (blink = 1) to match the
  previous xterm.js `cursorBlink: true`, while DECSCUSR / DEC mode 12 still win. Key encoding is
  two-pass sized (call with a null output to learn the size, expecting `GHOSTTY_OUT_OF_SPACE = -3`).
  Bracketed paste is done by Ghostty (`ghostty_paste_encode` after querying DEC 2004), not by string
  concatenation. Mouse encoding gets the full geometry so SGR/X10 encoding and motion filtering are
  Ghostty's job. `snapshot()` walks only **dirty rows**; `faint` blends via `(front*155 + back*100)/255`.
- **`keyCodes.ts`** is a literal transcription of Ghostty's `GhosttyKey` enum order keyed by W3C
  `KeyboardEvent.code`, plus `loadGhosttyKeyboardLayoutMap()` using `navigator.keyboard.getLayoutMap()`.
  `ghosttyUnshiftedCodepoint` returns **0** when the unshifted form is genuinely unknowable, because
  "reporting the shifted character as unshifted corrupts Kitty alternate keys".
- **`renderer.ts`** is a pure paint function. Three passes per row: background runs coalescing
  consecutive cells with equal `background` + `selected`; text runs coalescing on fg colour + bold +
  italic + invisible (deliberately *not* on selection — *"splitting a text run at a selection boundary
  visibly shifts glyph spacing"*), each clipped to its cell box; then decorations. Cell metrics: width
  from `measureText("M")`, height `max(1, round(fontSize * 1.35), ceil(ascent + descent))`, baseline
  centred. Cursor styles: `0` bar (2 px), `2` underline (2 px), `3` hollow rect, default filled block
  with the glyph re-drawn in the background colour; **unfocused always draws hollow** "so the active
  pane is obvious". `DEFAULT_SELECTION_BACKGROUND = "rgba(72, 122, 191, 0.35)"`.
- **`surface.ts`** (1692 lines) builds three DOM nodes into the mount: a `<canvas class=
  "t3-ghostty-canvas">` with `getContext("2d", {alpha: false})` and `aria-hidden="true"`; a 1×1 px
  `opacity: 0` `<textarea class="t3-ghostty-input">` as the hidden IME target
  (`aria-label="Terminal input"`, `autocapitalize=off`, `spellcheck=false`); and a
  `<div class="t3-ghostty-scrollbar">` with `role="scrollbar"`.

Design constants:

```
DEFAULT_TERMINAL_FONT_SIZE   12        (clamped 6..32)
CONTENT_PADDING              4 px
MIN_SCROLLBAR_THUMB_HEIGHT   18 px
CURSOR_BLINK_INTERVAL_MS     500       (half a cycle)
DEFAULT_TERMINAL_FONT_FAMILY '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", '
                             + TERMINAL_GLYPH_FALLBACKS
TERMINAL_GLYPH_FALLBACKS     '"Symbols Nerd Font Mono", "Symbols Nerd Font", "JetBrainsMono Nerd Font",
                              "JetBrainsMono NF", "FiraCode Nerd Font", "Hack Nerd Font", "MesloLGS NF",
                              "CaskaydiaCove Nerd Font", "PowerlineSymbols", monospace'
```

Concrete names only — an unknown keyword like `ui-monospace` makes the canvas font shorthand
unparseable and the assignment silently no-ops; family names are also quoted defensively for the same
reason. A **symbols-only Nerd Font is vendored and registered lazily**:
`fonts/SymbolsNerdFontMono-Regular.woff2` (1.18 MB, MIT), loaded once per page as a `FontFace` named
`"Symbols Nerd Font Mono"`; because it carries no text glyphs it composes with any face without
changing metrics. A user-chosen family is **rejected unless `isMonospaceFamily()` passes** (a
proportional face would draw text narrower than its own cells). All four style variants are pre-loaded
with the probe string `"iMW0@# ."` before measuring, and a `document.fonts` `loadingdone` listener
re-measures and refits.

Layout: grid size is `floor((width - 2*padding)/cellWidth) × floor((height - 2*padding)/cellHeight)`.
**The grid is bottom-anchored once scrollback exists** — the sub-row remainder moves *above* row 0 so
the prompt stays pinned to the bottom edge during resizes. Canvas backing store is
`round(cssSize * devicePixelRatio)` with a matching `setTransform`, and the
`matchMedia("(resolution: Xdppx)")` listener is **re-armed after every change** because such a query
fires once. A `ResizeObserver` triggers a *synchronous* render "so the browser never composites the old
backing store stretched into the new element box". **The PTY is only told about settled dimensions**:
`notifyResize()` debounces 150 ms and `dispose()` flushes a pending notify.

Input: a `beforeKey` hook runs first (React owns keybindings); IME guards cover `isComposing`,
`key === "Process"`, and **`keyCode === 229`** ("Safari's only signal that this keydown opens an IME
composition"). Keyup encodes a release event too, since Ghostty only emits bytes when the app enabled
Kitty report-event-types, and `suppressedKeyCodes` makes a keydown swallowed by `beforeKey` also
swallow its keyup, surviving blur. **Paste races two paths on purpose**: `navigator.clipboard.readText()`
guarded by a `pasteShortcutToken`, and the browser's native `paste` event which always
`preventDefault()`s and re-encodes, because a textarea would otherwise leak unbracketed text through
`input`. `shouldReportTerminalMouse` = tracking && no shift/ctrl/meta — **Shift bypasses application
mouse capture**, matching xterm convention. Click count 1/2/3 → cell/word/line with a 500 ms + 4 px
repeat window; selection anchors are stored in **screen** coordinates so streaming output cannot shift
a drag's origin; dragging past the edge autoscrolls on an 80 ms interval. On the alternate screen with
no mouse tracking, wheel translates into arrow keys (`\u001b[A/B`, or `\u001bOA/OB` in
application-cursor-keys mode). Cursor blink is disabled when unfocused, when Ghostty says not blinking,
or under `prefers-reduced-motion: reduce` — and the reduced-motion listener exists precisely because
"nothing else wakes an idle steady cursor". The hidden textarea is repositioned onto the cursor cell
every frame so the IME candidate window appears where the user is typing.

**Links**: `linkAt()` prefers a real OSC 8 hyperlink (expanding left/right across soft wraps),
otherwise falls back to regex detection —
`URL_PATTERN = /https?:\/\/[^\s"'`<>]+/g` and a file-path pattern covering `~/`, `./`, `../`, `/`,
`C:\`, UNC, and bare `a/b/c:12:4` forms. Trailing `.,;!?` are trimmed and unbalanced `)`/`]`/`}` peeled
off. `resolvePathLinkTarget` resolves `~/` by *inferring* the home directory from the cwd
(`/Users/x`, `/home/x`, `C:\Users\x`). Activation modifier is Cmd on mac, Ctrl elsewhere.

### 10.4 The React shell

`ThreadTerminalDrawer.tsx` (1589 lines). **React renders an empty `<div>`** —
`relative h-full w-full overflow-hidden rounded-[4px] bg-background` — and never touches a terminal
frame. The setup effect depends only on `[cwd, environmentId, runtimeEnvKey, terminalId, threadId,
worktreePath]`; `autoFocus` is deliberately excluded so focus changes never tear down a terminal. The
only React-visible signal is a monotonically increasing `version` counter, and the buffer sync does a
**`startsWith` prefix check**: if the new buffer starts with the old one it writes only the delta,
otherwise it does a full RIS-and-replay.

Client buffering (`terminalSession.ts`): `DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024`, and
`trimBufferToBytes` trims from the front then walks forward past UTF-8 continuation bytes
(`(byte & 0b1100_0000) === 0b1000_0000`) so trimming never splits a codepoint. Command scheduling has
two policies: lifecycle commands (`open/clear/restart/close`) run `{mode: "serial", key: [environmentId,
threadId]}`; `resize` runs `{mode: "latest", key: [environmentId, threadId, terminalId]}` so only the
newest resize survives; `write` is unthrottled.

Theme: `terminalThemeFromApp()` reads `--terminal-background/-foreground/-cursor/-selection-background`
off `document.documentElement`, falling back to the computed `.thread-terminal-drawer`
background/colour, then `document.body`, then hardcoded `rgb(14,18,24)`/`rgb(237,241,247)` (dark) or
`rgb(255,255,255)`/`rgb(28,33,41)` (light); cursor falls back to `rgb(180,203,255)` /
`rgb(38,56,78)`. Any CSS colour string is normalised to RGB by painting it into a 1×1 canvas and
reading the pixel. A `MutationObserver` on `documentElement`'s `class`/`style` re-applies on theme
toggles.

**Selection → composer.** On mouseup, after 260 ms for multi-click (0 otherwise), the drawer calls
Electron's native context menu with `[{id: "add-to-chat", label: "Add to chat"}, {id: "copy", label:
"Copy"}]`. "Add to chat" emits a `TerminalContextSelection {terminalId, terminalLabel, lineStart,
lineEnd, text}` with **screen** line numbers + 1. This is the producer side of the composer's
terminal-context chips — **and it only exists when `localApi` is present, i.e. in the desktop shell.**
The format (`lib/terminalContext.ts`) is an inline label `@terminal-1:12-18` occupying a single
`\uFFFC` in the composer, plus a prompt block appended on send:

```
<terminal_context>
- Terminal 1 lines 12-18:
    12 | …
    13 | …
</terminal_context>
```

(two-space indent, `NN | ` gutter). The same block is parsed back off displayed user messages so it
never shows in the bubble. A context whose text normalises to empty is "expired" and renders in
destructive colours.

Drawer chrome: `aside.thread-terminal-drawer` carries `data-terminal-owner="drawer" |
"right-panel"` — that attribute is how `lib/terminalFocus.ts` answers "is a terminal focused", by
walking `document.activeElement.closest("[data-terminal-owner]")`. Sizing: `MIN_DRAWER_HEIGHT = 180`,
`MAX_DRAWER_HEIGHT_RATIO = 0.75` of `window.innerHeight`, default
`DEFAULT_THREAD_TERMINAL_HEIGHT = 280`; the drag handle is
`absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize` using pointer capture. Splits:
`MAX_TERMINALS_PER_GROUP = 4`, rendered as a CSS grid (`repeat(N, minmax(0,1fr))`) with
`border-l first:border-l-0` separators, `border-border` on the active pane and `border-border/70`
otherwise, each pane wrapped in `h-full p-1`. The floating single-terminal toolbar is
`absolute right-2 top-2 z-20 … inline-flex items-center overflow-hidden rounded-md border
border-border/80 bg-background shadow-xs` with four `p-1` buttons separated by `h-4 w-px bg-border/80`
dividers, icons at `size-3.25` (`SquareSplitHorizontal`, `SquareSplitVertical`, `Plus`, `Trash2`). The
terminal sidebar (shown with >1 terminal) is `w-36 min-w-36 border border-border/70 bg-muted/10` with
a 22 px header, group headers at `text-[10px] uppercase tracking-[0.08em]`, rows at `text-[11px]`,
active `bg-accent text-foreground`, and nested rows prefixed with a literal `└` glyph indented via
`ml-1 border-l border-border/60 pl-1.5`.

UI state persists in a zustand store, key `"t3code:terminal-state:v1"`, per scoped thread:
`{terminalOpen, terminalHeight, terminalIds, activeTerminalId, terminalGroups, activeTerminalGroupId}`.
Closing a terminal calls `terminal.close` with `deleteHistory: true` and, **if the RPC fails, falls
back to writing the literal string `"exit\n"` into the PTY**.

**The terminal reshapes the global keymap.** Defaults:

```
mod+j        terminal.toggle
mod+d        terminal.split            when: terminalFocus
mod+shift+d  terminal.splitVertical    when: terminalFocus
mod+n        terminal.new              when: terminalFocus
mod+w        terminal.close            when: terminalFocus
mod+d        diff.toggle               when: !terminalFocus
```

and nine other global bindings (`commandPalette.toggle`, `filePicker.toggle`, `chat.new`,
`composer.stash`, `modelPicker.toggle`, …) carry `when: "!terminalFocus"`. Inside the surface,
`beforeKey` returns `false` for those terminal/diff shortcuts and intercepts a few emacs/readline
shortcuts, sending raw bytes over the write RPC instead: `Ctrl+L` (or `Cmd+K` on mac) → `\u000c`
(clear), mac `Cmd+Backspace` → delete-to-line-start, `Alt/Ctrl + Arrow` → word motion, `Cmd + Arrow` →
line start/end.

### 10.5 Three renderers, two Ghostty artifacts, two pins

- **Web + Android** share `libghostty-vt` @ `9f62873bf195e4d8a762d768a1405a5f2f7b1697`
  (`native/libghostty-vt/VERSION`), the C ABI where the embedder renders. Android is a local Expo
  module with prebuilt `libghostty-vt.so` checked in for all four ABIs, linked with
  `-Wl,-z,common-page-size=16384 -Wl,-z,max-page-size=16384` for Android 16 KB pages, a JNI shim
  compiled `-std=c++17 -Wall -Wextra -Werror`, and a **bespoke binary snapshot format**: little-endian,
  magic `0x54563354` ("T3VT"), version 1, 32-byte header, then `cols*rows` cells of
  `[fg argb u32][bg argb u32][flags u16][textLen u16][utf8 bytes]` with flags bitfield bold 1, italic 2,
  faint 4, inverse 8, invisible 16, strikethrough 32, overline 64, underline 128, selected 256. PTY
  replies are **returned as the return value of `nativeFeed`/`nativeResize`**, not through a JNI
  callback. Fonts are MesloLGS NF Regular/Bold shipped as assets. Mobile terminal palettes are hardcoded
  ("Pierre" light/dark): light bg `#f2f2f7` fg `#6C6C71` cursor `#009fff`; dark bg `#0a0a0a` fg
  `#adadb1`; ANSI 16 = `#1F1F21 #ff2e3f #0dbe4e #ffca00 #009fff #c635e4 #08c0ef #c6c6c8`.
- **iOS** embeds a *different artifact entirely*: the full `GhosttyKit.xcframework` (44 MB) built from a
  **custom-I/O fork** (`Yash-Singh1/ghostty@custom-io`), pinned separately at
  `d36c3b8dffd0d756dd5e5f4933962f774a0e6753`. libghostty renders itself there.

**The pin is verified from inside the binary.** The web wasm build embeds the Ghostty git revision as
semver build metadata, and `runtimeAbi.test.ts` imports the wasm inline, asserts
`byteLength < 750_000` (actual 630 932), calls `ghostty_build_info` and compares the embedded revision
against `native/libghostty-vt/VERSION` — one pin, no copy to keep in sync. The same test runs 25
create/write/free cycles with multi-codepoint graphemes (`é`, the 4-person ZWJ family emoji, Arabic).

---

## 11. Feature: workspace files — tree, search, and the in-app editor

One server-side index backs three user-facing features; the client file panel is a real code editor,
not a viewer.

### 11.1 The native index

Every workspace root gets **one or two native file indexes** built by `@ff-labs/fff-node` 0.9.4
(`FileFinder`), held in an Effect `LayerMap` keyed by `` `${variant}\n${cwd}` `` (`"\n"` chosen because
it "cannot appear in a filesystem path") with a 15-minute idle TTL. A **paths** variant (content
indexing disabled) answers the file tree, the composer's `@` search, and the ⌘P picker; a separate
**content** variant answers the ⇧⌘F grep. The composite key is what keeps the cheap and expensive
indexes as independent resources with independent lifetimes.

```ts
WORKSPACE_INDEX_MAX_ENTRIES      = 25_000
WORKSPACE_INDEX_PAGE_SIZE        = 25_002        // MAX_ENTRIES + 2
WORKSPACE_INDEX_SCAN_TIMEOUT     = "15 seconds"
WORKSPACE_INDEX_IDLE_TTL         = "15 minutes"
CONTENT_SEARCH_TIME_BUDGET_MS    = 250
CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 100
```

```ts
FileFinder.create({ basePath: cwd, disableMmapCache: true,
  disableContentIndexing: variant !== "content", aiMode: false,
  enableFsRootScanning: true, enableHomeDirScanning: true })
```

`FileFinder.create` returns a `Result<T>` rather than throwing, so every call site handles both a
thrown defect and a returned error string — and **deliberately keeps the returned error string out of
the Effect cause chain** (two tests assert this). Warmup is explicit
(`finder.waitForIndexReady(15_000)`); a `false` return is a timeout, not an error, and becomes
`WorkspaceSearchIndexScanTimedOut`. Index construction is `Effect.acquireRelease`d so `destroy()` runs
on scope close.

Four operations: `list()` (`mixedSearch("")`), `search(query, limit, kind?, imageOnly?)`,
`searchContents(input)` (a `GrepCursor` loop), `refresh()`.

`list()` is subtle: `mixedSearch("")` returns files *and* directories, but only directories that
themselves matched, so `withDirectoryAncestors` synthesises every missing ancestor entry so the tree
has no holes, then sorts by `path.localeCompare` and slices to 25 000. `search()` uses a page size of
`limit + 1` normally, but for `imageOnly` requests the full 25 002 page — because image filtering
happens *after* the search, so a small page would return a page of `.ts` files and zero images.

`searchContents()` is a cursor pump under a wall-clock deadline. Case-insensitive **plain** mode relies
on fff's *smart case* (lowercase the needle, set `smartCase: true`); case-insensitive **regex** mode
instead prepends the inline flag `` `(?i)${query}` `` (Rust regex syntax), because smart case does not
apply to regex. **Whole-word is a post-filter, not a pattern rewrite** — the comment explains that
consuming boundaries like `(?:^|\W)` swallow the separator between adjacent matches and widen reported
ranges, and `\b` cannot match punctuation-edged queries; `isWholeWordRange` reimplements VS Code's rule
by hand (an edge is a boundary if it touches the line edge, the neighbouring char is not a word char,
**or the match's own edge char is not a word char**), with word-ness as
`/[\p{Letter}\p{Mark}\p{Number}_]/u` and surrogate-pair-aware `codePointBefore`. Because filtering can
empty a page, the loop re-greps with `result.nextCursor` until it has `limit` matches, the cursor is
null, or the 250 ms deadline passes. fff returns **byte** ranges, converted to string offsets with
`Buffer.from(line).subarray(0, byteOffset).toString().length`.

`WorkspaceEntries` is what clients call. `search` passes the query through `normalizeSearchQuery` with
`trimLeadingPattern: /^[@./]+/` — which is why typing `@src/foo` in the composer works — while
`searchContents` passes the query **unmodified** (whitespace is significant). `refresh(cwd)` iterates
both variants but **skips any variant not currently in the map**, so refreshing never forces an index
to be built, and on failure logs a warning and invalidates the key so the next request rebuilds.
`browse` is *not* index-backed: a raw `readdir(parentPath, {withFileTypes: true})` used by the "add
project" autocomplete, returning **directories only**, expanding `~`, rejecting Windows-style paths on
non-Windows hosts, showing dotfiles only when the query ends in a separator or starts with `.`, and
swallowing `EACCES`/`EPERM` into an empty listing.

Behaviour that comes from the native index, asserted by repo tests rather than implemented in repo
code: gitignored paths are excluded; tracked paths matching ignore rules are excluded; **`.convex` is
excluded in non-git workspaces**; file search is typo-resistant (query `compoesr` matches
`src/components/Composer.tsx`); exact basename matches rank ahead of broader path matches. Result items
carry `accessFrecencyScore`, `modificationFrecencyScore`, `totalFrecencyScore`, and `gitStatus`, which
is what makes **an empty query a meaningful request** — the contract comment says "An empty query is a
bounded browse: the index returns frecency-ordered entries, which the file picker uses for its initial
results."

Packaging: `@ff-labs/fff-node` loads a platform-specific native package
(`@ff-labs/fff-bin-{darwin,win32}-{arm64,x64}`, `@ff-labs/fff-bin-linux-{arch}-{gnu,musl}`). A patch
(`patches/@ff-labs__fff-node@0.9.4.patch`) adds `resolveUnpackedAsarPath()`, rewriting `/app.asar/` to
`/app.asar.unpacked/` when that exists. **Windows desktop builds additionally bundle the Linux fff
binaries** because the Windows artifact ships a WSL backend that loads fff through ffi-rs.

### 11.2 Read and write

`PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024`. `readFile` does a **double containment check**: first the
lexical `resolveRelativePathWithinRoot` (rejects absolute inputs; rejects a resolved relative path that
is empty, `"."`, `".."`, starts with `"../"`, or is absolute), then `realpath` on both the workspace
root and the target with a second `path.relative` check — the symlink escape guard. Then inside an
`acquireUseRelease` around an `open(…, "r")` handle: `stat.isFile()` or error; read
`min(stat.size, 1 MB)`; **binary detection is a NUL-byte scan** (`if (fileBytes.includes(0))` →
`WorkspaceBinaryFileError`) with no mime sniffing; decode UTF-8; return
`{relativePath, contents, byteLength: stat.size, truncated: stat.size > 1MB}`.

`writeFile` resolves within root, `makeDirectory(dirname, {recursive: true})`, writes, then calls
**`workspaceEntries.refresh(input.cwd)`** — that last line is the whole cache-coherence story for
saves. `ProjectWriteFileInput` is `{cwd, relativePath, contents}`: **no revision, mtime, or ETag**.
Writes are last-write-wins against the filesystem.

Contract limits: `PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200`, `PROJECT_SEARCH_CONTENTS_MAX_LIMIT = 500`,
`PROJECT_WRITE_FILE_PATH_MAX_LENGTH = PROJECT_READ_FILE_PATH_MAX_LENGTH = 512`. Errors are tagged
schema classes with **optional structured fields plus a required `message`** — "The structured fields
are optional on the wire so newer peers can decode legacy message-only failures." Failure
classifications are closed literal unions. Notably `ProjectSearchEntriesError` carries `queryLength`,
not `query`, and two tests assert the error message never contains the needle.

Method names: `projects.listEntries`, `projects.readFile`, `projects.searchContents`,
`projects.searchEntries`, `projects.writeFile`, `shell.openInEditor`, `filesystem.browse`. The four
read methods and `filesystem.browse` require `AuthOrchestrationReadScope`; `projects.writeFile` and
`shell.openInEditor` require `AuthOrchestrationOperateScope`.

### 11.3 The file tree

`FileBrowserPanel.tsx` uses **`@pierre/trees` 1.0.0-beta.4**, a **shadow-DOM web component**, which
drives most of the file's complexity. Model config:

```ts
useFileTree({
  composition: { contextMenu: { triggerMode: "right-click", onOpen } },
  dragAndDrop: { canDrop: () => false },   // drag out to composer only; no reordering
  density: "compact",
  fileTreeSearchMode: "hide-non-matches",
  flattenEmptyDirectories: true,
  initialExpansion: 1,
  icons: T3_PIERRE_ICONS,
  paths: [], search: false,
  unsafeCSS: TREE_UNSAFE_CSS,
})
```

Directories get a **trailing slash** in `treePaths`. Three separate shadow-DOM workarounds exist:

- **Right-click position capture** — the tree renders rows in shadow DOM and "its anchor rect is
  unreliable", so a capture-phase `document` `contextmenu` listener records `{x, y, at}` and the menu
  uses it if fresher than 1000 ms, else falls back to the anchor's bounding rect. The menu itself is
  the **native Electron menu** via `localApi.contextMenu.show(...)`, items `copy-mention` and
  `add-to-chat`; without the local API (web build) the menu simply does not open.
- **Drag-to-composer** — a capture-phase `dragstart` walks `event.composedPath()` for a node with
  `data-item-path`, converts tree paths to composer mentions, and writes them under the private drag
  type **`application/x-t3code-composer-mention`**. The composer registers *capture-phase* drop
  handlers so Lexical never sees the drop, and calls `event.nativeEvent.stopPropagation()` too because
  React's `stopPropagation` only halts the synthetic dispatch. `dropEffect` must be `"move"` — the tree
  constrains `effectAllowed` to `move`, and naming any other effect makes the browser cancel the drop.
  The host interface deliberately has **no** way to focus the editor: focusing synchronously during
  drop makes the unreconciled editor sync its stale state over the insert.
- **Reveal sync** — opening a file from the picker, content search, or a chat link must select and
  scroll the tree row, but a selection that *originated in* the tree must not be re-revealed (it would
  close an active tree search). Guarded by `handledRevealRef`, `treeSelectionPathRef`, and a
  `syncingSelectionRef` cleared in a `queueMicrotask`. Ancestor expansion looks up both
  `` `${ancestorPath}/` `` and the bare path, because directories are registered with the trailing
  slash.

### 11.4 The editor

`FilePreviewPanel.tsx` (38 KB) picks a mode in this order: image → error → no-data → markdown-rendered
→ truncated read-only → editable.

- **Images bypass `projects.readFile` entirely.** The client mints a signed asset URL via
  `assets.createUrl` with resource `{_tag: "workspace-file", threadId, path: absolutePath}` and renders
  a plain `<img>`. Extensions: `.avif .gif .ico .jpeg .jpg .png .svg .webp`.
- A `>1 MB` file renders read-only with a banner: "Preview limited to the first 1 MB of a N byte file."

The editor is **`@pierre/diffs` 1.3.0-beta.10**: `new Editor({persistState: true,
persistStateStorage: "inMemory", onChange})` inside
`<EditProvider><Virtualizer><File contentEditable /></Virtualizer></EditProvider>`. `Virtualizer`
config `{overscrollSize: 600, intersectionObserverMargin: 1200}`; `File` options include
`disableFileHeader: true`, `enableGutterUtility: !hasOpenCommentForm`,
`enableLineSelection: !hasOpenCommentForm`, `overflow: wordWrap ? "wrap" : "scroll"`,
`theme: resolveDiffThemeName(resolvedTheme)`.

**The 85-line patch exists specifically to make this surface possible.** Upstream `Editor`
force-disables `enableGutterUtility`, `enableLineSelection`, and `lineHoverHighlight` whenever the
editor is attached; the patch removes that forcing, adds
`if (this.#fileInstance?.options.enableLineSelection === true) return;` to the gutter pointerdown
handler, adds `if (options.controlledSelection === true) return;` to `#setSelectedLinesSafe`, and adds
`if (fileInstance.file !== void 0) fileInstance.file.contents = textDocument.getText();` so the
rendered file object stays in sync with the edit document. **Without the patch, editing and
line-selection/commenting are mutually exclusive in this library.**

Cache keys drive renderer reuse. `fileContentRevision.ts` is an FNV-1a-32 hash rendered as
`` `${contents.length}:${(hash >>> 0).toString(36)}` ``, and `projectFileEditorCacheKey` additionally
**reuses the editor's own current cache key when its contents already equal the incoming contents** —
so local typing never rotates file identity and forces a remount, while external or environment changes
do.

**Saving.** `FileSaveCoordinator`, `FILE_SAVE_DEBOUNCE_MS = 500`. State: `latestContents`,
`latestRevision` (monotonic), `lastChangeAt`, `saving`, `disposed`. `change(contents)` bumps the
revision and reschedules the timer; `persistLatest()` refuses to run concurrently, awaits the
`writeFile` atom command (itself serialised per `[env, cwd, path]`), calls `onConfirmed`, and — **if
the revision moved while the write was in flight** — reschedules with the *remaining* debounce
(`max(0, debounceMs - (Date.now() - lastChangeAt))`) rather than a fresh full delay. `dispose()`
flushes one final save if anything was ever typed. Each keystroke does three things: writes the
optimistic atom, feeds the coordinator, and remaps line annotations.

The optimistic cache (`projectFilesQueryState.ts`) reconciles carefully: `confirmProjectFileQueryData`
stamps `confirmedAgainst` with the current server result, refreshes and re-executes the query atom, and
**only clears the optimistic entry if the atom is still the exact same object** — so an edit landing
during the refetch is not clobbered.

**Review comments from a file.** Selecting lines fires `onLineSelectionEnd` → a `draft` annotation
rendered through `File`'s `renderAnnotation`. Submitting calls `addReviewComment(...)` on the composer
draft store with `buildFileReviewComment`:

```ts
{ id, sectionId: `file:${filePath}`, sectionTitle: "File comment", filePath,
  startIndex: startLine-1, endIndex: endLine-1,
  rangeLabel: "L12" | "L12 to L20",
  diff: <the selected source lines joined by \n>,
  fenceLanguage: <extension, or dotfile name, else "text"> }
```

These serialise into the outgoing message as `<review_comment …>` XML blocks —
**this is where the composer's "review comments arrive fully formed from other surfaces" come from.**
`remapFileCommentAnnotations` re-derives `startLine`/`endLine` from the annotation's Pierre-remapped
`lineNumber` while preserving the range's line count, so typing above a comment moves it with the code.

**Line reveal** is the most intricate client mechanism here: the file is virtualised, contents hydrate
asynchronously, and the editor's own focus restoration issues late programmatic scrolls. So:
`REVEAL_MAX_ATTEMPTS = 30` rAF retries while contents or `getLinePosition(line)` are unavailable; then
`REVEAL_GUARD_FRAMES = 20` with `REVEAL_GUARD_TOLERANCE_PX = 2`, a rAF loop re-asserting the target
scrollTop for 20 frames, cancelled by real user input via listeners on `wheel`, `touchstart`
(passive), `pointerdown` (passive **capture**, "Pierre stops gutter pointer events from bubbling"), and
`window` `keydown` (capture). `resolveCenteredFileLineScrollTop` prefers the *rendered* line's real
geometry over the virtualizer's estimate when the DOM row exists, then centres and clamps. The
container's `minHeight` is forced to `max(instance.height, scrollContainer.clientHeight)` so a short
file can still be scrolled to centre a line. Highlighting sets a `data-file-link-reveal` attribute on
`[data-line="N"]` and `[data-column-number="N"]` **inside the shadow root**, styled by injected
`unsafeCSS`.

**Rendered markdown mode** renders `ChatMarkdown` in a `ScrollArea` with `mx-auto max-w-4xl px-6 py-5`.
Its checkbox handler is a live edit path: `setMarkdownTaskChecked` validates the three-character
`[ ]`/`[x]` window at the reported byte offset and swaps the middle character, then the result goes
through the same optimistic-cache + save pipeline. **Ticking a checkbox in a rendered README writes
the file.**

Toolbar: breadcrumbs (project → dirs → file) in a fade-masked horizontal `ScrollArea`; `OpenInPicker`;
a markdown source/render `Toggle` (`Code2` / `Eye`); an "open in preview browser" `Toggle` (`Globe2`)
for `.htm/.html/.pdf`; and a file-explorer `Toggle` (`FolderTree`). Explorer open state persists under
`t3code.fileExplorerOpen`; markdown render preference under `t3code.renderMarkdown` — moved off the
panel because "a thread switch dropped it and forced source back". The explorer aside is
`w-[min(22rem,46%)] min-w-64 border-l border-border/60` when a file is open, full-width otherwise.

### 11.5 Content search dialog (⇧⌘F)

Hosted inside the command palette as one of three modes (`"files" | "content" | command list`), keyed
by `data-palette-mode`. Client constants: `PROJECT_PATH_SEARCH_DEBOUNCE_MS = 120`,
`COMPOSER_PATH_SEARCH_LIMIT = 80`, `PROJECT_CONTENT_SEARCH_DEBOUNCE_MS = 120`,
`PROJECT_CONTENT_SEARCH_LIMIT = 500`. `useProjectPathSearch` debounces the **whole target object**
(env + cwd + query + kind + imageOnly) and reports `isPending` as
`!areProjectPathSearchTargetsEqual(normalized, debounced) || result.isPending` — pending covers the
debounce window too — and returns `searchedQuery` so callers highlight against the query the results
were computed for, not half-typed input.

Three toggle buttons render as an `inputAccessory` absolutely positioned inside the input: `Aa` (match
case), underlined `ab` (whole word), `.*` (regex). `VISIBLE_MATCH_WINDOW = 100` — with a 500-match
limit and per-row syntax highlighting, mounting everything stalls, so rows render in windows grown by
an `IntersectionObserver` on a sentinel `<div className="h-8">` and also when keyboard navigation moves
past the window. Matches group by path with a `sticky top-0 z-10 … bg-popover/95 backdrop-blur-sm`
header carrying a `PierreEntryIcon`, filename, dimmed directory, and a pill count. Arrow keys wrap
modulo `matches.length`; **Enter is blocked while `search.isPending`** with the comment "the visible
matches belong to the previous query; opening one would jump to a result the user did not ask for".
Status line: `"{n}{+ if truncated} results in {m} files"`, or "Searching…", or the error, or "Invalid
regular expression". The whole dialog is keyed by `${environmentId}:${cwd}` so switching workspaces
resets query and options.

Per-row highlighting is a two-layer intersect: Shiki tokens (`codeToTokens(...).tokens[0]`) split
against the server's merged match ranges, match segments becoming
`<mark className="rounded-[2px] bg-primary/25 text-inherit">` and non-match segments plain `<span>`,
both carrying the token's own inline style. Token `fontStyle` is a bitfield: `1 = italic`,
`2 = bold (fontWeight 700)`, `4 = underline`.

### 11.6 File picker (⌘P)

`PROJECT_FILE_PICKER_RESULT_LIMIT = 200`. **Server ordering is preserved verbatim** — the comment is
explicit: "Server ordering is preserved — ranking already happened there; this pass only filters to
files and computes highlight positions." `findMatchIndices` computes the first ordered subsequence for
highlighting and returns `null` (no highlights, entry still shown) when the value does not contain the
subsequence, because the server may have matched fuzzily in a way a naive subsequence scan cannot
reproduce. Empty-state copy distinguishes indexing from searching: `"Indexing workspace files…"` when
pending with no query vs `"Searching workspace files…"` with one. `ProjectFaviconPickerDialog` reuses
the same hook with `{imageOnly: true}` — the only consumer of the server's `imageOnly` branch.

### 11.7 External editor launcher ("Open In")

`packages/contracts/src/editor.ts` holds **21 entries** in three launch styles:

| style | arg shape | editors |
|---|---|---|
| `goto` | `--goto <path[:line[:col]]>`, or bare path if no position | Cursor, Trae, Kiro (`baseArgs: ["ide"]`), VS Code, VS Code Insiders, VSCodium, Antigravity |
| `direct-path` | `<target>` | Zed (`commands: ["zed","zeditor"]`), File Manager (`commands: null`) |
| `line-column` | `--line <n> [--column <n>] <path>` | IntelliJ IDEA, Aqua, CLion, DataGrip, DataSpell, GoLand, PhpStorm, PyCharm, Rider, RubyMine, RustRover, WebStorm |

`EditorId` is derived from the table (`Schema.Literals(EDITORS.map(e => e.id))`), so the union cannot
drift from the launch table. `LaunchEditorInput.cwd` is overloaded: it is not necessarily a directory —
the file panel passes an **absolute file path with `:line:col`**, parsed by
`TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/`. `file-manager` resolves to `open` (darwin)
/ `explorer` (win32) / `xdg-open` (else).

**Discovery cache**: `EDITOR_DISCOVERY_CACHE_TTL_NANOS = 60_000_000_000n` (60 s) in a `Ref` keyed off
`Clock.currentTimeNanos`. A 15-line comment explains it deliberately avoids `Effect.cachedWithTTL`,
because that memoises the first caller's Exit *including an interrupt* — and since discovery runs on
the connection fiber under a timeout, one client disconnecting mid-scan would poison `server.getConfig`
for the whole TTL. Only successes are cached; expiry uses the monotonic clock so a backward wall-clock
adjustment cannot keep an entry alive. Every launch is `detached: true` with stdio `"ignore"` followed
by `handle.unref`.

`launchBrowser` (same module) has a notable platform matrix: darwin → `open`; win32 → PowerShell with
`-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64 UTF-16LE of
`$ProgressPreference='SilentlyContinue'; Start '<target>'`>`; **WSL detection**
(`WSL_DISTRO_NAME`/`WSL_INTEROP` set and none of `SSH_CONNECTION`, `SSH_TTY`, `container`) → the same
PowerShell payload via `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`; else
`xdg-open`.

The picker only renders in the file panel when `environmentId === primaryEnvironmentId` — launching an
editor on a *remote* environment would open it on the wrong machine.

---

## 12. Feature: browser preview, and the agent-facing MCP server that drives it

The preview is a `<webview>` inside the desktop shell that the human can use — and that the agent can
also drive, through a second, independently-authenticated HTTP endpoint speaking the Model Context
Protocol.

### 12.1 The shape of it

The server runs `/mcp` as a **sibling** of the environment-authenticated HTTP API, not wrapped by it.
Every provider CLI process is handed, at session start, a one-time bearer credential scoped to
`{environmentId, threadId, providerSessionId, providerInstanceId}`, and is told — through each CLI's
own MCP-registration mechanism — to add `/mcp` as a remote MCP server named `t3-code`. When the agent
calls a `preview_*` tool, the MCP handler resolves the bearer back to that scope and hands the
operation to `PreviewAutomationBroker`, an in-memory request/response router that **has no knowledge of
"the browser" at all** — it holds a `Queue` per connected desktop client and waits on a `Deferred`. The
desktop client (the **web bundle running inside Electron**, not a desktop-only module) subscribes to
that queue over the *ordinary* authenticated WebSocket RPC and, when a request arrives, drives the real
`<webview>` via Electron's Chrome DevTools Protocol debugger. The result flows back over
`previewAutomationRespond` and resolves the broker's `Deferred`, which resolves the tool call.

So "the agent sees the browser" is **two independently-authenticated hops glued by one in-memory
broker**: MCP HTTP (agent → server), and the pre-existing environment WS RPC (server → desktop UI,
piggybacking the human's own preview tab).

### 12.2 The MCP credential — a second, parallel auth model

`McpSessionRegistry` is a from-scratch, in-process credential store, structurally unrelated to the
pairing/DPoP/RPC-scope model:

- **Token shape**: `crypto.randomBytes(32)` → base64url. Only the **SHA-256 hash** is kept in the map;
  the raw token exists only in the `Bearer …` header handed to the provider CLI and is never persisted.
- **Scope**: `{environmentId, threadId, providerSessionId (a fresh UUID per issuance, not the CLI's own
  session id), providerInstanceId, capabilities: Set<"preview">, issuedAt}`. Today the capability set is
  always exactly `{"preview"}`, so `requireMcpCapability` cannot yet fail in practice.
- **Issuance** happens at `startSession` and at thread recovery, **not on plain `sendTurn`**;
  `issueActiveMcpCredential` revokes first, so a thread never holds two live credentials.
- **Endpoint URL** is computed from the live HTTP server address, rewriting `0.0.0.0`/`::`/`[::]` to
  `127.0.0.1`, since a child process cannot connect to a wildcard address.
- **Liveness**: every resolve and every `touch` bumps `lastAliveAt`; records stale beyond
  `DEFAULT_LIVENESS_WINDOW_MS` (24 h) are pruned lazily on the next issue/resolve/touch. **There is no
  background sweep timer.**
- **`touch` is wired into every turn** (`ProviderService.ts:734`) specifically so a long-lived session
  that goes hours without a browser tool call never has its credential expire out from under it — a
  credential is minted once per CLI-process lifetime and **cannot be rotated into an already-spawned
  process**.
- **Storage** is a single `SynchronizedRef<Map<tokenHash, CredentialRecord>>`. **Nothing is persisted.**
  A server restart invalidates every outstanding credential.
- **Module escape hatch**: adapter code needs the credential *before* spawning the child process but
  does not have `McpSessionRegistry` in its context, so the two are bridged through
  `McpProviderSession` — **a bare top-level mutable `Map<ThreadId, config>`, not an Effect `Ref`**.
  Ordering is guaranteed only by `ProviderService` sequencing `prepareMcpSession` immediately before
  `adapter.startSession`.

The 401 body is
`{"error": "invalid_mcp_credential", "message": "A valid provider-scoped MCP bearer credential is
required."}` with `Cache-Control: no-store` and `WWW-Authenticate: Bearer`; the middleware logs a
warning distinguishing `missing_bearer_token` from `unknown_or_expired_token`, explicitly because a
dead credential would otherwise silently drop the whole `t3-code` toolkit from the agent's session with
nothing server-side to explain why. `normalizeMcpHttpResponse` rewrites an empty `200` into `202` — a
workaround for how the MCP SDK signals notification-style responses.

The doc comment states the risk plainly: `/mcp` "is mounted outside the environment auth stack and is
reachable on whatever host the server binds to, so this token is the only thing guarding the preview
toolkit on a remote-reachable server."

### 12.3 Five adapters, five MCP-registration formats

`prepareMcpSession`/`clearMcpSession` are the single choke point; every driver reads the same
`McpProviderSessionConfig` but formats it completely differently, with **no shared abstraction**:

- **Claude** — the Agent SDK's own `mcpServers` map:
  `{"t3-code": {type: "http", url, headers: {Authorization}}}`.
- **Codex** — injects `T3_MCP_BEARER_TOKEN` (token only, `Bearer ` prefix stripped) into the **child
  process environment**, and passes two `-c` config-override flags:
  `mcp_servers.t3-code.url=<endpoint>` and
  `mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"`. The token never appears in argv.
- **Cursor / Grok** — an ACP `McpServer` array entry
  `{type: "http", name: "t3-code", url, headers: [{name: "Authorization", value}]}` forwarded verbatim
  into the ACP `session/new` params. It is the ACP agent binary, not T3, that dials `/mcp`.
- **OpenCode** — a runtime SDK call
  `client.mcp.add({name: "t3-code", config: {type: "remote", url, headers, oauth: false}})` — **but only
  if `!server.external`**, i.e. only when T3 spawned the OpenCode server itself. An externally-managed
  OpenCode server never gets the `t3-code` MCP server registered: a silent, intentional feature gap.

### 12.4 The 14 tools

`preview_status`, `preview_open`, `preview_navigate`, `preview_resize`, `preview_set_appearance`,
`preview_snapshot`, `preview_click`, `preview_type`, `preview_press`, `preview_scroll`,
`preview_evaluate`, `preview_wait_for`, `preview_recording_start`, `preview_recording_stop`. Each is
annotated with MCP hint flags (`Tool.Readonly` / `Destructive` / `Idempotent` / `OpenWorld`).

Two toolkits registered through **two different code paths**: `PreviewStandardToolkit` (13 tools) uses
the generic `McpServer.toolkit(...)` registration, while **`preview_snapshot` is registered by hand**
because its result needs two MCP content blocks — a JSON text block (page metadata minus the raw
screenshot bytes) and a separate `{type: "image", data, mimeType}` block. It gets its own
`server.addTool` call, its own error formatter returning a structured `isError: true` result rather
than throwing, and pulls the broker and invocation context out of the fiber manually via
`Context.getUnsafe` inside `Effect.withFiber`. MCP protocol version is pinned:
`McpProtocol.v2025_06_18`, no negotiation.

### 12.5 The broker

`PreviewAutomationBroker.ts` is keyed by three concepts:

- **Clients** — one `ClientConnection` per connected host stream, keyed by a client-generated
  `clientId` with a fresh `connectionId` (UUID) and an unbounded queue per *connection*. Reconnecting
  with the same `clientId` **evicts** the previous connection; a client can only have one live stream.
- **Host assignment** — keyed by `environmentId + \0 + providerSessionId`, i.e. one desktop runtime is
  pinned per *provider session*, not per thread or per tool call. The doc comment explains this
  deliberately has "no clock of its own": it used to inherit the MCP credential's TTL, which could
  migrate a live multi-step interaction to a different physical Electron instance mid-flow. A lease is
  valid only while its `connectionId`/queue identity is still live; a dead lease is dropped lazily and
  can fail over.
- **Host selection** when no live assignment exists: filter to clients in the right environment that
  advertise the requested operation, then pick by *(most supported operations, currently focused, most
  recent focus order)* — prefer the fullest-capability host, then whichever desktop window the human has
  focused. A live assignment is **not** silently reassigned even if the operation is unsupported there;
  the caller gets a capability-shaped failure instead of a surprise host swap.
- **Tab stickiness** — once a response carries a `tabId` (or explicit `null`), the assignment records it
  with a `tabSequence` so a late/out-of-order response cannot clobber a tab pointer set by a later
  request.
- **Request lifecycle** — one `Deferred` per request; the request is offered onto the assigned client's
  queue as a `{type: "request", connectionId, request}` stream event; `Effect.timeoutOption(timeoutMs)`
  guards the await (**default 15 s**, tool-schema capped at **60 s**). If the queue offer itself fails,
  it still **polls the `Deferred` once** in case the response raced the shutdown.
- **Disconnect** fails every still-pending `Deferred` for that connection with
  `PreviewAutomationClientDisconnectedError` and shuts down its queue.
- **`respond`** cross-checks `clientId` + `connectionId` before resolving, so a stale or foreign client
  cannot resolve someone else's request.
- **Error reclassification** switches the client's free-form `{_tag, message, detail}` into one of ~11
  contract error subclasses (falling back to `PreviewAutomationExecutionError`), re-attaching the full
  server-side request context plus `remoteTag`/`remoteMessageLength`/`remoteDetailKind`/`cause`
  diagnostics — **without forwarding the remote's message text or detail payload verbatim** into the
  typed fields (kept only in an opaque `cause: Schema.Defect()`).

`PREVIEW_AUTOMATION_V1_OPERATIONS` vs `PREVIEW_AUTOMATION_OPERATIONS` explicitly versions the operation
set so a newer server can coexist with an older desktop build: `supportedOperations` is optional on the
wire, and its absence is read as "assume V1 only".

The automation host is gated by `isElectron` — **the hosted web app and mobile never register as
automation hosts.** It advertises the full operation list, subscribes through an Atom that drains the
stream and posts responses back, tracks `activeConnectionId` defensively against superseded
connections, reports window focus via `document.hasFocus()` on `focus`/`blur` (feeding the broker's
focus tiebreak), and for anything needing a live tab first calls `requireReadyTab()` which polls
`previewBridge.automation.status` until `available: true` or a request-scoped timeout. Several
operations (`open`, `resize`) also drive the server-side plain preview RPCs to keep the human-visible
tab list and viewport state consistent with what the agent just did.

### 12.6 Desktop execution: CDP plus a smuggled-in Playwright locator engine

`apps/desktop/src/preview/Manager.ts` (~3700 lines) is the executor.

- **Control session**: before any automation action it refuses if DevTools is already open
  (`PreviewAutomationDevToolsOpenError`) or the debugger is already attached
  (`PreviewAutomationDebuggerAttachedError`), then `wc.debugger.attach("1.3")` and enables `Runtime`,
  `Accessibility`, `Network`, `Log`. This is a genuine Chrome DevTools Protocol session over Electron's
  `webContents.debugger` API, driven directly.
- **Playwright is vendored as a locator engine, not run as a browser automation tool.**
  `PlaywrightInjectedRuntime.ts` `require.resolve`s `playwright-core/package.json`, reads its bundled
  `lib/coreBundle.js`, locates a specific string marker (`"source3 = "` … terminated by `";\n  }\n});"`)
  that Playwright's own build embeds as a **string literal containing the entire browser-side
  `InjectedScript` source**, evaluates that literal in a fresh `node:vm` context (1 s timeout) to get
  the actual JS source text, and builds a self-installing IIFE that constructs
  `new (module.exports.InjectedScript())(globalThis, options)` and stashes it at
  `globalThis.__t3PlaywrightInjected` — evaluated **inside the guest page** via CDP `Runtime.evaluate`.
  `injected.parseSelector(...)` and `injected.querySelector(parsed, document, strict)` then resolve
  `role=`/`text=`/CSS locators to elements. There is **no Playwright browser server, no Playwright Node
  client, no separate Chromium**. It is brittle by construction — guarded only by a minimum-length
  sanity check (`PLAYWRIGHT_SOURCE_MINIMUM_LENGTH = 100_000`) and typed extraction errors, not by any
  published API.
- **Click** resolves a locator to a centre point (or uses raw `x`/`y`), validates the point is inside
  the measured viewport, then — before dispatching — calls `expectAgentInput(tabId, {kind: "pointer",
  …})` to pre-register the exact signal the human-input listener should treat as "the agent did this",
  emits a visual `pointer-event` IPC message the renderer uses to animate an agent cursor
  (`AGENT_CURSOR_MOVE_MS = 160`, `AGENT_CURSOR_CLICK_LEAD_MS = 40`), then sends real
  `Input.dispatchMouseEvent` commands.
- **Human/agent arbitration**: `PreviewManager` tracks a per-tab `controller: "human" | "agent" |
  "none"` and a monotonic `controlEpochRef`. Genuine human input that does **not** match a
  just-registered `expectAgentInput` signal (matched within a 1 s TTL, ±1 px tolerance) bumps the epoch,
  which causes any in-flight automation command to fail with
  `PreviewAutomationControlInterruptedError` — a human clicking the live preview mid-automation
  cooperatively interrupts the agent rather than racing it.
- **Snapshot** produces `{url, title, loading, visibleText, interactiveElements, accessibilityTree,
  consoleEntries, networkEntries, actionTimeline, screenshot}`. Console/network diagnostics accumulate
  *continuously* per `webContents` from `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` /
  `Log.entryAdded` / `Network.*`, ring-buffered at `DIAGNOSTIC_BUFFER_LIMIT = 200`. Screenshots are
  downscaled to `MAX_SCREENSHOT_WIDTH = 1280`. `actionTimeline` is the last 200 automation actions with
  `running`/`succeeded`/`failed`/`interrupted` status — the agent's own action history.
- `evaluate` results are capped at `MAX_EVALUATION_BYTES = 64_000` with
  `PreviewAutomationResultTooLargeError` on overflow.
- **Recording** is CDP `Page.screencastFrame` events forwarded over IPC to the renderer, fed into a
  canvas + `MediaRecorder`, and on stop written to disk via an IPC round-trip, path-validated to stay
  inside the configured artifact directory (rejecting `..` escapes with
  `PreviewArtifactPathOutsideDirectoryError`).

### 12.7 Security posture of the guest

`apps/desktop/src/preview/WebviewPreferences.ts` exports exactly one string:

```ts
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=false,sandbox=true,nodeIntegration=false";
```

Its 40-line doc comment: `contextIsolation=false` is **required** so the pick preload shares
`globalThis` with the page and `react-grab`/bippy can read `__REACT_DEVTOOLS_GLOBAL_HOOK__` to resolve
React component names; `sandbox=true` is what keeps that safe (without it the preload's `require` would
land on the page's shared `globalThis`, handing any third-party page full Node + IPC). The string must
be whitespace-free (Electron's parser splits on `,` without trimming) and must use `true`/`false`
(`"no"` is a truthy string, which would silently re-enable context isolation) — and the exact format is
unit-test-locked.

Sessions derive a persistent partition `persist:t3code-preview-<hash>` per scope. The permission
allow-list is `clipboard-read`, `clipboard-sanitized-write`, `notifications`, `geolocation` — and
explicitly **not `local-fonts`**, with the fingerprinting and `FontData.blob()` rationale written into
the list. Both the permission *request* and *check* handlers must allow `clipboard-sanitized-write` or
in-page "Copy" buttons (e.g. the Next.js error overlay) fail.

The main window additionally rejects, at `will-attach-webview`, any `<webview>` whose partition is not
a preview partition, and force-sets `sandbox: true`, `nodeIntegration: false`,
`nodeIntegrationInSubFrames: false`, `contextIsolation: false` on the ones it allows.

The webviews are rendered by **React** in `apps/web/src/browser/`, not by `WebContentsView`:
`HostedBrowserWebview.tsx` declares `interface ElectronWebview extends HTMLElement`, augments
`HTMLElementTagNameMap` so TSX accepts `<webview>`, reads its partition/preload/`webpreferences` from a
one-shot `preview.getPreviewConfig(environmentId)` call, then registers itself with
`preview.registerWebview(tabId, webview.getWebContentsId())` — after which the **main process** drives
it via `webContents.fromId(...)`. `BrowserSurfaceSlot.tsx` is a *placeholder* `<div>` reporting its
rounded `getBoundingClientRect()` into a zustand store on `ResizeObserver`, `resize`, and capture-phase
`scroll`; the real webview is positioned from that rect.

### 12.8 Navigation targets and an admitted gap

`preview_navigate` accepts a direct `url` or an `{kind: "environment-port", port, protocol?, path?}`
target, resolved **client-side**. Any `url` whose host is a loopback address is rewritten against the
*environment's own* base URL — "localhost:5173" in a tool call means "port 5173 on whichever machine is
running environment X", not the machine running the desktop client.

`resolveEnvironmentPortTarget` **throws a plain `Error`** when the environment's host is not judged
private-network reachable (`isPrivateNetworkHost`: loopback, `*.local`, `*.ts.net`, RFC1918,
`169.254.0.0/16`, IPv6 ULA/link-local), with the literal message: *"This environment port needs the
planned authenticated preview gateway; its server address is not directly private-network reachable."*
**That gateway does not exist in this codebase** — navigating an agent's browser to a dev-server port on
a genuinely remote environment is not implemented.

Separately, `apps/server/src/preview/PortScanner.ts` discovers locally listening dev servers —
`lsof -iTCP -sTCP:LISTEN -P -n -F pcn` parsing on macOS/Linux, or probing a curated `COMMON_DEV_PORTS`
list (3000, 5173, 8080, …) on Windows or when `lsof` is missing — reference-counted polling every 3 s,
exposed over `subscribeDiscoveredLocalServers`. It also tracks which terminal-spawned pids own which
ports so discovered servers can be attributed to a thread's terminal (§10.2). **It never talks to the
MCP/broker layer**; it feeds human-facing UI.

**No database is involved anywhere in this area.** Credentials, the provider→config bridge, and the
broker's client/assignment/pending maps are all in-memory state scoped to one server process, and there
is **no retry or backoff anywhere in this path** — a timed-out or interrupted operation is returned as
a typed failure to the agent, which may retry via its own tool-call loop.

---

## 13. Feature: remote access — environments, pairing, and auth

### 13.1 The four target kinds

`packages/client-runtime/src/connection/model.ts:9-47` defines four tagged target classes:

| Tag | Persisted? | Meaning |
|---|---|---|
| `PrimaryConnectionTarget` | No — reconciled from the host at boot | The platform-managed local server (desktop's bundled backend, or the CLI-served web app). Same-origin cookie auth. |
| `BearerConnectionTarget` | Yes | Any manually paired endpoint — direct HTTP/WS, Tailscale, or a secondary desktop-local backend such as a parallel WSL instance. |
| `RelayConnectionTarget` | Yes | A managed T3 Connect relay tunnel, identified only by `environmentId`; no URL is stored client-side, it is re-minted on every connect. |
| `SshConnectionTarget` | Yes | A desktop-managed SSH-launched/forwarded environment; also has no static URL. |

`PersistedConnectionTarget = Bearer | Relay | Ssh`. **Tailscale is explicitly not a fifth kind** — a
Tailscale URL is paired through the ordinary Bearer path; Tailscale is an endpoint provider and
transport only.

An **AdvertisedEndpoint** is a server- or desktop-authored *candidate* (a concrete http/ws URL pair
plus a reachability hint: loopback/LAN/private/public/tunnel). Clients treat these as hints; the actual
connection attempt is what proves reachability.

### 13.2 The client connection stack

```
EnvironmentRegistry (registry.ts)
  owns: catalog (persisted + platform targets), per-environment supervisor scopes
    |
EnvironmentSupervisor (supervisor.ts)  — one per environment, for the whole app lifetime
  owns: desired/offline/backoff state machine, retry ladder, active RPC session lease
    |
ConnectionDriver (driver.ts)           — one attempt: resolve → open session → wait ready
    |
ConnectionResolver (resolver.ts)       — target._tag switch → one of 4 brokers
    |
RpcSessionFactory (rpc/session.ts)     — one transport attempt, no retry of its own
```

**Registry.** `acquireSupervisor` is guarded by a per-environment semaphore so concurrent callers reuse
or atomically replace a supervisor; a changed catalog entry closes the old `Scope` and builds a new
supervisor rather than mutating state under it. Registering a **platform** environment bypasses the
persisted store and puts any bearer credential directly through `credentials.put`. `remove()` clears
persisted registration and cache, and for SSH targets calls `ssh.disconnect(...)` to tear down the
tunnel.

**Supervisor** — the single retry owner, one long-running forked loop driven by an unbounded signal
queue (`ConnectRequested`/`DisconnectRequested`/`RetryRequested`/`NetworkChanged`/`Wakeup`). Phases:
`available → offline → connecting → backoff → connected → blocked`. Concrete numbers:

```
RETRY_DELAYS_MS                  = [3000, 4000, 8000, 16000]   // retries forever, caps at 16s
BACKOFF_RESET_AFTER_MS           = 30_000                       // 30s up resets the ladder
CONNECTION_ESTABLISHMENT_TIMEOUT = "15 seconds"
CONNECTION_PROBE_TIMEOUT         = 15s
MOBILE_CONNECTION_PROBE_TIMEOUT  = 3s
```

Being offline **suspends the loop entirely** — no timer runs, no attempt counted.
`ConnectionBlockedError` (auth/config/permission/unsupported) parks the supervisor in `blocked`
indefinitely until an external wakeup; it is *not* retried on a timer. Wakeups differ by phase: during
establishment, plain app-foreground activation is *ignored* (do not restart an in-flight attempt), but
`application-active-reconnect` (mobile, after real background suspension) always interrupts and resets
the ladder, because the OS may have silently killed the socket without delivering a close event. Once
connected, foregrounding just probes the live session rather than reconnecting. On relay targets a
`credentials-changed` wakeup interrupts and restarts; on bearer/ssh it is a no-op.

Every relay connection attempt links a failed attempt's span to the *next* retry's span via
`Effect.linkSpans`, so a chain of retries reads as one causally-linked trace.

**Driver** reports three progress stages — `preparing` / `opening` / `synchronizing` — back to the
supervisor for UI display. It does not retry.

**Resolver** has one broker per tag:

- *Primary*: if `PrimaryEnvironmentAuth.bearerToken` is `None` (the normal desktop case), return the URL
  as-is with `httpAuthorization: null` and let the cookie jar do the rest; if a token is present (a
  secondary desktop-local backend on a different loopback origin) it goes through the ordinary bearer
  exchange.
- *Bearer*: load the saved profile + credential, call `remote.authorizeBearer(...)`.
- *Relay*: obtain a Clerk token + device id, call `ManagedRelayClient.connectEnvironment` (a
  DPoP-authenticated relay call) for a bootstrap credential + managed endpoint, then exchange that for
  an environment DPoP access token via `remote.authorizeDpop(...)`.
- *SSH*: call `SshEnvironmentGateway.prepare(...)`, persist the refreshed profile (host/port may change
  across launches), then do an ordinary bearer exchange against the tunnelled loopback URL.

`authorizeBearer` fetches — and 10 s-TTL-caches — the environment's public descriptor to confirm
`environmentId` matches, then issues a short-lived `wsTicket` appended to the ws URL. `authorizeDpop`
reuses a locally cached `RemoteDpopAccessToken` when the environment, DPoP key thumbprint, and expiry
> now + 60 s all match; on a cache hit it still round-trips a fresh websocket ticket **with a 3 s
timeout** so a stale cached token fails fast into a fresh bootstrap rather than hanging.

### 13.3 Server-side auth

Three collaborating stores behind one `EnvironmentAuth` facade.

**PairingGrantStore** — one-time or long-lived **bootstrap credentials**, table `auth_pairing_links`
(migration `020_AuthAccessManagement.ts`, hard-cutover-replaced by `031_AuthAuthorizationScopes.ts`
which added a `scopes` column and dropped `role`; the migration comment calls it *"an intentional alpha
cutover: role-bearing credentials and sessions cannot safely be assigned new capabilities implicitly"*
— upgrading wipes all pairing links and sessions and requires re-pairing). Credential format:
**12-character strings from a Crockford-like alphabet `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`**, generated by
rejection sampling over `crypto.randomBytes` to avoid modulo bias. Default one-time TTL is **5
minutes**. Two long-lived exceptions, both justified in comments as trusted-channel exceptions rather
than weaker security: the **desktop bootstrap token**, seeded in memory (not the DB) at boot with
`remainingUses: "unbounded"` and a 24 h TTL because it rides a trusted fd3/stdin IPC channel and the
renderer must re-exchange it after a page reload; and the **dev-server startup token**, 24 h, because a
developer reads it off a log minutes later. `consume()` is a two-tier lookup — in-memory seeded grants
first, then an atomic DB `consumeAvailable` UPDATE — falling through to a plain read only to *classify*
why it failed (not-found / revoked / expired / DPoP-key mismatch).

**SessionStore** — sessions are **self-describing signed tokens**, not opaque DB lookups on the hot
path. `SessionClaims` is `{v: 1, kind: "session", sid, sub, scopes, method, jkt?, iat, exp}`,
base64url-encoded and HMAC-signed with a per-server random 32-byte key (`server-signing-key`). The token
is `base64url(payload).signature` — a homegrown compact JWT-like format, not an actual JWT. `verify()`
checks the signature and `exp`, then **still** confirms the session row exists and is not revoked, so
revocation works despite self-verification. TTLs: plain bearer sessions **30 days**; DPoP-bound
sessions **1 hour** (they are additionally constrained by proof-of-possession); WebSocket tickets — a
*separate* signed token kind, `kind: "websocket"` — **5 minutes**. `markConnected`/`markDisconnected`
track live WS counts in an in-memory map purely for the "connected" badge; not security-relevant, and
lost on restart. The session cookie name is `t3_session[_<port>[_<hash>]]` — scoped by port/instance
hash for dev servers and desktop where several instances share `127.0.0.1`, but the stable unscoped name
for real hosted deployments so a change in public port does not log everyone out.

**DPoP** — a self-contained RFC 9449 implementation with no external DPoP library. The proof is a
3-part compact structure parsed by hand; P-256 verification via `@noble/curves/nist`; thumbprint =
`base64url(sha256(stableStringify({crv, kty, x, y})))`. Verification checks thumbprint match, HTTP
method match, normalised URL (`htu`), optional access-token hash (`ath`) binding, and a **5-minute
clock-skew window** (`DEFAULT_MAX_AGE_SECONDS = 300`, only 5 s future skew allowed). The server adds
**single-use replay protection**: after a proof verifies, a replay marker is written to
`ServerSecretStore` under `dpop-proof-${sha256(thumbprint:jti)}` using `create()` — which fails if the
file already exists — so a captured valid proof can be replayed exactly zero times.

**Seven scopes** (`docs/internals/environment-auth.md`):

| Scope | Grants |
|---|---|
| `orchestration:read` | snapshots/status/events/config/filesystem/VCS reads |
| `orchestration:operate` | dispatch commands, mutate workspace |
| `terminal:operate` | create/attach/write/resize/clear/restart/kill terminals |
| `review:write` | read review diff previews |
| `access:read` | inspect pairing links / client sessions |
| `access:write` | create/revoke pairing links / client sessions |
| `relay:read` / `relay:write` | inspect / link-unlink-configure the managed relay |

Ordinary pairing links grant `orchestration:read orchestration:operate terminal:operate review:write
relay:read`; desktop bootstrap and CLI administrative bootstrap additionally grant `access:read
access:write relay:write`. **A pairing exchange can only narrow scopes, never widen them past what the
grant carries.** Enforcement is redundant: `requireEnvironmentScope(scope)` per HTTP endpoint, and a
per-RPC check on every WebSocket call against the scopes captured once at handshake — so a mid-connection
privilege change does not retroactively re-check already-open calls, only new ones.

**HTTP surface**: `GET /api/auth/session` (never fails to "not authenticated" — credential errors fold
into `authenticated: false`); `POST /api/auth/browser-session` (consumes a bootstrap credential, sets
an **httpOnly, `sameSite: lax`** cookie, so the session secret never reaches browser JS);
`POST /oauth/token` — RFC 8693 token-exchange shaped, `grant_type=urn:ietf:params:oauth:grant-type:
token-exchange`, `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`, where
sending a `dpop` header switches the exchange into DPoP-bound mode (1 h TTL, `token_type: "DPoP"`) and
an invalid proof gets a `WWW-Authenticate: DPoP` challenge rather than a generic 401;
`POST /api/auth/websocket-ticket`; and the pairing/clients management endpoints gated by
`access:read`/`access:write`. Notably `pairingCredential` lets an *already-scoped* client mint a
**delegated** pairing credential naming a subset of its own scopes — this is how a paired mobile/web
client generates its own onward pairing link without administrative access. `revokeClient` refuses to
let a session revoke **itself**.

**WebSocket auth never uses the long-lived credential.** The handshake prefers `?wsTicket=` in the URL
(a 5-minute single-purpose token) and falls back to header-based cookie/bearer/DPoP only if absent.
That is the documented reason long-lived tokens never appear in a URL, query string, or browser
history. Correspondingly, hosted pairing places the pairing token in the URL **hash**
(`app.t3.codes/pair?host=…#token=…`), never a query param, so it is never sent to the hosted app's own
origin — and hosted pairing only works against HTTPS/WSS backends, because an HTTPS page cannot open
`ws://` to a LAN backend (mixed-content block).

**Server secrets** are plain files: `ServerSecretStore` writes one file per secret at
`<secretsDir>/<name>.bin`, directory `chmod 0700`, files `chmod 0600`, atomic temp-file-then-rename, and
`create()` uses `wx` (`O_EXCL`) for atomic create-if-absent — which doubles as a generic
idempotency/replay-guard primitive (the DPoP jti guard, the Ed25519 keypair first-write race). **No KMS,
no HSM.**

### 13.4 Tailscale

`packages/tailscale/src/tailscale.ts` shells out to the real `tailscale` binary (never through a shell)
for two operations: `tailscale status --json` (1.5 s timeout), parsed for `Self.DNSName` and
`Self.TailscaleIPs` filtered to the **`100.64.0.0/10` CGNAT range**; and
`tailscale serve --bg --https=<port> http://127.0.0.1:<localPort>` / `… off` (10 s timeout). The server
itself calls `ensureTailscaleServe` at startup when enabled and `disableTailscaleServe` on scope close.
**Stderr is never logged raw** — `stderrDiagnosticOf` classifies it into a closed set
(`no-existing-handler` / `not-logged-in` / `permission-denied` / `unknown`) explicitly because
`tailscale` stderr can contain `tskey-…` auth keys and node identifiers. Reachability probe:
`GET /.well-known/t3/environment` with a 2.5 s timeout, folded to `false` on any failure.

### 13.5 Desktop-managed SSH

Not a distinct environment type — a *launch-and-forward helper* producing an ordinary loopback Bearer
target. `SshEnvironmentManager.ensureEnvironment`:

1. Resolve the SSH target from `~/.ssh/config`/known hosts and compute a stable `targetConnectionKey`
   used to dedupe concurrent connects (a `Deferred`-based pending map so two simultaneous connects share
   one launch).
2. `launchOrReuseRemoteServer` pipes a generated **POSIX shell script** (`REMOTE_LAUNCH_SCRIPT`,
   tunnel.ts:438-591) over `ssh … sh -s`. Written entirely in `sh` with no assumption of bash, it: runs
   a **PATH-repair routine** trying common install dirs then volta, asdf, mise, fnm, nodenv, nvm —
   because a non-interactive `sh -c` session often does not source the profile where a version manager
   lives; checks for an already-running server at the **default** `~/.t3` install by reading
   `userdata/server-runtime.json`, verifying the PID is alive and the origin is loopback, and adopts it
   as `external` if found; otherwise picks a free port (scanning a 200-port window from a persisted
   preferred port) and starts `t3 serve --host 127.0.0.1 --port <port> --base-dir ~/.t3` detached with
   `nohup`, polling readiness every 100 ms up to 15 s; and persists `pid`/`port`/`managed` under
   `~/.t3/ssh-launch/<host-key>/`, re-launching if the generated runner script content changed (compared
   with `cmp -s`). The runner prefers an installed `t3` on `PATH`, else `npx --yes t3@latest`, else
   `npm exec --yes t3@latest`. The script carries its own inline Node.js snippets via heredocs
   (port picking, readiness waiting, a semver-range check) because remote tooling like `nc` or `curl`
   cannot be assumed — only Node, once PATH is repaired.
3. Optionally run `t3 auth pairing create --json` remotely to mint a bootstrap credential **without
   putting a secret on the SSH command line**.
4. Spawn a **separate** `ssh -N -L <local>:127.0.0.1:<remote> host` process — its own `ChildProcess`
   with `-o ControlMaster=no -o ControlPersist=no` so it does not share the launch connection's control
   socket, plus `ExitOnForwardFailure=yes`, `ServerAliveInterval=15`, `ServerAliveCountMax=3` — and poll
   the forwarded local port with an HTTP readiness probe (20 s) racing against the tunnel process
   exiting. `resolveLoopbackSshHttpBaseUrl` asserts the forwarded URL really is loopback.

Auth-failure handling prompts for a password up to **2 times**, caching the accepted secret in memory
per connection key for the manager's lifetime — **never persisted to disk**. Disconnect kills the local
`ssh -L` process (SIGTERM, 2 s force-kill grace) and runs a remote stop script that kills the remote PID
**only if `managed`** — a server marked `external` is left running.

### 13.6 T3 Connect (the relay)

The relay **never proxies application traffic**; it brokers credentials and provisions a Cloudflare
Tunnel, then gets out of the way.

**Cloud identity.** Web/desktop/mobile sign in through Clerk directly. The relay's
`verifyRelayClientBearerToken` first tries a `t3-relay`-templated Clerk session JWT (audience
`t3-code-relay`) and falls back to Clerk's OAuth-token verification path — the second path is what lets
the **headless CLI's separate public-PKCE OAuth client** authenticate without minting a JWT template.

**Linking (`t3 connect link`).** The server lazily generates an **Ed25519 keypair**
(`node:crypto.generateKeyPairSync("ed25519", {pkcs8 / spki})`) stored as one JSON secret
`cloud-link-ed25519-key-pair`; this is the environment's long-lived identity. The relay's
`EnvironmentLinker.link()`: decodes the environment's link proof *unverified* to learn which
environment claims to be linking, then verifies it as an EdDSA JWT signed by *that* environment's
embedded public key — a bootstrap chicken-and-egg resolved by trusting the embedded key only after the
signature over it validates; checks the proof's `scopes` cover what is requested; verifies a
relay-issued **link challenge** JWT created moments earlier via `client.createEnvironmentLinkChallenge`
(this is the piece that authenticates the *user* half, separate from the environment's own signature);
consumes **two** replay nonces (the proof's `jti` and the challenge's `jti`); then upserts one row per
`(userId, environmentId)` — **one environment can be linked to multiple cloud users** — and mints the
environment's ongoing bearer credential, stored only as a hash.

If the endpoint provider is `cloudflare_tunnel`, `ManagedEndpointProvider.provision` derives a stable
hostname and tunnel name from `SHA-256(namespace, userId, environmentId)` — **content-addressed, not
random, so unlinking and relinking reproduces the same subdomain** — enforces a per-user tunnel cap,
lists-or-creates the tunnel by name, points its ingress at `http://127.0.0.1:<port>` (the origin must
pass `isLoopbackOrigin`; the relay will only ever tunnel to a loopback origin), ensures a proxied CNAME
at `<tunnelId>.cfargotunnel.com`, and fetches a connector token. Every stage failure is a distinctly
tagged `ManagedEndpointProvisioningFailed{stage}`. The server then runs `cloudflared tunnel run` locally
with `TUNNEL_TOKEN` **in its env, never on the command line** (so it does not leak into `ps`), supervises
it (auto-restart on exit, matching config key so a stale desired-vs-actual race cannot double-spawn),
classifies stdout by cloudflared's zerolog level tokens, and **redacts the connector token out of every
logged line**. `t3 connect link` only records intent; provisioning reconciles on the next
`t3 serve`/`t3 start`. A separate **`publish_only`** mode links to the relay purely to publish agent
activity for push notifications, without provisioning a tunnel or advertising a relay endpoint.

**Connecting through the relay** is a bespoke mutual-attestation protocol layered on the tunnel:

1. the client exchanges a Clerk token for a relay-scoped **DPoP access token** (30 minutes), cached per
   `(accountId, clientId, relayUrl, thumbprint, scopes)` with a 5 s early-expiry buffer;
2. `dpopClient.connectEnvironment` → `EnvironmentConnector.connect` looks up the link record and the
   endpoint allocation and **cross-checks** that the linked endpoint's URLs still match what the
   allocation resolves to (a mismatch is a distinct `managed_endpoint_mismatch` reason, not a generic
   failure);
3. the relay builds a short-lived (2 min) JWT carrying the *client's* DPoP key thumbprint (`cnf.jkt`),
   signed with the **relay's own** `cloudMintPrivateKey`, and POSTs it to the environment's
   `connect.t3MintCredential` endpoint through the Cloudflare Tunnel;
4. the environment mints a bootstrap credential and returns it wrapped in **another** signed JWT, this
   time signed by the **environment's** Ed25519 private key;
5. the relay verifies that response proof against the stored public key — `environmentId`,
   `requestNonce`, the bound client thumbprint, the credential, `exp` — before handing anything to the
   client;
6. the client feeds the bootstrap credential into `authorizeDpop` exactly like any other DPoP bootstrap.
   **From here the relay is out of the picture; the WebSocket goes directly to the tunnel hostname.**

**Two separate DPoP keypairs are in play** — one for authenticating to the relay Worker, one for the
environment's own session. The relay never sees the environment credential and vice versa;
`docs/internals/environment-auth.md`'s "Relay Boundary" section states *"an environment access token is
not a relay token and cannot be presented to the relay"*.

Client-side, relay DPoP tokens survive a 401 by invalidate-and-retry-**once**, and every relay call has
a hard **10-second** client timeout, deliberately longer than the relay's own **9-second** server-side
request deadline so a stuck request fails server-side first and leaves a traceable span instead of a
client abort with no server-side trace.

**Clerk-backed CLI auth** uses a separate OAuth application: a public PKCE client with no stored client
secret. Two flows, auto-selected from `SSH_CONNECTION`/`SSH_TTY` or `--headless`: a **loopback flow**
binding `127.0.0.1:34338` and opening the hosted `/connect` page (never Clerk's `/oauth/authorize`
directly — a signed-out browser sent there drops the authorize params across Clerk's own sign-in
redirect, documented as bug #5051); and an **out-of-band flow** printing an authorize URL and accepting
a pasted code, where the PKCE verifier never leaves the CLI process so a captured pasted code is
useless. Tokens persist through `ServerSecretStore` under `cloud-cli-oauth-token`, refreshed
proactively 5 minutes before expiry under a single-permit semaphore; a corrupt or revoked stored token
silently falls through to a fresh interactive login. Desired-link state is a separate secret
(`cloud-cli-desired-link`: "managed" vs "publish_only"), decoupled from whether a tunnel is currently
running. `t3 connect unlink` stops the connector but **keeps** the CLI's OAuth credential so relinking
does not require another browser flow; `t3 connect logout` additionally clears it.

### 13.7 Mobile background leasing

Independent of the connection supervisor, mobile periodically calls `serverReportClientActivity` on
every connected environment — every `REPORT_INTERVAL_MS = 25_000`, debounced 250 ms, and immediately on
app-state or registry change — with a `ttlMs: LEASE_TTL_MS = 45_000` lease naming the background
"scopes" it wants kept alive (baseline `provider-status`, plus whatever the app currently retains, e.g.
an open thread's subscription). This is how the server knows it is safe to tear down expensive per-client
work when the app backgrounds: the lease simply expires. (The server side is `BackgroundPolicy`, §15.4.)

---

## 14. Feature: agent awareness — push notifications and Live Activities

The out-of-app awareness loop: a running thread's state is projected into a phase machine, published
from an environment to the hosted relay, and fanned out to iOS devices as APNs pushes and Live Activity
updates. **Android is entirely absent from this feature** — the schema hardcodes
`platform: Schema.Literal("ios")`.

### 14.1 The phase machine

`packages/shared/src/agentAwareness.ts`'s `projectThreadAwareness()` is a pure function
`(environmentId, project, thread shell) → AgentAwarenessState | null` deriving one of six *reachable*
phases from ordinary read-model fields — **no new event type, no separately persisted state machine**:

- `waiting_for_approval` — `thread.hasPendingApprovals`
- `waiting_for_input` — `thread.hasPendingUserInput`
- `failed` — `session.status === "error"` or `latestTurn.state === "error"`
- `starting` — `session.status === "starting"`
- `running` — `session.status === "running"` or `latestTurn.state === "running"`
- `completed` — `latestTurn.state === "completed"`, **or** an `interrupted` turn that still has
  `completedAt` set (a teardown race: session status can overwrite turn state, but `completedAt`
  survives it), **or** — for threads whose turns never produced a checkpoint and so have no materialised
  `latestTurn` — a live session sitting at `ready`/`idle` with nothing pending
- `null` — nothing to show; this is what "tombstones" a thread on the relay

`buildAgentAwarenessDeepLink()` builds `/threads/{environmentId}/{threadId}`, which round-trips through
the relay's DB, the push payload, and the widget's `widgetURL()`.

`stale` is defined in the contract type and rendered by the mobile widget's tint/glyph switch, **but
`resolveThreadAwarenessPhase` never returns it.** No producer in the codebase emits it.

### 14.2 The publisher

`apps/server/src/relay/AgentAwarenessRelay.ts` is started once at boot. It subscribes to
`streamDomainEvents` and filters with `shouldPublishAgentAwarenessEvent()`: most event types publish,
but **`thread.message-sent` and `thread.turn-start-requested` are explicitly excluded** — the shell
still shows the *previous* turn's terminal state until the provider acks the new turn, so publishing
immediately would fire a spurious "Done" push right before the real "running" state lands — and
`thread.activity-appended` publishes only for approval/input/error kinds. Matching events are enqueued
onto a `DrainableWorker`, so publishes for the whole server are **serial, one thread at a time**, which
is load-bearing for the dedupe and confirm logic.

`publishThreadUnsafe()` reads the publish flag and relay config from `ServerSecretStore`
(`cloud-relay-url`, `cloud-relay-issuer`, `cloud-relay-environment-credential`,
`cloud-publish-agent-activity`); if publishing is off or the environment is not linked, it is a silent
no-op. Otherwise it re-derives the snapshot, then **`sanitizeRelayAgentActivityState()` truncates
`detail` to 160 chars and redacts the failure detail entirely for `phase === "failed"`**
(`REDACTED_RELAY_AGENT_FAILURE_DETAIL = "The agent run failed."`) — whatever `session.lastError` says,
the real error message never leaves the machine over this channel.

**Dedupe**: an in-memory `Map<ThreadId, string>` of the last published state identity (JSON of the state
minus `updatedAt`); unchanged → skip.

**Confirmation deferral**: two transitions are not published immediately even when the identity changed
— a `null` tombstone when the last published state was live (a projector write can produce a transient
null mid-transaction), and `completed` as a thread's very first published state (a session boots at
"ready" for an instant before its first turn starts, which would otherwise read as `completed` and fire
a false "Done" push at thread birth). Both defer **5 seconds** and re-enqueue through the same worker.
The deadlines live in a plain `Map` — **not persisted, lost on server restart** (self-healing, since the
next real event re-derives, but the 5 s window is not a durable guarantee).

Each publish carries a signed proof: an **EdDSA JWT** (`typ: "t3-env-activity+jwt"`, 5-minute expiry,
`iss: t3-env:{environmentId}`, `aud` = normalised relay issuer, random `jti`) whose payload **embeds
the entire state object**, not a hash.

On the first boot after linking, `publishActiveThreadsOnceWhenConfigured()` polls every 5 s until
config and flag are ready, then publishes a full snapshot of every currently-active thread so relay and
mobile catch up on state that predates the connection.

### 14.3 Signing primitives

- `relayJwt.ts` wraps `jose` and hardcodes **EdDSA** with `typ` header discrimination per use
  (`t3-env-link+jwt`, `t3-cloud-mint+jwt`, `t3-cloud-health+jwt`, `t3-env-mint+jwt`,
  `t3-env-health+jwt`, `t3-env-activity+jwt`), a 5-minute default max token age and 60 s clock
  tolerance. `normalizeRelayIssuer` strips trailing slashes so issuer/audience comparisons never fail on
  a stray `/`.
- `relaySigning.ts`'s **`stableStringify()`** — a hand-rolled canonical JSON serialiser (sorted keys,
  `undefined` dropped, recursive) — is what every signature actually signs over, so key order can never
  desync signer and verifier.

### 14.4 The relay Worker

`infra/relay` is a single Cloudflare Worker with Hyperdrive → Postgres (drizzle-orm), one Cloudflare
Queue plus a dead-letter queue, a Cloudflare Tunnel binding + DNS binding, and a **cron trigger every 5
minutes**. Config secrets via `effect/Config`: `APNS_ENVIRONMENT`, `APNS_TEAM_ID`, `APNS_KEY_ID`,
`APNS_BUNDLE_ID`, `APNS_PRIVATE_KEY`, a per-deploy random `ApnsDeliveryJobSigningSecret` (32 bytes),
Clerk keys, and a per-deploy `CloudMintKeyPair`. HTTP is `HttpApiBuilder.layer(RelayApi, {openapiPath:
"/openapi.json"})` plus Scalar docs at `/docs`, CORS wide open, and a **9-second server-side request
deadline**. The cron prunes expired DPoP replay-nonce rows and prunes terminal
`relay_agent_activity_rows` older than 30 minutes — **the only garbage collection for this state**. The
queue consumer runs `batchSize: 10, maxRetries: 5, maxWaitTime: "5 seconds", retryDelay: "30 seconds"`,
dead-lettering after 5 failed attempts.

Auth layers: Clerk session bearer (falling back to Clerk OAuth verification); environment-credential
bearer (hashed lookup); and relay-issued DPoP access tokens requiring the `Authorization: DPoP` scheme
prefix. **Every mobile-scoped handler additionally checks the token's `scope` claim *and* re-verifies a
fresh per-request DPoP proof header against the access token's bound `cnf.jkt`, consuming its `jti` as a
replay nonce** — two layers of proof per registration call.

**Publish-proof verification** decodes the proof JWT, checks `exp`, re-verifies the signature against
the **caller's already-authenticated environment public key** (so the JWT signature check and the bearer
check are two independent proofs of the same identity), cross-checks that the proof's
`environmentId`/`threadId`/`sub` match the request's URL params **and that
`stableStringify(proof.state) === stableStringify(request.state)`** — i.e. the JWT is a signature over
the exact published state, so a MITM with valid bearer auth cannot swap in different state — then
consumes the `jti` as a replay nonce thumbprinted per environment identity rather than globally.

### 14.5 The delivery pipeline

`AgentActivityPublisher.publish()`:

1. Upsert (or, for `state === null`, delete) one row in `relay_agent_activity_rows` keyed
   `(environmentId, environmentPublicKey, threadId)`. **Terminal states are persisted too**, so a
   finished thread still shows Done/Failed in the aggregate for other live agents, pruned by the cron
   once 30 minutes old.
2. List every cloud user with a non-revoked link to this environment — **one environment fans out to N
   users' devices**.
3. For each user, rebuild that user's **entire** aggregate from all their active rows (not just the one
   that changed), filtering out phase-expired entries (**2 h TTL for `running`/`starting`, 24 h for
   anything else**, since an environment that dies mid-run never publishes a terminal state to clear its
   own row) and capping at `MAX_ACTIVITY_ROWS = 5`, sorted so waiting-for-approval/input roughly lead.
4. For each registered device, decide per-device, concurrently (4 users × 2 per user):
   - **Live Activity path**: if the user disabled Live Activities but a token remains, send an `end`. If
     enabled but no token registered, fall through to push-only. If the new aggregate is `null` — end,
     *unless* the card was armed less than 2 minutes ago (`FRESHLY_ARMED_GRACE_MS`, covering the gap
     between the app arming a card on send and the first real publish landing). Otherwise
     `shouldUpdateLiveActivity`: unconditional on first delivery, skip if byte-identical, force on
     `activeCount` change or a newly-attention or newly-terminal row, else throttle to one update per
     **15 s**.
   - **Alerting vs silent** is decided separately: `alertForAttentionTransition` (a row newly entered
     waiting_for_approval/input since the last delivered aggregate) or `alertForNewlyTerminal` (a row
     newly completed/failed, only if updated within the last **2 minutes**, so server-restart replays
     never re-buzz). Both require a **non-null previous aggregate** as baseline — a fresh registration
     replay never alerts.
   - **Push-notification path** fires only when Live Activities are off *or* there is no armed card,
     gated by per-event preference switches (`notifyOnApproval/Input/Completion/Failure`).
   - When a Live Activity `end` fires and a companion push would also ring, the `end` stays silent.
5. Every chosen delivery is **enqueued onto the Cloudflare Queue**, never sent synchronously — the HTTP
   handler returns `queued: true`, and the server-side `deliveryStats()` reports "queued", not
   "delivered".

Each queue job is an **HMAC-SHA256-signed envelope** with a 10-minute max age, verified again on dequeue
with `timingSafeEqual`. On dequeue, `processSignedJob` re-checks the job is not stale against the
*current* DB state (the device's stored token still matches; the aggregate/state identity has not moved
on; `userStillHasLiveWork` for `start` jobs) — and **each check fails open** (allows the delivery) on a
persistence error, with only a warning, so a transient DB hiccup never silently drops a real alert. A
job whose `sourceJobId` already completed short-circuits as a duplicate; one currently in flight returns
a claim-in-flight result rather than double-sending.

**APNs provider-token signing is deliberately deterministic across isolates**: `apnsJwt.ts` uses RFC 6979
deterministic ES256 (via `@noble/curves`, not Node's randomised signer) and quantises `iat` to a
45-minute window, so every stateless Worker isolate independently derives the byte-identical provider JWT
for the same window — no shared cache, no coordination — dodging APNs' `429
TooManyProviderTokenUpdates`, which the comments say was observed live during bursty Live Activity
updates.

### 14.6 The mobile side

- **Capability gate**: `supportsAgentAwarenessPush()` returns `false` when
  `Constants.expoConfig.extra.iosPersonalTeamBuild === true` — a build signed with a free/personal Apple
  team has no push entitlement, so the entire registration path is skipped, not merely degraded.
- The relay **enforces `iosMajorVersion >= 18` at the schema level**
  (`Schema.Int.check(Schema.isGreaterThanOrEqualTo(18))`), so an older-OS registration is rejected by
  request validation before any handler runs.
- **Registration** (`remoteRegistration.ts`, ~1100 lines) is a hand-rolled single-flight/coalescing state
  machine: a `deviceRegistrationGeneration` counter bumped on every sign-out/identity change so
  in-flight registrations from a stale identity are discarded even after they complete (checked at four
  separate await points); burst coalescing into at most one active + one pending request with merged
  inputs; and a `registrationSignature()` fingerprint of everything the relay stores for a device, so an
  identical signature skips the network call entirely on ordinary relaunch. A local
  `AgentAwarenessRegistrationStatus` (`unknown|pending|registered|failed`) is exposed to Settings and
  **deliberately decoupled from raw iOS permission state, so toggles never lie about "on" when the
  server-side registration never succeeded**.
- **Live Activities are only ever started client-side, in the foreground** (armed when the user sends a
  message from the phone) or **primed from a relay snapshot** on sign-in/foreground/connection-change, so
  an idle app never arms an empty card. **The relay never remote-starts one** — the code comment says
  background push-to-start proved "too unreliable to hand the token over". Re-registering an activity's
  update token is deliberately **not** deduped as a pure no-op, because every accepted registration
  triggers a relay-side **replay** of the current aggregate to that device, which is how a drifted or
  orphaned Live Activity self-heals on next foreground.
- **Navigation**: a tapped notification's `data.deepLink` is validated to be exactly
  `/threads/{env}/{thread}` (path traversal, query, fragment rejected), falling back to
  `data.environmentId` + `data.threadId`, and is deduped per notification `identifier` so a cold-start
  tap is never handled twice.
- **The widget is not Swift.** `widgets/AgentActivity.tsx` uses `expo-widgets`' `createLiveActivity()`:
  the Live Activity's SwiftUI layout is authored as a JSX function (`@expo/ui/swift-ui` components and
  modifiers) that gets **serialised and shipped into the widget extension's own JS bundle** — the file
  comment insists it stay self-contained with no references to module-scope helpers. It renders `banner`
  (lock screen, up to 5 rows), `bannerSmall` (watchOS/CarPlay), `compactLeading`/`compactTrailing`/
  `minimal` (Dynamic Island collapsed), and `expandedLeading/Center/Trailing/Bottom`. Colours are SwiftUI
  **semantic** labels (`"primary"`/`"secondary"`), not scheme-derived hex, because the Live Activity
  banner always renders over a fixed dark system material regardless of device theme.

**Push-to-start is fully wired in the data model and never fires.** The contract field
(`pushToStartToken`), the DB column, the APNs `start` event builder, the delivery-job kind
`live_activity_start`, and its token-invalidation handling all exist end to end — but
`chooseLiveActivityDelivery()` never returns `kind: "live_activity_start"`, and no mobile call site ever
obtains or sends a push-to-start token.

### 14.7 Mobile share-sheet ingestion

Not networking, but the other mobile-specific ingress: `apps/mobile/src/features/sharing/*` handles the
OS "Share to T3 Code" surface. It reads share payloads defensively (a missing iOS App Group — e.g. a
Personal-Team dev build without the entitlement — is treated as "no shares" rather than a crash), builds
an `IncomingShareDraft` (deduped shared text plus up to `PROVIDER_SEND_TURN_MAX_ATTACHMENTS` images each
≤ `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES`, converted to data-URL attachments **so the composer preview
survives after the OS-owned temp file is deleted**) with an optional `{environmentId, projectId}`
destination, and best-effort deletes the OS-owned temp files it consumed.

---

## 15. Feature: settings, keybindings, and provider health

### 15.1 One config stream carries everything

The server exposes a single push RPC, `server.subscribeServerConfig`, that **multiplexes three
independent concerns into one `Stream`**: a `"snapshot"` event on subscribe carrying the full
`loadServerConfig` result (which includes `keybindings` and `keybindingsConfigPath`), then a merged live
stream of `"keybindingsUpdated"` (from `keybindings.streamChanges`), `"providerStatuses"` (from
`providerRegistry.streamChanges`, debounced by `PROVIDER_STATUS_DEBOUNCE_MS`), and `"settingsUpdated"`
(from `serverSettings.streamChanges`, redacted via `redactServerSettingsForClient` before leaving the
server). There is no separate polling RPC for the steady state; `server.getSettings` exists only as a
point-in-time read.

Settings are one `UnifiedSettings` object (`packages/contracts/src/settings.ts`, defaults in
`DEFAULT_UNIFIED_SETTINGS`); clients send partial patches and `ServerSettingsService` is the authority.
Panels never write to localStorage for anything that must sync across devices — only for per-browser UI
state (theme, last project-grouping mode, the advanced-typography toggle).

**"Restore defaults" is a diff, not a wipe.** `useSettingsRestore()` computes a `changedSettingLabels`
list by comparing every tracked field to the defaults, shows exactly what will reset in a confirm
dialog, then applies the reset in a specific order — theme (base preference) → theme-half mix clear →
follow-system — with a **manual rollback path if any theme storage write fails midway**, before finally
calling `updateSettings` with every non-theme default. This is deliberately more careful than
`updateSettings(DEFAULT_UNIFIED_SETTINGS)` because theme preferences live in localStorage, a separate
failure domain, and the code treats a storage failure as something that must not leave theme and
non-theme state inconsistently reset.

**Background-activity settings are a profile system with an escape hatch.** `balanced` / `performance` /
`battery-saver` are named presets; picking "Advanced" does not set arbitrary values — it constructs
`{schemaVersion: 1, profile: "custom", baseProfile: <last named profile>, overrides: {...}}`.
`resolveBackgroundActivityProfileOption` round-trips the resolved effective settings back through
`normalizeBackgroundActivitySettings` to decide whether the state still matches a named profile or has
become genuinely "advanced" — so the UI can tell "user is on Performance" from "user tweaked one
Performance-based interval", and always retains a `baseProfile` fallback so overrides layer on a preset
rather than replacing it.

### 15.2 Keybindings

Commands are a closed union (`STATIC_KEYBINDING_COMMANDS`) unioned with one open pattern,
`SCRIPT_RUN_COMMAND_PATTERN = `script.${id}.run`` — this is how user-defined **project scripts** get
bindable shortcuts without a contract change. `KeybindingRule = {key, command, when?}` is the on-disk
and wire shape; `ResolvedKeybindingRule = {command, shortcut, whenAst?}` is the runtime shape.

Parsing is hand-written, not a library. `parseKeybindingShortcut` splits on `+`, tolerates a literal
trailing `+` key (`"mod++"` for zoom-in), and maps modifier tokens (`cmd`/`meta`, `ctrl`/`control`,
`shift`, `alt`/`option`, `mod`) plus one non-modifier key. `parseKeybindingWhenExpression` is a
hand-rolled recursive-descent parser for a boolean expression language over identifiers with `!`, `&&`,
`||`, and parens, with `MAX_WHEN_EXPRESSION_DEPTH = 64` guarding against pathological nesting; it
produces a `KeybindingWhenNode` **AST**, which is what is stored and evaluated at match time.
**`mod` is resolved to Cmd/Ctrl only at match and format time, never baked into storage**, so a
`keybindings.json` written on Windows behaves correctly when synced to a Mac.

Server-side persistence is one JSON file at `<stateDir>/keybindings.json`, no DB row:

- **Cache + file watcher**: a `Cache.make({capacity: 1, lookup: readFromDisk})` holds the resolved
  config; `fs.watch` on the config *directory* (not the file — editors truncate/rewrite/rename),
  debounced 100 ms, invalidates the cache and re-emits on a `PubSub`. Hand-editing the file is picked up
  live.
- **Startup default-backfill**: `syncDefaultKeybindingsOnStartup` diffs the user's custom rules against
  `DEFAULT_KEYBINDINGS` by `command` and appends any default whose command is not customised — *unless*
  that default's key+when shortcut is already claimed by an unrelated custom rule, in which case it is
  skipped with a logged warning. Shipping a new default is safe for existing users only up to that
  collision.
- **Invalid entries degrade, not fail**: a malformed entry is logged and reported as a
  `ServerConfigIssue` (`keybindings.invalid-entry` / `keybindings.malformed-config`) but does not fail
  the whole load.
- **Merge precedence**: keep every default whose `command` is not overridden, cap at
  `MAX_KEYBINDINGS_COUNT = 256`, dropping the **oldest** entries first when over budget.
- **Atomic write + single-writer semaphore** for every persist.
- Two RPC methods: `server.upsertKeybinding` (with an optional `replace: {key, command, when}` target so
  "rebind this row" atomically removes the old rule and adds the new one) and `server.removeKeybinding`;
  both return the full resolved config so the client needs no refetch.

Client matching walks the resolved config **backwards** (last rule wins on tie), and conflict resolution
is **context-aware**: even when computing "the effective shortcut for command X" for hint display, the
code tracks a `claimedShortcuts` set keyed by (key + resolved-mod + modifiers) *per matching `when`
context*, so two commands can legitimately share a physical key when their `when` clauses are mutually
exclusive. The UI conflict detector only flags a row when the `when` clauses overlap or either is empty.

The shipped defaults (`packages/shared/src/keybindings.ts:22-59`):

```
mod+b            sidebar.toggle
mod+j            terminal.toggle
mod+alt+b        rightPanel.toggle
mod+d            terminal.split          when: terminalFocus
mod+shift+d      terminal.splitVertical  when: terminalFocus
mod+n            terminal.new            when: terminalFocus
mod+w            terminal.close          when: terminalFocus
mod+d            diff.toggle             when: !terminalFocus
mod+shift+j      preview.toggle
mod+r            preview.refresh         when: previewFocus
mod+l            preview.focusUrl        when: previewFocus
mod+= / mod++    preview.zoomIn          when: previewFocus
mod+-            preview.zoomOut         when: previewFocus
mod+0            preview.resetZoom       when: previewFocus
mod+k            commandPalette.toggle   when: !terminalFocus
mod+p            filePicker.toggle       when: !terminalFocus
mod+shift+f      projectSearch.toggle    when: !terminalFocus
mod+alt+shift+t  themeEditor.toggle
mod+s            composer.stash          when: !terminalFocus
mod+n            chat.new                when: !terminalFocus
mod+shift+o      chat.new                when: !terminalFocus
mod+shift+n      chat.newLocal           when: !terminalFocus
mod+shift+m      modelPicker.toggle      when: !terminalFocus
mod+o            editor.openFavorite
mod+shift+[      thread.previous
mod+shift+]      thread.next
mod+1..N         thread jump commands
mod+1..N         model-picker jump       when: modelPickerOpen
```

### 15.3 Project scripts ("Actions")

`ProjectScript` (`packages/contracts/src/orchestration.ts:194-212`):

```ts
{ id, name, command, icon: ProjectScriptIcon, runOnWorktreeCreate: boolean,
  previewUrl?: string,      // opened in the in-app browser preview when the script runs; desktop only
  autoOpenPreview?: boolean // auto-open the preview panel the moment the script starts
}
```

So a project script doubles as a **worktree lifecycle hook** (`runOnWorktreeCreate`) and can bind a
keyboard shortcut through the `script.${id}.run` command pattern.

### 15.4 Provider health and one-click updates

**Aggregation.** `ProviderRegistry` turns N independently-polling provider *instances* into the one list
the UI renders. `providersRef` is seeded from on-disk cache files before any live probe runs, so the UI
has something to show immediately. Each instance contributes a `ProviderSnapshotSource`, and the registry
**subscribes to each instance's `streamChanges` before reading its current snapshot** — two long inline
comments document a previously-shipped race (`Stream.fromPubSub`'s subscribe-on-start vs `forkScoped`'s
async start) that dropped a config-driven instance-rebuild publish. `mergeProviderSnapshot` retains
previously-known **models** across snapshots that momentarily report zero, with an explicit
OpenCode-specific carve-out: OpenCode's first probe is non-authoritative (still connecting to its own
daemon), so a transient empty/error snapshot must not blank a good model list, whereas a disabled or
missing-CLI snapshot *is* authoritative and should. Volatile update-in-progress state is layered onto
snapshots and **explicitly never persisted** — a restart correctly forgets it, since the update process
does not survive either.

**On-disk cache.** One JSON file per *instance* at `<cacheDir>/<instanceId>.json` — not per driver kind,
which is what stops multi-instance setups colliding (for a driver's default instance
`instanceId === kind`, so legacy `<kind>.json` paths are preserved for free). Cache reads require the
payload's `instanceId` + `driver` to match the source's expected identity; a stale or mismatched file is
discarded, not trusted by filename.

**Health-check interval is demand-gated, not a fixed timer.** The refresh loop
(`Effect.forever` around `Effect.raceFirst(sleep(interval), interval-change-queue)`) re-reads the
interval from live settings on every iteration — so changing it in Settings takes effect on the *next*
tick, not after a restart — and before refreshing calls `hasProviderStatusDemand`, which asks
`BackgroundPolicy` whether a generic `{type: "provider-status"}` or instance-scoped scope currently has
client demand. An interval of `0` disables the loop's own scheduling, substituting a 60 s poll purely to
keep re-checking demand. Settings-triggered rebuilds (e.g. binary path changed) happen via a separate
subscription regardless of demand.

**`BackgroundPolicy`** is the lease mechanism. Clients report activity leases scoped by
`{server-config | diagnostics | provider-status[:instanceId] | vcs-status:cwd | git-refs:cwd |
thread:threadId}`, each with a TTL: `DEFAULT_LEASE_TTL_MS = 45_000`, capped at
`MAX_LEASE_TTL_MS = 120_000`, max **16** leases per RPC client (oldest evicted first). A scope "has
demand" only while at least one live client holds an unexpired lease, and `shouldRunScopeWork`
additionally folds in host power state (locked screen, low power mode, on battery) per the resolved
background-activity pause flags. **Closing every tab genuinely stops background provider probing** after
the lease expires.

**Package-manager detection for "Update" is path string-matching.**
`resolvePackageManagedProviderMaintenance` sniffs the resolved binary's path against known install-tree
shapes: npm global (`node_modules/.bin`, `lib/node_modules`), bun global (`/.bun/bin/`), pnpm global
(`/.local/share/pnpm/`, `/pnpm/global/`), vite-plus global (`/.vite-plus/bin/`), Homebrew
(`/opt/homebrew/cellar/`, `/usr/local/cellar/`, a `caskroom` variant, or a bare `/opt/homebrew/bin/` /
`/usr/local/bin/` prefix). A driver may supply a `nativeUpdate` checked first. If nothing matches and the
resolved path has no separator (found via `PATH`), it defaults to `npm install -g <pkg>@latest`; if the
path resolves but matches nothing known, maintenance falls back to **manual-only** and the UI shows no
update button. Latest-version lookup hits `https://registry.npmjs.org/<pkg>/latest` with a 4 s timeout
and caches **per package name for one hour** in a process-lifetime `Context.Reference`.

**Update execution**: run via `ChildProcessSpawner` with Windows `.cmd` shim resolution (a bare
`spawn("npm", …)` fails `ENOENT` on Windows without it); a **5-minute** timeout races the command;
stdout and stderr are each capped at **10 000 bytes** with a `truncated` flag surfaced to the UI. A
coordinator enforces **one update per target** (`targetKey = "instance:<instanceId>"`) — a second
request queues ("Waiting for another provider update to finish") rather than running concurrently or
being rejected — and a separate `lockKey` (e.g. `"npm-global"`) can serialise across different providers
sharing an update mechanism. After exit 0 the runner **re-probes the provider** and only reports
`"succeeded"` if the fresh version advisory no longer says `behind_latest`; if the probe itself fails,
status is `"unchanged"` with an explicit "could not verify" message — **the tool does not trust the
update command's own exit code.**

### 15.5 Diagnostics

- **`ProcessDiagnostics`** exposes the live descendant-process tree (server children, provider roots,
  terminal roots). Sending a signal **verifies the target `(pid, startTimeMs)` pair against a freshly
  re-read telemetry snapshot** before calling `process.kill` — closing a PID-reuse race where a stale UI
  holding an old PID could signal an unrelated process — and explicitly refuses to signal the server's
  own pid.
- **`TraceDiagnostics`** parses the server's own local OTEL-style JSON-Lines trace file plus rotated
  backups to build an in-memory dashboard: slow-span threshold (default 1000 ms), top spans by count,
  slowest spans, common failure signatures grouped by `(name, cause)`, and the most recent warning/error
  log lines pulled out of span `events[].attributes["effect.logLevel"]`. Hand-rolled line-by-line
  parsing; a malformed line increments `parseErrorCount` and is skipped.
- **CPU/RSS history is sampled by a separate native Rust binary**, `t3-resource-monitor`. The server
  locates it through an ordered candidate list — env override `T3CODE_RESOURCE_MONITOR_PATH`, config
  override, then bundled/dev-tree paths keyed by `<platform>-<arch>` with Linux further split by glibc
  vs musl (detected via `process.report`) — falling through `dist/resource-monitor/<platform-arch>/`,
  sibling `native/` build outputs, and finally a `debug` build. On non-Windows the executable bit is
  checked. The subsystem degrades to "resource monitoring unsupported" rather than crashing on an
  unrecognised platform/arch/libc.

---

## 16. Feature: the desktop app shell

### 16.1 Process model

`apps/desktop/src/main.ts` (217 lines) is the whole composition root, bundled to CommonJS at
`dist-electron/main.cjs`. It composes roughly 30 Effect layers: an `electronLayer` of thin wrappers over
Electron globals (`ElectronApp`, `ElectronDialog`, `ElectronMenu`, `ElectronPowerMonitor`,
`ElectronProtocol`, `ElectronSafeStorage`, `ElectronShell`, `ElectronTheme`, `ElectronUpdater`,
`ElectronWindow`, plus `DesktopIpc`), a `desktopFoundationLayer`, a `desktopWindowLayer`, and a
`desktopBackendLayer`, all provided over `DesktopPreReadyPlatform.layer`. The sharpest ordering comment
in the file: the Clerk layer is acquired **after** `DesktopPreReadyPlatform` because Clerk's userData
resolution can yield and let Electron emit `ready` before scheme privileges are registered.

Startup: import the user's login-shell environment into `process.env`; reconcile the Linux
`--password-store` switch; `setPath("userData", …)`; load settings; configure app identity, lifecycle,
Clerk; `whenReady`; configure the application menu, updates, Linux URL handler; then bootstrap. Any
failure routes to `handleFatalStartupError`, which logs, shows
`dialog.showErrorBox("T3 Code failed to start", …)` once (guarded by a `quitting` `Ref`), requests
shutdown, and quits.

Bootstrap resolves the backend port — in development `T3CODE_PORT` is **required**; in production it
scans from **3773** upward, requiring the port to be free on **all three** of `127.0.0.1`, `0.0.0.0`,
`::` (otherwise switching to network-accessible mode later would fail on a port that only looked free on
loopback). Then it configures server exposure, registers the custom protocol, installs IPC handlers, and
starts the backend — showing a "Connecting to WSL…" splash first when `wslOnly && wslBackendEnabled`.

`scopedProgram` generates a 12-hex-char `runId` used to annotate every log and span, and installs a
finalizer that stops **every** pooled backend concurrently, because `electronApp.quit()` can outrun the
layer-scope cascade and the OS would hard-kill a WSL child instead of SIGTERM + grace.

**The single-instance lock is not taken by T3 code directly** — `DesktopClerk` creates the Clerk Electron
bridge, which acquires the lock as a side effect; if `bridge.isPrimaryInstance` is false the app quits
before `whenReady` can fire. The primary registers `second-instance` to reveal the existing window.

### 16.2 The custom protocol

Schemes `t3code` (production) and `t3code-dev` (development), host always `app`, so the renderer origin
is `t3code://app`. `registerSchemesAsPrivileged` marks both
`standard: true, secure: true, supportFetchAPI: true, corsEnabled: true`, synchronously pre-`ready`.
`protocol.handle` installs a **reverse proxy**: rewrite `t3code://app/<path>` to
`<targetOrigin>/<path>`, **strip** `host`, `origin`, `referer`, `connection`, `content-length`,
`accept-encoding`, `upgrade-insecure-requests` and any `sec-fetch-*` header, then forward via
`Electron.net.fetch`. `GET`/`HEAD` go through `fetchWithTransientRetry` with delays `[0, 50, 150] ms`;
other verbs use a streaming body with `duplex: "half"`. Origin stability is what buys stable
localStorage, cookies, and Clerk sessions across port changes; the header stripping is what makes the
backend treat it as first party.

Every response gets an injected CSP:

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://<clerk-frontend-api> https://challenges.cloudflare.com;
connect-src 'self' http: https: ws: wss:;
img-src 'self' t3code: blob: data: http: https:;
style-src 'self' 'unsafe-inline';
font-src 'self' t3code: data:;
worker-src 'self' blob:;
frame-src 'self' https://challenges.cloudflare.com;
form-action 'self'
```

`connect-src` is deliberately scheme-wide rather than host-scoped, because the renderer dials
user-configured remote environments whose origins are unknown at policy-construction time.
`'wasm-unsafe-eval'` is what lets the Ghostty terminal WASM run.

The renderer uses **hash history** in Electron (`createHashHistory()` vs `createBrowserHistory()`).

### 16.3 Window chrome

```ts
TITLEBAR_HEIGHT             = 40
TITLEBAR_COLOR              = "#01000000"   // "#00000000 does not work on Linux"
TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937"
TITLEBAR_DARK_SYMBOL_COLOR  = "#f8fafc"
```

macOS uses `titleBarStyle: "hiddenInset"` with `trafficLightPosition: {x: 16, y: 18}`; Windows and Linux
use `titleBarStyle: "hidden"` plus a `titleBarOverlay` at height 40 with the symbol colour switched by
theme. Initial window background is `#0a0a0a` dark / `#ffffff` light.

`BrowserWindow`: `minWidth: 840, minHeight: 620`, default size **1100 × 780**, `show: false`,
`autoHideMenuBar: true`, `disableAutoHideCursor: true` (darwin), and webPreferences
`{preload, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true,
webviewTag: true}`. Persisted bounds are restored **only if they fit entirely inside one connected
display**. Bounds persistence is debounced **500 ms** with interruptible Effect fibers, flushed on
`close` and on quit.

Event handling worth knowing:

- **`will-attach-webview`** rejects non-preview partitions and force-sets the guest's security flags
  (§12.7).
- **`context-menu`** builds a native menu with up to 5 spellcheck suggestions, "Copy Link" for safe
  external URLs, "Copy Image" for images, then cut/copy/paste/selectAll gated on `params.editFlags`.
- **`setWindowOpenHandler`** always returns `{action: "deny"}` and `shell.openExternal`s safe URLs;
  **`will-navigate`** allows same-origin only.
- **`before-input-event`** swallows **auto-repeat** Cmd/Ctrl+W: holding the close-terminal shortcut can
  outlive the terminal that handled the first press, and Electron's `windowMenu` close role owns Cmd+W.
- **`page-title-updated`** is prevented; the title is pinned to `environment.displayName`.
- **`render-process-gone`** reloads on `crashed | oom | abnormal-exit` after **500 ms**, at most **3
  times per rolling 60 s**. The comment names the cause: V8 heap exhaustion on long sessions. Renderer
  crash recovery is a product feature — agents keep running in the backend, so the user would otherwise
  stare at a dead window.
- **Development load retry** uses delays `[100, 250, 500, 1000, 2000] ms` for main-frame failures with
  error codes `-2, -7, -9, -102, -105, -106, -118`.
- **First reveal** fires exactly once via `bindFirstRevealTrigger` (`ready-to-show`, plus
  `did-finish-load` on Linux), maximising first if configured, then closing the WSL splash so there is no
  blank gap.

**The WSL splash** is a self-contained `data:text/html` page — no bundled asset, no backend — with its
own inline CSP (`default-src 'none'; style-src 'unsafe-inline'`), a 26 px CSS-only spinner
(`border: 3px`, `animation: spin .8s linear infinite`),
`font-family: system-ui, -apple-system, 'Segoe UI', sans-serif`, `font-size: 13px`, and
`-webkit-app-region: drag`. Splash colours: label `#9ca3af`/`#6b7280`, accent `#f8fafc`/`#1f2937`, track
`rgba(248,250,252,0.18)`/`rgba(31,41,55,0.18)`. The window is 360 × 220, frameless, non-resizable,
centred. It is tracked in a separate `Ref` and **explicitly filtered out of every "current window"
lookup** by `withoutSplash`, because treating it as the main window is a documented past bug.

**Zoom menu items are not roles.** Electron's `zoomIn`/`zoomOut` roles act on the focused `webContents`,
which with a preview `<webview>` or DevTools focused is the guest page; `zoomMain` always targets the
main window's own `webContents` with the same ±0.5 step.

The application menu is one template: a macOS app menu; **File** (Settings… `CmdOrCtrl+,` on non-mac,
then `close`/`quit`); `{role: "editMenu"}`; **View** (reload, forceReload, toggleDevTools, Actual Size
`CmdOrCtrl+0`, Zoom In `CmdOrCtrl+=` plus a hidden duplicate on `CmdOrCtrl+Plus`, Zoom Out
`CmdOrCtrl+-`, togglefullscreen); `{role: "windowMenu"}`; **Help** ("Check for Updates…"). "Settings…"
does **not** open a native window — it sends the string `"open-settings"` on `desktop:menu-action` to
the focused window (queuing behind `did-finish-load` if still loading), and the renderer navigates to
`/settings`.

### 16.4 IPC

Three files: `ipc/channels.ts` (**80 exported channel-name constants**, all prefixed `desktop:`),
`ipc/DesktopIpc.ts` (an Effect service wrapping `ipcMain`, where `handle`/`handleSync` are
`Effect.acquireRelease`d so leaving the scope unregisters the handler, and every invocation is wrapped
in a span annotated with `{channel}`), and `ipc/DesktopIpcHandlers.ts` (registers all of them in one
place).

The type-safety trick is `makeIpcMethod`/`makeSyncIpcMethod`: **each method declares an Effect
`Schema.Codec` for its payload and for its result**, and the generated handler is
`decode(raw) → handler → encode(result)`. The IPC boundary is schema-validated in both directions rather
than cast.

The preload calls `exposeClerkBridge({passkeys: true})` first, then
`contextBridge.exposeInMainWorld("desktopBridge", {…} satisfies DesktopBridge)` — a flat mapping to
`ipcRenderer.invoke`/`.on`/`.sendSync` with hand-written runtime type guards on every listener payload.
**Three channels are synchronous** because the renderer needs them before it can render anything:
`desktop:get-app-branding`, `desktop:get-local-environment-bootstraps`,
`desktop:get-window-fullscreen-state`. Push channels are `desktop:menu-action`,
`desktop:window-fullscreen-state`, `desktop:update-state`, `desktop:ssh-password-prompt`,
`desktop:preview-state-change`, `desktop:preview-pointer-event`, `desktop:preview-recording-frame`. One
special case: `ensureSshEnvironment` unwraps a sentinel
(`SSH_PASSWORD_PROMPT_CANCELLED_RESULT = "ssh-password-prompt-cancelled"`) and rethrows it as a JS
`Error`, because the cancellation cannot cross IPC as a rejection without losing its message.

`DesktopBridge` is declared once in `packages/contracts/src/ipc.ts` and consumed by both the preload
(`satisfies`) and the web app (`window.desktopBridge`, and `isElectron` is literally
`typeof window !== "undefined" && window.desktopBridge !== undefined`). Some members are **optional
specifically to tolerate older desktop builds against a newer web bundle**: `getConnectionCatalog?`,
`setConnectionCatalog?`, `clearConnectionCatalog?`, `pickThemeFiles?`, and `preview?` — whose presence is
the actual capability check for "am I in the desktop app with browser previews".

`apps/web/src/localApi.ts` is the renderer façade (`dialogs.pickFolder`, `shell.openExternal`,
`contextMenu.show`, `persistence.get/setClientSettings`), each branching on `window.desktopBridge` with a
browser fallback — notably `contextMenu.show` falls back to a DOM menu that **re-draws Lucide icon paths
inline** (`viewBox 0 0 24 24`, `strokeWidth 2`) because it cannot use React there. Conversely
`ElectronMenu.normalizeContextMenuItems` **strips** `header` items and `icon` keywords since native menus
have no equivalent, and on macOS decorates destructive items with
`nativeImage.createFromNamedImage("trash").resize({width: 12, height: 12})` as a template image. Context
menu coordinates are multiplied by the window's zoom factor before `popup()` (CSS pixels vs window
points).

### 16.5 Backend supervision

`DesktopBackendManager.ts` (1141 lines) is a **factory, not a singleton service**: `makeBackendInstance
(spec)` returns an instance with `id`, `label`, `start`, `stop`, `currentConfig`, `snapshot`,
`waitForReady`, called once per backend — the native **primary** and, when enabled, a WSL instance under
`wsl:<distro>` ids.

```
INITIAL_RESTART_DELAY                     = 500 ms   (exponential: 500ms · 2^attempt)
MAX_RESTART_DELAY                         = 10 s
MAX_PREFLIGHT_FAILURE_ATTEMPTS            = 5
DEFAULT_BACKEND_READINESS_TIMEOUT         = 1 minute
DEFAULT_BACKEND_READINESS_INTERVAL        = 100 ms
DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT = 1 s
DEFAULT_BACKEND_TERMINATE_GRACE           = 2 s   (SIGTERM, then force kill)
DEFAULT_BACKEND_OUTPUT_DRAIN_TIMEOUT      = 5 s
BACKEND_READINESS_PATH = "/.well-known/t3/environment"
```

**The server bootstrap travels on file descriptor 3** as one line of JSON:

```ts
{ mode: "desktop", noBrowser, port, t3Home?, host, desktopBootstrapToken,
  tailscaleServeEnabled, tailscaleServePort,
  otlpTracesUrl?, otlpMetricsUrl?, desktopTelemetryFd?, desktopTelemetryControlFd?,
  resourceMonitorPath? }
```

Two further fds may be opened: an input fd carrying a desktop→server telemetry stream and an output fd
carrying newline-delimited `DesktopTelemetryControlMessage` JSON back (e.g.
`{version: 1, type: "setDiagnosticsDemand", enabled}`). **WSL is the exception**: `wsl.exe` drops extra
file descriptors when forwarding to Linux, so that path sets `bootstrapDelivery: "stdin"` and passes
`--bootstrap-fd 0`. WSL also uses `extendEnv: false` so a leaking `T3CODE_HOME` cannot pin the WSL
backend to `/mnt/c/…/.t3`.

**The main window no longer points at the backend URL.** A comment records the migration: the window
always loads `getDesktopUrl(isDevelopment)` and the renderer dials backends through the shared connection
supervisor; `handleBackendReady`'s `httpBaseUrl` is now only used for the readiness log.

What the renderer sees: `desktop:get-local-environment-bootstraps` returns one
`{id, label, runningDistro, httpBaseUrl, wsBaseUrl, bootstrapToken?}` per pooled instance. Instances with
no config yet, or retrying a *transient* preflight failure, are surfaced with **null endpoints** so the
renderer shows "Connecting…" without dialling a dead port; the primary and *fatally* failed instances are
skipped entirely.

### 16.6 Desktop settings and updates

Despite `electron-store@8.2.0` being a declared dependency, **it is never imported** anywhere in
`apps/desktop/src` — settings are plain JSON written through Effect's `FileSystem`:

```
<stateDir>/desktop-settings.json     ← DesktopAppSettings
<stateDir>/client-settings.json      ← the web app's ClientSettings
<stateDir>/saved-environments.json
<stateDir>/settings.json             ← server settings
<stateDir>/logs/
<stateDir>/browser-artifacts/
```

`DesktopSettings` holds `linuxPasswordStore`, `mainWindowBounds`, `mainWindowMaximized`,
`serverExposureMode`, `tailscaleServeEnabled`, `tailscaleServePort` (default **443**), `updateChannel`
(`"latest"`), `updateChannelConfiguredByUser`, `wslBackendEnabled`, `wslDistro`, `wslOnly`. A legacy
`wslMode: "wsl"` key is still accepted on load and rewritten; settings missing
`updateChannelConfiguredByUser` are treated as user-configured only if they were on `"nightly"`. Persist
writes **only non-default keys**, so the file stays minimal.

Identity values: `appUserModelId` `com.t3tools.t3code` (`.dev` in development), Linux desktop entry
`t3code.desktop` / `t3code-dev.desktop`, WM class `t3code` / `t3code-dev`, userData dir `t3code` /
`t3code-dev` (legacy names `T3 Code (Alpha)` / `T3 Code (Dev)`). Product name is `"T3 Code (Alpha)"`, and
`resolveDesktopAppBranding` composes `displayName` as `` `${APP_BASE_NAME} (${stageLabel})` ``.

**Auto-update** wraps `electron-updater@6.6.2`. `updates/updateMachine.ts` is a pure reducer module (one
function per transition, no Effect, no I/O); `DesktopUpdates.ts` (852 lines) owns the listeners, the
polling loop, and IPC broadcast. Cadence: `AUTO_UPDATE_STARTUP_DELAY = "15 seconds"`, then
`AUTO_UPDATE_POLL_INTERVAL = "4 minutes"` — but **auto-download is never triggered automatically**
(`autoDownload` left off); the user clicks once to download, then again to install. Checks are skipped
while a download or install is in flight. `install` stops every pooled backend concurrently (5 s timeout
each) before `quitAndInstall({isSilent: true, isForceRunAfter: true})`, explicitly because leaving a WSL
backend running would let `app.quit()` race the pool's stop finalizer. Updates are unconditionally
disabled outside packaged production builds, when `T3CODE_DISABLE_AUTO_UPDATE` is set, or on Linux when
not running the AppImage build.

The "Update track" selector unifies two entirely different implementations: desktop calls
`window.desktopBridge.setUpdateChannel`; the hosted web app instead **navigates the browser** to a URL
that flips the `t3code_web_channel` cookie on the router domain and reloads — there is no server-side
"hosted channel" RPC at all.

### 16.7 App shell layout

`AppSidebarLayout.tsx` wraps everything in a `SidebarProvider` (`className="h-dvh! min-h-0!"`) from a
shadcn-style sidebar rebuilt on Base UI. The left `<Sidebar side="left" collapsible="offcanvas"
data-app-sidebar>` hosts either the settings nav (on `/settings*`), `LegacySidebar`, or the default
thread/project sidebar. `SidebarRail` is a resize handle; double-click resets width.

Widths: `SIDEBAR_WIDTH = "16rem"`, `SIDEBAR_WIDTH_MOBILE = "calc(100vw - var(--spacing(3)))"`,
`SIDEBAR_WIDTH_ICON = "3rem"`. Thread-sidebar-specific limits (`threadSidebarWidth.ts`): default
**256 px**, min **208 px**, and the main content is guaranteed **640 px**, so max sidebar width is
`viewportWidth - 640`. Persisted under localStorage key `chat_thread_sidebar_width`. **Sidebar
open/closed state is persisted in a cookie via the `cookieStore` API** (`sidebar_state`, max-age 7 days)
— the only place in the app that uses cookies for UI state.

macOS-only: when `isElectron && isMacPlatform(navigator.platform)` and the window is **not** fullscreen,
`--workspace-controls-left` is overridden to **90 px** (`MACOS_TRAFFIC_LIGHTS_LEFT_INSET`) to clear the
traffic lights.

**Right panel.** `rightPanelStore.ts` is zustand + persist, key `t3code:right-panel-state:v2`, **version
11**. State is per `scopedThreadKey(threadRef)`: `{isOpen, activeSurfaceId, surfaces[]}`. The seven
surface kinds are `diff`, `files`, `file`, `preview`, `terminal`, `pull-request`, `agents`. Ids encode
the resource: `browser:<tabId>`, `terminal:<id>` (with `terminalIds[]`, `activeTerminalId`, optional
`splitDirection`), `file:<path>`, `pull-request:<ref>`; `diff`, `files`, `agents` are singletons. The
pull-request *list* panel is deliberately **not** persisted.

Tab strip facts: the strip is `.workspace-topbar` at `height: var(--workspace-topbar-height)` with
`gap-1 pl-2`, overriding the height to `--spacing(11)` (2.75 rem) in non-inline modes. A tab is
`h-6 max-w-36 rounded-md pr-2 pl-1.5 text-xs gap-0.5`; active `bg-accent text-foreground`, inactive
`text-muted-foreground hover:bg-accent/60 hover:text-foreground`. **The leading 16 px button swaps its
icon for `X` on tab hover** (`group-hover/tab:hidden` / `group-hover/tab:block`) — the icon *is* the
close button, so tabs stay 24 px tall with no separate affordance. A `size-1.5 rounded-full bg-current`
dot at bottom-right marks a pending surface. Icons are 12 px (`size-3`) Lucide: `FileDiff`, `Files`,
`TerminalSquare`, `Globe2`, `GitPullRequest`, `Bot`, `Plus`, `X`; browser tabs show a real favicon
falling back to `Globe2`; file tabs use `PierreEntryIcon`. Middle-click closes a tab; right-click opens
the *native* context menu with Copy path / Close / Close others / Close to the right / Close all.

`PreviewPanelShell` owns the preview width: storage key `t3code:preview-panel-width`, min **360 px**,
default **540 px**, max **0.7 × viewportWidth**. `RightPanelSheet` is the narrow variant — a Base UI
`Sheet` on `side="right"` with
`w-[min(42vw,28rem)] min-w-80 max-w-[28rem] p-0 max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0
wco:mt-[env(titlebar-area-height)]` — and the inline↔sheet switch is
`RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)"`. The diff panel is
`w-[42vw] min-w-[360px] max-w-[560px]` in inline mode with a 52 px drag-region header in Electron.

---

## 17. Feature: themes — five built-ins, a palette engine, VS Code import, and a live editor

The token values themselves are in §19; this section is the feature mechanism.

### 17.1 Fifty-seven roles, one canonical colour form

`THEME_COLOR_ROLES` (`apps/web/src/themePalette.ts:26-84`) is a 57-entry tuple, grouped:

```
canvas chrome
toolbar toolbarForeground toolbarBorder toolbarControl toolbarControlForeground toolbarControlHover
surface surfaceRaised surfaceOverlay
text textMuted border input focus
accent accentForeground accentSurface accentSurfaceForeground
secondary secondaryForeground muted mutedForeground placeholder secondaryLabel iconMuted
error errorForeground errorSurface  warning warningForeground warningSurface
update updateForeground updateSurface
messageSurface messageForeground messageAction messageActionForeground messageActionHover
codeBackground codeForeground
sidebar sidebarForeground sidebarMutedForeground sidebarControlSurface
sidebarRowHover sidebarRowActive sidebarRowSelected sidebarBorder
terminalBackground terminalForeground terminalCursor terminalSelection
terminalScrollbar terminalScrollbarHover
```

`APP_THEME_VARIABLES` maps each role to a kebab-case `--app-theme-*` variable, with one name mismatch:
role `terminalSelection` → `--app-theme-terminal-selection-background`.

Every stored colour is normalised to OKLCH text by `toCanonicalThemeColor` via culori: `parse()` →
`converter("oklch")` → formatted `oklch(L C H)` with 6/6/3 decimal places, or `oklch(L C H / A)` when
alpha < 1. Hue is forced to 0 when chroma < 5e-7. A CSS `/ none` alpha is detected by regex and read as
0 because culori drops it.

### 17.2 Two palette engines

**`createManagedThemeColors(appearance, background, accent, {exactSeeds?})`** — the "guided" engine,
working in sRGB/HSL. It first pushes seeds into a readability envelope (`managedThemeBackground`:
saturation ≤ 0.30 dark / 0.20 light; lightness clamped to [0.07, 0.13] dark or [0.94, 0.985] light;
`managedThemeAccent` scans 61 lightness candidates for the one closest to a preferred lightness that
still clears **contrast ≥ 4.7**). Then it derives surfaces by linear RGB mixing:
`sidebar = canvas + 8% accent`, `surfaceRaised = canvas + 12%/3.5% text`,
`secondary = +20%/8% accent`, `accentSurface = +30%/14%`, `messageSurface = +36%/18%`,
`border = (canvas + 22%/10% accent) + 10% text`, `input = (canvas + 30%/14% accent) + 14%/13% text`.

**`createVividThemeColors(appearance, background, accent)`** — the perceptual engine used by the
*advanced* editor and by VS Code import, working entirely in OKLCH. Surfaces climb an even lightness ramp
`canvas.L ± delta` carrying the accent hue at low chroma
(`tintC = clamp(accent.C * 0.22, 0.008, 0.045)`); the companion action colour is the accent rotated
**+50°** in hue; and every foreground is binary-searched for contrast (`solveOklchLightness`, 18
iterations). Text targets **WCAG AAA (7.0)** against the canvas; surface foregrounds target **4.6** — a
hair over 4.5, to "leave a little headroom for browser color conversion at render time". Out-of-gamut
OKLCH is chroma-reduced by binary search to fit sRGB.

Both engines key light-vs-dark decisions off **measured relative luminance < 0.179**, not the declared
appearance — *"0.179 is the relative luminance where white and black text have equal contrast
headroom"* — so a dark canvas saved as a light theme still gets light text.

Muted text is matched to the stock palettes by **measured** contrast, not an arbitrary mix:
`STANDARD_LIGHT_MUTED_CONTRAST = 4.705` and `STANDARD_DARK_MUTED_CONTRAST = 5.082`, described as "the
measured contrast ratios of zinc-500 on the standard light canvas and `#818181` on the standard dark
canvas".

Generated themes deliberately **do not inherit the brand's error/warning colours**:
`standardStatusColors()` re-derives red/amber from `STANDARD_STATUS_COLORS` (light `#fb2c36`/`#c10007`,
`#fe9a00`/`#bb4d00`; dark `#fb414a`/`#ff6467`, `#fe9a00`/`#ffb900`) laid over the theme's own canvas at
8% (light) / 16% (dark), so a destructive button never inherits a theme's hue.

### 17.3 Storage, preference resolution, and theme halves

localStorage keys:

```
t3code:theme                   the theme preference ("system" | "light" | "dark" | <theme id>)
t3code:themes:v1               the custom-theme library (JSON array of ThemeDefinition)
t3code:theme-appearance-mode   "light" | "dark" | "system"   (source of truth)
t3code:theme-follow-system     legacy boolean, read-only migration input
t3code:theme-halves:v1         {"light": <id>, "dark": <id>}  — the appearance MIX
t3code:typography-advanced     advanced typography toggle
```

**Theme halves** are the notable feature: under "system" appearance you can bind a *different theme* to
each side — e.g. Grove for light and T3 Chat for dark. Halves naming a theme that cannot render that
appearance are dropped on read, so a stale mix degrades to the base preference; picking a whole theme
clears the mix (with rollback if the preference write then fails).

Legacy id aliasing: `t3-chat-dark → t3-chat` (carrying a dark-mode hint), `t3-grove/t3-ocean/t3-ember/
t3-iris → grove/ocean/ember/iris`. All of these plus `system/light/dark` are in `RESERVED_THEME_IDS`.

The custom-theme library is read through a memoised snapshot with a tri-state result
(`ready` / `unavailable: "malformed"` / `unavailable: "storage-unavailable"`); writes throw a typed
`ThemeLibraryStorageError` (an Effect `Schema.TaggedErrorClass`). **`parseStoredThemeColors` tolerates
unknown roles and malformed values** so a theme saved by a newer build keeps its remaining colours.
Cross-tab changes arrive via a `storage` event listener.

### 17.4 Applying a theme touches zero React state

`applyThemePalette(theme, appearance)` sets `document.documentElement.dataset.themeId`, writes all 57
`--app-theme-*` properties inline, or — with no palette — deletes `dataset.themeId` and removes all 57.
`applyThemeColorPreview` does the same but stamps `data-theme-id="__preview"` and **skips roles whose
value is not a valid colour**, so a half-typed hex keeps the last good value.

`applyTheme()` wraps this: add `.no-transitions` to `<html>`, resolve the appearance, apply the palette,
toggle `.dark`, call `syncBrowserChromeTheme()`, sync the desktop shell, **force a reflow**
(`document.documentElement.offsetHeight`), then remove `.no-transitions` in a `requestAnimationFrame`.
The swap is therefore a single un-animated frame with no re-render.

`syncBrowserChromeTheme()` reads the resolved `--app-chrome-background` (falling back to the computed
background of `main[data-slot='sidebar-inset']` → `[data-slot='sidebar-inner']` → `body`), writes it to
`html`/`body` inline, and pushes it into **every** `<meta name="theme-color">` tag.

**Desktop bridge**: `syncDesktopTheme` calls `window.desktopBridge.setTheme(resolveDesktopTheme(...))`
with `"light" | "dark" | "system"`, crossing IPC to `ElectronTheme.setSource(theme)`. The web app
therefore drives Electron's native `nativeTheme` source, and a theme with only one appearance forces
that appearance rather than `"system"`.

### 17.5 Boot-time flash prevention

`apps/web/index.html` (467 lines) carries the single largest inline script in the repo (~320 lines),
which runs before any module loads and **re-implements the whole theme resolution in vanilla JS**:
legacy id aliases, custom-theme validation, halves resolution, the appearance-mode fallback chain, and
an `isThemeColor` guard that rejects `currentcolor`, every CSS system-color keyword (a full regex of
`accentcolor|activeborder|buttonface|…`), and anything containing `from`/`var(`/`env(`/`calc(` — then
validates with `CSS.supports("color", value)`.

It carries a **duplicated copy of the five built-in palettes** reduced to four roles (background,
foreground, accent, chrome) in OKLCH, with the comment "Keep this small boot-time copy in sync with the
built-in palettes". It stamps `data-theme-id`, `data-theme-selected`, `.dark`,
`html.style.backgroundColor`, `<meta name="theme-color">`, and
`--boot-background / --boot-foreground / --boot-accent`, which an inline `<style>` uses to paint a
`#boot-shell` splash (a 96 × 96 card holding a 64 × 64 `/apple-touch-icon.png`). Fallback when storage
throws: follow `prefers-color-scheme`, **defaulting to dark**.

### 17.6 VS Code / Open VSX import

`vscodeThemeImport.ts` (454 lines). Detection: not our `version: 1`, and either `colors` has a dotted key
or `tokenColors` is an array. Colour parsing accepts `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA` **and** CSS
`color(display-p3 …)` / `color(srgb …)` with a hand-written Display-P3 → sRGB linear matrix;
semi-transparent overlays are composited onto whatever surface they sit on, because T3's roles are
opaque.

Conversion strategy:

1. `editor.background` (or `editorPane.background`) is the canvas — **required**, else it throws.
2. Appearance from `type` (`light|hc-light` → light, `dark|hc-black` → dark), else luminance < 0.179.
3. Accent from the first of `focusBorder`, `button.background`, `textLink.foreground`,
   `activityBarBadge.background`, `progressBar.background`, `badge.background`.
4. A **muted** accent (accent at 20% alpha over the canvas) seeds `createVividThemeColors` for the floor
   palette, because "the vivid engine carries the accent hue into every surface, which washes an imported
   neutral palette (a gray theme with a blue focusBorder would get blue code and text surfaces)".
5. ~25 workbench keys are layered on top, **each foreground gated by `readableOn(...)`** — a specified
   colour only wins if it reaches contrast ≥ 4.5 on the surface it will actually land on; otherwise the
   derived fallback, otherwise pure white/black.
6. The result is re-validated through `parseThemeFile`, so imports go through exactly the same
   id/name/colour validation as a hand-written file.

Two batch helpers: `pairVsCodeThemes` merges a light and a dark file whose names differ only by the word
"light"/"dark" into one dual-mode theme (refusing to guess when ambiguous), and
`resolveThemeLabelCollisions` relabels themes from their file names when an extension reuses a display
name (the cited case: Dracula ships `dracula.json` and `dracula-soft.json` both named "Dracula"),
numbering only as a last resort.

`openVsxThemes.ts` (776 lines) fetches
`https://open-vsx.org/api/-/search?category=Themes&sortBy=…&size=16` then per-extension detail, and is
mostly **hardening**:

```
MAX_VSIX_BYTES           20 MB      MAX_SEARCH_BYTES        512 KB
MAX_DETAIL_BYTES         256 KB     MAX_MANIFEST_BYTES      256 KB
MAX_THEME_BYTES          256 KB     MAX_ZIP_ENTRIES         2 000
MAX_UNCOMPRESSED_BYTES   50 MB      MAX_COMPRESSION_RATIO   200
MAX_THEMES_PER_EXTENSION 40         MAX_INCLUDE_DEPTH       8
SEARCH_REQUEST_TIMEOUT_MS 10 000
SUPPORTED_LICENSES: 0BSD, Apache-2.0, BSD-2-Clause, BSD-3-Clause, CC0-1.0, ISC, MIT, MPL-2.0, Unlicense
```

All URLs must be `https://open-vsx.org`; the `.vsix` is SHA-256 verified against the published checksum
with `@noble/hashes`; **the ZIP central directory is hand-parsed before JSZip touches it** to enforce
entry count, total uncompressed size and compression ratio, to reject ZIP64, and to strip an archive
comment that would otherwise make JSZip mis-locate the EOCD; every entry path is normalised and must stay
inside `extension/`; the packaged `package.json` must match the advertised
publisher/name/version/license; theme JSONC is parsed with `jsonc-parser` and **filtered down to a
43-key allowlist** of workbench colours before anything else looks at it; and `include:` chains are
resolved with a cycle check and a file budget. Ids are content-addressed:
`ovx-theme-<6 bytes of sha256("<extensionId>:<sourcePath>")>`, and every theme from one extension carries
a `collection: {id: "open-vsx:<ext id>", label}` so settings groups them into one card.

### 17.7 The theme editor and the theme inspector

`ThemeEditorPanel.tsx` (1133 lines) is hosted **above the router**, outside the app shell, with the
comment: *"a theme draft is judged by walking the app, so the editor has to survive navigation away from
settings."* Session state is a small zustand store keyed by an incrementing `id` so re-opening reseeds.
The panel is a floating, draggable, corner-resizable window (min 280 × 220, clamped to the viewport on
`resize`) that can be minimised to its header.

Two modes: **Simple** exposes exactly two editable roles,
`THEME_EDITOR_SIMPLE_ROLES = ["canvas", "accent"]`, and editing either regenerates the entire palette
through `createVividThemeColors`; **Advanced** exposes all 57 roles in three groups — "Main colors" (12),
"Status colors" (9), "Other colors" (36). **Only themes carrying `managed: true` reopen in Simple mode**;
imports and hand-edited files open Advanced "so guided regeneration cannot silently discard hand-tuned
colors". Naming a draft after an installed theme **merges** rather than fails: a light "My Theme" plus a
dark "My Theme" become one theme with both modes, and the appearance toggle auto-flips to whichever side
is free.

`ThemeColorPicker.tsx` is a hand-rolled HSV square + hue rail + hex field, described as "an sRGB/hex
adapter over the OKLCH palette engine", with alpha preserved separately and re-attached on commit so
adjusting hue cannot change transparency.

**The inspector** (`themeInspector.ts`, 501 lines) answers "which pixels use this token?" with two
mechanisms, cheap first:

1. **Utility-class inference.** `THEME_UTILITY_ROLES` maps Tailwind colour names back to theme roles
   (`bg-card → surface`, `text-muted-foreground → mutedForeground`, `ring-* → focus`,
   `accent → accentSurface`, `primary → messageAction`, …), with prefix sets per paint kind: background
   `bg-`; border `border- outline- ring-`; foreground `text- caret- fill- stroke-`. Class names
   containing `:` (stateful variants) are skipped.
2. **Computed-style token probe** — the fallback, and the notable mechanism. `applyThemeTokenProbe`
   replaces one `--app-theme-*` variable with the sentinel `#01fea7` (or `#fe01a7` if the real value
   already is the sentinel) at `!important`, `getThemePaintSnapshot` re-reads `getComputedStyle` for
   background/border/foreground on every candidate element, and the original value is restored — **all
   synchronously inside `withThemeTokenProbeSession`, which sets `data-theme-token-probe` on `<html>` so
   a CSS rule kills every transition, then flushes with `void getComputedStyle(root).color` before
   removing it.** The browser never gets a paint opportunity in between. This finds *actual dependency on
   a token*, not colour equality.

Highlighting a role walks `[document.body, ...document.body.querySelectorAll("*")]`, marks matches with
`data-theme-inspector-match`, and renders an SVG spotlight: a full-viewport 54%-black dimmer with rounded
holes punched by an SVG `<mask>`, plus glow rects using an `feGaussianBlur stdDeviation="5"` + `feMerge`
filter, stroked in `color-mix(in oklab, var(--ring) 72%, white)`. Because a probe pass snapshots the whole
tree twice, refreshes are throttled to `MIN_REFRESH_INTERVAL_MS = 500` behind a `MutationObserver`, and
click-to-inspect hover uses a 140 ms debounce before falling back from utility inference to the full
probe.

### 17.8 Theme cards and sidebar artwork

Each theme previews as a pair of **56 px "balls"**: a
`color-mix(in oklab, canvas 80%, #09090b|#ffffff)` base with two radial gradients — the accent as a
contained glow at `28% 78%` (dark) / `72% 22%` (light), and the action colour as a 45%-alpha tint from
the opposite corner, blurred `3px` and scaled `1.10`. The comment explains the restraint: *"two bright
hotspots read as headlights."* Active balls get `inset 0 0 0 2px var(--ring)` plus a sun/moon badge;
clicking a ball assigns that theme to that half of the appearance mix. Collections (imported extensions
with many variants) render a **radial fan-out**: hovering a mode circle springs up N sibling variants
with a per-item **35 ms** transition delay.

`ThemeWireframe.tsx` draws a percentage-based miniature of the app — 22%-wide sidebar, search box, thread
rows, a message bubble, the composer with its round send button in `messageAction`, and a floating
"orchestrator island" with three agent rows whose status dots are hard-coded `#34d399` /
`messageAction` / `#fbbf24` at 55% opacity.

**Sidebar artwork is gated to maintainer themes.** `SidebarStageBackdrop.tsx` holds two hand-drawn SVG
scenes ("Nightly" night sky with stars, "Dev" blueprint) on a `viewBox="0 0 8192 96"` so sidebar resizing
reveals more canvas instead of zooming. Its palette comes from seven `--stage-art-*` pigments (plus
derived `--stage-night-*`) defined per theme id — a full per-theme artwork palette for `t3-chat`,
`grove`, `ocean`, `ember`, `iris`, in both light and dark. The art fades into the sidebar with a
`mask-image` (`black 0% → black 55% → transparent 92%`) plus an `::after` ramp.
`themeAllowsSidebarArtwork` returns true **only for built-ins**, and previews force it off — user-created
and imported themes always get the pill fallback.

---

## 18. Feature: distribution and self-update

Two entirely separate update mechanisms, easy to conflate.

### 18.1 Desktop app updates

Electron auto-updater with GitHub Releases as the feed, per-user opt-in channel (`"latest"` or
`"nightly"`) — covered in §16.6. One quirk worth isolating: **`electron-updater` reads
`latest-mac.yml` / `nightly-mac.yml` for both Intel and Apple Silicon** — there is no per-arch manifest
at runtime — so the release pipeline must merge the two architecture-specific manifests electron-builder
produces into one before publishing.

### 18.2 Server self-update: a from-scratch blue/green supervisor

For remote/headless `t3` servers, `apps/server/src/serviceLauncher.ts` implements an entirely separate
**protocol 2** blue/green process-supervisor scheme, unrelated to Electron. A `service-launcher.mjs`
process is the systemd-managed parent; it never edits its own unit file, and the running server child
never self-restarts — all restart/replace decisions are the launcher's. State lives in one file,
`service-state.json`, containing `{protocol, activeVersion, update?}` where `update` is
`pending A→B | committed A→B | rolled-back A→B | failed A→B`; **every write is same-directory
temp-file-then-rename plus explicit `fsync` on both the file and its parent directory handle** — genuinely
crash-safe, not just atomic-looking.

The flow:

1. The active child sends `request-update {targetVersion, dbPath}` over its inherited IPC channel. The
   launcher validates: sender is the active child at the active version; no update already pending; the
   target is an exact semver strictly newer; `dbPath` is absolute; and the target runtime's
   `node_modules/t3/dist/bin.mjs` plus an `.install-complete` sentinel **already exist on disk** (staged
   by the active server *before* requesting).
2. The launcher writes `pending`, replies `update-accepted{updateId}`, waits `HANDOFF_DELAY_MS = 2000`
   for response flush, then kills the active child.
3. With the old child dead (SQLite quiescent), it copies `state.sqlite`/`-wal`/`-shm` into a per-update
   backup directory — **exactly once per update id, idempotent across launcher restarts** — before
   starting the target version as a **trial** child.
4. The trial runs migrations, binds HTTP, starts all root fibers, parks at an "activation gate", and sends
   `prepared{updateId}`. It must do so within `PREPARED_TIMEOUT_MS = 120_000` or the launcher rolls back.
5. On `prepared`, the launcher commits: writes `committed` state, discards the DB backup, replies
   `committed{updateId}` — and the trial then opens its already-parked gate. Post-commit startup
   explicitly must **not** call any service `start`/`initialize`/`connect`/`load`/`acquire`, only "open
   the gate", because those already ran during trial preparation.
6. Any failure path restores the DB backup — **marking a durable restore-pending marker file first, so a
   launcher crash mid-restore resumes the restore on next boot instead of booting a half-restored DB** —
   writes `rolled-back`/`failed`, and restarts the *original* version.
7. `SERVICE_STOP_MARKER_FILE` (`.service-stopping`) is written **synchronously, outside the launcher's
   async transition queue**, the instant a `SIGTERM`/`SIGINT` arrives, specifically so a child already
   mid-shutdown can distinguish "the whole service is stopping" from "my replacement is about to start";
   systemd's `KillMode=mixed` is relied on to signal the launcher before the rest of the cgroup.
8. Client correlation across the update uses the launcher-generated `updateId`, not a version number — a
   reconnecting client waits for a lifecycle-ready event carrying the *same* id, so a coincidentally
   matching version from an unrelated later update cannot be mistaken for the awaited one.

**Compatibility invariant enforced release-side**: connected servers self-update to the **exact version
the connecting client is running**, not to an npm dist-tag — which is why the release graph *requires*
`publish_cli` (npm) to complete before `release` (GitHub Release) before `deploy_web`, so that by the time
any client offers "Update server", `t3@<that exact version>` already exists on npm.

### 18.3 The release pipeline

`.github/workflows/release.yml` (1114 lines). Trigger: a `v*.*.*` tag push (stable), a 3-hourly cron
(nightly), or manual dispatch. Job graph:
`check_changes → preflight, relay_public_config, build_wsl_node_pty → build (matrix) → publish_cli →
release → deploy_web → finalize → announce_discord`.

- **Build matrix**: macOS arm64 + macOS x64 + Linux x64 + Windows x64 (Windows arm64 present but
  commented out), each setting up a matching **Rust target triple** to build the native
  `t3-resource-monitor` alongside the Electron app.
- **Windows-specific**: downloads a pre-built `pty.node` produced by a separate `build_wsl_node_pty` job
  so the WSL backend ships a working native addon without compiling on first launch; also installs
  Spectre-mitigated MSVC libs before building.
- **Packaging**: `scripts/build-desktop-artifact.ts` invokes `electron-builder --publish never` per
  platform (`dmg` + `zip` for mac, `AppImage` for Linux, `nsis` for Windows); CI, not electron-builder,
  uploads assets. Artifact pattern `T3-Code-${version}-${arch}.${ext}`.
- **Code signing is auto-detected from secrets, not required.** macOS uses an Apple Developer ID cert +
  App Store Connect API key notarisation + an Associated-Domains provisioning profile (needed for Clerk
  passkey AASA); Windows uses **Azure Trusted Signing** (cloud HSM, not a local `.pfx`). If the secret set
  is incomplete the build proceeds **unsigned** rather than failing — documented as intentional, and
  **there is no dry-run tag path: every pushed release tag is a real publish.**
- **macOS manifest merge**: the `release` job renames the x64 manifest to `*-mac-x64.yml` during artifact
  collection and runs `scripts/merge-update-manifests.ts --platform mac` to fold it into the arm64
  manifest. The equivalent Windows arm64/x64 merge exists in the workflow but is **commented out**.
- **npm publish** (`publish_cli`) uses **OIDC trusted publishing, no long-lived npm token**, and bundles
  the per-platform `t3-resource-monitor` binaries into
  `apps/server/dist/resource-monitor/<platform-arch>/` before publish — so the CLI package physically
  ships every platform's native binary, selected at runtime by path probing.
- **GitHub Release**: stable prerelease vs latest is decided by tag shape (`X.Y.Z` exact → latest;
  `X.Y.Z-suffix` → prerelease); nightly is always a prerelease. Release notes are pinned to the previous
  tag *in the same channel* so stable and nightly diffs do not cross-contaminate.
- **Hosted web deploy** goes through the Vercel CLI (Git-integration deploys explicitly disabled) only
  after the GitHub Release publishes. A **router domain** (`app.t3.codes`) rewrites to
  `latest.app.t3.codes` / `nightly.app.t3.codes` based on a `t3code_web_channel` cookie set by visiting
  `/__t3code/channel?channel=…` — the same URL the "Update track" selector navigates to on web.
- **`finalize`** commits the version-aligned `package.json` bump back to `main` as a GitHub App identity;
  stable releases only, nightly does not commit back.

**What "distribution channels" means here.** T3 Code's own pipeline publishes to exactly two places:
GitHub Releases (desktop installers + updater manifests) and npm (the `t3` CLI/server package). The
`winget` / `brew --cask` / `yay` commands in the README are consumption paths that this workflow does not
produce. The Homebrew/npm/pnpm/bun/vp *detection* logic in `providerMaintenance.ts` (§15.4) is for
updating the **third-party agent CLIs**, a different concern that shares vocabulary.

---

## 19. The design system as built

Every value in this section is quoted from code. Line references are to `apps/web/src/index.css` (2318
lines) unless stated otherwise.

### 19.1 Stack

| Library | Version | Role |
|---|---|---|
| `tailwindcss` + `@tailwindcss/vite` | `^4.0.0` | CSS-first Tailwind v4. **There is no `tailwind.config.*`**; `apps/web/components.json` sets `"tailwind": {"config": "", "css": "src/index.css"}`. |
| `@base-ui/react` | `^1.4.1` | The headless primitive library behind every `components/ui/*` file. **Radix is not a dependency.** |
| `class-variance-authority` | `^0.7.1` | `cva()` variant tables (button, badge, sidebar menu button, alert). |
| `tailwind-merge` | `^3.4.0` | `cn()` in `lib/utils.ts:7` = `twMerge(cx(inputs))`. |
| `lucide-react` | `^0.564.0` | Default icon set (`components.json` → `"iconLibrary": "lucide"`), imported in 127 `.tsx` files. |
| `culori` | `^4.0.2` | CSS colour parsing → OKLCH in the palette engine. |
| `@pierre/diffs` / `@pierre/trees` | `1.3.0-beta.10` / `1.0.0-beta.4` | Diff + file-preview renderer (own shadow-DOM surfaces, own `--diffs-*` tokens, bundles Shiki) and the file-tree icon sprite sheet. |
| `jszip` + `jsonc-parser` + `@noble/hashes` | `3.10.1` / `3.3.1` / catalog | Open VSX `.vsix` import: unzip, JSONC parse, SHA-256 integrity. |
| `zustand` | `^5.0.11` | UI stores (theme editor, composer drafts, right panel, terminal UI). |
| `effect/Schema` | catalog | All persisted shapes and tagged errors. |
| `@legendapp/list` | `3.3.5` (patched) | Virtualisation (timeline, model picker, font picker). |
| `lexical` / `@lexical/react` | `^0.41.0` | The composer editor. |
| `react` | `19.2.6` | With **`babel-plugin-react-compiler@1.0.0`** wired through `@rolldown/plugin-babel`. |
| `@tanstack/react-router` | `^1.160` | Routing (hash history in Electron). |
| `@effect/atom-react` | catalog | Server state / RPC atoms. |

`apps/web/components.json`:

```json
{ "style": "base-mira", "rsc": false, "tsx": true,
  "tailwind": { "config": "", "css": "src/index.css", "baseColor": "zinc", "cssVariables": true },
  "iconLibrary": "lucide", "menuColor": "default", "menuAccent": "bold",
  "aliases": { "components": "~/components", "ui": "~/components/ui", "utils": "~/lib/utils" },
  "registries": { "@coss": "https://coss.com/ui/r/{name}.json", "@spell": "https://spell.sh/r/{name}.json" } }
```

### 19.2 The three-layer token cascade

1. **Layer A — Tailwind theme tokens** (`@theme` / `@theme inline`) map Tailwind utility names
   (`bg-card`, `text-muted-foreground`, `rounded-lg`) onto bare CSS variables (`--card`,
   `--muted-foreground`, `--radius`).
2. **Layer B — semantic app tokens** (`:root` and a nested `@variant dark` block, `index.css:1059-1192`)
   give those bare variables their default light/dark values out of Tailwind's zinc/neutral ramps.
3. **Layer C — theme palettes.** When a theme is active, `document.documentElement` carries
   `data-theme-id="<id>"` and 57 inline `--app-theme-*` properties, and a static CSS block
   (`index.css:1250-1317`) re-points every Layer-B variable at its `--app-theme-*` counterpart.

Custom variants (`index.css:1-5`):

```css
@import "tailwindcss";
@custom-variant dark (&:is(.dark, .dark *));
@custom-variant wco (&:is(.wco, .wco *));   /* Window Controls Overlay */
```

`.wco` and `.electron-windows` are toggled on `<html>` by `lib/windowControlsOverlay.ts`.

### 19.3 Colour tokens — exact values

**Light (`:root`, `index.css:1059-1127`)**

```
--radius: 0.625rem
--background: var(--color-zinc-25)     /* --color-zinc-25: oklch(99.2% 0 0), defined at :143 */
--foreground: var(--color-zinc-800)
--card / --popover: var(--color-white)
--primary: oklch(0.488 0.217 264)      /* blue */
--primary-foreground: var(--color-white)
--secondary / --muted: var(--color-zinc-50)
--muted-foreground: var(--color-zinc-500)
--accent: var(--color-zinc-100)        --accent-foreground: var(--color-zinc-900)
--border: var(--color-zinc-200)        --input: var(--color-zinc-300)
--ring: var(--primary)
--error: var(--color-red-500)          --error-foreground: var(--color-red-700)
--destructive: var(--error)            --destructive-foreground: var(--color-red-700)
--error-surface: color-mix(in srgb, var(--error) 8%, transparent)
--info: var(--color-blue-500)          --info-foreground: var(--color-blue-700)
--success: var(--color-emerald-500)    --success-foreground: var(--color-emerald-700)
--warning: var(--color-amber-500)      --warning-foreground: var(--color-amber-700)
--warning-surface: color-mix(in srgb, var(--warning) 8%, transparent)
--message-surface: var(--accent)       --message-foreground: var(--foreground)
--message-action: var(--primary)
--message-action-hover: color-mix(in srgb, var(--primary) 90%, var(--background))
--code-background: color-mix(in srgb, var(--card) 90%, var(--background))
--code-foreground: var(--foreground)
--placeholder / --secondary-label / --icon-muted: alias --muted-foreground
--sidebar: zinc-50 · --sidebar-control-surface: zinc-100
--sidebar-row-hover: zinc-25 · --sidebar-row-active / --sidebar-row-selected: white
--terminal-background: var(--background)  --terminal-foreground: var(--foreground)
--terminal-cursor: rgb(38 56 78)
--terminal-selection-background: rgb(37 63 99 / 20%)
--terminal-scrollbar: rgb(0 0 0 / 15%)    --terminal-scrollbar-hover: rgb(0 0 0 / 25%)
```

**Dark (`@variant dark`, `index.css:1128-1191`)**

```
--background: var(--color-neutral-950)
--foreground: var(--color-neutral-100)
--card:    color-mix(in srgb, var(--background) 97%, var(--color-white))
--popover: color-mix(in srgb, var(--background) 94%, var(--color-white))
--primary: oklch(0.571 0.21 264)
--secondary / --muted / --accent: --alpha(var(--color-white) / 4%)
--border: --alpha(var(--color-white) / 6%)
--input:  --alpha(var(--color-white) / 8%)
--muted-foreground: color-mix(in srgb, var(--color-neutral-500) 90%, white)
--destructive / --error: color-mix(in srgb, var(--color-red-500) 90%, white)
--destructive-foreground / --error-foreground: var(--color-red-400)
--info-foreground: var(--color-blue-400) · --success-foreground: var(--color-emerald-400)
--error-surface / --warning-surface: 16% mix (vs 8% light)
--terminal-cursor: rgb(180 203 255)
--terminal-selection-background: rgb(180 203 255 / 25%)
--terminal-scrollbar: rgb(255 255 255 / 10%)  --terminal-scrollbar-hover: rgb(255 255 255 / 18%)
```

**Sidebar override (`[data-app-sidebar]`, `index.css:1197-1248`).** A second block pins the sidebar to a
fixed zinc hierarchy in light and to **hard hex values in dark** — note that in dark the sidebar is
*darker* than the canvas, not lighter:

```
--background: #000
--foreground: #f1f3f7
--accent: #191a1d
--muted: #0a0a0a
--muted-foreground: #a3a3a3
--border: rgb(255 255 255 / 8%)
row states: color-mix(in srgb, var(--foreground) 7…11%, transparent)
```

The comment describes this as the "two sidebar implementations must agree" compatibility layer.

### 19.4 Geometry

**Radius scale** (`index.css:199-205`), all derived from one `--radius: 0.625rem` (10 px):

```
--radius-sm  = calc(var(--radius) - 4px)    =  6px
--radius-md  = calc(var(--radius) - 2px)    =  8px
--radius-lg  = var(--radius)                = 10px
--radius-xl  = calc(var(--radius) + 4px)    = 14px
--radius-2xl = calc(var(--radius) + 8px)    = 18px   → cards, dialogs, user bubble
--radius-3xl = calc(var(--radius) + 12px)   = 22px
--radius-4xl = calc(var(--radius) + 16px)   = 26px
```

Controls use a **separate** radius, `--control-radius: 0.5rem` (8 px) — every `Button`, and sidebar menu
buttons. The composer glass shell is hard-coded at **22 px** with a **16 px** attachment strip; the
composer's inner surface is `rounded-[20px]` and header slots `rounded-t-[19px]`.

**Compact geometry tokens** (`index.css:78-105`):

```css
--app-scrollbar-width: 6px;
--app-scrollbar-thumb: rgb(217 217 217);        /* dark: rgb(255 255 255 / 8%)  */
--app-scrollbar-thumb-hover: rgb(191 191 191);  /* dark: rgb(255 255 255 / 12%) */
--control-radius: 0.5rem;
--sidebar-content-inset: 0.5rem;
--sidebar-control-gap: 0.5rem;
--sidebar-row-content-inset: 0.625rem;
--command-shell-inset: 0.5rem;
--command-content-inset: 1rem;
--floating-content-inset: 0.75rem;
--glass-blur: 12px;          /* .dark: 16px */
--glass-opacity: 80%;        /* runtime-overridden by the Appearance slider */
--glass-saturation: 1.14;    /* .dark: 1.08 */
--workspace-topbar-height: 52px;
--workspace-titlebar-control-size: 1.75rem;
--workspace-titlebar-control-gap: 0.75rem;
--workspace-controls-left: calc(env(safe-area-inset-left) + 0.75rem);
--desktop-window-right-resize-inset: 0px;   /* .electron-windows: 6px */
```

**Native titlebar geometry as CSS custom properties** (`index.css:78-127`) — the one block tying web
layout to native chrome:

```css
:root {
  --workspace-topbar-height: 52px;
  --workspace-controls-top: 0px;
  --workspace-controls-left: calc(env(safe-area-inset-left) + 0.75rem);
  --workspace-controls-right: calc(env(safe-area-inset-right) + 0.75rem);
  --workspace-native-controls-inset: 0px;
}
.wco {
  --workspace-topbar-height: env(titlebar-area-height, 52px);
  --workspace-controls-top: env(titlebar-area-y, 0px);
  --workspace-controls-left: calc(env(titlebar-area-x, 0px) + 0.75rem);
  --workspace-controls-right: calc(100vw - env(titlebar-area-width, 100vw) - env(titlebar-area-x, 0px) + 0.75rem);
  --workspace-native-controls-inset: calc(100vw - env(titlebar-area-width, 100vw) - env(titlebar-area-x, 0px) + 0.75rem);
}
[data-slot="sidebar-wrapper"] {
  --workspace-titlebar-content-left: calc(var(--workspace-controls-left) + var(--workspace-titlebar-control-size) + var(--workspace-titlebar-control-gap));
}
```

Drag regions (`index.css:1660-1670`):

```css
.drag-region { -webkit-app-region: drag; }
.drag-region button, .drag-region input, .drag-region textarea,
.drag-region select, .drag-region a { -webkit-app-region: no-drag; }
```

**Panel header utility** (`index.css:604-606`):

```css
.surface-subheader { @apply flex h-10 min-h-10 shrink-0 items-center border-b border-border/60 bg-background; }
```

**Content widths.** The chat content column is `max-w-3xl` = 48 rem = **768 px**
(`TIMELINE_CONTENT_MAX_WIDTH = 768`); the composer form is `mx-auto w-full min-w-0 max-w-3xl`; the branch
strip is `w-[calc(100%-2.75rem)] max-w-[calc(48rem-2.75rem)]` with `-mt-4` so it tucks under the
composer's curve. Rendered-markdown file view uses `max-w-4xl`.

**Z-index ladder (observed):**

```
50   dialog backdrop + viewport
70   composer command menu (portalled to body)
100  #theme-inspector-spotlight
101  #theme-inspector-hover
120  popover/tooltip positioners containing the theme editor panel
130  menu positioner
140  tooltip positioner
```

### 19.5 Typography

**No webfont is loaded for the UI.** The stacks are declared **outside** `@theme inline` precisely so
runtime overrides work (`index.css:133-140`):

```css
@theme {
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
}
```

Mirrored in `appearanceFonts.ts` with one deliberate difference: `DEFAULT_CODE_FONT_STACK` **drops
`ui-monospace`**, because "some engines alias `ui-monospace` to the proportional system UI font, which
would break every code surface". The only bundled face in the web app is
`terminal/ghostty/fonts/SymbolsNerdFontMono-Regular.woff2` — symbols-only, registered lazily on first
terminal mount.

**Runtime application** (`applyAppearanceFontVariables`, called from a `FontAppearanceSync` component in
the root route):

- `--font-sans`, `--font-mono`, `--font-composer` — a user family is **prepended** to the default stack
  (`"Custom", <default stack>`) so glyph coverage never regresses; empty removes the property entirely.
- `root.style.fontSize = "<interface px>px"` — **the interface size drives the root font size and
  therefore every rem dimension in the app.**
- `--font-size-prompt`, `--font-size-code`, and `--diffs-font-size` in **absolute px** so they do not
  scale twice.
- `-webkit-font-smoothing: antialiased` when enabled, removed when off.

Consumption: `body { font-family: var(--font-sans) }`; `pre, code { font-family: var(--font-mono) }`;
`.composer-editor-surface { font-family: var(--font-composer, var(--font-sans)); font-size:
var(--font-size-prompt, 0.875rem) }`; and — the clever one — `:root { --diffs-font-family:
var(--font-mono); --diffs-header-font-family: var(--font-sans) }`, which reaches `@pierre/diffs`' shadow
roots **because custom properties inherit across the shadow boundary**.

Touch guard: `@media (max-width: 39.999rem) and (pointer: coarse)` floors the composer at **16 px** so
mobile browsers do not zoom on focus — gated on coarse pointers so a narrow desktop window does not
silently override a smaller chosen prompt size.

**Size ranges** (`packages/contracts/src/settings.ts:66-101`):

| preference | min | max | default |
|---|---|---|---|
| interface | 12 | 20 | **16** |
| prompt | 12 | 20 | **14** |
| code | 10 | 18 | **13** |
| terminal | 8 | 20 | **12** |
| glass opacity | 40 | 100 | **80** |

`fontFamilySans / Code / Composer / Terminal` are strings ≤ 200 chars defaulting to `""` ("use the app
default"); `fontSmoothing` defaults to `true`. In **Simple** typography mode the terminal follows the
code font and size; in **Advanced** they are independent.

**Font detection uses three separate probes:**

1. `isFontFamilyAvailable` — canvas `measureText` of `"mmmmmmmmMMWli1O0@# fjord"` against three
   generics. The comment explains why not `document.fonts.check()`: it "reports true for families that
   are not installed at all".
2. `isMonospaceFamily` — measures 8 glyphs (`i M W 0 @ # . space`) across 4 variants
   (normal/bold × roman/italic) at 32 px and requires all advances within `0.01`. Used to keep
   proportional faces out of the terminal.
3. `resolveDefaultFamilyLabel` — names what "Default" actually renders as, by laying out
   `"RagIl10O@ fjord quiz"` at 100 px in a hidden DOM span (**not** canvas — "this engine draws
   `ui-monospace` as the proportional UI font on canvas but not in CSS") and comparing widths against
   curated candidate lists: `Segoe UI, Roboto, Noto Sans, Ubuntu, Cantarell, DejaVu Sans, Liberation
   Sans, Helvetica Neue, Arial` for sans; `Menlo, Consolas, Cascadia Mono, DejaVu Sans Mono, Ubuntu Mono,
   Liberation Mono, Noto Sans Mono, Roboto Mono, Monaco, Courier New` for mono. A miss on an Apple
   platform is reported as `"SF Pro"` / `"SF Mono"` because those faces are not CSS-nameable.

`queryInstalledFontFamilies` uses the **Local Font Access API** (`window.queryLocalFonts`), filters out
dot-prefixed macOS internal faces, and **treats an empty result as a denial** ("no machine has zero
fonts"). The picker shares one module-level enumeration state across rows, probes
`navigator.permissions.query({name: "local-fonts"})` for an existing grant (Electron approves silently),
and degrades to a plain text input where the API is absent.

**Chat markdown type scale** (`index.css:1803-2147`):

```
root .chat-markdown: text-sm leading-relaxed text-foreground/80, overflow-wrap: anywhere
block spacing: 0.65rem 0        headings: margin 1.25rem 0 0.5rem, weight 600, line-height 1.3
h1 1.25rem · h2 1.125rem · h3 1rem · h4-h6 0.875rem (h6 uses --muted-foreground)
lists: padding-left 1.25rem; nested markers disc→circle→square, decimal→lower-alpha→lower-roman
li + li margin-top 0.25rem
inline code: 1px border, radius 0.375rem, bg --muted, padding 0.1rem 0.35rem, font-size 0.75rem
pre: 1px border, radius 0.75rem, bg --muted, padding 0.8rem 0.9rem, scrollbar 7px tall,
     radius 999px, color-mix(in srgb, var(--border) 78%, transparent)
.chat-markdown-codeblock: border-radius var(--radius); header padding 0.375rem 0.375rem 0 0.75rem;
     title font-mono 0.6875rem (11px); chrome color color-mix(in srgb, var(--foreground) 72%, transparent)
blockquote: 2px left border --border, padding-left 0.8rem, color --muted-foreground
links: color var(--info-foreground), no underline; hover paints a dotted underline via
       radial-gradient(circle, currentcolor 0.75px, transparent 1px) at background-size 4px 2px
favicon slot: 14px × 14px, margin-inline 0.25em 0.2em, vertical-align -0.125em
tables: font-size 0.75rem, cells 0.45rem 0.75rem, header padding-block 0.55rem + weight 600 + nowrap,
        row separators only at 60% --border, collapsed cells max-width 24rem with ellipsis
footnotes: font-size 0.75rem, top border, margin-top 1.25rem; refs are inline-flex 0.6875rem/600 chips
task-list items drop their marker and pull the checkbox back by -1.25rem
.chat-markdown img { display: inline-block }   /* defeats Tailwind preflight's block-level img */
```

### 19.6 Surfaces: glass, grain, fades, and the composer shape

**Four named glass recipes** (`index.css:620-880`), all `color-mix` + `backdrop-filter`:

```css
.chat-composer-glass  { background: color-mix(in srgb, var(--background) var(--glass-opacity), transparent);
                        backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation)); }
.dialog-glass         { same over --background; border-color 10% foreground;
                        box-shadow: 0 24px 64px -24px rgb(0 0 0 / 65%);
                        dark: inset 0 1px rgb(255 255 255 / 4%), 0 24px 72px -20px rgb(0 0 0 / 90%) }
.dialog-backdrop      { color-mix(in srgb, var(--background) 60%, transparent); blur(4px) }
.dropdown-glass       { background: color-mix(in srgb, var(--popover) 18%,
                          color-mix(in srgb, var(--popover) var(--glass-opacity), transparent));
                        backdrop-filter: blur(var(--glass-blur));
                        border: 1px solid color-mix(in srgb, var(--foreground) 10%, transparent);
                        box-shadow: 0 16px 40px -18px rgb(0 0 0 / 55%);
                        dark: 0 18px 44px -18px rgb(0 0 0 / 80%) }
.alert-glass          { tinted 4% by --destructive/--info/--success/--warning per data-variant }
```

The nested `color-mix` in `dropdown-glass` is documented: it preserves the full user opacity range
(40% → 51%, 80% → 84%, 100% → 100%) while stopping high-contrast page content from blooming through
menus. There is an `@supports not (backdrop-filter)` fallback that flattens every glass surface to its
opaque token.

**The composer's joined glass shell** is the most elaborate CSS in the repo. The composer body and the
branch strip are separate DOM elements, but one `::before` pseudo-element paints a **single continuous
glass layer across both**, using `clip-path: shape()` with explicit Bézier control points
(`index.css:654-681`): a 22 px-radius composer whose bottom corners curve inward and continue into a
16 px-radius strip, offset by `--chat-composer-context-extension: 2.25rem` (2 rem above `min-width:
40rem`, "because the xs toolbar controls shrink by 4px at Tailwind's sm breakpoint"). The hand-computed
tangent values are **`9.85px`** (= 22 × 0.4477) and **`7.16px`**. There is an
`@supports not (clip-path: shape(...))` fallback that splits it back into two independent rounded
rectangles. The outline (`.chat-composer-glass-host::after`) is clipped with a polygon leaving a 22 px
inset gap at the bottom so the strip's own border continues it seamlessly. Shadows:
`0 12px 28px -18px rgb(0 0 0 / 40%)`; in dark, none on the host but an
`inset 0 1px rgb(255 255 255 / 3%)` highlight instead, with the strip at
`0 14px 32px -18px rgb(0 0 0 / 75%)`.

**Surface grain** (`index.css:1608-1632`) is a procedural SVG noise data-URI applied as `background-image`
on `body`, and opt-in via `@utility surface-grain`:

```
--surface-grain: url("data:image/svg+xml,…feTurbulence type='fractalNoise'
                 baseFrequency='0.9' numOctaves='4' stitchTiles='stitch' … opacity='0.035'")
--surface-grain-size: 256px 256px
```

For `html[data-theme-id="t3-chat"]` it drops to a **128 px** tile at `opacity='0.02745'` ("The live T3
Chat texture is a 128px grayscale tile with a constant 7/255 alpha"). The comment records why it is baked
into each surface's background rather than being one fixed overlay: **a full-viewport overlay forces the
compositor to re-blend every frame of any animation.**

**Scroll fades are masks, not gradients over content.** `.chat-timeline-scroll-fade`,
`.settings-page-scroll-fade`, `.pull-requests-scroll-fade` (`index.css:521-570`) use a **three-layer
`mask-image`** — a top gradient plus two solid rects — so the scrollbar column stays unmasked. Fade
height is `2.5rem` (`--topbar-scroll-fade-height`), `1.5rem` for pull requests, `3rem` above the 40 rem
breakpoint, with a hand-tuned gradient (`transparent 0% → 10% at 10% → 30% at 24% → 58% at 42% → 82% at
62% → 96% at 82% → black`) and a third layer `var(--app-scrollbar-width)` wide on the right. The
`ScrollArea` primitive has its own Tailwind-native version driven by Base UI's
`--scroll-area-overflow-y-start/end` variables with `--fade-size: 1.5rem`.

**Terminal CSS hooks** (`index.css:1708-1736`):

```css
.t3-ghostty-canvas { cursor: text; }
.t3-ghostty-scrollbar { position: absolute; z-index: 1; top: 4px; right: 1px; bottom: 4px;
                        width: var(--app-scrollbar-width); cursor: default; touch-action: none; }
.t3-ghostty-scrollbar-thumb { position: absolute; top: 0; right: 1px; left: 1px; border-radius: 3px;
                              background: var(--app-scrollbar-thumb);
                              transition: background-color 120ms ease-out; }
```

**Third-party shadow roots are theme-bridged by injecting CSS.** The file tree gets:

```css
:host {
  --trees-bg-override: transparent;
  --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
  --trees-hover-bg-override:    color-mix(in srgb, currentColor 7%, transparent);
  --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
  --trees-font-family-override: var(--font-sans);
  --trees-font-size-override: 12px;
}
button[data-type='item'] { border-radius: 5px; }
```

and the diff/file renderer maps `--diffs-header-font-family → var(--font-sans)`,
`--diffs-font-family → var(--font-mono)`, `--diffs-bg → var(--code-background)`, deriving every row tint
by mixing the code surface with the code foreground or a semantic colour:

```css
--diffs-bg-context-override:  color-mix(in srgb, var(--code-background) 97%, var(--code-foreground));
--diffs-bg-hover-override:    color-mix(in srgb, var(--code-background) 94%, var(--code-foreground));
--diffs-bg-addition-override: light-dark(
    color-mix(in srgb, var(--code-background) 50%, var(--success)),
    color-mix(in srgb, var(--code-background) 70%, var(--success)));
```

The file panel layers reveal-highlight rules on top, mixing `--diffs-computed-diff-line-bg` with the
selection base at **82% (light) / 75% (dark)** for the line and **75% / 60%** for the gutter number.
Syntax themes are the library's own `pierre-light` / `pierre-dark`.

### 19.7 Components

`apps/web/src/components/ui/` holds **43 primitives** (~6.4k lines): alert, alert-dialog, autocomplete,
badge, button, card, checkbox, collapsible, combobox, command, dialog, dialog-styles, draft-input, empty,
field, fieldset, form, group, input, input-group, kbd, label, menu, number-field, popover, qr-code,
radio-group, scroll-area, select, separator, sheet, sidebar (1041 lines — the largest), skeleton,
spinner, switch, table, textarea, toast (811 lines), toggle, toggle-group, tooltip.

**The house pattern** — three conventions in every primitive:

1. **`data-slot="…"` on the root element**, used for styling hooks
   (`[data-slot=input-group]`, `in-[[data-slot=menu-checkbox-item][data-checked]]`), for theme overrides
   (`html[data-theme-id] [data-chat-header] [data-slot="button"]`), and by `useTheme` to find the
   browser-chrome surface.
2. **`useRender` + `mergeProps` from Base UI** instead of Radix `asChild`. Every primitive ends in
   `useRender({defaultTagName, props: mergeProps<"button">(defaultProps, props), render})`; consumers
   pass `render={<Button variant="ghost" />}`.
3. **Base UI state data-attributes** in class strings: `data-highlighted`, `data-checked`,
   `data-disabled`, `data-pressed`, `data-popup-open`, `data-starting-style`, `data-ending-style`,
   `data-nested-dialogs`, `data-instant`.

**Button** (`components/ui/button.tsx`). Every size has a **compact `sm:` step down** — the app is denser
on desktop than on touch:

| size | mobile | ≥ sm | icon size |
|---|---|---|---|
| `xs` | h-7, text-sm | h-6, text-xs | 4 → 3.5 |
| `sm` | h-8, gap-1.5 | h-7 | |
| `default` | h-9 | h-8 | 4.5 → 4 |
| `lg` | h-10 | h-9 | |
| `xl` | h-11, text-lg | h-10, text-base | 5 → 4.5 |
| `icon-xs`…`icon-xl` | size-7…size-11 | size-6…size-10 | |

Horizontal padding is always `px-[calc(--spacing(N)-1px)]` — the border eats the odd pixel. Variants:
`default` (primary fill + `inset-shadow-[0_1px_--theme(--color-white/16%)]` top highlight and
`shadow-primary/24 shadow-xs`, pressed flipping to `--color-black/8%`), `secondary`, `destructive`,
`destructive-outline`, `outline`, `ghost`, `link`. Radius is `rounded-[var(--control-radius)]` (8 px).
Disabled opacity is a repo-wide **`opacity-64`**. Focus is universally
`focus-visible:ring-2 ring-ring ring-offset-1 ring-offset-background`. Touch targets are enlarged
invisibly with `pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11`. Icon colour routes through
a local `--control-icon-color` (default `currentColor`, `var(--muted-foreground)` for ghost/outline) so
themed toolbars can re-point it.

**Dialog / Sheet** (`dialog.tsx`, `dialog-styles.ts`):

- Backdrop: `dialog-backdrop fixed inset-0 z-50 transition-all duration-200`, fading from `opacity-0`.
- Popup: `dialog-glass rounded-2xl border`,
  `transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform`, entering and
  leaving at `scale-98 opacity-0`.
- **Nested-dialog stacking is a CSS calc off Base UI's `--nested-dialogs` counter**:
  `-translate-y-[calc(1.25rem*var(--nested-dialogs))]`,
  `scale-[calc(1-0.1*var(--nested-dialogs))]`, `opacity-[calc(1-0.1*var(--nested-dialogs))]`.
- Mobile: `max-sm:rounded-none max-sm:border-x-0` turns every dialog into a bottom sheet, and
  `DialogViewport` switches to `grid-rows-[1fr_auto]` with `max-sm:pt-12`.
- Padding rhythm: header/panel/footer all `p-6` / `px-6`, footer `py-4` with `bg-muted/72` and a top
  border. Title is `font-heading font-semibold text-xl leading-none`.
- Command palette popup: `max-h-105 max-w-xl`, `rounded-2xl border`; content-search mode forces `h-105`;
  the file-picker panel is `max-h-[min(34rem,76vh)]`.

**Sidebar** (`components/ui/sidebar.tsx`):

```
SIDEBAR_WIDTH                    = "16rem"
SIDEBAR_WIDTH_MOBILE             = "calc(100vw - var(--spacing(3)))"
SIDEBAR_WIDTH_ICON               = "3rem"
SIDEBAR_COOKIE_NAME              = "sidebar_state"   (max-age 7 days, via cookieStore)
SIDEBAR_RESIZE_DEFAULT_MIN_WIDTH = 256px
```

**Inline chips** (`components/composerInlineChip.ts`) — metrics in **`em`** so they scale with the prompt
font-size preference:

```
base: inline-flex max-w-full items-center gap-[0.33em] rounded-[0.5em]
      border border-border/70 bg-accent/40 px-[0.5em] py-[0.08em]
      font-medium leading-[1.1] text-foreground align-middle
composer variant: + text-[0.86em] select-none      chat variant: + text-[12px]
skill chip: border-fuchsia-500/25 bg-fuchsia-500/12 text-fuchsia-700 dark:text-fuchsia-300
icon: size-[1.17em] shrink-0 opacity-85           skill label: relative top-[0.15em]
expired terminal chip: border-destructive/35 bg-destructive/8 text-destructive
```

and a hand-rolled selection highlight, because browsers skip `contentEditable={false}` decorators when
painting selection:

```css
.composer-inline-chip[data-composer-chip-selected]::after {
  content: ""; position: absolute; inset: 0; border-radius: 6px;
  background-color: Highlight; opacity: 0.3; pointer-events: none;
}
```

— note the CSS **system colour keyword `Highlight`**, so the fake selection matches the OS.

**Send button** (`ComposerPrimaryActions.tsx`): `h-9 w-9 sm:h-8 sm:w-8 rounded-full bg-message-action`,
`inset-shadow-[0_1px_--theme(--color-white/16%)]`, `hover:scale-105`,
`active:inset-shadow-[0_1px_--theme(--color-black/8%)]`, `transition-all duration-150`,
`disabled:opacity-30`; the glyph is a 14 × 14 inline arrow at `strokeWidth 1.8`. The stop button is the
same shape in `bg-destructive/90` with an 8 × 8 rounded square. The plan-follow-up state splits into a
two-part pill (`rounded-l-full` "Implement" + `rounded-r-full` chevron menu).

**Stash badge**: `absolute -top-3 right-4 z-10`, pill
`rounded-full border bg-popover px-2.5 py-0.5 text-xs shadow-sm`, resting at `opacity-70` and lifting to
100% on hover/open/pulse, `transition-[color,border-color,opacity] duration-200`. The count `<span>` is
remounted via `key={pulseKey}` so a CSS enter animation replays per stash instead of looping; the pulse
clears after **1200 ms**.

**Context window meter**: a 24-viewBox SVG donut, `r = 9.75`, `strokeWidth 3`, `-rotate-90`,
`strokeDashoffset` animated with
`transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none`; track
`color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)`, fill `… 72% …`, switching to
`var(--color-error)` above 90%. Opens on hover with `delay={150}`.

**Search option buttons**: `size-8 rounded-[5px] font-mono text-xs font-medium transition-colors`, active
= `bg-accent text-foreground shadow-sm`. **Truncation banner**: `text-[11px]`, `bg-warning-surface`,
`border-warning/20`, `text-warning-foreground`.

### 19.8 Motion

Named animations (`index.css:144-264`):

```css
--animate-skeleton:     skeleton 2s infinite linear;
--animate-status-pulse: status-pulse 2s infinite;
--animate-ghost-pulse:  ghost-pulse 2.4s infinite;
--animate-status-ping:  status-ping 2s infinite;
```

**All four keyframes are deliberately duty-cycled with `steps()`** — `status-pulse` with `steps(6)`,
`ghost-pulse` with `steps(4)`, `status-ping` with `steps(8)`. The `ghost-pulse` comment quantifies it:
stepped keyframes mean the compositor draws "a handful of discrete frames per cycle rather than one per
vsync — which on a 120Hz display is the difference between ~14 and ~288 updates". `skeleton` is
transform-only (`translateX(-100%) → translateX(100%)`, reaching its end at 60% and holding).

Other motion values in the stylesheet:

- Mobile composer view-transition: **180 ms `cubic-bezier(0.4, 0, 0.2, 1)`**; headline exit **130 ms
  `cubic-bezier(0.4, 0, 1, 1)`** with `translateY(-6px)`. Named groups
  `view-transition-name: t3-mobile-composer` / `t3-mobile-draft-headline`, with
  `html[data-mobile-composer-route-transition="true"]` freezing the root snapshot.
- Settings search target pulse: **650 ms ease-in-out, 2 iterations**, `box-shadow 0 0 0 2px` of 70%
  `--color-primary`.
- Prompt-stash count enter: **180 ms ease-out both**, `translateY(2px) → 0`, disabled under
  `prefers-reduced-motion`.
- Settings slider thumb: `transform 120ms ease, box-shadow 120ms ease`; hover `scale(1.08)`, active
  `scale(0.94)`.
- Ultrathink rainbow: **10 s linear infinite** gradient sweep plus `hue-rotate(0→360deg) saturate(1.2)`
  on the model-picker icon over the same period. The spectrum:
  ```css
  --ultrathink-spectrum: linear-gradient(120deg, #ff6b6b 0%, #f59e0b 18%, #22c55e 36%,
                         #14b8a6 54%, #3b82f6 72%, #ec4899 90%, #ff6b6b 100%);
  ```
  painted into a `padding: 2px` ring via `mask-composite: exclude`, `background-size: 220% 220%`,
  `filter: saturate(0.82) brightness(0.92)`, animating background-position 0% → 200%; the surface also
  gets `shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]`.
- `.no-transitions` zeroes all `transition-duration`/`animation-duration` during theme swaps.
- `html[data-theme-token-probe]` sets `transition: none !important` — this exists purely for the theme
  inspector.

**In primitives:**

- Switch / menu-switch thumb:
  `[transition:translate_.15s,border-radius_.15s,scale_.1s_.1s,transform-origin_.15s]` with an
  `active:scale-x-110` squash and a rounded-rect morph; track
  `transition-[background-color,box-shadow] duration-200`; thumb `--thumb-size: --spacing(5)` shrinking
  to `--spacing(4)` at `sm:`.
- Scrollbars: `opacity-0` with `delay-300`, `data-hovering`/`data-scrolling` →
  `opacity-100 delay-0 duration-100`; 1.5-unit (6 px) rails.
- Tooltip: `transition-[width,height,scale,opacity]`, enter/exit `scale-98 opacity-0`,
  `data-instant:duration-0`, default `sideOffset = 4`, `side = "top"`; content cross-fades inside a
  `Tooltip.Viewport`.
- Skeleton: an `::after` gradient sweep
  `linear-gradient(120deg, transparent 40%, var(--skeleton-highlight), transparent 60%)` where the
  highlight is `white/64%` light and `white/4%` dark; **the `::after` is removed entirely under reduced
  motion**.

Common inline transitions in the timeline: `transition-opacity duration-200` for hover-revealed metadata,
`transition-colors duration-150` for toggles, `transition-transform duration-200` + `rotate-180` for
chevrons, `transition-[background-color,width] duration-150` for minimap dashes.

The one hand-written FLIP animation in the app is the branch strip's compaction: measure
`getBoundingClientRect()` for every `[data-composer-context-control]`, toggle `data-compact` (with a
`COMPACT_EXPAND_HYSTERESIS_PX = 16` band so the boundary cannot flap), then
`control.animate([{transform: translate3d(dx,dy,0)}, {transform: none}], {duration: 180, easing:
"cubic-bezier(0.32, 0.72, 0, 1)", fill: "backwards"})` — skipped entirely under
`prefers-reduced-motion: reduce`. Labels themselves collapse via `max-w-0` +
`translateX(-0.25rem) scaleX(0.95)` + `opacity-0` over the same duration and easing, re-measuring on
`ResizeObserver`, every render, **and `document.fonts` `loadingdone`** because font preference changes
move labels without moving boxes.

### 19.9 Icons

Four sources, all inline SVG or sprite — **no icon font, no runtime icon fetch**:

1. **Lucide** — the default set, sized by the primitives' `[&_svg:not([class*='size-'])]:size-4.5
   sm:…size-4` convention rather than per call.
2. **`components/Icons.tsx`** (698 lines) — 22 hand-written, full-colour brand icons typed
   `Icon = React.FC<SVGProps<SVGSVGElement>>`: GitHub, Git (`#DE4C36`), Jujutsu, GitLab, AzureDevOps,
   Bitbucket, Cursor, Grok, Trae, Kiro, VisualStudioCode, VisualStudioCodeInsiders, VSCodium, Zed,
   OpenAI, ClaudeAI, Gemini, Antigravity, OpenCode, GithubCopilot, ACPRegistry, PiAgent. Gradient/def ids
   are namespaced with React's `useId()` (with `:` stripped) so multiple instances do not collide.
3. **`components/JetBrainsIcons.tsx`** (610 lines) — 12 JetBrains IDE marks: Aqua, CLion, DataGrip,
   DataSpell, GoLand, IntelliJIdea, PhpStorm, PyCharm, Rider, RubyMine, RustRover, WebStorm.
4. **`pierre-icons.ts`** — file-tree/file-type icons from `@pierre/trees`' `"complete"` sprite set, plus a
   **T3-authored sprite of 6 overrides** inlined as a `<symbol>` sheet: `package.json` (npm red
   `#c12127`), `tsconfig.json` (`#007acc`/`#99b8c4`), `agents.md` (currentColor), `claude.md` (Anthropic
   orange `#d97757`), `readme.md` (`#b48a5a`), `pnpm-lock.yaml`/`pnpm-workspace.yaml` (`#f9ad00`). The
   sprite is prepended once into a hidden 0 × 0 div on `document.body` under id
   `t3code-pierre-file-icon-sprite`. A language→extension alias table (`bash→sh`, `typescript→ts`,
   `plaintext→txt`, …) lets code blocks reuse file icons via a synthetic filename `file.<ext>`.

`PierreEntryIcon` renders `<svg viewBox="0 0 16 16"><use href="#name"/></svg>` at `size-4` with an
explicit colour from a **58-entry light/dark pair table**, e.g.

```
typescript: ["#1a85d4", "#69b1ff"]   javascript: ["#d5a910", "#ffd452"]
markdown:   ["#199f43", "#5ecc71"]   rust:       ["#d47628", "#ffa359"]
react:      ["#1ca1c7", "#68cdf2"]   css:        ["#693acf", "#9d6afb"]
default:    ["#84848a", "#adadb1"]
```

falling back to lucide `FolderIcon`/`FileIcon` at `text-icon-muted`.

### 19.10 The five built-in theme palettes

`T3_CHAT_THEME` (id `t3-chat`) is the only one with hand-written hex tables, and the comments state these
were **measured off the live t3.chat product** with translucent surfaces pre-flattened — e.g.
`surfaceRaised: "#2c2631"` is "pre-composited for the composer's 80% glass layer", and
`sidebar: "#171018"` is a "pre-grain base" that lands on the visible `#1a131a` after the noise layer
composites.

Signature T3 Chat values:

```
light: canvas #fdf7fd · text #501854 · accent/focus #db2777 · message surface #f7def2
       code #f5ecf9 / #673c8b · sidebar #f2e1f4
       terminal #fdf7fd / #501854 / #db2777 / #f1c4e6 / #e7c1dc / #eaa7cb
dark:  canvas #1f1a24 · surface #29232d · accent #a3004c · focus #db2777
       sidebar #171018 · sidebarBorder #322028   (the deliberately pink panel divider)
```

The other four are **generated from two seed colours** plus a companion action colour:

| theme | light canvas / accent | light action | dark canvas / accent | dark action |
|---|---|---|---|---|
| Grove (`grove`) | `#f2f8f4` / `#19734a` | `#8f6410` | `#1d2b24` / `#69d69a` | `#e3b34e` |
| Ocean (`ocean`) | `#f2f7fb` / `#2878b8` | `#0a6f75` | `#1b2938` / `#70b9ee` | `#5bd0d6` |
| Ember (`ember`) | `#fff6ef` / `#c4602f` | `#b23535` | `#30231e` / `#f39a62` | `#f78a7a` |
| Iris (`iris`) | `#f7f4fc` / `#7254b9` | `#a82c87` | `#29243b` / `#ad92f5` | `#f099d8` |

All five set `sidebarArtwork: true`.

There is also a "standard T3 Code look as a theme" pair used as the seed when creating a theme with none
installed: light canvas `#fcfcfc`, accent `#1b4ed8`; dark canvas `#0a0a0a`, surface `#111111`, accent
`#346bf1`, sidebar `#000000`, with dark terminal roles
`#0a0a0a / #f5f5f5 / #b4cbff / #343a47 / #222222 / #363636`.

### 19.11 Mobile: a parallel, non-shared design system

`apps/mobile/global.css` (237 lines) is a **completely separate token set** for `uniwind`
(Tailwind-for-React-Native). It shares **none** of the web's role names:

```
--color-screen #f2f2f7 / #0a0a0a       --color-card #ffffff / #171717
--color-foreground #262626 / #f5f5f5   --color-user-bubble #007aff / #0a84ff  (iMessage blue)
--color-switch-active #34c759          --color-glass-surface rgba(255,255,255,0.72)
--color-md-link #2563eb                --color-inline-skill-* fuchsia family
```

Typography is a **real webfont** — **DM Sans**, loaded natively via `expo-font` from
`@expo-google-fonts/dm-sans` and exposed as `--font-sans: "DMSans-Regular"`,
`--font-medium: "DMSans-Medium"`, `--font-bold: "DMSans-Bold"`. Its type scale is explicit px pairs:

```
3xs 11/14 · 2xs 12/16 · xs 13/17 · sm 14/19 · base 16/23 · lg 18/23 · xl 21/28 · 2xl 26/32 · 3xl 30/36
```

`useThemeColor("--color-…")` bridges to native style props. There is **no theme import, no palette
engine, and no user theme library on mobile** — light/dark only. Markdown is rendered by a custom
Objective-C++ Fabric component (`apps/mobile/modules/t3-markdown-text/ios/T3MarkdownText.mm`), not
react-markdown.

### 19.12 Known inconsistencies in the design system

- **`font-heading` is an inert class.** It is applied to `DialogTitle`, `AlertDialogTitle`, `SheetTitle`,
  and `EmptyTitle`, but `--font-heading` is defined nowhere in the repo. Under Tailwind v4's CSS-first
  theming the utility is never generated, so those titles render in `--font-sans`. Almost certainly a
  leftover from the `base-mira` shadcn registry.
- **Two theme roles are written but never consumed.** `textMuted` → `--app-theme-text-muted` and
  `accentForeground` → `--app-theme-accent-foreground` are set on `<html>` by `applyThemePalette`, but no
  CSS or TS reads either variable. They are still meaningful *inside* the generators (as inputs to
  derived roles) and editable in the theme editor, but changing them in a theme file has no visible
  effect. The other 55 roles all have a consumer.
- **The six `--terminal-scrollbar*` tokens are themeable and generated but have no consumer** — the
  Ghostty scrollbar uses the generic `--app-scrollbar-*` tokens instead.
- **Nothing lints token usage.** The `oxlint-plugin-t3code` plugin's four rules are about node imports,
  the Effect runtime, and Schema compilation; nothing forbids raw hex in components, and raw hex does
  appear (e.g. `ThemeWireframe.tsx`, the ultrathink spectrum).
- **`index.html` and `themePalette.ts` duplicate the built-in palettes**, enforced only by a comment
  ("Keep this small boot-time copy in sync").

---

## 20. Usage and limits tracking

This is a self-contained read path that never touches the orchestration event log, the SQL database, or
T3's own turn/checkpoint model.

### 20.1 The mechanism in one sentence

On every RPC call, the server walks the **provider CLIs' own on-disk session-history files**
(`~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl`), parses each line with a
hand-written pure reducer, prices the resulting token counts against a public LiteLLM rate table,
buckets everything into `(day, hourStart?, provider, model)` cells, and returns those pre-aggregated
cells over the same typed RPC channel every other feature uses.

The comment at the top of `apps/server/src/usage/UsageService.ts:1-13` states this explicitly: *"The
scan reads the provider CLIs' own session files rather than T3 Code's orchestration projections, so
usage covers turns driven outside T3 Code too. This is the approach `ccusage` takes."* Consequently
usage totals cover **all** of a user's Claude Code / Codex activity, not just turns driven through T3.

### 20.2 Which files, and how the directories are found

- **Claude**: `UsageService.ts:191-198` resolves the Claude home via `resolveClaudeHomePath`
  (`provider/Drivers/ClaudeHome.ts:9-15` — the *same* home-resolution helper the Claude driver uses to
  spawn the CLI: `CLAUDE_CONFIG_DIR` override or `os.homedir()`), then probes whether
  `<home>/.claude/projects` exists; if not, falls back to `<home>/projects`. This covers both "home
  override points straight at `~/.claude`" and "home override points at a directory that already looks
  like `~/.claude`".
- **Codex**: `resolveCodexHomeLayout` (`provider/Drivers/CodexHomeLayout.ts:44-66`) is the *same* layout
  resolver the Codex driver uses for shadow-home overlays (isolating Codex's `auth.json` per environment
  while sharing `sessions/`, `sqlite/`, etc. via symlinks). Usage always reads
  `codexLayout.sharedHomePath + "/sessions"`, **never the shadow/effective home** — sessions are one of
  the directories that stay symlinked into every shadow home, so the shared path is always the complete
  picture.
- **Only two providers are tracked at all**: `UsageProviderKind = Literals(["claude", "codex"])`
  (`packages/contracts/src/usage.ts:26`). Cursor, Grok and OpenCode — three of the five supported
  provider drivers — have **no usage path**; their local session-history formats, if they keep one, are
  not parsed.

### 20.3 The scan

`listTranscriptFiles` (`usage/usageTranscriptReader.ts:41-74`) does a raw recursive
`node:fs/promises` directory walk — **not** Effect's `FileSystem` — looking for `*.jsonl` filtered by
`stats.mtimeMs >= sinceMs`. The module comment explains the deliberate departure from the rest of the
Effect-typed codebase: a cold 30-day scan is **~1.4 GB across ~1,500 files**, and `readline` over a raw
`fs.createReadStream` is "roughly an order of magnitude cheaper" than the idiomatic Effect `Stream`
pipeline — not fast enough to sit behind a page load. Errors on individual `readdir`/`stat` calls are
swallowed (files rotate and vanish mid-walk); a partial listing beats failing the page.

`readTranscriptRecords` streams one file with `node:readline` (`crlfDelay: Infinity`) and, per line:

- **Claude**: gates on `mightCarryUsage` — a cheap `line.includes('"usage"')` substring check before
  `JSON.parse`, described as skipping "roughly half the lines outright" and worth "about an order of
  magnitude". Then `parseClaudeLine` requires `type === "assistant"`, a `message.usage` object, a
  parseable `timestamp`, and a non-empty `message.model`.
- **Codex**: gates on `token_count`/`turn_context`/`session_meta` substrings, then `parseCodexLine` runs
  a small **stateful reducer** (`CodexScanState`) carried across lines of one file, because Codex
  `token_count` events carry no model of their own — the model is remembered from the most recent
  `turn_context` line.

A parse failure returns `null`, which the caller must not cache as "empty" (§20.5).

**Claude dedupe.** Claude Code writes one JSONL record per assistant *content block*, and every block
repeats the full parent-message `usage` object; summing naively overcounts by **~2.4×** on a real
workload. `dedupeKey` is `` `${messageId}:${requestId}` ``, matching what `ccusage` itself uses. Records
missing both ids get `dedupeKey: null` and are simply never de-duplicated.

**Codex corrections — three, layered:**

1. **Consecutive-duplicate suppression** — identical consecutive `last_token_usage` payloads (by
   `JSON.stringify` signature) are skipped, because Codex re-emits an unchanged `token_count` on some
   stream boundaries.
2. **Fork-copy suppression** — a forked or subagent rollout file opens with the *entire parent history
   re-stamped to the fork instant*. `isForkedSessionMeta` detects this via `forked_from_id` or a
   `source.subagent.thread_spawn.parent_thread_id` field on `session_meta`. Once detected, every usage
   event within `FORK_COPY_MAX_GAP_MS` (**1000 ms**) of the previous one is dropped as a copied-history
   burst. The comment records the empirical basis: "observed gaps 0-40ms" for the burst vs "observed 5s+"
   before the child's first genuine usage event — and notes `ccusage` uses the same 1-second threshold.
3. **`input_tokens` double-counts cache** — Codex reports `input_tokens` *inclusive* of the cached and
   cache-write portions, so `uncachedInputTokens = max(0, input_tokens - cached_input_tokens -
   cache_write_input_tokens)`.

Also: `reasoningTokens` is always a **subset** of `outputTokens` for both providers, and every place that
sums totals is careful never to add it a second time.

### 20.4 Pricing

Rates come from LiteLLM's public
`https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` — an
**unauthenticated GitHub raw-content fetch, no API key**. `ensureRates`:

1. reuses the in-memory table if fetched within `RATES_TTL_MS` = **24 h**;
2. on cold start loads a disk snapshot (`usage-model-rates.json` in `config.stateDir`) first so the page
   works before the network call lands, stopping there if that snapshot is itself within TTL;
3. otherwise does an `HttpClient.get` with a **10-second timeout**; any failure is swallowed and, if a
   table already exists, its status is demoted from `"fresh"` to `"cached"` rather than silently claiming
   freshness;
4. a successful fetch is written back to disk (best-effort).

`parseRateTable` keeps only entries with **both** an input and an output rate — a half-priced model is
explicitly rejected rather than under-reporting cost. Model names are normalised by stripping a
`provider/` prefix and lowercasing. A fixed `UNPRICEABLE_MODELS` set (`<synthetic>`, `synthetic`,
`opus`, `sonnet`, `haiku`, `fable`) is never priced even if present in the table, because bare family
names are ambiguous across model generations.

`priceUsage` prefers a **provider-reported cost** (Claude transcripts carry `costUSD` on some records)
over the rate table; otherwise it computes `costUsd` from the four token categories, or returns
`costSource: "unpriced"` if the model is not in the table. `cacheSavingsUsd` is a separate derived
figure: what cached input *would have* cost at full input rate minus what it actually cost at the
(usually discounted) cache-read rate. LiteLLM entries missing either cache rate fall back to the plain
input rate — cached input priced as full-price input, **never as free**.

**Only the base tier rate is used** even though LiteLLM publishes tiered variants
(`*_above_272k_tokens`, `*_flex`, `*_priority`, `*_batches`), because the transcripts do not record which
tier served a request; the comment is explicit that pricing anything else "would be a guess dressed up
as precision".

### 20.5 Two-layer caching

Transcripts are append-only, so a file's parsed records are memoised by **`(size, mtimeMs, provider)`**.
Provider is part of the key deliberately — if Claude and Codex ever pointed at the same directory, a hit
parsed by the wrong parser must not be reused.

- A **failed read returns `null`, which is not cached** — caching a transient read failure under the
  current `(size, mtime)` would silently drop that file's usage forever, until the file next changes.
- A **successfully parsed empty file** *is* cached as `[]` — a stable fact worth memoising.
- Cached entries are stored already de-duplicated **within their own file** ("99% of all duplicates"),
  while the aggregator still runs a second, global de-dup pass across the small surviving key set,
  because Claude Code copies a message's records forward across sessions on resume/fork, so the same
  `dedupeKey` legitimately reappears in *different* files.

**The persisted scan cache** serialises the whole in-memory map to `usage-scan-cache.json` in
`config.stateDir`, written only when dirty, with the dirty flag cleared only *after* a successful write
so a failed persist is retried next scan rather than leaving disk permanently stale. The comment
quantifies the payoff: without it, every server restart re-parses the whole window (~3.5 s for 30 days)
vs **~11 ms** to reload the cache.

The on-disk shape is a **hand-rolled compact encoding, not a straight `JSON.stringify`**: per-record
arrays are **positional tuples**, and model/session strings are **interned into shared string tables**
referenced by index. The comment: this is "the difference between a file measured in tens of megabytes
and one under six" on a 30-day window. An explicit `USAGE_SCAN_CACHE_VERSION` (currently **2**) means any
version mismatch, or any structurally malformed row, discards the whole cache (or that file's entry)
rather than serving corrupted-shaped data as a warm hit — and the v1→v2 bump happened because "Codex
fork-copy suppression changed what a file parses to", a concrete example of invalidating whenever the
parser's *semantics* change, not just its schema.

**Pruning** drops entries either older than a **90-day** retention cutoff regardless of anything else, or
that were inside the just-walked window/root but not seen this pass (implying deletion) — deliberately
*not* pruning everything the walk did not reach, since a request for a 7-day window must not evict warm
30-day entries. A stated design note: this replaced an earlier "record cap that cleared the whole cache
once exceeded", which meant a large-enough window never warmed up at all.

**mtime slack.** Files are pre-filtered by `mtimeMs >= windowStartMs` where `windowStartMs` is the
requested window start minus `MTIME_SLACK_MS` = **36 hours** — covering a session whose last write lands
just before local midnight on the window's first day in an arbitrary IANA zone, without precomputing that
zone's actual UTC offset for the mtime filter. Records that pass this coarse filter but fall genuinely
outside the window are dropped precisely by the aggregator (an `outOfWindow` counter).

### 20.6 Aggregation

`UsageAggregator` is a plain class (not an Effect), fed one record at a time via `.add()`, producing
`.finish()` with sorted `UsageBucket[]`. The bucket key is
`` `${day}\0${hourStart}\0${provider}\0${model}` ``; day resolution collapses `hourStart` to `""`.

- **Day boundaries respect the requesting client's IANA time zone**, not server local time or UTC:
  `makeDayFormatter` uses `Intl.DateTimeFormat("en-CA", {timeZone})` specifically because `en-CA` yields
  ISO-ordered `YYYY-MM-DD` parts directly from `.format()`. An unknown or invalid zone string degrades to
  UTC rather than failing the scan.
- **Hourly resolution is a genuinely different mode**, not day-bucket subdivision: it requires exact
  `sinceTimeMs`/`untilTimeMs` bounds (throwing otherwise), uses **fixed 60-minute buckets anchored to the
  exact window start** (not wall-clock-hour aligned) so DST transitions and odd-minute "now" values still
  produce a clean rolling 24-hour window, and the bound check is inclusive-start/exclusive-end on raw
  milliseconds rather than calendar-day comparison. The server caps the hourly window at
  `MAX_HOURLY_WINDOW_MS` = **24 h** — the longest the UI ever requests, since "Past 24h" is the only
  hourly option and 7/30/90-day windows use daily resolution.
- Global de-dup happens *inside* `.add()`, **ahead of** the window check, so a duplicate outside the
  window is counted as `duplicatesDropped` rather than `outOfWindow`.
- Per-bucket `costSource` takes the **weakest** provenance present: if every record was unpriced the
  bucket is `"unpriced"`; if every record had a provider-reported cost, `"providerReported"`; otherwise
  `"modelPriced"`. A bucket must never claim a stronger costSource than its weakest contributing record.

### 20.7 The contract

`USAGE_CONTRACT_VERSION = 4` is bumped on any incompatible shape change; the client checks each
environment's reported `contractVersion` against its own expected constant and **excludes** (not fails)
any environment that disagrees, listing it as `staleEnvironments`.

**Raw transcript records never cross the wire** — only pre-aggregated
`(day, hourStart?, provider, model)` buckets do. Each bucket carries its own `totals`, `costUsd`,
`cacheSavingsUsd`, `costSource`, `records`, `unpricedRecords`, and distinct `sessions` count.

`UsageSourceFingerprint` identifies a physical transcript directory by `hostId` (`os.hostname()`) +
`provider` + `resolvedHomePath` + **`volumeId`** (a `device:inode` string from `stat`). The comment is
explicit about why hostname + path alone is insufficient: *"every Mac in a fleet resolves
`/Users/<user>/.claude`"* — two different machines sharing a hostname would otherwise collapse into one
source on the client and lose one side's data silently.

`UsageSourceStatus = Literals(["ok", "missing", "partial", "failed"])` — **but the server only ever emits
`"ok"` or `"missing"`.** `UsageSource.malformedRecords` is likewise declared in the contract but
hardcoded to `0` at both emission sites; nothing counts malformed lines.

The RPC is `WsServerGetUsageSummaryRpc`, method name `server.getUsageSummary`, payload
`UsageSummaryInput`, success `UsageSummary`, errors `EnvironmentAuthorizationError | UsageReadError`.
Auth scope is `AuthOrchestrationReadScope` — the same read scope as process diagnostics and resource
telemetry; **there is no usage-specific scope.** The handler in `ws.ts:1566-1569` is a one-liner
(`usage.readSummary(input)` wrapped in `observeRpcEffect`). `UsageService.layer` is provided from
`ServerSettingsLayerLive` because it needs live settings to resolve the *configured* (possibly
overridden) Claude/Codex home paths. There is also a `layerTest` stub returning an always-empty summary,
so RPC-surface tests resolve the method without touching disk.

### 20.8 The multi-environment client merge

A connected client can be attached to several environments at once, and the Usage page **fans the same
RPC out to every connected environment and merges client-side.**

- `apps/web/src/state/usage.ts` builds one `EnvironmentUsageStatus` per environment via a generic
  `createEnvironmentRpcQueryAtomFamily` — an SWR-style query-atom-per-environment wrapper reused across
  every environment-scoped RPC — instantiated here with `staleTimeMs: 60_000`, because "a cold transcript
  scan is measured in seconds, so keep the result around long enough that switching windows or
  re-rendering does not rescan".
- `apps/mobile/src/state/usage.ts` is a byte-for-byte mirror of the web version, explicitly documented as
  such in its header.
- The merge itself is shared, pure, and framework-free: `packages/shared/src/usageMerge.ts`. It solves
  two structural problems:
  1. **Stale-contract exclusion** — an environment whose `contractVersion` mismatches is dropped from the
     merge and reported via `staleEnvironments` rather than blocking the page.
  2. **Duplicate-source ownership** — several environments on one physical machine (e.g. two worktree
     servers on the same laptop) resolve to the *same* transcript directory and would double-count every
     token. `claimSources` sorts environments by id for determinism, then the first environment to see a
     given `fingerprintKey` "claims" it; every subsequent environment reporting the same fingerprint has
     that provider's buckets dropped from its contribution and is listed in `duplicateSources` for the UI
     to disclose. **The server has no awareness that another environment might be reading the same
     files** — this is entirely a client-side correction based on filesystem device/inode identity.
  3. Session counts are summed from each environment's *owned* `distinctSessions` per source, not by
     summing per-bucket session counts, because a session spans multiple days and models.
- **Loading semantics**: the page holds the entire content area on a static skeleton until *every*
  environment is terminal, explicitly to avoid every number visibly jumping as each device's scan lands.
  With 2+ environments a `UsageDeviceStrip` shows live per-device check/×/pulsing status while waiting.
  The acknowledged cost: one slow or unreachable environment holds up the whole page.
- **Refresh** cannot simply invalidate the derived merge atom — because the per-environment query atoms
  are the actual SWR cache holders, the refresh button loops over every connected environment and calls
  `appAtomRegistry.refresh(...)` on each environment's `usageSummary` atom individually, which is what
  forces a real server-side rescan rather than reading the 60-second-stale cached result.

### 20.9 The UI

Time windows are computed in the browser's own resolved IANA zone
(`Intl.DateTimeFormat().resolvedOptions().timeZone`) and sent to the server as `timeZone`, so
day-bucketing happens against the viewer's actual calendar days regardless of server locale. "Past 24h"
uses `resolution: "hour"` with minute-aligned exact rolling bounds; 7/30/90-day windows use
`resolution: "day"` with calendar-day arithmetic **done in UTC specifically to dodge DST-transition
off-by-one-day bugs**.

The chart renders **absolute per-provider series from a shared zero baseline, not stacked** — an explicit
design choice, because a stacked chart would make whichever series is drawn last look permanently
"bigger" even on days it was not. It uses a hand-rolled **monotone-cubic (Fritsch-Carlson)** smoothing
chosen specifically because plain cubic smoothing can overshoot spiky daily data into negative territory,
which would visually read as "negative spend". `niceScale()` computes a human-readable 1/2/5 × 10^n axis
ceiling rounded *up* from the peak so the tallest bar is never visually clipped.

Only Claude and Codex ever render (`PROVIDER_ORDER = ["codex", "claude"]`), with brand colours
**`#d97757`** (Claude orange) and **`#e6e6e6`** (neutral for Codex) and brand-icon marks reused from the
provider picker.

### 20.10 What is absent

- **There is no remaining-limit or quota retrieval anywhere in this path.** Nothing queries a provider's
  subscription plan, rate-limit headers, remaining-credits endpoint, or reset time. The feature is
  entirely a re-derivation of *observed token consumption* from local transcript files.
- **`costUsd` is explicitly not "money spent"**: it is the raw API-equivalent cost of the observed tokens
  at base-tier rates. Both the contract comment and the UI's `*` footnote ("if billed at full API rate")
  flag that subscription-plan billing is untracked and separate. This is a documented scope limit, not a
  bug — but a re-implementer must not conflate the two.
- Tiered / priority / batch pricing is deliberately ignored.
- Cursor, Grok and OpenCode activity is entirely absent.
- No mechanism exists to invalidate a stale rate table faster than the 24 h TTL if LiteLLM ships an
  urgent correction; refresh waits for TTL expiry or a server restart. There is no fallback mirror if
  that GitHub raw URL moves, and no retry/backoff beyond "try again next scan".

The only other place the product surfaces per-turn consumption is the composer's **context-window
meter** (§19.7), fed by `thread.token-usage.updated` runtime events translated into
`context-window.updated` activities — that is a per-thread context-fill indicator, not a plan limit.

---

## 21. Where the video teardown was wrong or stale

`docs/research/t3code-ui-notes.md` reads v0.0.31 from the outside; this clone is v0.0.33. Some of these
are genuine version drift, some are limits of reading from frames.

1. **"Dark only, and *very* dark. No light mode shown."** The code ships a **complete light palette** as
   the `:root` default, five built-in themes each with light and dark variants, a VS Code / Open VSX
   theme importer, a full theme editor with a live inspector, and a "theme halves" feature binding a
   different theme to each appearance. Light mode is not an afterthought; it is the base layer.
2. **The estimated colour values are close in feel but not the actual tokens.** The dark canvas is
   `--color-neutral-950` (not `#0A0A0B`–`#0D0D0F`); accents are OKLCH (`oklch(0.571 0.21 264)` dark,
   `oklch(0.488 0.217 264)` light), not hex blues. Most importantly the **sidebar in dark is `#000` —
   *darker* than the canvas**, the opposite of the note's "sidebar ~1 step lighter than the canvas".
3. **"A single geometric/neo-grotesque UI sans (reads like Inter/Geist)."** No webfont is loaded for the
   UI at all. It is `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` — on the
   reviewer's Windows machine, Segoe UI. The only bundled face in the web app is a symbols-only Nerd Font
   for the terminal. (Mobile is the exception: it really does load a webfont, DM Sans.)
4. **The right panel offers seven surface kinds, not four.** `RIGHT_PANEL_KINDS` is
   `diff | files | file | preview | terminal | pull-request | agents`. The note's "Browser · Terminal ·
   Files · Diff" misses the **Agents** panel and the **Pull request** surface.
5. **"T3's sub-agent rendering… the weakest thing in the app — no elapsed time, no status dot, no
   completion count, no ordering, no tree."** By this commit there is a dedicated **Agents panel** with
   per-agent status dots and labels, a per-agent elapsed timer ticking every second, token totals, tool
   counts, run counts, workflow grouping with a phase rail, phase sections with active/done counts, a
   footer with `N working / N idle / N settled / Σ tok`, and a 100-agent roster cap with an explicit
   retention rank. The chat itself deliberately shows only one CTA row per spawn batch — that is the
   *quiet-timeline guarantee*, not an absence of a fleet view.
6. **"There is nothing anywhere in the app that claims to know how far along a run is."** Turn plans do:
   `ThreadPlanProgressService` tracks `{step, completedSteps, totalSteps}`, the timeline's `turn-plan`
   row renders a segment bar plus `completed/total`, and the sidebar/composer surface plan step labels.
   It is still true that there is no percentage or ETA for the *turn* itself.
7. **"No `Failed` / `Error` state color for a run."** There is: `--error`/`--destructive` tokens, error
   tone on activities, `bg-destructive` for a failed agent, `text-destructive` status glyphs on failed
   tool rows, and a session `status === "error"` that outranks the background-liveness pill in the
   sidebar.
8. **Permission-mode copy has changed.** The video quotes Auto as *"An AI reviewer approves routine
   actions; risky ones still ask."*; the code says **"Supported providers approve routine actions; others
   still ask."**
9. **Model-picker shortcuts are `mod+1..9`, not `Ctrl+1…Ctrl+5`**, and the left rail is a rail of
   **provider instances**, not providers — two Codex accounts appear as two rails with independent model
   lists, custom models, and saved selections.
10. **Radii are larger than estimated.** Cards and dialogs are `rounded-2xl` = **18 px** (not "12px
    modals"), the composer is a hard-coded **22 px** with a 20 px inner surface, and controls are 8 px
    (`--control-radius`).
11. **The content column caps at 768 px, not "roughly 640px"** (`max-w-3xl` /
    `TIMELINE_CONTENT_MAX_WIDTH = 768`). Separately, the *sidebar* math guarantees 640 px of main content,
    which may be where the number came from.
12. **"No URL-shaped routing exposed."** The app runs TanStack Router (hash history inside Electron),
    with a real `/settings` route and `/threads/{environmentId}/{threadId}` deep links that push
    notifications and Live Activity taps navigate to.
13. **"It shells out to `codex`, `claude`, `cursor-agent`, `grok`, `opencode`."** Only Codex is a plain
    spawned child speaking JSON-RPC over stdio. Claude goes through the vendored Agent SDK (which itself
    manages a CLI subprocess), Cursor and Grok speak ACP over stdio via a shared in-repo package, and
    OpenCode is HTTP to a locally spawned server. Four transports, one normalised event union.
14. **Distribution nuance.** The README does advertise `winget` / `brew --cask` / `yay`, but this repo's
    release pipeline publishes only to **GitHub Releases and npm**; those package-manager channels are not
    produced by the workflow in this clone.
15. **Two smaller framing points.** "Token-by-token streaming is off by default" is correct — and the
    code goes further: turning it *on* requires a native confirm dialog, and the setting key was renamed
    to force prior opt-ins back to buffered. And the composer's "floats over content with a
    semi-transparent background" is a `backdrop-filter` glass layer whose outline is one continuous
    `clip-path: shape()` spanning the composer *and* the branch strip — not a simple translucent panel.

Confirmed correct by the code, worth recording as verified: the environment-vs-client split; the
collapse-and-count log with `+N previous tool calls` (`MAX_VISIBLE_WORK_LOG_ENTRIES = 1`); the
`Working for …` → `Worked for … ›` same-component tense flip; per-turn diff scoping
(`getTurnDiff` / `getFullThreadDiff`); the floating "Scroll to end" pill (debounced 150 ms on show,
immediate on hide); Settings as a full-window route rather than a modal; auto-titling via a separate
title-regeneration worker; the workspace/base-branch strip declaring isolation before a run; and Actions
as project scripts that can run automatically on worktree creation and carry a preview URL.

---

## 22. Notable mechanisms

Facts worth knowing when building any agent control surface. No recommendations.

**Event model and state**

1. One totally-ordered command queue with a single worker fiber makes an in-memory read model safe to
   mutate without locks; `dispatch` returns a `Deferred` so callers still get request/response semantics.
2. Idempotency is a **command-receipt table** keyed by client-generated `commandId`, not a retry policy.
   An `"accepted"` receipt short-circuits; a `"rejected"` receipt fails fast and is never re-decided; a
   `SqlError` writes no receipt so a real retry is not blocked.
3. **Two independent projections of one event stream** — a pure in-memory reducer that feeds the
   decider's own validation, and a 9-table SQL pipeline that every read actually queries — kept in sync
   only by both running inside the same transaction. There is no shared reducer.
4. Events publish **only after commit**, so no subscriber can observe a non-durable event.
5. **The decider is idempotent by re-emission**: settle/snooze/pin on an already-settled thread re-emit
   the same timestamps so a duplicate command becomes a no-op when projected.
6. `actor_kind` is not a structural field — it is inferred at the SQL boundary from the `commandId`
   string prefix (`provider:`, `server:`), so `commandId` doubles as idempotency key and actor namespace.
7. **Runtime receipts are a documented production no-op**: a whole typed milestone bus exists, compiles,
   and is wired through real paths, but only the test layer is PubSub-backed.
8. A `DrainableWorker`'s `drain` is explicitly a **test-only** synchronisation primitive, not production
   backpressure.

**Streaming and rendering**

9. **Token-by-token streaming is off by default.** The server buffers the whole assistant message in RAM
   with a 24 000-char spill valve and flushes at interaction boundaries (an approval or user-input request
   forces a flush so the timeline never freezes mid-sentence behind a modal).
10. **There is no delta event type.** Deltas ride as ordinary message events with `streaming: true`, and
    the "append vs replace" rule is duplicated verbatim in three places.
11. **The server drops rows it knows the client would collapse anyway**, with the measured cost of both
    choices written into the comment (2 291 superseded rows ≈ 1 MB in one thread; 47 k across a real
    database; 1.5 % of dropped rows would have rendered distinctly under the client's rule).
12. **Ingestion writes activities under deterministic ids** so an upsert collapses an unbounded tick
    stream into ~3 rows per agent — with token usage under its *own* id purely so a reasoning tick cannot
    blank the count.
13. **Structural sharing on derived rows**: previous row objects are reused when content is unchanged, so
    a virtualised list does not re-render the whole log per delta.
14. **Elapsed-time labels bypass React entirely**, writing `textContent` on an interval, in three separate
    places (working row, agent row, timers).
15. Live-follow has three modes and a generation counter; the wheel/touch opt-out is guarded specifically
    against a documented bug where a spurious break while pinned produced no scroll event and follow never
    re-armed.
16. The shell (sidebar) stream **coalesces to the latest event per aggregate in a 50 ms window**; the
    thread-detail stream does not.
17. A resume cursor more than 1 000 events behind gets a fresh snapshot instead of a replay; a windowed
    page carries a `threadSequence` watermark the client must have applied before merging older content,
    or streaming deltas would be replayed on top of content that already includes them.

**Correctness under provider chaos**

18. An **env-var-gated strict lifecycle guard (default on)** rejects out-of-order or duplicate provider
    lifecycle notifications, with a named documented exception for one provider quirk.
19. **Tool failure is detected by string-matching output** (`ENOENT`, `CommandNotFoundException`, `is not
    recognized as the name of a cmdlet`, `<exited with exit code N>`) because providers report
    `status: completed` while the error text sits in `detail`.
20. The subagent fold is a **defensive parser, not a decoder**: payloads are not schema-validated on the
    read path, so status lookups use `Map`/`Set` to dodge prototype pollution and URLs are re-validated
    client-side even though the adapter already sanitised them.
21. **Usage merge is field-wise maximum**, because cumulative frames make max-merge idempotent under
    duplicate and late delivery, and because a terminal payload carrying only a total must not wipe a
    known breakdown.
22. Two independent "the run is over" cascades exist — a settled coordinator force-settles stalled
    members, and a dead session force-interrupts every active agent — because terminal rows genuinely go
    missing.
23. Batch membership for a collapsed spawn group is **frozen at the first row seen for a task id**,
    because background subagents settle under later synthetic turn ids.
24. Codex's fleet-wide stop interrupts every live child turn with concurrency 8, a 3 s per-child timeout
    and a 10 s overall bound, *before* interrupting the parent.

**Filesystem and git**

25. A checkpoint is a **parentless commit written through a scratch `GIT_INDEX_FILE`** under
    `refs/t3/checkpoints/…`, with `git add -A` so untracked files are captured — never touching
    `.git/index`, `HEAD`, or any branch, and therefore safe to run while the agent is editing.
26. Revert restores the worktree **and** calls `adapter.rollbackThread` to rewind the provider's own
    conversation, because otherwise the filesystem and the agent's memory drift apart.
27. A **worktree-branch-drift follower** adopts a branch the agent checked out behind T3's back, but only
    when the worktree is exclusively owned by one thread, and via compare-and-swap.
28. Agent turns **refresh the workspace search index** after every checkpoint and revert, so files an
    agent created appear in the tree and in `@` completions without user action.
29. The workspace read path guards symlinks with a **second `realpath`-based containment check** after the
    lexical one; binary detection is a NUL-byte scan; and search errors carry `queryLength`, not `query`.
30. **Whole-word grep is a post-filter that re-drives the cursor** under a 250 ms deadline, reimplementing
    VS Code's boundary rule by hand rather than wrapping the pattern in `\b`.
31. A hardened file read for a UI affordance: realpath the *file* (not just the directory), then
    open-then-fstat-then-compare-inode to close the TOCTOU window, then truncate-don't-fail at 256 KB.

**Terminals**

32. **Stored scrollback is not the byte stream** — a hand-written VT sanitiser strips only query/response
    sequences, because replaying a stored query makes the live shell answer again and echo junk.
33. A **112-byte second WASM module** exists purely as a function-pointer trampoline, with a comment
    documenting the WebKit bug that forces `table.grow(1)` then `table.set()`.
34. **Struct layouts are negotiated at runtime** via a JSON description of every C struct's size, align
    and field offsets, so the TS side never hardcodes an ABI layout.
35. **The version pin is verified from inside the binary**: the build embeds the upstream git revision as
    semver build metadata and a unit test reads it back and compares it to the single `VERSION` file.
36. The tab label is the running command, derived from a 1 Hz process-tree poll whose transitive pid set
    also tells the port scanner which listening ports belong to which terminal.
37. The terminal's existence reshapes the global keymap: nine app-wide shortcuts carry
    `when: "!terminalFocus"`, resolved by walking `document.activeElement.closest("[data-terminal-owner]")`.

**Auth and connectivity**

38. **The WebSocket never carries the long-lived credential** — a 5-minute single-purpose ticket is minted
    first and is the only thing appended to the URL.
39. **DPoP replay protection is an atomic file create** (`O_EXCL`) in the secrets directory; the same
    primitive guards the Ed25519 keypair first-write race.
40. Per-RPC scopes are a `satisfies Record<Method, Scope>` map, so adding an RPC without a scope is a
    **compile error**, plus a test that the map covers every declared method.
41. Scope narrowing is one-way: a pairing exchange can only narrow, never widen, and an already-scoped
    client can mint a **delegated** pairing credential naming a subset of its own scopes.
42. The relay is a credential broker, not a data path: a **double-signed JWT handshake** (relay→environment
    request signed by the relay's key, environment→relay response signed by the environment's key, both
    nonce-checked) mints a bootstrap credential, after which traffic goes straight to the tunnel hostname.
43. Tunnel hostnames are **content-addressed** (`SHA-256(namespace, userId, environmentId)`), so relinking
    reproduces the same subdomain.
44. Retry semantics differ by *why* a connection failed: transient errors use a `[3, 4, 8, 16] s` ladder
    that resets after 30 s of stability; `blocked` (auth/config/permission) never retries on a timer.
45. Mobile gets a deliberately shorter (3 s) foreground probe timeout, because OS-suspended sockets need
    fast detection when the user reopens the app.
46. Third-party CLI stderr is classified into a **closed set of diagnostic labels** rather than logged,
    because it can contain auth keys.

**Agent-facing surfaces**

47. The MCP endpoint is a **second, parallel auth model** mounted outside the environment auth stack; its
    bearer is minted once per CLI-process lifetime, cannot be rotated into a live process, and is
    therefore "touched" on every turn to keep it alive.
48. Five providers, five hand-rolled MCP-registration formats for the identical credential — including one
    that passes the token only via the child process environment so it never reaches argv.
49. **Playwright is vendored as a locator engine, not run as a browser tool**: its `InjectedScript` source
    is string-marker-extracted from a bundled file, evaluated in a `node:vm` to recover the source text,
    then installed into the live guest page over CDP.
50. **The browser the agent controls is the same one the human is looking at**, with a cooperative control
    epoch so a human click mid-automation interrupts the agent's in-flight action rather than racing it.
51. `contextIsolation=false` on preview guests is intentional and paired with `sandbox=true`, and the
    exact preference string is unit-test-locked because `"no"` would be truthy.

**Client/desktop**

52. The renderer is served through a **privileged custom scheme that reverse-proxies to the backend** and
    stamps a CSP, stripping `origin`/`referer`/`sec-fetch-*` — origin stability is what buys stable
    storage and sessions across port changes.
53. The bootstrap envelope travels on **file descriptor 3** as one line of JSON, with two optional further
    fds for bidirectional telemetry — degraded to stdin for WSL, which drops extra fds.
54. Port selection requires a port free on `127.0.0.1` **and** `0.0.0.0` **and** `::`.
55. **Renderer crash recovery is a product feature**: reload after 500 ms, at most 3 times per rolling
    minute, on the reasoning that agents keep running in the backend.
56. IPC methods declare an Effect `Schema.Codec` for payload *and* result, so the boundary is validated in
    both directions; several bridge members are optional purely to tolerate an older shell with a newer web
    bundle.
57. `electron-store` is a declared dependency that is never imported; all persistence is plain JSON, and
    only non-default keys are written.

**Design system**

58. **Theme switching touches zero React state** — 57 inline custom properties on `<html>` plus a static
    CSS block, wrapped in `.no-transitions` + a forced reflow + a `requestAnimationFrame` cleanup, so the
    swap is one un-animated frame.
59. **The token-probe inspector** answers "which pixels use this token?" by swapping the variable for a
    sentinel colour, re-reading computed styles for every element, and restoring — all before the browser
    can paint, guarded by a CSS rule that suppresses transitions during the probe. It finds *dependency*,
    not colour equality.
60. **Every generated palette is contrast-solved by binary search**, with targets calibrated to *measured*
    values from the stock theme (`4.705` light muted, `5.082` dark muted, `4.6` "with headroom for browser
    color conversion"), and light-vs-dark decided by measured luminance `< 0.179` rather than the declared
    appearance.
61. **Imported themes are deliberately stripped of the brand**: error and warning always fall back to
    standard red/amber over the imported canvas, so a destructive button never inherits a theme's hue.
62. **Animations are duty-cycled with `steps()` on purpose**, with the 120 Hz frame-count arithmetic
    written into the CSS comment; the paper grain is baked into each surface's own background rather than
    overlaid, for the same compositor reason.
63. The composer's outline is drawn with the CSS **`shape()`** function — one continuous path fusing a
    22 px composer to a 16 px strip with hand-computed Bézier handles — with a full `@supports not`
    fallback.
64. Selection over non-editable chips is **faked with the CSS system colour `Highlight` at 0.3 opacity**,
    because browsers skip `contentEditable={false}` decorators when painting selection.
65. **Font "Default" labels are resolved by DOM text measurement**, not canvas, with a written note that
    the engine renders `ui-monospace` differently in the two — and an Apple special case, since San
    Francisco is not CSS-nameable.
66. Sidebar open state is stored in a **cookie via the `cookieStore` API**, not localStorage.
67. The ZIP central directory of an imported `.vsix` is **hand-parsed before JSZip sees it**, partly for
    zip-bomb limits and partly because JSZip mistakes EOCD-like bytes inside an archive comment for the
    real EOCD.

**Data hygiene**

68. Draft persistence **verifies itself against localStorage**: it flushes the debounced write, re-reads
    the key, and diffs ids to mark attachments that silently lost the quota race.
69. The prompt stash writes the text-only entry **before** clearing the composer, and clears only if the
    write is confirmed; images are appended in a second phase, with a distinct toast per failure mode.
70. Failure detail is **redacted before it leaves the machine** on the push channel — the phase and thread
    identity cross the wire, the actual error text never does.
71. APNs provider tokens are signed with **RFC 6979 deterministic ES256** and an `iat` quantised to a
    45-minute window, so every stateless Worker isolate derives a byte-identical token without
    coordination — dodging a `429` observed live.
72. Queue jobs are **HMAC-signed and re-verified on dequeue against current DB state**, with every
    staleness check **failing open** so a transient DB hiccup never silently drops a real alert.
73. The usage scan cache is a bespoke compact encoding (positional tuples + interned string tables) purely
    for file size, and its version is bumped when parsing *semantics* change, not just its schema.

---

## Appendix: honest gaps

Reproduced verbatim from each area reader's own "honest gaps" section. These are the limits of the
study: files not read in full, claims read off source rather than run, and mechanisms that exist in the
contract but not in the code. Nothing here has been softened or re-worded.

### Design system

- **`font-heading` is an inert class.** It is applied to `DialogTitle` (`dialog.tsx:131`),
  `AlertDialogTitle` (`alert-dialog.tsx:110`), `SheetTitle` (`sheet.tsx:150`), and `EmptyTitle`
  (`empty.tsx:81`), but `--font-heading` is defined nowhere in the repo (I grepped all of `apps/` and
  `packages/`). Under Tailwind v4's CSS-first theming the utility is never generated, so those titles
  render in `--font-sans`. Almost certainly a leftover from the `base-mira` shadcn registry.
- **Two theme roles are written but never consumed.** `textMuted` → `--app-theme-text-muted` and
  `accentForeground` → `--app-theme-accent-foreground` are set on `<html>` by `applyThemePalette`, but no
  CSS or TS in `apps/` or `packages/` reads either variable. They are still meaningful *inside* the
  generators (as inputs to derived roles) and are editable in the theme editor, but changing them in a
  theme file has no visible effect. The other 55 roles all have a consumer.
- **The boot script and `themePalette.ts` duplicate the built-in palettes** with only a comment ("Keep
  this small boot-time copy in sync") enforcing agreement. I found no test or codegen step that verifies
  the two copies match; `apps/web/src/themeBoot.test.ts` exists but I did not read it, so I cannot say
  whether it covers this.
- **I did not read** `ThemeSettings.tsx` past ~line 330, `ThemeEditorPanel.tsx` past ~line 520,
  `ThemeImportDialog.tsx`, `ThemeSearchSection.tsx`, most of `sidebar.tsx` (1041 lines), or `toast.tsx`
  (811 lines) in full. Statements about those files are limited to what I read.
- **`experiments/` and `apps/marketing/`** may carry their own styling; I did not look at either.
- **I did not verify at runtime** that the `shape()` composer outline, the WCO variables, or the
  `sidebar-stage-backdrop` mask render as described — those claims are read off the CSS only.
- **The `oxlint-plugin-t3code` plugin has no design-system rules** (its four rules are about node
  imports, Effect runtime, and Schema compilation), so nothing lints token usage or forbids raw hex in
  components — and raw hex does appear in components (`ThemeWireframe.tsx:103`, `index.css:2240-2248`).

### Usage and limits

- **`UsageSource.malformedRecords` is dead**: declared in the contract, always hardcoded to `0`
  server-side. Lines that fail to parse are silently dropped by the parsers with no counter incremented
  anywhere.
- **`UsageSourceStatus` "partial" and "failed" are unreachable**: the contract defines four statuses; the
  server only ever produces `"ok"` (directory exists, walked successfully) or `"missing"` (directory
  doesn't exist). There is no code path — e.g. a directory that exists but a walk partially fails, or a
  directory read that outright errors — that produces `"partial"` or `"failed"`. Directory walk errors are
  caught at the individual `readdir`/`stat` call level inside `listTranscriptFiles` and simply skipped,
  not surfaced as a source-level status.
- **No auth/API key on the pricing fetch**: the LiteLLM rates file is fetched unauthenticated from a
  public GitHub raw URL; there's no fallback mirror if that specific URL or repo path changes upstream — a
  broken/moved URL degrades every environment's cost figures to `"unavailable"`/stale-cached rather than
  failing loudly, but there's no retry/backoff strategy beyond "try again next scan or in 24h."
- **Only Claude and Codex are covered**, despite the product supporting five provider drivers (Codex,
  Claude, Cursor, Grok, OpenCode). Cursor/Grok/OpenCode activity — whether or not those CLIs even keep
  comparable local session logs — is entirely absent from the Usage page.
- **`costUsd` is explicitly not "money spent"**: it's the raw API-equivalent cost of the observed tokens
  at base-tier rates; the contract comment and the UI's `*` footnote ("if billed at full API rate") both
  flag that subscription-plan billing is untracked and separate — this is a documented scope limit, not a
  bug, but a re-implementer should not conflate the two.
- **Tiered/priority/batch pricing is deliberately ignored** — base-tier rate only, because transcripts
  don't record which tier served a given request.
- No mechanism was found for *invalidating* a stale in-memory rate table faster than the 24h TTL if
  LiteLLM ships an urgent price correction — refresh always waits for TTL expiry or a full server restart.

### Orchestration and provider runtime

- **No server-initiated reconnect/backoff for a crashed provider process** was found in the files read.
  It's possible this exists in code paths not reached (e.g. `providerMaintenanceRunner.ts`,
  `ProviderInstanceRegistry` reconciliation on settings change) — worth a targeted follow-up read of
  `apps/server/src/provider/Services/ProviderInstanceRegistry.ts` before concluding it's genuinely absent.
  Session recovery on crash currently reads as "next turn attempt resumes from the persisted cursor,"
  which is a reasonable design but is user-triggered, not automatic.
- **`processDomainEvent` in `ProviderRuntimeIngestion.ts` (line 2023) is a documented no-op** for
  `thread.turn-start-requested` domain events routed through the ingestion worker — the plumbing (a second
  subscription, `RuntimeIngestionInput` union with a `"domain"` variant) exists but does nothing yet. Read
  as intentionally reserved, not broken, but it is dead weight today.
- **`effect-acp` and `effect-codex-app-server` internals** (the actual JSON-RPC/ACP framing,
  `_generated/schema.gen.ts` code-gen source, retry behavior of the RPC client itself) were only skimmed at
  the call-site level (spawn + client construction), not read line-by-line. The exact wire protocol
  (message framing, request/response correlation, timeout handling) is unverified beyond "child process,
  stdio, JSON messages."
- **Auth/authorization flow** (`EnvironmentAuth.authenticateWebSocketUpgrade`, scope model) was only
  touched at the routing-table level (`RPC_REQUIRED_SCOPES`) — not traced end-to-end (pairing, session
  tokens, how a desktop vs. mobile vs. web client obtains its scope).
- **CheckpointReactor internals** (baseline-vs-completed capture sequencing, revert-both-workspace-and-
  provider-conversation coordination) were read only from the header/imports and the docs description, not
  the full implementation — the mechanism is real (confirmed via `checkpointRefForThreadTurn`,
  `parseTurnDiffFilesFromUnifiedDiff`, the projector's placeholder guard) but its internal state machine
  was not traced turn-by-turn.
- **GrokAdapter/CursorAdapter/OpenCodeAdapter** were confirmed only at the "which transport" level (ACP vs.
  HTTP), not read for their full event-mapping logic the way `CodexAdapter.ts`/`ClaudeAdapter.ts` partially
  were.

### Connections and environment auth

- **Relay Worker internals** (`infra/relay/src/http/Api.ts` and everything else under `infra/relay/`) were
  only read about, not read — the relay's own DPoP token issuance, environment linking/challenge flow, and
  Cloudflare tunnel provisioning API were not traced from the server side.
  `verifyRelayClientBearerToken`'s dual Clerk-template/OAuth verification path is documented in
  `docs/internals/t3-connect.md` but not inspected in code.
- **DPoP replay-marker cleanup**: `verifyRequestDpopProof` writes one file per consumed proof to
  `ServerSecretStore` (effectively the secrets directory) forever; no eviction path was found in this pass.
  Given a 5-minute proof validity window this is a file-per-proof accumulation that appears unbounded —
  flagged as a real gap, not confirmed as intentional or already handled elsewhere.
- **Client-side persistence formats** (`Persistence.ConnectionTargetStore`, `ConnectionRegistrationStore`,
  `ConnectionProfileStore`, `ConnectionCredentialStore`, `EnvironmentCacheStore`) are referenced throughout
  `registry.ts`/`onboarding.ts` as `Context.Service` interfaces but their concrete web (IndexedDB?) and
  mobile (Expo SecureStore?) implementations were not opened — only their contracts were seen.
- **`ConnectionsSettings.tsx`** (the actual settings UI, referenced heavily by `docs/internals/remote.md`
  for `selectPairingEndpoint`'s five-step endpoint-choice algorithm) was read about via the doc, not opened
  directly — its exact React state handling is unverified first-hand.
- **Mobile-specific onboarding/pairing UI** was not located/read in this pass; only the shared
  `client-runtime` layer (used identically by web and mobile per the doc) was traced.
- **`EnvironmentAuthAdmin.test.ts`** exists alongside `EnvironmentAuthPolicy.test.ts` but no corresponding
  `EnvironmentAuthAdmin.ts` source file was found in the initial file listing — worth a follow-up grep if
  the admin-auth surface matters; may be dead test scaffolding or a file this pass missed under a different
  name.
- Desktop's `apps/desktop/src/backend/tailscaleEndpointProvider.ts` and
  `apps/desktop/src/ssh/DesktopSshEnvironment.ts` (the desktop-main-process side that calls into
  `packages/ssh`) are cited by `docs/internals/remote.md` but were not opened directly — only their
  documented contract (`discoverHosts`/`ensureEnvironment`/`disconnectEnvironment`) is captured here, not
  the implementation.

### Composer

- I did not read the whole 3,767-line `composerDraftStore.ts`. Specifically, the v1→v8 migration bodies
  (`migratePersistedComposerDraftStoreState`, `normalizePersistedDraftThreads`,
  `normalizePersistedDraftsByThreadId`, lines ~1482-1865) and the sticky-model actions (`applyStickyState`,
  `setProviderModelOptions`, ~2600-2800) were read only by signature and surrounding comments. The claim
  that sticky selections carry across threads is from those signatures plus
  `setStickyComposerModelSelection` in `ChatView`, not a line-by-line read of the reducer.
- `BranchToolbarBranchSelector.tsx` and `BranchToolbarEnvModeSelector.tsx` were not opened; their behaviour
  above is inferred from `BranchToolbar.tsx`'s props and `BranchToolbar.logic.ts`. The base-branch list's
  own data source (git RPC) is outside what I traced.
- `ComposerStashMenu`, `ComposerPendingApprovalPanel`, `ComposerPendingUserInputPanel`,
  `ComposerPlanFollowUpBanner`, `ComposerPendingElementContexts`, `ComposerPreviewAnnotationCards`,
  `ComposerPendingReviewComments`, and `ModelListRow` were not read; they are named here as slots only.
- `@t3tools/shared/model` (`getProviderOptionDescriptors`, `resolveSelectableModel`,
  `applyClaudePromptEffortPrefix`, `isClaudeUltrathinkPrompt`) and `@t3tools/shared/searchRanking`
  (`scoreQueryMatch` internals) were used from their call sites; I did not open their implementations, so
  the exact fuzzy-match algorithm and the exact set of capability→descriptor mappings are unverified.
- The web `composer-logic.ts` duplicates `packages/shared/src/composerTrigger.ts` with a behavioural
  difference (the shared one emits a `"slash-model"` trigger kind that the web composer never produces). I
  could not determine from the code whether that is intentional divergence for mobile or drift; nothing
  marks either as deprecated.
- Element-context capture, preview annotations, and review comments arrive in the composer fully formed
  from other surfaces (preview browser, diff review). I traced only their storage and their removal
  buttons, not how they are produced.
- `getSendContext().selectedModelOptionsForDispatch` is typed `unknown` on the handle
  (`ChatComposer.tsx:481`) and is re-narrowed at the call site; that is a real type hole in the interface,
  not something I mis-read.

### Thread timeline and markdown rendering

- **`getItemType` recycling semantics.** I read how T3 supplies `getItemType`/`keyExtractor` but did not
  read LegendList's internals (it's a node_modules dependency, and the vendored patch only touches the
  keyboard/mobile surface). Claims about *how* recycling and `maintainVisibleContentPosition` behave are
  inferred from the props T3 passes and the comments around them, not from the library source.
- **`ProviderRuntimeIngestion.ts` is ~1900 lines and I read roughly a third of it.** I traced the
  assistant-text buffering path, the activity emission switch for tool/task/context events, and the
  turn/session lifecycle around flush points. I did **not** exhaustively enumerate every
  `ProviderRuntimeEvent` → activity mapping, nor the per-driver differences (Codex vs Claude vs Cursor vs
  Grok vs OpenCode) that produce `agentId` / `timelineBypass` / `spawnTurnId`.
- **`ChatView.tsx` is 6623 lines** and is the container, not the area proper. I read the timeline
  derivation, scroll state machine, and the `MessagesTimeline` call site. The composer, panels, approvals
  UI, checkpoint/revert flows, and PR surfaces in that file are out of scope here and unread.
- **`AgentPanelModel` / `foldSubagentActivities`** (`packages/client-runtime/src/state/subagentRuntime.ts`)
  is consumed by `AgentSpawnCtaRow` but belongs to the Agents area; I read only its exported shape as used
  by the CTA row (`workflows`, `directAgents`, `phases`, `usage`), not its derivation.
- **`turn.plan.updated` producers.** I traced how the client consumes plan activities and how
  `ThreadPlanProgressService` records them, but not which provider events produce them per driver.
- **Mobile timeline internals unread.** I confirmed the files exist (`ThreadFeed.tsx`,
  `thread-work-log.tsx`, `lib/threadActivity.ts`, the native `T3MarkdownText` module) and that the server
  comments treat both clients as symmetric consumers, but I did not diff mobile's derivation against web's,
  so I can't say how far they have drifted.
- **`@pierre/diffs` `getSharedHighlighter`** is a third-party package. The theme names it is handed are
  `DIFF_THEME_NAMES = { light: "pierre-light", dark: "pierre-dark" }`
  (`apps/web/src/lib/diffRendering.ts:4-7`), but those grammars/themes live inside the package and I did
  not open them, so I can't state the actual token colors Shiki emits — the app only overrides the surface
  (`.chat-markdown .chat-markdown-shiki .shiki { background: transparent !important }`).

### Desktop app shell

- **`apps/desktop/src/preview/Manager.ts` (3747 lines) and `PickPreload.ts` (1270 lines) were only
  sampled**, not read end to end. I traced the webview registration path, the security posture, and the IPC
  surface; I did **not** verify the element-picker annotation pipeline, picture-in-picture, screencast frame
  encoding, or the Playwright automation bridge in detail.
- **`apps/web/src/components/Sidebar.tsx` (3779 lines) was read selectively** — header/search chrome, row
  components, and the drag-and-drop imports. Its thread-grouping, snooze, and jump-hint logic
  (`Sidebar.logic.ts`, `Sidebar.snooze.ts`, `sidebarProjectGrouping.ts`) is summarized only from names and
  signatures.
- **`DesktopBackendPool.ts`, `DesktopWslBackend.ts`, `DesktopServerExposure.ts`,
  `tailscaleEndpointProvider.ts`, and `DesktopSshEnvironment.ts` were not read in depth.** I know their
  interfaces from `main.ts`, `DesktopApp.ts`, and the IPC method modules; the WSL distro-resolution and
  Tailscale serve mechanics are outside what I verified.
- I did **not** confirm the `electron-builder` packaging config (targets, signing, `app-update.yml`
  generation). `scripts/build-desktop-artifact.ts` and `apps/desktop/resources/` exist but were not opened.
- `ElectronPowerMonitor.ts`, `ElectronSafeStorage.ts`, `linuxSecretStorage.ts`, and
  `DesktopObservability.ts`/`DesktopTelemetryPublisher.ts` are named accurately here but their internals
  were not traced.
- The **`LegacySidebar.tsx`** path is live (`useLegacySidebarEnabled()`), and `index.css` carries
  compatibility overrides for "both sidebar implementations". I did not determine which is the default or
  how the setting is surfaced — this is an in-flight migration.
- The right-panel store comment references a **removed "plan" surface kind (v9)** and version-11
  migrations; I did not read the migration functions themselves.
- `@pierre/diffs` and `@pierre/trees` are third-party (Pierre) packages consumed as black boxes; I recorded
  T3's adapter CSS and props but not the libraries' own rendering model.

### Agent awareness (push and Live Activities)

- `packages/shared/src/relayClient.ts` (~476 lines) was located and named in the brief but not read in
  full; its relationship to `managedRelay.ts` (does it wrap it, predate it, or serve a different non-DPoP
  caller?) is unconfirmed.
- `packages/client-runtime/src/relay/discovery.ts` was located but not traced — it appears to belong to the
  broader T3-Connect environment-discovery/connection flow rather than push/Live-Activity specifically, but
  that boundary was not verified by reading the file.
- The **desktop/web-triggered "link to cloud" UI flow** that actually calls `client.linkEnvironment` (which
  screen, which button, `apps/web` or `apps/desktop` component) was not traced — only its server-side and
  relay-side handlers were. Confirmed to exist (`RelayLinkProofRequest` in contracts,
  `EnvironmentLinker.link` in the relay) but the human-facing pairing UX (QR code? paste a code? one-click
  from a signed-in web session?) is unconfirmed.
- `EnvironmentCredentials.ts`, `ManagedEndpointProvider.ts`, `ManagedEndpointAllocations.ts`,
  `ManagedTunnelLimits.ts`, and `EnvironmentConnector.ts` are all part of the same `infra/relay` deployment
  and share its auth/DB layer, but they implement the **managed-tunnel / T3-Connect direct-connection**
  feature, not agent-awareness push — read only enough to understand they're a separate concern living in
  the same Worker, not traced in depth.
- Android is entirely absent from this area (schema hardcodes `platform: "ios"`); whether that's a
  deliberate current scope limit or a known gap was not stated anywhere in the code and wasn't investigated
  further.
- `apps/mobile/src/persistence/imperative.ts` / `mobile-storage.ts` / `mobile-preferences.ts` (where the
  device ID, registration record, and preferences actually persist on-device) were referenced but not
  opened — their storage format (AsyncStorage? SecureStore? file?) is unconfirmed.
- The relay's Postgres connection (`db.ts`, `dbConfig.ts`) and the `RelayTransactions` wrapper were
  referenced (used to wrap `unlinkEnvironmentRecord` in a transaction) but not read — whether
  `AgentActivityPublisher.publish()`'s row-upsert + fan-out delivery is itself transactional, or whether a
  crash between the DB write and the queue-enqueue can leave them inconsistent, was not verified.

### Environments and connectivity

- **`infra/relay/src/persistence/schema.ts`** (the actual Drizzle table definitions) was not read — I only
  inferred table shapes from the service layer's field usage (`EnvironmentLinks`,
  `ManagedEndpointAllocations`, `DpopProofs`, `AgentActivityRows`, `Devices`, `LiveActivities`,
  `ApnsDeliveries`/`ApnsDeliveryQueue`).
- **`apps/server/src/persistence/AuthSessions.ts` / `AuthPairingLinks.ts`** (the SQLite-backed
  session/pairing-link stores behind `SessionStore.ts`/`PairingGrantStore.ts`) were not opened; I only
  confirmed they exist and are used, and that migration `031_AuthAuthorizationScopes` was a hard cutover per
  the docs.
- **`apps/server/src/cli/connect.ts`** (the actual `t3 connect login/link/unlink/logout` CLI command
  implementations, and the loopback-vs-out-of-band OAuth PKCE flow) was not read; I only summarized it from
  `docs/internals/t3-connect.md`.
- **APNs delivery internals** (`ApnsClient.ts`, `ApnsDeliveryQueue.ts`, `apnsDeliveryJobs.ts`,
  `apnsJwt.ts`, `ApnsProviderTokens.ts`) were not read beyond file names and the one caller I did trace
  (`AgentActivityPublisher`); I cannot describe APNs retry/backoff or JWT provider-token rotation specifics.
- **`packages/shared/src/remote.ts`** (`resolveRemotePairingTarget`, referenced constantly) and
  **`packages/shared/src/connectAuth.ts`** (`buildConnectAuthorizeRequestUrl`, `connectCallbackUrl`) were not
  opened directly — described only via their call sites and the docs.
- **`apps/web/src/hostedPairing.ts`** and the hosted-web-app pairing URL consumption code path were not
  read; hosted pairing is described only from `docs/internals/remote.md` / `docs/user/remote-access.md` plus
  the shared `catalog.ts`/`onboarding.ts` machinery it must call into.
- **`apps/desktop/src/backend/DesktopSshPasswordPrompts.ts`** (the actual UI-side password prompt
  implementation) was referenced (`DesktopSshEnvironment.ts` imports it) but not opened.
- I did not verify the **mobile push registration → device-token lifecycle** end-to-end (what happens on app
  uninstall/token rotation) — only that `unregisterDevice` exists as an RPC.
- `apps/server/src/server.ts`'s exact startup sequencing (Tailscale serve, relay reconciliation,
  boot-service coordination) was not read as a whole file — only the specific calls
  (`ensureTailscaleServe`/`disableTailscaleServe`) cited from the docs and grep.

### Git, worktrees and checkpointing

- **Checkpoint ref garbage collection**: found no code that deletes `refs/t3/checkpoints/...` refs when a
  thread is deleted/archived or its worktree removed — only `handleRevertRequested` deletes refs, and only
  the ones *after* the revert target. Over a long-lived repo this looks like it accumulates hidden refs
  indefinitely unless something outside this area's files (a reaper, a `git gc`/prune policy) handles it;
  not found in the files read. `ProviderSessionReaper.test.ts` exists but wasn't opened — possibly relevant,
  not confirmed.
- **`SourceControlProviderDiscovery.ts` / `refineUnknownRemoteProvider`** (self-hosted GitHub/GitLab
  Enterprise detection) was not read in depth — noted as existing, mechanism not verified.
- **`BackgroundPolicy.shouldRunScopeWork`**, which gates the remote-status poller, was not opened — its
  exact "when is a thread background/inactive" rule is unverified.
- **How `GIT_TRACE2_EVENT` hook progress (`createTrace2Monitor`) is consumed downstream** (i.e. what UI, if
  any, shows "running pre-commit hook…" from `onHookStarted`/`onHookFinished`) was not traced past
  `GitCommitProgress`'s definition.
- **Cross-process / multi-server safety** for concurrent checkpoint ref writes: not addressed anywhere
  found.
- The **decider's SQL-transaction guarantee** (event persistence + projection in one transaction, per the
  recon overview) was taken as given from the task brief, not independently re-verified against
  `orchestration/Layers/OrchestrationEngine.ts` in this pass.

### MCP and preview automation

- `apps/desktop/src/preview/Manager.ts` is ~3700 lines; I read the click/type/snapshot/control-session/
  listener-attachment machinery closely (roughly the first 3200 lines) but did **not** fully trace
  picture-in-picture, the element picker (`START_PICK_CHANNEL`/`ELEMENT_PICKED_CHANNEL`), or the annotation
  capture pipeline in this file — those are human-driven preview features adjacent to, but not part of, the
  MCP automation path. I also did not read `resize`'s and `waitFor`'s full CDP implementations line-by-line
  (I inferred their shape from the surrounding pattern and the contract schemas); a re-implementer should
  re-verify those two bodies directly.
- I did not trace `apps/server/src/preview/Manager.ts` (the plain, non-automation preview subsystem that
  owns tab metadata / `previewOpen`/`previewResize`/etc.) in depth — I only followed the calls the
  automation host makes into it (`previewEnvironment.open`, `.resize`) to keep human-visible tab state in
  sync. Its full event-fan-out model (`subscribePreviewEvents`) is out of scope here.
- I did not verify how `effect/unstable/ai`'s `McpServer`/`Toolkit`/`Tool` machinery actually serializes
  `Tool.make` schemas into the MCP `tools/list` JSON-RPC response, or how it handles MCP session/protocol-
  level concerns (initialize handshake, capabilities negotiation at the *MCP* protocol level as opposed to
  T3's own `McpInvocationScope.capabilities`) — that's inside the `effect` package itself, not this repo.
- `browserRecording.ts` (627 lines) was only skimmed for its error taxonomy and overall shape (CDP
  screencast → canvas → `MediaRecorder` → save IPC); the exact encoding/codec choices and frame-pacing logic
  were not verified line-by-line.
- I did not check whether `mobile` (Expo/React Native) has any code path that even attempts to reference
  `previewAutomationConnect`/`PreviewAutomationHost` — a quick grep across `apps/mobile/src` found nothing,
  consistent with the preview surface being Electron-only, but I did not exhaustively rule out an indirect
  reference.
- The exact mechanism by which `effect/unstable/ai`'s toolkit-based `CallToolResult` differs from a
  hand-built one (i.e., *why* the snapshot tool specifically can't return an image block through the generic
  path) is inferred from the code structure, not confirmed by reading the `effect` library source.

### Settings, health and distribution

- `apps/web/src/hooks/useSettings.ts` (the client mutation hook backing every `updateSettings(...)` call)
  was not opened directly — its behavior is inferred from call sites, not verified against its own source
  (e.g. whether it debounces, batches, or fires one RPC per keystroke for text fields is unconfirmed).
- `apps/server/src/serverSettings.ts` (the server-side settings store/persistence format) was not read;
  only its streaming/redaction interface was observed from `ws.ts`. Whether it's one JSON file,
  SQLite-backed, or something else is unconfirmed.
- `apps/web/src/components/settings/DiagnosticsSettings.tsx` (1393 lines) and
  `ResourceTelemetryDiagnostics.tsx`/`.logic.ts` were not read in depth — only their RPC surface was
  confirmed via `rpc.ts`. The actual dashboard UX (charts, thresholds shown to the user) is undocumented
  here. `apps/server/src/resourceTelemetry/ResourceTelemetry.ts` (the service that spawns and streams from
  the Rust binary, does history bucketing) was not opened — only its binary-resolution and consumer layers
  were read.
- `scripts/lib/update-manifest.ts` (the actual YAML manifest merge algorithm used by
  `merge-update-manifests.ts`) was not opened — only the thin CLI wrapper that calls it was read, so the
  precise merge semantics (how file entries from two arch-specific manifests combine, checksum handling) are
  unverified.
- `apps/desktop/src/updates/DesktopUpdates.ts` lines ~630-852 (roughly the last third: `setChannel`,
  `configure`, and the electron-updater event-listener wiring for `update-available`/`download-progress`/
  `update-downloaded`/`error`) were not read — the state-machine calls and IPC channel names were confirmed
  from what was read, but the exact listener registration code was not inspected.
- The provider **CLI probing** itself (how `checkCodexProviderStatus` etc. actually determines "installed",
  "version", "auth state") was traced only one level deep (`CodexDriver.ts` wiring);
  `Layers/CodexProvider.ts`'s `checkCodexProviderStatus` implementation was not opened, nor were the other
  four drivers (Claude/Cursor/Grok/OpenCode) — the maintenance-capability wiring pattern was confirmed to
  repeat across all five via grep, but each driver's actual health-probe mechanics (spawn `--version`? read
  a lockfile? hit a local daemon?) were not individually verified.
- `deploy_web` job body in `release.yml` and `apps/web/vercel.ts` router rules were described from
  `docs/operations/release.md` narrative, not independently confirmed by reading the workflow YAML for that
  job or the `vercel.ts` file.

### Subagent fleet and the Agents panel

- **The v2 path does not exist.** `deriveAgentPanelModel`'s `v2Projection` parameter is exercised only in
  one unit test. Every production call site omits it. Searching the whole repo for an orchestration-v2
  subagent projection turns up only comments and the `#4779` field-name references in
  `packages/contracts/src/providerRuntime.ts:472`. The file's header says it is slated for deletion; nothing
  has landed to delete it for.
- **Three exported timeline predicates are dead in production.** `isSubagentActivityKind`,
  `isAgentAttributedToolActivity`, `isTimelineBypassActivity` (`subagentRuntime.ts:882-910`) are referenced
  only by their own test file; `session-logic.ts` re-implements the same checks inline and imports only
  `isBackgroundTaskActivity`.
- **`workflowCardMembers` (`:861`) has no production caller** either — only the test. Its doc-comment
  describes "the capped inline workflow card", a surface I could not find in the current tree; the timeline
  now renders a plain CTA row instead. Likewise `ChatView.tsx:2195` claims the model is shared by "the
  Agents surface, live strip, and workflow cards" — I found the Agents surface, the CTA rows, the toggle
  badges, and the composer banner, but no live strip or workflow card component.
- **`getWorkflowScript` ignores `threadId`.** No ownership check exists.
- **Codex v2 registration is explicitly probe-gated WIP** (`CodexSessionRuntime.ts:613`): "the spec's
  'provisionally treat unknown foreign thread ids as v2 children' rule needs a live wire capture of the
  packaged binary before it lands". A child whose first notification precedes registration passes through as
  ordinary parent traffic.
- **Mobile has no Agents surface at all.** `apps/mobile/src/lib/threadActivity.ts:302-313` keeps terminal
  bypassed rows visible precisely because "a NESTED AGENT's terminal row is the only signal mobile gets (no
  Agents sheet)". The fleet view is web/desktop only.
- **The `ThreadBackgroundLiveness` registry is unpersisted and unreplayed**, so after a server restart the
  sidebar pill and the reaper's guard are both blind until new task events arrive. This is intentional
  (documented at the top of the file), but it means a fleet running inside a surviving provider process is
  invisible to the pill after a server bounce.
- I traced the fold, the panel, the CTA, ingestion, both provider adapters, the liveness registry, the
  reaper, and the script query. I did **not** trace the Cursor / Grok / OpenCode adapters for subagent
  support — a grep for `task.started` emission suggests only Claude and Codex synthesize agent lifecycle,
  but I did not confirm that exhaustively.

### Terminals and the Ghostty stack

- I did not read `Manager.test.ts` (1766 lines), `surface.test.ts`, `renderer.test.ts`, or
  `ThreadTerminalDrawer.test.ts`; behavior claims here come from source and comments, not from tests.
- I read `apps/mobile/modules/t3-terminal/ios/T3TerminalView.swift` only via a symbol-level grep, not line
  by line — the iOS gesture/keyboard details (`GhosttyKeyCommands`, pan/scroll math, hardware keyboard
  sequences) are summarized from function names and the module README.
- `TerminalCanvasView.kt` (628 lines) was skimmed for metrics, typefaces, and selection handles; its gesture
  detector, selection-handle drawing, and scroll physics are not fully traced.
- `apps/mobile/src/features/terminal/ThreadTerminalRouteScreen.tsx` and `ThreadTerminalPanel.tsx` were only
  grepped; the mobile screen's attach/resize lifecycle is not traced end to end.
- The `subscribeTerminalEvents` stream is wired all the way through
  (`packages/client-runtime/src/state/terminal.ts:47` exposes `events`), but I found **no web consumer** of
  `terminalEnvironment.events` — the web UI reads `attach` + `metadata` only. Either a mobile/desktop
  consumer exists that I did not find, or it is currently unused surface area.
- The six `--terminal-scrollbar*` CSS tokens are themeable and generated but have no consumer I could find —
  stated as an observation, not a claim that they are dead everywhere.
- `TerminalRestartInput` / `terminal.restart` is fully implemented server-side and exposed as an atom
  command, but I found no web UI that calls it; the drawer's "restart" path is really close + reopen. I did
  not exhaustively search mobile/desktop for a caller.
- `packages/contracts/src/ipc.ts` declares an Electron `EnvironmentApi.terminal` bridge; I confirmed the web
  drawer does not use it but did not trace whether the Electron preload actually implements it.
- I did not verify the `patches/` directory at the repo root for any node-pty patches.

### Workspace files, search and editor

- **`kind: "directory"` search appears to have no caller.** `WorkspaceSearchIndex.search` implements a
  `directorySearch` branch and the contract exposes `kind`, but the only client uses are `kind: "file"`
  (picker, favicon picker) and `kind` omitted (composer). I found no web, mobile, or desktop call site
  passing `"directory"`. The directory autocomplete for adding a project uses `filesystem.browse` instead.
- **fff internals are opaque.** Ranking (frecency weighting, typo tolerance), ignore-rule handling,
  `aiMode`, `enableFsRootScanning`, `enableHomeDirScanning`, `disableMmapCache`, and the grep engine's regex
  dialect are all inside the native package; I inferred behaviour only from the repo's integration tests. The
  `(?i)` inline-flag choice implies a Rust-`regex`-style engine but I could not confirm it from source in
  this tree.
- **`FileSaveCoordinator` is not conflict-aware against the server.** There is no revision, mtime, or ETag
  in `ProjectWriteFileInput`; concurrent external edits are overwritten. The revision counter only coalesces
  the client's own in-flight saves.
- **No file create / rename / delete / move.** The workspace RPC surface is read + write-content only. The
  tree explicitly disables drops (`canDrop: () => false`) and its context menu offers only "Copy mention" /
  "Add to chat".
- **Mobile is read-only.** `apps/mobile/src/features/files/*` uses `listEntries` + `readFile` and filters the
  tree client-side; no `writeFile`, no `searchContents`. The content-search atom is explicitly web-only.
- **No watcher.** Index freshness comes from explicit `refresh()` calls (write, turn checkpoint, revert) and
  the manual tree refresh button; there is no filesystem watch in this area.
- **The 25 000-entry cap is a silent truncation for the tree.** `truncated: true` crosses the wire but I
  found no UI in `FileBrowserPanel` that surfaces it — the tree just shows fewer files. (The content-search
  dialog *does* surface truncation, as a `+` on the result count.)
- I did not trace the `@pierre/trees` internals (virtualization, its own search ranking) or `@pierre/diffs`'
  `Virtualizer`/`VirtualizedFile` internals beyond the public options used here; both are distributed as
  built bundles.
