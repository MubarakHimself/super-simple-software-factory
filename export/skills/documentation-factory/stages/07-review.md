# Stage 7 — Review

Two passes, two different postures. Run them in order; they catch different failure classes. If subagents are available, each reviewer must be a *fresh* agent — never the drafter. In a single-agent runtime, adopt each role's constraints explicitly and sequentially (re-read the role brief before starting; do not carry drafting rationalizations into review).

## Pass 1 — Consistency reviewer

**Role constraints: may read `docs/`, `_docwork/ledger.yaml`, `_docwork/gaps.yaml`, the registry, and contracts. May NOT read raw sources or chunks.** The point: verify the docs against the ledger, not against your own reconstruction of the transcript.

Checklist:
- Every normative statement traces to its cited ledger entry *and says what the entry says* — citation-present-but-content-drifted is the subtle failure the scripts can't catch.
- No two docs disagree (values, names, behavior). Same concept, same name everywhere (glossary is the arbiter).
- No doc restates a registry value as a literal (must reference).
- Dead list enforced: nothing dead is described as alive; nothing dead is missing its ADR/records if instructive.
- Every `depends_on` in frontmatter exists in `dependencies.yaml`, and interfaces referenced actually appear in contracts.

Write findings to `_docwork/review-consistency.md` (finding, doc, severity, suggested fix). Fixes are applied by the drafter role, then re-reviewed.

## Pass 2 — Adversarial red team

**Role: you are a competent engineer (or coding agent) who has NEVER seen this project. You will implement or modify the system from these docs alone. Your job is to fail loudly.** May read only `docs/` — not the ledger, not sources.

Attack questions:
- Pick a component and plan a real change. Where do the docs run out? What did you have to assume?
- Follow every cross-reference you actually need — do any dead-end?
- Take a golden-scenario-worthy behavior and trace it through the docs. Can you predict the system's output? If not, what's missing?
- Where would a naive agent do damage? (Ambiguous authority boundaries, unstated invariants, missing failure modes.)
- Read the constitution alone: does it contain everything you must not violate?

Every assumption you were forced to make is a finding: either a doc fix (information existed, poorly placed) or a new GAP (information never existed). Write to `_docwork/review-redteam.md`.

## Resolution

Drafter role applies fixes; new gaps go to `gaps.yaml`; new enhancement ideas go through the ENHANCEMENT mechanism, never silently in. Repeat review of changed docs until both reports have no open blocking findings.

## Gate

Both review reports exist with all blocking findings resolved, and:

```bash
python <skill>/scripts/lint_docs.py --root <project-root>
```
