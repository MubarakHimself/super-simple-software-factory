# Stage 1 — Intake

Goal: turn a pile of sources into an inventoried, chunked, resumable workspace. Nothing is interpreted here; interpretation starts at Stage 2. Doing inventory badly is how whole topics silently vanish from documentation, so be exhaustive and mechanical.

## Steps

1. **Initialize the workspace** (if not already present):
   ```bash
   python <skill>/scripts/init_workspace.py init --project "<name>" --mode <transcripts|codebase|enhance> --root <project-root>
   ```
   This creates `_docwork/` with `manifest.yaml` and `stage_state.yaml`.

2. **Inventory every source.** List each in `manifest.yaml` under `sources:` with `id`, `path`, `kind` (transcript | code | doc | design | rider | data), and `status: pending`. Sources include:
   - Transcripts/chat exports (any format: jsonl, md, txt).
   - Design packets — mark them `kind: design` and read [Design packets](#design-packets) below before inventorying them.
   - Rider files — operator-supplied project-specific inputs (scope rulings, known dead lists, laws, glossary seeds, coding standards, naming conventions). They live in `_docwork/riders/`; mark them `kind: rider`. They are *authoritative* — their contents enter the ledger at Stage 3 pre-ratified (`authority: rider`), and where a rider contradicts a source, the rider wins and the contradiction is ledgered rather than quietly dropped. **Riders are the only channel for project specifics**: nothing project-specific is ever written into this skill. Ask for them here if the front door did not already collect them; a project with no riders is normal, a project whose rulings live in the skill is a defect.
   - In `codebase` mode: the repo tree, README-level docs, and commit history (`git log --oneline` saved to a file counts as a source).
   - In `enhance` mode: every existing doc. On the docs-only batch path (front door answer (c)), chunk them as well — a drifted doc is a transcript of a past intention, and its claims need citable chunk IDs like any other source. Ingest is once; the drafting passes that follow are many.
   - Any *baseline* material for the gap report (old docs/vault) — mark `kind: doc`, `role: baseline`.

3. **Chunk large sources:**
   ```bash
   python <skill>/scripts/chunk_transcript.py <source-file> --source-id SRC-01 --out _docwork/chunks/
   ```
   Chunks get stable IDs (`SRC-01-C0042`) so extractions can cite exact locations. Chunk *every* transcript, even short ones — citation stability matters more than convenience.

4. **Select lenses — by asking the capture questions, not by reading the room.** Read `references/lens-catalog.md`, then put these five to the operator in one message, each with the answer you would recommend and why (see [Stage 4](04-ratify.md) for the posture — a recommendation he can ratify with one word, never a questionnaire). Record the answers in `manifest.yaml` under `lenses:` (`core` is always on) and carry every "yes" into the stack doc at Stage 6:

   | Ask | A "yes" means |
   |---|---|
   | Does this project store data in a database or a schema-bearing store? | `data` lens on; the stores get named in `docs/architecture/stack.md` and their schemas in `docs/lenses/data/data-layer.md`. |
   | Does it train or fine-tune a model? | `mlops` lens on; the training questions in the lens catalog get answered, not skipped. |
   | Does it have a human interface? | `ui` lens on; a design packet, if one exists, lands here. |
   | Does it run somewhere unattended? | `ops` lens on. |
   | Does it handle money, secrets, or third-party access? | `security` lens on. |

   A "no" is an answer and gets recorded as one. What must never happen is silence: a lens nobody asked about is a topic that was never harvested, and Stage 8 is far too late to find that out.

   Stack, custom libraries and the CI/CD declaration are **not** lens-gated — every project has them, so they are drafted at Stage 6 into `docs/architecture/stack.md` whatever the answers above. Whatever the sources do not say becomes a gap here, and a gap carries a recommendation into Stage 4.

5. **Record scope.** Write `scope:` in the manifest: what is in, what is explicitly out. Out-of-scope topics still get harvested at Stage 2 (cheap insurance) but are ledgered `status: out-of-scope` and excluded from drafting.

## Design packets

A design packet is a pre-built description of an interface, handed over whole: an Open-Design-style export (real HTML/CSS pages plus a design-handoff file and a project manifest), a design-os-style export (`design-system/` tokens, `data-shapes/` types, `sections/*/components/`), or the plain shape — a `design.md` and a folder of screenshots. It arrives as **one source** of `kind: design` whose `path` is the packet root; its member files are inventoried under it, not as separate top-level sources.

Read it structurally. A design packet is a specification that happens to render, and the whole value is in its structure:

- **HTML/CSS/component files** — chunk them like any `kind: code` source. What is being harvested is the *structure*: the sections and their nesting, element roles and states, the class or token names, the strings that are real copy, the field names in a form. Not the pixels.
- **The handoff file / manifest** — chunk it first and read it as the packet's own table of contents: which screens exist, which components each composes, which tokens are canonical, which data shapes the UI expects. Where it names a data shape, that shape is a **contract**, and it will be one at Stage 5.
- **Screenshots and other binaries** — no chunking. Give each a manifest entry with no chunk index and cite it by filename (`design/handoff/screens/settlement-empty.png`). A screenshot is evidence that a state exists; the state's *definition* comes from the structured files, never from reading the image. Where only a screenshot covers a state, that is a gap, not an extraction.

The gate proves the structural reading happened: a `kind: design` source that is not `pending` must have a chunk index, exactly as a transcript must. A packet that genuinely ships nothing but images says so in its manifest entry — `no_chunks: "screenshots only; every screen's structure is GAP-00NN"` — and that reason is what makes the emptiness a decision instead of a skipped step.
- **What the packet does not decide.** A design packet describes the `ui` layer and nothing below it. Every backend, storage, or stack fact it appears to imply is a gap for the operator — see `references/layer-conventions.md` rule 3, which is where mixed inputs get split.

The packet's output home is the `ui` lens (`references/lens-catalog.md`): the tokens become `design-system.md`, the sections become `screens/`, and `design-record.md` records what the packet contained and which packet file each doc traces to. That record is what a spec or ticket downstream cites — the packet itself is an input and is never cited directly.

## Gate

```bash
python <skill>/scripts/init_workspace.py check --root <project-root>
```

Passes when the manifest is valid, every source path exists, and every transcript and design source that has been read carries a chunk index (or an explicit `no_chunks:` reason). Then set `stage_state.yaml: current_stage: 2`.
