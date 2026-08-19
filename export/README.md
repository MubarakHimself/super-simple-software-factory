# Export — machine migration bundle

Everything needed to move to a new machine (Linux) that the repo itself does not
already carry. Created 2026-08-19.

## What's here

| Path | What |
|---|---|
| `skills/documentation-factory/` | The supply line's front half: ingest → decision ledger → ratify (Gate 1) → feature inventory. The in-depth one. |
| `skills/to-kanban/` | The supply line's back half: batch-publishes the feature inventory as queue cards with `Needs:` edges. Replaced the spec → tickets → triage chain. |
| `skills/queue-publish/` | Publishes a single triaged brief into `queue/` (card + changed docs, one push). |
| `skills/morning-brief/` | Gate 2: plain-words narration of each run, checkbox walk against the card, compare link as the merge button. |
| `skills/ship-check/` | The pre-merge deep-dive before a chunk squash-merges from `integration` to `main`. |
| `sdl-factory-blueprint.html` | The rebuild dossier — architecture, contracts, model roster, porting map (UI and server deployment excluded). |

The `sssf` skill is NOT here because it already lives in this repo at
`.claude/skills/sssf/` and travels with the clone.

## Not here, by design

The Matt Pocock skills (wayfinder, to-spec, to-tickets, triage,
improve-codebase-architecture, grilling, teach, ...) are upstream and are
reinstalled from their own source on the new machine — nothing of his is
forked into this bundle.

## Install on the new machine

```bash
git clone https://github.com/MubarakHimself/super-simple-software-factory.git sdl-factory
cp -r sdl-factory/export/skills/* ~/.claude/skills/
```

That's the whole skill install — Claude Code reads `~/.claude/skills/` directly,
and `pi` reads the same directory. For Codex, link them into `~/.agents/skills`
as well (junction/symlink, same bytes).

Then run the factory wizard as usual: `uv run installer/install.py`.
On Linux, Skylos activates fully (the Windows `incomplete` state was the
MSVC-only landmine) and the cp1252 encoding landmines disappear.
