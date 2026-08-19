# Stage 2 — Harvest

Goal: extract every decision, correction, rejection, constraint, and value from the sources into `_docwork/extractions.yaml` — with citations. Extraction is *not* interpretation: capture what the source says, quote it, cite the chunk. Synthesis happens at Stage 3.

## Why this is its own stage

Long transcripts contain decisions that were later reversed, sometimes twice. If you synthesize while reading, the reversal you haven't reached yet corrupts your synthesis. Harvest first, in source order, mechanically; reconcile later with all evidence on the table.

## What to extract

One entry per atomic finding. Types (see `references/ledger-schema.md` for the schema):

- `decision` — something was chosen ("we use X for Y").
- `correction` — a human corrected the agent/author; these outrank surrounding text and are the highest-value extractions in any transcript.
- `death` — an idea explicitly rejected or killed. Capture the *reason* verbatim; this feeds the dead list.
- `constraint` — a law, invariant, or non-negotiable ("never do X").
- `value` — a concrete number, formula, threshold, name, or schema fragment. These feed the registry.
- `open` — a question raised and never resolved.
- `context` — background needed to understand other entries (use sparingly).

Each entry: `id: EXT-0001`, `type`, `summary` (one sentence, your words), `quote` (verbatim, trimmed), `cite: SRC-01-C0042`, `topic` tags.

## Working through large source sets

- Process chunks in order, batches sized to fit comfortably in context. Update `stage_state.yaml` with the last chunk processed after each batch — this is what makes harvest resumable after any interruption.
- When subagents are available, shard by source (never split one transcript across harvesters mid-conversation — reversals need a single reader).
- Rider files: extract each ruling as its own entry, marked `authority: rider`.
- Codebase mode: harvest from code structure (module boundaries, public interfaces, config values, TODO/FIXME comments) and commit messages. A commit that says "removed X because Y" is a `death`.
- Design sources (`kind: design`, see `stages/01-intake.md`): a screen is a `decision` about what the interface does; a token, a field name, or an enum of states is a `value`; "this state is not designed" is an `open`. Quote the markup or the handoff line, not a description of the picture. A packet says nothing about the layers beneath the UI, so anything it seems to imply about a store, an endpoint, or a framework is an `open`, never a `decision`.

## Gate

```bash
python <skill>/scripts/coverage_report.py --root <project-root>
```

Review the report: it lists chunks with zero extractions. Some silence is legitimate (small talk, tangents) — annotate legitimately-empty chunks in the report file rather than forcing junk extractions. If substantive chunks are uncovered, harvest them. Then advance `stage_state.yaml`.
