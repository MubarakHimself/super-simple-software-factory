# Video 1 — "FORGET Loop Engineering. Agentic Engineering is about THIS"

| Field | Value |
|---|---|
| **Title** | FORGET Loop Engineering. Agentic Engineering is about THIS |
| **Speaker** | Dan (IndyDevDan) — surname rendered "Eisler" by auto-captions at [01:36], treat spelling as unverified |
| **Channel** | IndyDevDan |
| **URL** | https://www.youtube.com/watch?v=VQy50fuxI34 |
| **Duration** | 34:18 (2058s) |
| **Published** | 2026-07-13 |
| **Transcript source** | YouTube auto-captions (no manual subs). Auto-caption errors corrected inline below; see "Transcription artifacts" at the end. |
| **Notes captured** | 2026-08-11 |

---

## 0. Read this first — scope warning

**This video is a pure conceptual lecture delivered over animated Mermaid diagrams. There is no code, no repository walkthrough, no directory tree, no configuration file, no terminal output, and no dashboard in it.** The speaker builds one idea across 14 successive Mermaid diagrams, each an incremental refinement of the last.

Specific consequences for a builder:

- The repo you are starting from (`disler/super-simple-software-factory`) **is never mentioned or shown.** Zero implementation detail maps from this video to that repo directly.
- The vocabulary the parent brief anticipated — **phase, gate, envelope, trace, config concept** — **does not appear in this video at all.** Those are not IndyDevDan's terms here. If they exist, they come from the repo itself or from a later video. Don't go looking for them in this transcript.
- **Observability, tracing, and dashboards: essentially absent.** See §8. There is exactly one state mechanism in the entire architecture (ticket status writes) and he does not call it observability.
- **Cloud / remote / headless execution: named but not explained.** "Agent sandbox" is asserted as the future and used in every diagram, but no provider, no runtime, no image, no networking, no cost, no implementation. See §7.
- **Cost: entirely qualitative.** No dollar figures, no token counts, no model names beyond product names. See §6.

What the video *is* extremely good for: the mental model, the vocabulary, the shape of the pipeline, and a very explicit set of build-order warnings (§9, §10). Those are the durable value.

---

## 1. Core thesis in one paragraph

"Loop engineering" is a bad rebrand of the software development lifecycle and will hold you back. The correct unit of thought is the **AI Developer Workflow (ADW)**: a named, repeatable pipeline composed of *engineers + agents + code*, running inside a **software factory**. Prompts go in, a specific workflow runs, results come out. A loop is just one control-flow primitive inside that workflow — no more special than a conditional or an exception handler. Your engineering effort belongs on the **agentic layer** (the system that builds the system), not the **app layer**.

> **[00:42]** "It's much more valuable and helpful to think about building with agents as if you're building developer workflows inside your software factory. Your prompts go into your software factory. A specific workflow runs. Each workflow is a combination of code plus agents and then your results come out."

The on-screen title card at [01:08] states it as an equation:

```
SOFTWARE FACTORY
YOUR WORKFLOW = CODE + AGENTS

PROMPT  →  [ CODE ] [ AGENT ]  →  RESULTS
```

---

## 2. Key vocabulary (glossary)

Definitions are the speaker's own framing, quoted or tightly paraphrased, with the timestamp where each is established.

| Term | Timestamp | Definition (his words / tight paraphrase) |
|---|---|---|
| **Loop engineering** | [00:00]–[00:20] | The term he is arguing against. "A terrible rebrand of the software development life cycle. It's as unclear as it is hype-filled." Attributed in context to ideas circulating from Boris Cherny (Anthropic) and Peter Steinberger (then OpenAI). |
| **AI Developer Workflow (ADW)** | [09:52], [26:10] | The correct unit. The workflow an engineer used to execute by hand — plan, build, test, review, ship — now composed of agents and code. Canonical minimal form (diagram 13): `Engineer Prompt → Agents → Code → Engineer Review`. Plural and specialized: you build *many* ADWs, not one. |
| **Software factory** | [01:03], [17:48]–[22:40] | The full system of many routed, specialized ADWs. "A software factory that can operate your application as well — and if you're doing it right, better than you and your engineering team." |
| **Three actors of value creation** | [03:33] | Engineers, Agents, Code. "Knowing when and where to place each of these is the name of the game of agentic engineering." Reliability ranking, most to least: **Code > Engineers > Agents** [04:36]. |
| **The agentic layer** | [12:24], [21:57], [22:12] | "The agents, the prompts, the skills, the system prompts that wrap your application." Distinct from the **app layer**. Drawn on screen at [22:12] as "AL" enclosing the *entire* factory diagram, with "APL" (app layer) as the thing being acted upon. |
| **The app layer** | [21:57] | Your actual product code. "The app layer is for your agents. The best engineering teams never touch the product themselves." Flagged by him as deliberately controversial. |
| **The two constraints** | [07:05], [07:18] | Planning (a.k.a. prompting) at the front and Reviewing (a.k.a. validation) at the end. These are the only two places the engineer should routinely appear. On-screen at [07:18]: `PLANNING (engineer) → AGENTS: FAST and PARALLEL → REVIEWING (engineer) → SHIPPED`. |
| **Building the system that builds the system** | [11:16], [22:18] | His recurring phrase for meta-engineering: your effort goes into the workflow machinery, not the feature. "That is the central thesis inside of tactical agentic coding." |
| **Agent sandbox** | [10:35], [20:11] | Give every single agent its own computer. Full isolation, beyond git worktrees. You can jump *into* the sandbox to inspect work, the page, the tests, the app. "Agent sandboxes are going to, I can guarantee you this, be the majority of computers out there in the world." |
| **Worktree (git)** | [09:10] | Isolation + parallelism for agents so they don't trip over each other. Explicitly framed as a stepping stone: **"a great place to start, not a great place to end"** [10:35]. |
| **Scout Agent** | [13:48] | Search/discovery specialist. "Look for all the code, look for all the tickets, look for all the documentation, look for previous spec files" — then hands to the Plan Agent. Searching is deliberately split from planning. |
| **Plan / Planner Agent** | [08:28], [13:48] | Produces the plan/spec from the scout's findings. In the router diagrams, present for `feature` and `bug` workflows, absent for `chore`. |
| **Build Agent** | [05:19] onward | The implementer. The node that all failed validations route back into. |
| **Test Agent** | [07:47] | Collapses lint + format + type-check + test into one agent. "Scaling our compute to scale our impact. We're adding compute to add confidence." |
| **Hot Fix Agent** | [15:55] | A specialized **agent expert** for production-down. "It's not doing things the right way. It's not doing things the fancy way. It's not optimizing anything. It's getting the fix out ASAP and nothing else. This is a surgical hotfix agent." Has "a specialized set of mental memory." |
| **Factory Router Agent** | [19:28] | Reads the incoming ticket + a quick look at the codebase and decides which ADW to run. Explicitly: **"This could just be a simple LLM call. This could be some deterministic code. The exact nodes are up to you to decide."** |
| **Start Factory** | [19:28] | A code node. The moment a Kanban ticket lands, the factory kicks off; marks the ticket in progress. |
| **Setup Sandbox** | [19:50] | A code node that provisions the sandbox *before* the router-selected ADW runs. |
| **Status: Planning / Building / Testing / In Progress** | [14:09], [19:38] | Code nodes (diamond, `</>` icon) that write ticket state back into the Kanban system between agent stages. The only persistent-state mechanism shown anywhere in the video. |
| **Agent expert** | [16:16], [33:21] | A custom, specialized agent you have "templated your engineering into." He calls it "a massively banger idea… turning out to be a massively important idea." Opposed to out-of-the-box agents. |
| **Workhorse model** | [20:33] | The cheaper/mid-tier model you assign to the Build Agent. Contrast with "state-of-the-art model" for Planner/Scout. |
| **Lightweight model** | [20:55] | Even cheaper tier, appropriate for a `chore` ADW. |
| **ZTE** | [20:55] / [21:10] | **Unresolved.** He says "We'll talk about ZTE in a second" immediately before "the best teams are going to start dropping off engineering review because they've built the best system possible" — and then **never returns to it in this video.** Context strongly implies "Zero-Touch Engineering/Execution" (removing the human review gate). Treat as a dangling forward-reference to his course material. |
| **Vibe coding** | [25:51] | "Not knowing how the system works and not looking at how the system works." The thing agentic engineering is defined against. |
| **Agentic engineering** | [25:51] | "Knowing your system works so well you don't have to look." |
| **KISS** | [28:19] | "Keep it simple, stupid" — his explicit starting-posture instruction. |
| **Tactical Agentic Coding (TAC)** | [32:16] | His paid course. 8 lessons + 6 upgradable ("Agentic Horizon"). 30-day refund before lesson 4. |
| **Thinking In Threads** | [33:41] | His **free** blog covering ~the same ideas. Recommended as the no-cost entry point. |

---

## 3. The three actors of value creation

Established at [03:33], on-screen diagram `00 - The Three Actors`.

```
Your actors of value creation
   ├── Engineers   (person icon, yellow stadium)
   ├── Agents      (robot icon, orange rectangle)
   └── Code        (</> icon, green diamond)
```

The shape/color grammar is consistent across every diagram in the video and is worth stealing wholesale:

| Shape | Color | Means |
|---|---|---|
| Stadium / rounded pill | yellow | **Engineer** (human touchpoint) |
| Rectangle | orange/red | **Agent** (LLM call) |
| Diamond | green, `</>` prefix | **Code** (deterministic, zero-token) |
| Subgraph box | green tint, lock icon | **Sandbox** boundary |

**The argument for code** [03:54]–[04:36]:

> "Everyone in their AI psychosis seems to forget code is fast, always runs the same way unless you tell it not to. And guess what? It costs nothing. There are no token costs associated with code… code is the unsung hero of all of this."

> **[04:36]** "Out of these three, code is the most reliable by miles, followed by engineers, and then agents."

Repeated at [30:28]: *"Speed costs zero tokens. There's no hallucination. It does the exact same thing every time. And it literally runs at the speed of light."*

---

## 4. The architecture — the 14-diagram spine

At [29:52] his own tooling is visible on screen ("animaid — animated Mermaid", running at `localhost:5273`) with the complete diagram index in the left sidebar. **This is the canonical curriculum order and the cleanest possible outline of the video's architecture:**

```
00 · The Three Actors
01 · Prompt, LLM, Response
02 · Prompt, Agent, Response
03 · Build, Lint Loop
04 · Lint, Format
05 · Lint, Format, Test
06 · Build + Test Agent Team
07 · The Planner Pipeline
08 · Parallelize With Worktrees
09 · Agent Sandboxes
10 · Kanban Sandbox Workflow
11 · Hot Fix Workflow
12 · The Software Factory
13 · AI Developer Workflow
```

Each step below gives the diagram as drawn on screen.

### 01–02 · The atom [04:43]–[05:19]

```
Engineer Prompt → LLM → Engineer Review        (01)
Engineer Prompt → Agent → Engineer Review      (02)
```

> **[04:58]** "Insert your favorite agent. Insert your favorite model. **It doesn't matter anymore.** It's about the workflow that you and I execute every single day."

Note for a multi-model builder: he asserts model-agnosticism at the *atom* level here, then contradicts it deliberately at the *routing* level in §6. Both are intentional.

### 03 · Build, Lint Loop — the first loop [05:19]–[05:40]

```
Engineer Prompt → Build Agent → ◇Lint Code ──pass──> Engineer Review
                       ↑____________fail____________|
```

> **[05:40]** "This condition and this routing back to our build agent creates our first loop. Hence the term loop engineering. But loop engineering is too simple. It's too inaccurate."

At [27:34] he re-draws this exact diagram and circles the Build Agent box and the Lint Code diamond **as two separate boxes with an arrow between them**, to hammer the separation-of-concerns point (§9.1).

### 04–05 · Add format, add tests [06:03]–[07:05]

```
Engineer Prompt → Build Agent → ◇Lint ──pass──> ◇Format ──pass──> Engineer Review
                       ↑___fail___|                  |
                       ↑______________fail___________|
```
Then `◇Test` is chained on the same pattern.

Every deterministic check is its own diamond with its own `fail` edge routing **back to the Build Agent**. This fan-in-to-build pattern is the single most repeated structure in the video.

### The two constraints [07:05]–[07:18]

On-screen overlay:

```
PLANNING  ─────→   AGENTS   ─────→  REVIEWING  →  SHIPPED
(ENGINEER)      FAST and PARALLEL   (ENGINEER)
```

> **[07:05]** "You and I always show up at the ends. These are the two constraints of agentic engineering. Prompting, also known as planning, and reviewing, also known as validation."

### 06 · Build + Test Agent Team [07:47]

All the deterministic validation collapses into a single **Test Agent**:

```
Engineer Prompt → Build Agent → Test Agent ──pass──> Engineer Review ──pass──> Ship
                       ↑__fail: loop back__|              |
                       ↑___________fail__________________|
```

> **[07:47]** "So now we're scaling our compute to scale our impact. **We're adding compute to add confidence.**"

Note the *second* fail edge: Engineer Review can also reject back to Build Agent.

### 07 · The Planner Pipeline [08:28]

```
Engineer Prompt →(review)→ Planner Agent → Build Agent → Test Agent ──pass──> Engineer Review ──pass──> Ship
                                 ↑____________fail_______|                          |
                                 ↑_________________fail___________________________|
```

The Planner Agent has a `review` edge back to Engineer Prompt — plan approval is a human gate.

> **[08:28]** "These are all steps that you and I, the engineer, used to take and used to execute ourself. We would plan work, we would build the work, we would test the work, we would then have another engineer review the work, and then we would finally ship it into production. It's a developer workflow and all we've done here is added AI to it. **The loops is just one piece of it.**"

### 08 · Parallelize With Worktrees [09:10]–[09:58]

```
                       ┌── ⑂Worktree 3: Planner → Build → Test → Engineer Review ──pass──┐
Engineer Prompt → ◇Build Worktree Code ── ⑂Worktree 2: (same) ──pass──────────────────────┼→ Merge → Ship
                       └── ⑂Worktree 1: (same) ──pass───────────────────────────────────┘
```

The fan-out node is **code, not an agent** (`</> Build Worktree Code`, green diamond). Fan-in is `Merge → Ship`.

### 09 · Agent Sandboxes [10:35]–[11:22]

Identical topology, one substitution: `◇Build Worktree Code` → `◇Build Agent Sandbox Code`, and each subgraph is relabeled `🔒 Agent Sandbox 1/2/3`.

> **[10:35]** "Work trees are a great place to start, not a great place to end. There are a lot of problems with work trees. We can do one better by giving our agents each their own sandbox… instead of spinning up work trees, we're now giving every single agent their own computer."

> **[10:56]** "You yourself can jump into the sandbox to look at the work, look at the result, look at the web page, look at the tests, look at the application, whatever you need to do, do your review."

**He never says what a sandbox is technically.** No VM, container, cloud provider, or product is named anywhere in the video.

### 10 · Kanban Sandbox Workflow [12:02]–[14:51]

The full ticket-to-ship pipeline. Reconstructed from frames at [12:12], [13:12], [13:58], [14:22], [14:48]:

```
Support  ┐
Product  ├→ ◇Kanban Ticket ─┬─── "advanced teams" ─────────────────┐
Engineer ┘                  └→ Engineer Prompt ───────────────────┐│
                                                                  ▼▼
                            ┌────────────────── 🔒 Sandbox ────────────────────────────────┐
                            │ ◇Status: Planning → Scout Agent → Plan Agent → ◇Status:       │
                            │  Building → Build Agent → ◇Status: Testing → Test Agent       │
                            │       ↑___________fail______|              ──pass──> ◇CI/CD   │
                            │       ↑______________________fail___________________|         │
                            └───────────────────────────────────────────────────────────────┘
                                          ──pass──> Engineer Review ──pass──> Ship
                                                          └──fail──> back into sandbox
```

Two structural points:

1. **The `advanced teams` bypass edge** [13:06]–[13:27]. Normally a ticket goes to an engineer who translates it into a mid/low-level prompt. Advanced teams route the raw ticket straight into the factory, skipping the engineer-prompt node entirely.

   > **[13:06]** "Some advanced teams — if you're teaching your organization how to write prompts well enough, and as models become more capable — you can skip your engineer input prompt here, because your engineer's job should be *building the system*. We act on the meta layer. We act on the layer that can compound across our organization."

2. **`Status: X` code nodes interleave between every agent stage.** These are the write-backs that keep the external ticket system in sync with pipeline position. This is the closest thing to observability in the entire architecture (§8).

> **[14:51]** "You can see this is much more than just prompt engineering. It's much more than context engineering. It's much more than harness engineering. It's much more than loop engineering. This is about how teams move as an organism with all the actors inside."

### 11 · Hot Fix Workflow [15:27]–[17:41]

The worked emergency scenario. Reconstructed from frames at [16:00] and [16:48]:

```
Support: Production Crash → Engineer Prompt → Scout Agent → Hot Fix Agent → Approve/Reject
                                                                 ↑             │  ├─reject─┘ (back to Hot Fix Agent)
                                                                 │             │  └─approve─→ ◇Build Sandboxes
                                                                 │                                    │
                                                                 │        ┌── 🔒Sandbox 1: Build Agent ⇄ Test Agent ──pass──┐
                                                                 │        ├── 🔒Sandbox 2: Build Agent ⇄ Test Agent ──pass──┤
                                                                 │        └── 🔒Sandbox 3: Build Agent ⇄ Test Agent ──pass──┤
                                                                 └───────────────── fail ─────────────────────────────────┘
                                                                                            ↓
                                                                        Engineer Review ──pass──> Ship
```

Distinguishing features vs. the normal pipeline:

- **Entry is a comms channel, not a board.** "This goes right to Slack. It goes right to Teams, goes right to your communication channel, and one of your cracked engineers picks this up immediately" [15:55].
- **A mandatory human gate** (`Approve / Reject`) sits *before* any building. "This is a hot fix. We need to know the solution is going to work. So you put in human effort" [16:37].
- **Racing sandboxes.** N sandboxes run the same fix in parallel; first correct one wins.

  > **[16:37]** "I want the first fastest agent that has the solution to win. Whatever your compute budget is, you'll scale this up. You'll scale this down. If you're in a production system that's complex, you might want three, five, ten agents running and racing toward a solution in their own agent sandbox — you don't care. You have the compute."

- **No Planner Agent.** Deliberately skipped for speed.

> **[17:19]** "A question for you and your organization: do you have an agentic workflow for production crashes? Can you get that resolved in record time using the three actors of value creation?"

### 12 · The Software Factory [17:48]–[22:40]

The full picture. Reconstructed from frames at [19:38], [20:48], [21:48], [22:48]:

```
Support  ┐                        ┌ "advanced teams" ┐
Product  ├→ ◇Kanban Ticket ───────┤                  ├→ ◇Start Factory → ◇Status: In Progress
Engineer ┘                        └ Engineer Prompt ─┘                            │
                                                                                  ▼
                                                                        ⬛ Factory Router Agent
                                                                                  │
                                                                          ◇ Setup Sandbox
                                                                                  │
        ┌─────────────────────────────────────────────────────────────────────────┤
        │ 🔒 "Any specialized ADW you need" ── Your ADW                           │  (extension point)
        │ 🔒 Hotfix Sandbox: Scout → Hot Fix Agent → Approve/Reject →             │  ← "hotfix"
        │       Build Agent ⇄ Test Agent ──pass──> Engineer Review                │
        │ 🔒 Feature Sandbox: Planner Agent → Build Agent ⇄ Test Agent →          │  ← "feature"
        │       ◇CI/CD → Engineer Review                                          │
        │ 🔒 Bug Sandbox: Plan Agent → Build Agent ⇄ Test Agent →                 │  ← "bug"
        │       ◇CI/CD → Engineer Review                                          │
        │ 🔒 Chore Sandbox: Build Agent → ◇Lint → ◇CI/CD → Engineer Review        │  ← "chore"
        └─────────────────────────────────────────────────────────────────────────┘
                                          │
                                     all ──pass──> Merge → Ship
```

**Read the ADW variants as a deliberate complexity ladder.** They are not the same pipeline with different labels — they have genuinely different node counts:

| ADW | Scout | Plan | Build | Test Agent | Deterministic checks | Human gate |
|---|---|---|---|---|---|---|
| **hotfix** | yes | no | yes | yes | none shown | **Approve/Reject before build** + Engineer Review |
| **feature** | no | Planner Agent | yes | yes | CI/CD | Engineer Review |
| **bug** | no | Plan Agent | yes | yes | CI/CD | Engineer Review |
| **chore** | no | no | yes | **no** | Lint + CI/CD | Engineer Review |

> **[20:55]** "The whole point is you're not going to deploy your heavy AI developer workflows for a chore. Throw a single agent at this with a workhorse model, maybe even a lightweight model. Build it, run the lint, run the CI/CD, engineer reviews it, and ship it out."

### The agentic layer vs. the app layer [21:57]–[22:40]

At [22:12] he draws a box around the *entire* software factory diagram and labels it **"AL"** (agentic layer), with **"APL"** (app layer) noted separately.

> **[21:57]** "All of your effort goes into the agentic layer, not the app layer. **The app layer is for your agents. The best engineering teams never touch the product themselves.** I know this might be controversial. Some engineers are going to hate hearing this, but the best teams are doing meta work on the agentic layer. They're building the system that builds the system."

Qualified immediately after: *"That doesn't mean you can't jump into the app to do work. But when you have a successful product scaled with users, the name of the game is building a software factory that operates everything better than you alone could, better than code alone could, and better than agents alone could."* [22:18]

### 13 · AI Developer Workflow — the closing reduction [26:10]

The whole video collapses back to one four-node diagram, boxed and titled "AI Developer Workflow":

```
Engineer Prompt → ⬛Agents → ◇Code → Engineer Review
```

That is the answer to "what is the spine of the factory": *human intent in, agents and code alternating, human validation out — recursively nestable at any scale.*

---

## 5. Organizational scaling [23:22]–[24:25]

> **[23:22]** "At the highest levels of agentic engineering, you're building software factories that execute the right work and the right combination of engineers, agents, and code across your organization."

- You add non-engineer teammates as ticket sources as you scale.
- **"At the core of it, the engineers are responsible for the code."** [23:43] — accountability does not transfer.
- Explicit friction he predicts: *"a lot of orgs are going to have a problem with this once they start scaling and adding other team members — especially ones that can't write clear tickets for the life of them… it's the most painful thing when your product manager, your CTO, your tech lead just writes a ticket and you have to translate it."* [24:04]

Forward-looking claim at [26:13]: eventually you build ADWs **into your products for your customers**, with customers as nodes — "every user that can prompt into the system and receive results out the system. You have to design this system. It's just another system."

---

## 6. Multi-model / multi-agent routing, and cost

This is the densest passage for the user's multi-agent setup. All of it lives at [20:33]–[21:00].

> **[20:33]** "Our agent has already decided what type of workflow we need to get the job done at **the best price, at the best performance, and at the right speed.** Because as you likely know, you're not going to run your hot fix AI developer workflow or your feature AI developer workflow where you're scaling out your very best agents. **Maybe your build agent is a workhorse model, but your planner and your scouters are going to be state-of-the-art models so nothing gets missed.** Of course, there's a whole slew of multi-agent orchestration work that can happen here."

Extractable rules:

1. **Model tier is assigned per role, not per project.** Scout and Plan get the strongest model (recall/coverage matter most; a miss there poisons everything downstream). Build gets a workhorse. Chore gets lightweight.
2. **Model tier is also assigned per ADW.** The same Build Agent role may warrant a different model in a `chore` ADW than in a `feature` ADW.
3. **The Factory Router Agent is the selection point**, and it optimizes three axes simultaneously: **price, performance, speed**.
4. **The router itself may be code, not a model.** [19:28] "This could just be a simple LLM call. This could be some deterministic code."
5. **Compute budget is a dial, not a constant.** For hotfixes: "three, five, ten agents racing" is explicitly sanctioned when the incident justifies it [16:57].

At the atom level he insists the specific agent harness doesn't matter — the named harnesses he cites as interchangeable are **Codex, Claude Code, and "your pi coding agent"** [06:03] (also "your Claude Code, your Codex, your Pi coding agent" in the video description). This directly validates a multi-harness setup.

**Cost content is qualitative only.** No dollars, no token counts, no benchmarks. The only quantitative-flavored claim is the recurring "code costs zero tokens."

---

## 7. Remote / cloud / headless execution

Everything the video says on this subject:

- **Agent sandbox = one computer per agent** [10:35]. Full isolation. Inspectable by the human mid-flight.
- **[20:11]** "We're not limiting our agents anymore. We know that agents are going to continue to expand. This is what the CPU crunch is all about. CPUs are getting wiped off the board outside of scaling RL and other ML engineering related work. **Agent sandboxes are going to, I can guarantee you this, be the majority of computers out there in the world. You and I will be using fewer and fewer devices while our agents continue to scale up and use more sandboxes.**"
- **`◇Setup Sandbox` is a first-class code node** in the software factory, sitting between the router and the workflows [19:50]. Provisioning is part of the pipeline, not a prerequisite.
- The `◇Build Sandboxes` node in the hotfix ADW provisions **N sandboxes at once** [16:37].

That is the complete set. **No cloud provider, container runtime, orchestrator, VM image, credential-handling, networking, persistence, or teardown detail appears anywhere in the video.** For a builder who needs cloud execution because of power outages, this video establishes *that the architecture assumes remote per-agent compute* and nothing about how to get it.

---

## 8. Observability, tracing, dashboards

**Near-zero coverage. Be aware of this gap.**

The only mechanisms present:

1. **`Status: X` code nodes** written between every agent stage in the Kanban ADW [14:09] and in the factory (`Status: In Progress`) [19:38]. These push pipeline position back into the ticketing system. He describes them functionally ("we run code to update our ticket to move context") and never frames them as observability.
2. **Human inspection of a live sandbox** [10:56] — "jump into the sandbox to look at the work, look at the result, look at the web page, look at the tests, look at the application." That is the review surface.
3. **Session-ID continuity** [27:17] — "when the linter fails, pass that back into the build agent **with the same session ID**." The only concrete state-plumbing instruction in the video, and the only trace-like concept.
4. **An implicit state store.** At [29:52] the Mermaid source visible in his own `animaid` tool includes a **SQLite** node: `C -->|writes| DB@{ icon: "tabler:database", label: "SQLite" }`. That's his own tool's architecture, not the factory's, but it signals his default choice of local state store.

He does gesture at the need without naming a solution:

> **[30:50]** "There is information orchestration. This is what context engineering is. **You're going to need a place for all the results in between each step.** Yes, it's going to take some time. Yes, it's going to be a little annoying."

**No dashboards. No tracing tooling. No metrics. No cost telemetry. No log aggregation.** If observability matters to your build, it is entirely on you.

---

## 9. Explicit warnings — what NOT to do

These are stated as direct instructions, not asides. This is the highest-value section of the video for an implementer.

### 9.1 Do not hide code inside a skill — the central warning [27:17]–[28:00]

> **[27:17]** "To be clear, so that you can really feel this — **separate this out. I'm not saying write a skill, have your agent build, and then at the bottom of the skill, run lint. Separate this out.** Use an agent SDK, run a build agent, do work, and then run a linter. And when the linter fails, pass that back into the build agent **with the same session ID**. You have to separate your code and your agents. **Otherwise, you just have an agent calling code. That's not what we want.** We want separation of concerns all the way through."

> **[27:38]** "This is not a big skill where you run a hundred different nodes of workflows. **There are massive testing, massive validation problems with doing that.**"

Restated as a rule at [28:40]:

> "You can absolutely start with pure skill-based workflows where it's all one skill outside of the prompt and the review. But **as soon as you start productionizing, as soon as you get serious about your ADWs, you must separate code out of the skills** — because that's still your agent running it. You have to be super, super clear about those steps so that you can set up the proper guardrails and information flows."

And the pre-emptive rebuttal at [30:50]:

> "During the process, you'll wonder, *I should just throw this all in the skill.* **You'll be wrong down the road. I can guarantee you that. I've been there. Don't waste your time doing [what] other engineers have already done wrong.**"

**Why it matters:** if the linter runs inside the skill, the orchestrator cannot observe the pass/fail, cannot route on it, cannot test that edge, and cannot swap the model for that node. The edge stops existing as a first-class object.

### 9.2 Do not over-leverage on agents [30:09]–[31:12]

> **[30:09]** "Make sure you're not just using agents. Use agents *and* code. You can always start with agents and skills, but as soon as you start hitting production, as soon as you want to get serious, move some of that skill work into code. **This is not just about token cost. This is about performance, reliability, and speed.**"

> **[30:28]** "Don't overleverage on agents. Balance it out with actual code execution."

### 9.3 Do not add engineering effort as you scale [08:08]

> "As you scale up your developer workflows, you add agents and you add code. But **what you don't want to add is more engineering effort** outside of building the system that builds the system."

This is the load-bearing scaling invariant: agents ↑, code ↑, human hours ↔ flat.

### 9.4 Do not end at worktrees [10:35]

"A great place to start, not a great place to end. There are a lot of problems with worktrees." He does not enumerate the problems.

### 9.5 Do not build one giant ADW [21:17]

> "Every single unique workflow is unique for a reason. There are multiple workflows you want to build out here, multiple AI developer workflows you should be building out, **not just one.**"

### 9.6 Do not use out-of-the-box agents at scale [25:08]

> "I've been pushing against out-of-the-box agents for a long time. **Specialization is the name of the game.** What is a product? What is a company? Unless you're a big tech giant, a product in a company is a set of people and technology that solve a specific problem for a specific avatar, for a specific user, for a specific customer. **By very definition it is specialization.** Your expertise is the most valuable thing you have now, and you can template that into your AI developer workflows."

### 9.7 Do not skip classic engineering discipline [31:34]

> "Keep using great classic engineering patterns — **isolatable, decoupled, single interface.** All that stuff matters probably even more now, because once you do it right and you set up your AI developer workflow, it gets multiplied hundreds and thousands of times."

Reason given at [31:12]: **you have to be able to test each node and each edge.** "You're going to need to test this node. You're going to need to test plan into build, and to update the status, and to testing, and to fail. This is all still a system you the engineer are responsible for."

---

## 10. How to build an ADW — his three rules [26:39]–[31:12]

Framed as "the oil of everything I've learned" from "hundreds and probably thousands" of ADWs he's written.

### Rule 1 — Keep it simple; start with the smallest thing [26:56]–[28:19]

Growth path he prescribes, in order:

1. Get an agent running; prompt back and forth, babysitting it. *(Everyone starts here.)*
2. **Add one deterministic node.** Just a linter. Separate process, separate from the agent, failure routes back with the same session ID.
3. **Add a couple more nodes.** Type checker. Formatter. Tests. All routing back to Build.
4. **Then separate/specialize the agents.** "Maybe you want to separate your front end and your back end. Maybe you want building and testing."

> **[28:19]** "The key here is just that **you separate the context out** so that your context can move between individual agents and code. When you're starting, remember KISS."

> **[27:58]** "What you'll notice here is that you're starting to build a larger unit, a larger system **that operates without you.** You show up at the beginning and the end — the two constraints of agentic coding, planning and reviewing — and your system does everything else."

### Rule 2 — Do it by hand first [29:02]–[30:07]

> **[29:03]** "Design your ADWs by doing the work yourself first. For a lot of engineers, this will sound insanely painful, but you can use your agent in the terminal. Run the build workflow. Do the testing. **I'm not saying do it by hand — that would be a waste of time now.** But whatever workflow you're setting up, **run it end to end. Step into each node yourself. Run the pass, run the condition, watch the functions get executed, do the review, and then do the ship to production** — and then start writing this all as a combination of agents, engineers, and code."

> **[29:45]** "Sit down [with] pencil and a piece of paper, or use Mermaid, or use whatever. **Really sit down and write out your workflow.**"

Tooling he names: **Mermaid** / **mermaid.live**. He mentions his own animated-Mermaid app was itself built by a plan→build→test ADW **in one shot** [29:23].

### Rule 3 — Use agents *and* code [30:09]–[31:12]

Covered in §9.2. The closing formulation:

> **[31:12]** "Agents plus code beats either alone — especially when you start really scaling these into legitimately large AI developer workflows that do serious work for you and your organization."

### The payoff he claims [24:25]

> "Once you get this right, you set up the right guardrails, the right harness — prompt, context, harness engineering, all of it — **you have a repeatable workflow that you can run tens, hundreds, and thousands of times, delivering consistent results to you over and over again, if you template your engineering into the fabric of your AI developer workflows.**"

---

## 11. Prerequisites and tooling actually named

The video names remarkably little concrete tooling. Complete list:

| Thing | Where | Note |
|---|---|---|
| **Agent SDK** | [27:17] | "Use an agent SDK, run a build agent, do work, and then run a linter." The only orchestration primitive named. Vendor unspecified. |
| **Session ID** | [27:17] | The mechanism for feeding failures back into the *same* agent conversation. |
| **Claude Code / Codex / "pi coding agent"** | [06:03] | Named as interchangeable harnesses. |
| **Git worktrees** | [09:10] | Starting-point isolation. |
| **Kanban / ticket system** | [12:02] | Any. He calls it "just code — there are no agents there" [13:27]. |
| **Slack / Teams** | [15:55] | Hotfix intake channel. |
| **CI/CD** | [14:30] | A code node inside the sandbox, before human review. |
| **Linter, formatter, type checker, tests** | [05:19]–[06:44] | The canonical deterministic quartet. Language-agnostic — "It doesn't matter what language you're in." |
| **Mermaid / mermaid.live** | [29:45] | For designing ADWs before building them. |
| **SQLite** | [29:52], on-screen | Appears in his own tool's diagram as the store agents write to. |
| **"animaid"** (his tool) | [29:23], [29:52] | Animated-Mermaid viewer on `localhost:5273`; not released/linked in the video. |

Historical color, not prerequisites: Aider, GPT-3.5 Turbo, GPT-4, Sonnet 3, ActionScript 2/3, C, TypeScript, Python, React, Vue [01:46]–[02:08].

---

## 12. Quotes worth keeping

| Timestamp | Quote |
|---|---|
| [00:20] | "Loop engineering is a terrible rebrand of the software development life cycle. It's as unclear as it is hype-filled." |
| [00:42] | "Clarity and simplicity of information gives you speed and performance in your work." |
| [03:33] | "There are now three actors of value creation for engineering work: the engineers like you and I, the agents, and the code. Knowing when and where to place each of these is the name of the game." |
| [04:36] | "Out of these three, code is the most reliable by miles, followed by engineers, and then agents." |
| [07:05] | "You and I always show up at the ends. These are the two constraints of agentic engineering: prompting, also known as planning, and reviewing, also known as validation." |
| [07:47] | "We're scaling our compute to scale our impact. We're adding compute to add confidence." |
| [08:08] | "As you scale up your developer workflows, you add agents and you add code. But what you don't want to add is more engineering effort outside of building the system that builds the system." |
| [08:50] | "If we have loop engineering, we need condition engineering, and then function engineering, and then a word-plus-engineering for every type of control flow inside of the software development life cycle — which is going to go on forever." |
| [10:35] | "Worktrees are a great place to start, not a great place to end." |
| [11:16] | "It's designing these AI developer workflows that is the most value-accretive thing an engineer can do. You want to be building the system that builds the system." |
| [16:16] | "It's not doing things the right way. It's not doing things the fancy way. It's not optimizing anything. It's getting the fix out ASAP and nothing else. This is a surgical hotfix agent." |
| [16:37] | "I want the first fastest agent that has the solution to win." |
| [17:19] | "Do you have an agentic workflow for production crashes?" |
| [20:11] | "Agent sandboxes are going to, I can guarantee you this, be the majority of computers out there in the world." |
| [20:33] | "Maybe your build agent is a workhorse model, but your planner and your scouters are going to be state-of-the-art models so nothing gets missed." |
| [21:57] | "The app layer is for your agents. The best engineering teams never touch the product themselves." |
| [25:51] | "Vibe coding is not knowing how the system works and not looking at how the system works. Agentic engineering is knowing your system works so well you don't have to look." |
| [27:17] | "You have to separate your code and your agents. Otherwise, you just have an agent calling code. That's not what we want." |
| [27:38] | "This is not a big skill where you run a hundred different nodes of workflows. There are massive testing, massive validation problems with doing that." |
| [29:03] | "Design your ADWs by doing the work yourself first… Step into each node yourself." |
| [30:28] | "Speed costs zero tokens. There's no hallucination. It does the exact same thing every time. And it literally runs at the speed of light." |
| [30:50] | "You'll wonder, *I should just throw this all in the skill.* You'll be wrong down the road. I can guarantee you that. I've been there." |
| [31:34] | "Keep using great classic engineering patterns: isolatable, decoupled, single interface. It matters even more now, because once you do it right, it gets multiplied hundreds and thousands of times." |

---

## 13. Decisions this raises for a custom build

Open questions a builder must answer. This video establishes the shape but resolves almost none of the mechanics.

### A. Orchestration substrate
1. **What is your orchestrator?** He says "use an agent SDK" and nothing more. Options: a Python/TS process driving agent CLIs; a real workflow engine (Temporal, Prefect, Dagster, GitHub Actions); or a homegrown state machine. The requirement he imposes: **every node and every edge must be independently testable** [31:12]. That rules out "one big shell script" and rules out "one big skill."
2. **How do you resume a failed agent with the same session ID?** [27:17] This is a hard constraint and it differs per harness — Claude Code, Codex, and Ollama-based agents expose session continuation differently, or not at all. **This is likely the first real blocker in a multi-harness build.** Decide whether you (a) require session resume from every harness, (b) re-hydrate context yourself from your own store and treat every agent call as stateless, or (c) allow only session-capable harnesses at loop nodes.
3. **Where does inter-node state live?** He gestures at the need ("you're going to need a place for all the results in between each step" [30:50]) and never answers. His own tool uses SQLite. Options: SQLite, a JSON artifact directory per run, Postgres, or the ticket system itself.

### B. Sandbox / cloud execution — the biggest gap for this build
4. **What is a "sandbox," concretely, given the requirement to run in the cloud?** The video mandates per-agent isolated compute and specifies nothing. Candidates: a cloud VM per run, Docker/Firecracker containers, GitHub Codespaces, Modal/Daytona/E2B, or a plain always-on VPS with worktrees as a v1. Given the stated motivation (home power outages), the sandbox layer *and* the orchestrator both need to live remotely — note he never discusses where the *orchestrator* runs, only where agents run.
5. **Do you start at worktrees anyway?** He says worktrees are the right *start* and the wrong *end*, but never enumerates the problems. Starting at worktrees on a cloud VPS is the cheapest path to a working v1 and matches his own "keep it simple" rule — at the cost of a known migration later.
6. **How does a human "jump into the sandbox" remotely?** [10:56] The review model assumes you can open the running app, the tests, the page. Over SSH/tunnel? A hosted preview URL per sandbox? This must be designed, not assumed.
7. **Sandbox lifecycle:** who provisions (`◇Setup Sandbox` is a code node in his diagram), who tears down, what happens to a sandbox whose agent crashed, and what the standing cost is when idle.

### C. Routing and model assignment
8. **Is your Factory Router code or a model?** He explicitly leaves this open [19:28]. Deterministic routing on ticket label is cheaper, testable, and debuggable; an LLM router handles ambiguity. A hybrid (label if present, model if absent) is the obvious compromise but is your call.
9. **Build the role×ADW→model matrix explicitly.** With Claude Code, Codex, ollama-cloud, Grok, and pi in play, his rule of thumb is: strongest models at Scout and Plan, workhorse at Build, lightweight for chores. But *he never says which agent harness for which role* — only which model tier. Decide whether harness choice is a per-node config value or fixed per ADW.
10. **What are your ADW types?** He ships four (`feature`, `bug`, `chore`, `hotfix`) plus an explicit "Any specialized ADW you need" extension slot. Are those yours? What's the taxonomy, and what routes to what?
11. **What is the compute-budget dial?** For hotfixes he sanctions 3–10 racing sandboxes. Define your cap, per-ADW, and where it's configured.

### D. Human gates
12. **Which ADWs get a human gate, and where?** In his diagrams: `hotfix` gets an Approve/Reject **before** any build; every ADW gets an Engineer Review before Ship; the Planner Pipeline has a plan-review edge back to the human. He then says the best teams **remove** the Engineer Review gate ("ZTE") [20:55]. Decide your starting gate set and your criteria for removing one.
13. **Do you keep the `advanced teams` bypass?** Ticket text straight into the factory vs. an engineer translating it into a prompt. For a solo builder this is really "how good does my ticket template have to be."

### E. Skill vs. code boundary
14. **Where exactly is your skill/code line?** His hardest rule. Concretely: every lint, format, type-check, test, CI/CD, status-write, and sandbox-provision step should be an orchestrator-invoked process with an observable exit code — **not** a line inside a skill or CLAUDE.md. Audit this on day one; retrofitting it is the mistake he says he made.
15. **What's your escape hatch when the boundary is inconvenient?** He predicts you *will* want to collapse code into a skill mid-build and says you'll regret it. Decide the rule now so it isn't decided under pressure later.

### F. Observability — entirely unaddressed by the video
16. **What is your run trace?** The video gives you nothing here. At minimum you need: run ID, ADW type, node sequence, per-node model + token count + duration + exit status, retry count, and the failure text that routed back. His `Status: X` nodes are a start (pipeline position → ticket) but are not a trace.
17. **How do you debug a failed ADW after the fact,** once the sandbox is gone? Artifact retention policy has to be decided before the first sandbox is destroyed.
18. **How do you attribute cost per run and per node?** He optimizes for "best price" at the router but provides no measurement. Without per-node token accounting, the routing decision is a guess.

### G. Verification of the architecture itself
19. **How do you test an edge?** He requires it ("test plan into build, and to update the status, and to testing, and to fail" [31:12]) and shows no technique. Fixture-based node tests with recorded agent outputs? A dry-run mode where agents are stubbed? This determines whether your factory is maintainable.
20. **What's your v1 slice?** Following his own Rule 1, the smallest honest thing is: `prompt → build agent → linter (separate process, observable exit code) → fail routes back with session continuity → human review`. Everything in §4 after diagram 03 is deferrable. Resist starting at diagram 12.

---

## 14. Transcription artifacts

Auto-captions garbled several terms. Corrected throughout these notes; recorded here so quotes can be re-verified against the raw VTT:

| Caption text | Actual |
|---|---|
| "conbon board" | kanban board |
| "llinter" | linter |
| "your AWS" (at [28:40]) | your ADWs |
| "Ader" | Aider |
| "Boris Churnney" | Boris Cherny |
| "Peter Steinberg" | Peter Steinberger |
| "a gentic" / "aent" | agentic / agent |
| "pass fill statements" | pass/fail statements |
| "code plus agents" / "props go into" | (at [01:03], "props" = prompts) |
| "ZTE" | verbatim in captions at [21:10]; meaning never given in-video |

**Reference links from the video description** (not discussed on camera): Peter's loop tweet (`x.com/steipete/status/2063697162748260627`), Boris's loop tweet (`x.com/bcherny/status/2064426115255730578`), Anthropic's loops blog post (`claude.com/blog/getting-started-with-loops`), `mermaid.live`, `agenticengineer.com/tactical-agentic-coding`, `agenticengineer.com/thinking-in-threads`.
