# Day One — driving your software factory

Written for the operator, in plain words. Everything here was built and verified on 2026-08-12/13.
The rules behind it all live in `MAP.md`; this file is just *how to drive*.

## 1. Open the dashboard

```
just app        # the desktop window (or: just ui  ->  http://127.0.0.1:4700 in a browser)
```

Four surfaces:

- **Trace** — every run, live. Click a run: phases, the work log, envelopes, gates, tokens.
- **Board** — your Kanban. Reads `queue/*.md` files; updates live whenever any file changes.
- **Gate** — runs waiting for *your* merge click. The compare link is the merge button.
- **Settings** — the roster and lanes, read-only.

Two runs from last night sit deliberately unmerged (the worktree verification runs — a clamp
helper and a titlecase helper). Run `just worktrees` to see them flagged as **HOLDS WORK**:
that flag is the whole anti-stranding system working. Merge or delete them at your leisure;
`just worktrees-prune` will refuse to touch them while they hold work — that refusal is a
feature, not a bug.

## 2. Your daily loop, end to end

Two boxes, one loop. **Plan and merge happen on the laptop**, in your own harness — Claude
Code, Codex (`$skill` form), or `pi` — all three read the same skills. **Work happens on the
server**, picked up by an always-on engine you never have to poll yourself. One vocabulary note
before the steps: `pi` is the *harness* the factory's workflows drive, never a provider itself —
the providers are the accounts underneath it (Claude Code via the bridge, Codex, Grok/xAI,
OpenCode, Ollama Cloud).

1. **Plan** (heavy model, laptop side): brainstorm however you like — `/wayfinder`, `/grilling`,
   or just talk.
2. **Document**: `/documentation-factory` with no arguments. It asks *"what are you trying to
   do?"* and routes itself — you never need to remember its modes. For your NHI platform
   (docs exist, code doesn't, docs have drifted): pick the docs-only route. It ingests
   everything **once**, builds the decision ledger, you **ratify** (Gate 1 — the one moment
   your signature matters), and it emits the **feature inventory**: "this documentation
   contains features X, Y, Z — scoped, ordered, dependencies declared."
3. **Spec → tickets → triage**, one feature at a time from the inventory: `/to-spec` →
   `/to-tickets` → `/triage`. No re-prompting — the inventory is the list.
4. **Publish, and hand off to the server**: `/queue-publish` commits the card *plus* whatever
   docs changed on the way to it, and pushes — one act, both halves of the journey travel
   together. That push is the whole handoff; there is no separate sync step and nothing to
   restart.
5. **The server picks it up on its own**: the always-on engine (`specs/engine.md`, `just
   engine`, the `sdl-engine.service` systemd unit) pulls on its ~60s cycle, scans `queue/` for
   `ready-for-agent` cards whose `Needs:` are satisfied, and dispatches — parallel across
   independent cards up to a configurable cap (default 2), strictly ordered when `Needs:`
   chains them. It isn't overnight-only; it works as long as there is work. Each run gets its
   own branch and its own worktree — the main checkout never moves. Finished `adw/` branches
   and card-status updates push back through the same GitHub hub the card arrived on.
6. **Morning review, back on the laptop**: the app / `/morning-brief` narrates each run in
   plain words — which branch and worktree, what actually changed, what the checks concluded,
   what it cost — then asks you: *"is this what we agreed?"*
7. **Merge, laptop-side**: fetch, `--ff-only` merge, move the card to `done/`, push. **The
   click is yours; nothing in the factory ever merges itself.**
8. **Docs catch up on their own**: right after the merge, a headless documentation-factory
   `change`-mode session runs automatically on the laptop and pushes the updated docs through
   the same hub. A failed doc run is shown to you; it never blocks the merge.

## 3. The commands that matter

| Command | What |
|---|---|
| `just app` / `just ui` | the dashboard (window / browser) |
| `just demo` | two cheap read-only runs, end to end — the smoke test |
| `just work <queue-file>` / `just work-next` | dispatch a Board item into the factory |
| `just sdlc "..."` / `just simple-sdlc "..."` | run a chain directly, skipping the Board |
| `just worktrees` / `just worktrees-prune` | every run's worktree, reconciled; prune merged only |
| `just sessions` / `just phases <id>` / `just tail <id>` | the trace, in the terminal |
| `just doctor` | is the toolchain alive (no tokens) |
| `uv run installer/install.py` | the wizard — deploy this factory onto any host |

## 4. What still needs *you* (nothing else does)

1. **Re-login Grok and Codex** (`codex login`; Grok via pi). Until then everything runs on the
   ollama-cloud test lane — fine for exercising, not the shipping roster.
2. **First deployment**: the intended path is **connect-server** from the desktop app — host
   and credentials once in Settings, SSH under the hood, autonomous provisioning; the app
   converges the factory on the server itself and you never see a terminal. Until the app
   ships, the interim path is running the wizard yourself on the host (Contabo VPS, or any
   host — laptop, Docker, same product).
3. **Skylos on this laptop reads "incomplete", never green** — that's honest fail-closed
   behaviour, not a bug (its dependency needs MSVC). On any Linux host it activates fully.

## 5. Where the truth lives

- `MAP.md` — every rule, decision, dead idea, and open question. One file.
- `docs/research/` — the no-mistakes study, the Codex skills research, the video notes.
- `specs/` — installer, UI, worktrees: what was built and why, kept in lockstep with the code.
- The first attempt (2026-08-11/12) is parked in git tag `park/opus5-2026-08-12` and
  `Documents\sdl-factory-parked-20260812\` — archaeology only, superseded by `MAP.md`.
