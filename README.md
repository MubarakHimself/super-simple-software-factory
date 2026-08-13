# SDL Factory

A software factory: deterministic Python workflows drive coding agents through
**plan -> build -> test -> review -> document**, on the operator's own flat-rate
subscriptions (no per-token API spend), observable through a dashboard, with a
human at exactly two gates -- **ratify** the plan before code exists, and
**merge** the finished run. Nothing ships without that second click.

Built on [disler/super-simple-software-factory](https://github.com/disler/super-simple-software-factory)
(MIT, full credit below) -- the deterministic-Python-owns-the-loop core is
untouched. This repo adds worktree parallelism (one branch and one checkout
per run, never colliding), a Kanban dispatcher (the queue between planning and
the factory), an installer wizard (one command converges any host), a desktop
control surface (the dashboard, as a window instead of just a browser tab),
and an operator skill chain (document, ratify, spec, ticket, triage, publish,
brief).

---

## Install

The one prerequisite is **uv**. Everything else -- `pi`, its extensions,
`just`, Skylos where the host supports it -- is installed *by the wizard*, not
by you. The one thing the wizard does **not** install yet is **bun**, which
the dashboard needs; get it yourself from [bun.sh](https://bun.sh) if you want
`just ui` / `just app` (skip it if you only want the factory itself).

```bash
# 1. get uv (pick your OS)
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"     # Windows
curl -LsSf https://astral.sh/uv/install.sh | sh                # Linux / macOS / container

# 2. clone
git clone https://github.com/MubarakHimself/super-simple-software-factory.git sdl-factory
cd sdl-factory

# 3. run the wizard
uv run installer/install.py                 # interactive: detect, propose, converge, verify
uv run installer/install.py --dry-run       # preview the plan, changes nothing
uv run installer/install.py --target server --yes   # non-interactive, for a headless box
```

The wizard installs `pi` (`npm install -g @earendil-works/pi-coding-agent`,
which needs Node -- detected first; on Linux it installs Node for you, on
Windows it tells you the one `winget` line to run rather than putting a
runtime on your personal machine behind your back), its extensions (the
Claude bridge, subagents), `just`, and Skylos (Windows reports
`expected-unavailable` honestly -- its dependency needs MSVC; any Linux host
activates it). It writes `PI_PATH` and `PI_MODELS_PATH` into `.env` for you,
and walks you through logging in to each lane your roster needs -- see
[Configuration](#configuration). Full flag reference:
`specs/installer-wizard.md` section 2.

---

## First run

```bash
just demo        # two cheap read-only runs, end to end -- the smoke test
just app         # the dashboard as a desktop window (needs bun)
just ui          # the same dashboard at http://127.0.0.1:4700 in a browser (needs bun)
just worktrees   # every run's worktree, reconciled -- exit 1 means work is stranded
```

---

## The daily loop

The full walkthrough lives in [`docs/day-one.md`](docs/day-one.md). In
outline, it is six steps:

1. **Document** -- `/documentation-factory` (no arguments; it asks what you're
   doing and routes itself), then **ratify** the decision ledger it produces
   -- Gate 1, your first click.
2. **Inventory** -- documentation-factory emits the feature inventory: scoped,
   ordered, dependencies declared.
3. **Spec / tickets / triage** -- `/to-spec` -> `/to-tickets` -> `/triage`,
   one feature at a time from the inventory.
4. **Queue-publish** -- `/queue-publish` puts the ticket on the Board as
   `queue/NNN-slug.md`. No restart, any harness.
5. **Dispatch** -- `just work-next` (or `just work queue/NNN-slug.md`) routes
   it to the right workflow, runs it on its own branch in its own worktree,
   and writes status back to the card as it goes.
6. **Morning brief, then your merge click** -- `/morning-brief` narrates the
   run in plain words and ends with the compare link -- Gate 2, the only
   place anything ever merges.

---

## The pieces

| Path | What it is |
|---|---|
| `adws/` | The factory -- deterministic Python workflows (ADWs), the phases, gates, and trace they write to SQLite |
| `apps/ui` | The dashboard -- Board / Trace / Gate / Settings, one Bun process, read-only over the trace db |
| `installer/` | The wizard -- one command that converges a host (laptop / server / container) |
| `queue/` | The board -- `queue/*.md` agent briefs, git-tracked, the seam between planning and the factory |
| `specs/` | The specs -- installer, UI, worktrees, dispatch: what was built and why, kept in lockstep with the code |
| `MAP.md` | The single planning record -- every rule, decision, dead idea, and open question, one file |
| `docs/day-one.md` | The guide -- how to actually drive the factory, day to day |

---

## Configuration

`SSSF_CONFIG` swaps the whole agent roster for one run, no code change:

```bash
# default (what every recipe uses today): the test lane -- one model,
# ollama-cloud/kimi-k2.7-code, no Anthropic in it (MAP rule 4: never test on
# Anthropic models)
just sdlc "add a /health endpoint"

# the operator's real roster: cross-family review -- xAI (Grok 4.5) builds,
# Claude reviews; scout stays on the Kimi test lane, documenter on MiniMax
SSSF_CONFIG=adws/adw_sssf_config/sssf.shipping.config.yaml just sdlc "add a /health endpoint"
```

The shipping roster is not live yet: its builder lane (`xai`) needs a fresh
login, and the Claude bridge gets its first real round trip on the first real
ticket (never on a test -- MAP rule 4). Both readiness items are written at
the top of the file itself.

Both files live in `adws/adw_sssf_config/`. `sssf.config.yaml` is the default
path every recipe and every `adw_*.py --config` falls back to; point
`SSSF_CONFIG` (or pass `--config` directly) at `sssf.shipping.config.yaml` or
any roster file you write yourself.

`.env` holds `PI_PATH`, `PI_MODELS_PATH`, and any provider API keys your
roster needs. The wizard writes the two `PI_*` lines for you on first install
(merging into any existing `.env`, never overwriting -- MAP rule 5, park never
delete) and walks you through the lane logins; API keys, where a provider uses
one, are yours to fill in. `.env.sample` documents them.

---

## Rules the project lives by

- **KISS.** If a ticket's answer is "add a system," it is probably wrong.
- **Agent proposes, code disposes.** Deterministic code owns sequencing,
  retries, and acceptance; the agent's job is bounded to the phase it's in.
- **No mock data, ever.** Production-grade code only -- the reason Skylos
  exists at all.
- **Park, never delete.** Uninstall and replace paths move files aside; they
  never remove anything.
- **The operator's click is the only merge.** Nothing in the factory ever
  merges or pushes itself.

---

## License / credits

MIT, unchanged -- see [`LICENSE`](LICENSE).

The core of this project is [disler's Super Simple Software
Factory](https://github.com/disler/super-simple-software-factory) (IndyDevDan)
-- the ADW pattern, the phase/envelope/gate model, and the trace db are his
design, untouched here. If you want the concept explained from first
principles, his [YouTube walkthrough](https://youtu.be/haUfb1ievTE) is the
primary source.

The `/to-spec` -> `/to-tickets` -> `/triage` planning skills in the daily loop
come from Matt Pocock's public skill chain. The rest of the chain
(`/documentation-factory`, `/queue-publish`, `/morning-brief`) is this
project's own.
