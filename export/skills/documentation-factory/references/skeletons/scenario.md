---
id: SCN-0000
title: <Behavior this scenario pins down>
type: scenario
status: draft
component: COMP-EXAMPLE
depends_on: []
decisions: [DEC-0000]
sources: [<SRC/EXT/DEC ids or file paths this scenario was built from>]
generated: YYYY-MM-DD
verified: YYYY-MM-DD
stale_after: 90d
---

# SCN-0000: <Title>

<One sentence: what behavior this proves and why it matters.>

## Given

<Concrete initial state. Real values via registry references, e.g. seed = `registry:seed_capital` (currently 500 USD).>

## When

<The triggering event, with concrete inputs.>

## Then

<The required outcome, concrete and checkable. Every assertion cites its DEC.>

## Worked numbers

<The arithmetic, step by step, so this doubles as a test fixture. If any number changes in the registry, this section must be recomputed — note which registry keys it depends on.>
