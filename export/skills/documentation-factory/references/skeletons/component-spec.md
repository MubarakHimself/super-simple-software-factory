---
id: COMP-EXAMPLE
title: Example Component
type: component-spec
status: draft
component: COMP-EXAMPLE
depends_on: []
decisions: []
sources: [<SRC/EXT/DEC ids or file paths this spec was generated from>]
generated: YYYY-MM-DD
verified: YYYY-MM-DD
stale_after: 90d
---

# <Component Name>

<One paragraph: what this component is and the single job it does. First sentence carries the point.>

## Authority boundary

May: <exhaustive list of what this component is allowed to do.>
May never: <exhaustive list of hard prohibitions, each citing its DEC.>

## Interfaces

| Interface | Direction | Contract | Peer |
|---|---|---|---|
| <name> | in/out | CT-NN (docs/contracts/...) | COMP-... |

## Behavior

<Normative description, present tense. Every non-obvious rule cites a DEC. State machines get a stateDiagram-v2 Mermaid block matching the contract enum exactly.>

```mermaid
flowchart TB
    %% Level-3 component diagram, or replace this block with:
    %% <!-- no-diagram: simple component, no internal structure -->
```

## Configuration

| Variable | Registry key | Notes |
|---|---|---|
| <name> | `registry:<name>` | <when/why it would change> |

## Failure modes

| # | Condition | Behavior | Cites |
|---|---|---|---|
| FM-1 | <dependency down / input malformed / state stale> | <exact behavior> | DEC-NNNN |

## Related

Decisions: <ADR links>. Scenarios: <SCN links>. Knowledge: <case-law links, if any>.
