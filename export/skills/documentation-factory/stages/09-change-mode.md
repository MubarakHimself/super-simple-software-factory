# Stage 9 — Change Mode (Maintainability)

Use when a knowledge base built by this skill already exists and something is changing: a new feature, a component upgrade, a design reversal, a bug whose fix alters documented behavior. The docs are built for editing; this is the editing protocol. The goal is that documentation *never lags the system* — a doc that's wrong is worse than no doc, because agents trust it.

## Protocol

1. **Scope the change.** One sentence: what is changing and why. Identify the primary component(s).

2. **Compute the blast radius:**
   ```bash
   python <skill>/scripts/blast_radius.py --root <project-root> COMP-<NAME>
   ```
   Output: every component transitively depending on the changed one, and every doc whose frontmatter declares a dependency. Read those docs *before* planning — this is the "one small change means re-checking the whole surface" discipline, mechanized.

3. **Architecture preflight — prove reuse-or-new.** Before anything gets built or specced, read the knowledge base and the component inventory (`docs/architecture/dependencies.yaml`, plus the specs of the components the blast radius listed) and answer in writing:
   - Which existing components could carry this change? Name them by ID — the inventory is a file, so it is either cited or it was not read.
   - For each, why it cannot (authority boundary, contract mismatch, a ratified DEC forbidding it) — or, if one can, **stop: this is a reuse change**, not a new component.
   - If new is genuinely required: what it owns that nothing else does, what it may never do, and which existing component's authority shrinks as a result.
   - Does any `status: dead` entry already cover this idea? A dead entry with a reason ends the discussion; re-proposing it is a defect, not a design.

   Record the verdict — `reuse COMP-<NAME>` or `new COMP-<NAME>`, with the reason — in the ADR at step 5. An unrecorded verdict means the preflight did not happen. Building a second component that does what an existing one already does is the failure this step exists to prevent; it is cheap here and expensive after code exists.

4. **Ledger first, docs second.** The change is a decision: add ledger entries (new DEC; supersession links to what it replaces; deaths if something is being killed — with reasons). If the change contradicts a ratified law or a dead entry's reason, stop and surface it to the operator: that's a design conflict, not a doc edit.

5. **Write the ADR.** Every change that touches the ledger gets `docs/decisions/ADR-NNNN-<slug>.md`: context, options, ruling, consequences, blast-radius summary, and the step-3 reuse-or-new verdict. Small change, small ADR — but always an ADR; the cost is minutes, the alternative is archaeology.

6. **Update the contracts layer if touched:** registry values (never edit history — supersede), `dependencies.yaml` edges, interface schemas. A new component declares its `kind` and its `layer` like every other (`references/layer-conventions.md`); a change that spans layers is two edits split on the seam, with a contract between them, never one component grown across the line. **Backfill first if the knowledge base predates the `layer` field**: a `dependencies.yaml` whose components carry no `layer:` gets every one filled in during this same edit, from the specs already written — one pass, before the re-run, so the gate reports this change rather than the age of the file. Re-run `validate_registry.py`. If the change adds, re-scopes, splits or completes a feature, update `_docwork/feature_inventory.yaml` in the same edit — new `FEAT-NNNN` entries tracing the new DEC ids, `status: shipped` on what landed, blocking edges re-drawn — and re-run `validate_inventory.py`. An inventory that still describes the pre-change plan sends the next pass at work that no longer exists.

7. **Update every doc in the blast radius.** Follow style rules; new claims cite the new DEC entries. Update frontmatter `verified` (and `sources`, where the provenance changed) on every doc you confirmed — even unchanged ones you checked, since a re-confirmed date is information. Re-set `stale_after` where the change alters how fast the doc goes stale.

8. **Changelog entry** in `docs/changelog.md`: date, ADR link, one-line summary, list of docs touched.

9. **Mini-review.** Run the consistency checklist (stage 07, pass 1) scoped to the touched docs. A fresh subagent if available.

## Gate

```bash
python <skill>/scripts/check_citations.py --root <project-root>
python <skill>/scripts/lint_docs.py --root <project-root> --strict
```

Both clean, ADR exists, changelog updated.
