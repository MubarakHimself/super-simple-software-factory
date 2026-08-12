# Video 2 — "My Super Simple Software Factory (For Agentic Engineers)"

| | |
|---|---|
| **URL** | https://www.youtube.com/watch?v=haUfb1ievTE |
| **Speaker** | IndyDevDan (disler) |
| **Duration** | 29:52 |
| **Repo** | `disler/super-simple-software-factory` (SSSF) — stated free + open source, link in video description |
| **Companion video** | "Video 1" on loop engineering vs. the SDLC — referenced repeatedly; he deliberately never says "loop engineering" in this video (`[29:29]`) |
| **Paid course referenced** | Tactical Agentic Coding (TAC) at `agenticengineer.com/tactical-agentic-coding` |
| **Evidence base for these notes** | Full caption transcript + 39 targeted frames read at 1024–1400px (config YAML, ADW source, dashboard, SKILL.md, cookbooks all legible) |

> Timestamps in `[mm:ss]` are from the caption track and are re-checkable.

---

## 1. The thesis in one line

> `[00:14]` "Software factories are massively misunderstood and under appreciated. The key is to understand that they're useful for one reason alone. **They give you more leverage on your prompt.** That's it."

Everything else is a consequence. The amount of leverage is proportional to investment:

> `[00:32]` "At the lowest levels, you chain together a few agents to do a little more work for you with some minor configuration. At the highest levels, you build a system of agents plus code that operates without you just as well and sometimes even better than you would."

The recurring slogan, printed at the top of the repo README:

> **"Agent proposes. Code disposes."** — and its prose form, `[02:29]` **"Agents plus code beats agents alone."**

---

## 2. Key vocabulary

| Term | Definition in his words / as demonstrated |
|---|---|
| **Software factory** | A system of agents **plus code** that runs your software developer life cycle for you. `[02:06]` "the system you use to scale your compute, to scale your impact." Made up of ADWs. |
| **ADW (AI Developer Workflow)** | One end-to-end developer workflow, expressed as a **deterministic Python script** that owns sequencing, retries and acceptance. `[10:45]` "I'm thinking about the full end-to-end developer workflow that I would run to get the work done and then I'm building that with agents." Lives in `adws/adw_*.py`. 12 ship as starters. |
| **Phase** | The atomic unit of an ADW. A Python `with run.phase(PhaseParams(...)) as ph:` block. Has `name`, `kind`, `owner`, `description`, optional `retries`. `[17:25]` "we're using the `with` statement in Python to denote the entrance and the exit of this block of code." |
| **`kind`** | What *type of actor* runs a phase. Three values: `engineer`, `agent`, `code`. `[17:48]` "we are clearly separating agents plus code… we go `kind=`… engineer, agents, code." This is the load-bearing distinction of the whole system. |
| **`owner`** | *Who specifically* runs the phase — `run.engineer` (you), a named agent from the roster (`planner`, `builder`, `scout`, `reviewer`, `documenter`), or a code owner (`git`, `quality`, `tester`). |
| **Envelope** | The **typed JSON** object one phase hands to the next. `[12:39]` "here's the previous envelope. This is the work that was handed off from the planner. So, it has all the context it needs, it has the task, it has its response report format." Types seen: `PlanOutput`, `BuildOutput`, `DocumentOutput`, base class `EnvelopeBase`. Passed as `previous=plan` on the next `AgentCall`. |
| **Gate** | A **deterministic code check** that runs at the *end* of a phase and decides whether the phase passed. `[11:18]` "we're making sure that work was accomplished by adding deterministic gate checks. So this is code, right? Let's be super clear about this. This is code that runs at the end of the plan step." Named gates seen: `artifacts_exist`, `files_non_empty`, `diff_matches_claims`. README: **"every phase defaults to fail · success is earned."** |
| **Roster / config** | `adws/adw_sssf_config/sssf.config.yaml`. Header comment: *"the factory's agent roster. One agent, one prompt, one purpose."* Declares defaults, observability, and the `agents:` list. |
| **Frontier roster / "sota config"** | A second, drop-in roster file `sssf.frontier.config.yaml`. Its own header (`[15:00]`): *"the same factory, staffed with frontier models. Known as: the frontier roster, the sota roster, the big models. Same file. **Nothing here but the roster changes. Same ADW scripts, same prompts, same …**"* |
| **Core four** | `[18:22]` "this is what really lets us customize our agents and their **core four. Context, model, prompt, tools.** Always the same thing. **If you match the core four, you'll master the agent.**" On-screen overlay at `[19:08]`: *"TURN ONE DIAL, NOT THE WHOLE SYSTEM — one entry in AGENTS = four independent inputs."* |
| **Prompt engineering** | Config key `prompt_engineering:` → `system:` and `user:` markdown file paths, per agent. Stamped into `adws/adw_data/prompt_engineering/{agent}/`. install.md: *"what an agent is told."* |
| **Harness engineering** | Config key `harness_engineering:` → a list of **coding-agent extension files** (`.ts`) loaded into that agent's harness. install.md: *"what its harness can do."* `[19:02]` "every single agent can have their own unique agent harness with specific abilities… The implications of this are massive." |
| **Context engineering** | Managing what's in the window — done via envelopes, the shared session directory, and per-agent context % readouts in the dashboard. |
| **Agentic access** | Pillar #5. `[26:17]` "I've taught an agent how to operate the super simple software factory. And this is agentic access… **You are moving too slowly if you are doing pretty much anything by hand unless you're building the system that builds a system.**" Implemented as the `sssf` Claude skill. |
| **Tracer** | `adw_modules/tracer.py`. Writes **every** event live into SQLite. |
| **ADW ID / session** | Per-run identifier (e.g. `d140d7dd`, `ad066baa`). Names the session directory, the dashboard URL, and lets you rejoin/restart a run. `[21:10]` "we can restart the workflow with the session ID, with the ADW ID." |
| **Staying in distribution** | `[20:22]` "**I'm not inventing a DSL.** The only customized thing I have here is this config file, which is just YAML… It's just Python. It's just YAML. It's just agents. And it's just a skill." |
| **Model stack** | His tracked tier list of models by performance/speed/cost, not a single favorite. `[05:24]` "I'm not really fixating on one model anymore. I'm using the right model at the right cost, at the right speed, at the right price, at the right performance." |
| **Vibe coding vs agentic engineering** | `[28:32]` "**Vibe coding is not knowing how your system works and not looking. Agentic engineering is knowing how your system works so well you don't have to look.** You want to rise with the ceiling of agentic engineering, not the floor of vibe coding." |
| **5 Pillars of Agentic Engineering** | Slide at `[26:22]`: 1. Agent Harness · 2. Software Factory · 3. Extensible Software · 4. Always On Agents · 5. Agentic Access. |

### Three design principles (stated up front, `[01:23]`)

1. **Observable** — "If you can't measure your agents, you can't improve them." (repeated `[13:11]`)
2. **Customizable** — every model, role, harness, tool, prompt is a config entry.
3. **Reusable** — one skill + `/install` stamps the whole factory into any repo.

### Three actors of value creation (`[02:09]`, rendered as dashboard swim lanes)

`engineer` (you) · `code` (the workspace / deterministic execution) · `agent` (the roster). Colour-legended in the README diagram as three distinct node types.

> `[02:18]` "this isn't just about running a bunch of agents in parallel or in different team configurations. It's about combining engineers plus code plus agents **at the right time**."

---

## 3. Architecture

### 3.1 The spine

The README diagram (`[16:40]`) is the canonical picture. It shows `adws/adw_plan_build_test.py` labelled **"deterministic control plane"** with this node chain:

```
request      →  plan      →  build     →  test_1   →  fix_1     →  commit
(engineer)      (planner)    (builder)    (tester)   (builder)    (git)
                [envelope     [envelope               [envelope
                 + gates]      + gates]                + gates]
                             └──────── bounded ×3 ────────┘
```

Below it:

```
tracer.py writes every event, live
        ↓
adws/adw_data/sssf.db          --poll 500ms-->   visualizer
sqlite · WAL · 6 tables                          "just phases / just tail
                                                  reads only · never blocked"
```

Footer of the diagram: **"every phase defaults to fail · success is earned."**

So the spine is: **Python owns the graph; agents are bounded nodes inside it; typed JSON envelopes move context along the edges; deterministic gates decide edge traversal; a tracer streams every event to SQLite; a read-only poller renders it.**

The SKILL.md body states it precisely (`[25:02]`):

> "Reusable combination of **agents plus code**: deterministic Python ADW scripts own sequencing, retries, and acceptance; coding agents (Pi in v1) work inside bounded phases; typed JSON envelopes carry context between them; everything streams into SQLite for the polled visualizer. Agent proposes, code disposes."

### 3.2 Repository layout (read off the VS Code tree, `[16:34]`–`[19:45]`)

```
super-simple-software-factory/
├── .claude/
│   ├── commands/
│   └── skills/sssf/                     ← the whole factory, packaged as ONE skill
│       ├── SKILL.md
│       ├── cookbooks/                   ← lazy-loaded action guides
│       │   ├── install.md
│       │   ├── create_adw.md
│       │   ├── update_adw.md
│       │   ├── create_config.md
│       │   ├── update_config.md
│       │   ├── update_modules.md
│       │   ├── run_adw.md
│       │   ├── how_to_prompt_for_the_eng.md
│       │   └── sssf_overview.md
│       ├── references/                  ← deep specs, loaded only when needed
│       │   ├── config.md
│       │   ├── handoff.md
│       │   └── observability.md
│       ├── scripts/install.py
│       ├── templates/                   ← what /install stamps out
│       │   ├── sssf.config.yaml
│       │   ├── env.sample
│       │   ├── adws/  (adw_*.py + adw_modules/)
│       │   ├── prompt_engineering/
│       │   └── harness_engineering/
│       └── apps/
├── adws/                                ← the factory, stamped into this repo
│   ├── adw_prompt.py                    ┐
│   ├── adw_scout.py                     │
│   ├── adw_plan.py                      │
│   ├── adw_build.py                     │
│   ├── adw_quality.py                   │  the 12 starter ADWs
│   ├── adw_document.py                  │
│   ├── adw_plan_build.py                │
│   ├── adw_build_test.py                │
│   ├── adw_build_review.py              │
│   ├── adw_plan_build_test.py           │
│   ├── adw_plan_build_test_quality.py   │
│   ├── adw_simple_sdlc.py               ┘
│   ├── adw_sssf_config/
│   │   ├── sssf.config.yaml             ← default roster
│   │   └── sssf.frontier.config.yaml    ← "sota" roster, same graph
│   ├── adw_modules/                     ← all low-level logic
│   │   ├── agents.py     (load_config, validate, execute)
│   │   ├── runner.py     (Run, Phase, ph.call)
│   │   ├── agent_pi.py   (Pi coding-agent adapter — v1)
│   │   ├── agent_cc.py   (Claude Code adapter — present, v2 per config comment)
│   │   ├── data_types.py (PlanOutput / BuildOutput / DocumentOutput / EnvelopeBase)
│   │   ├── quality.py    (lint / format / typecheck / tests as kind="code")
│   │   ├── tracer.py, git_helper.py, session.py, console.py, utils.py
│   └── adw_data/
│       ├── prompt_engineering/{planner,builder,scout,reviewer,documenter}/{system,user}.md
│       ├── harness_engineering/subagents.ts
│       ├── sessions/{adw_id}/{agent_name}/     ← runtime, gitignored
│       │   └── context_handoff/plan.md
│       └── sssf.db                              ← runtime, gitignored
├── requests/          ← the engineer's raw asks, e.g. split-view-editor.md
├── specs/             ← plans the planner writes, e.g. {adw_id}_inkwell-theme-tokens.md
├── apps/              ← the demo app "Inkwell"
├── ai_docs/  app_docs/  images/  prototypes/  tmp/
├── .env / .env.sample / .gitignore / justfile / LICENSE / README.md / VALUE.md
```

Note `.playwright-cli/` is also present at the root.

### 3.3 The 12 starter ADWs (verbatim from the orchestrator's own table, `[06:48]`–`[07:10]`)

| ADW | Chain | Use when |
|---|---|---|
| `adw_prompt` | engineer → \<agent\> | one agent, one prompt, traced end-to-end — the smallest unit |
| `adw_scout` | engineer → scout | read-only recon; nothing changes |
| `adw_plan` | engineer → planner | you want the plan reviewed before any code moves |
| `adw_build` | engineer → builder | the change is well understood; just do it |
| `adw_quality` | engineer → code(quality) | deterministic checks only (lint/format/typecheck) |
| `adw_document` | engineer → code(changes) → documenter | write up work already done, from git diff vs main |
| `adw_plan_build` | engineer → planner → builder → git(commit) | real change worth planning, then shipping as one commit |
| `adw_build_test` | engineer → builder → code(test) [→ builder(fix) … bounded] | code exists to build and a test command to prove it |
| `adw_build_review` | engineer → builder → reviewer [→ builder(revise) … bounded] | correctness-of-intent matters more than tests |
| `adw_plan_build_test` | engineer → planner → builder → code(test) [→ builder(fix) …] → git(commit) | the default full loop for a nontrivial change |
| `adw_plan_build_test_quality` | engineer → planner → builder → [code(verify) → code(test) → builder(fix)] bounded → git(commit) | same, plus quality gates before the commit |
| `adw_simple_sdlc` | engineer → planner → git(commit_plan) → … | the work is real and its shape is not obvious |

The orchestrator agent generates this table on demand and ends with `What would you like to run?` — this is *how you drive the factory*.

### 3.4 What an ADW script actually looks like

`adw_simple_sdlc.py` is **~180 lines** (`[17:00]`) and is the largest ADW in the repo. Read verbatim off screen at `[17:14]`/`[17:48]`:

```python
def main(prompt: str, config: str = "adws/adw_sssf_config/sssf.config.yaml",
         adw_id: str | None = None) -> …:
    cfg      = agents.load_config(config)
    agents.validate(cfg, REQUIRED_AGENTS)
    run      = session.ensure(cfg, adw_id)
    baseline = git_helper.rev("HEAD")   # pinned before this run commits anything

    def commit(ph, envelope) -> None:
        """Commit what the preceding phase produced, in that agent's own words."""
        message = envelope.commit_message or f"sssf({run.adw_id}): {envelope.summary}"
        ph.log(sha=git_helper.commit_all(message), message=message)

    def record(ph, result) -> None:
        """Log a deterministic block's verdict, the same shape every ADW uses."""
        passed = sum(1 for check in result.checks if check.passed)
        ph.log(passed=result.passed, checks=f"{passed}/{len(result.checks)}",
               artifacts=", ".join(result.artifacts))

    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                   description="Capture the incoming ask")) as ph:
        ph.log(input=prompt, baseline=git_helper.short_sha(baseline))

    with run.phase(PhaseParams(name="plan", kind="agent", owner="planner",
                   description="Turn the request into an implementable plan")) as ph:
        plan = ph.call(AgentCall(output_type=PlanOutput, prompt=prompt,
                                 gates=[gates.artifacts_exist, gates.files_non_empty]))

    with run.phase(PhaseParams(name="commit_plan", kind="code", owner="git",
                   description="Put the spec on record before any code exists to blur it")) as ph:
        commit(ph, plan)

    with run.phase(PhaseParams(name="build", kind="agent", owner="builder",
                   description="Implement the plan exactly")) as ph:
        build = ph.call(AgentCall(output_type=BuildOutput, prompt=prompt, previous=plan,
                                  gates=[gates.diff_matches_claims]))
    …
    with run.phase(PhaseParams(name="document", kind="agent", owner="documenter", retries=1,
                   description="Write up the completed change")) as ph:
        document = ph.call(AgentCall(output_type=DocumentOutput, prompt=prompt,
                                     previous=changes.as_envelope(changeset, DOCUMENT_NOTES),
                                     gates=[gates.files_non_empty]))

    with run.phase(PhaseParams(name="commit_docs", kind="code", owner="git",
                   description="Ship the write-up in its own commit, beside the code it describes")) as ph:
        commit(ph, document)

    return 0 if run.succeeded and verified else 1

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="inline text or a path to a prompt file")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")
    args = parser.parse_args()
    sys.exit(main(utils.resolve_prompt(args.prompt), args.config, args.adw_id))
```

There is also a guard against changeset-empty runs before `document`:

```python
if changeset.empty:
    raise RuntimeError(f"nothing changed since {changeset.base.label} "
                       f"({changeset.base.reason}) — there is nothing to document.")
```

**Every ADW is a plain `argparse` CLI.** That is the seam that makes headless/cloud operation possible.

`runner.py` (`[20:10]`):

```python
def call(self, call: AgentCall) -> EnvelopeBase:
    if self.phase.params.kind != "agent":
        raise RuntimeError("ph.call() is only valid inside an agent phase")
    return agents.execute(self.run, self.phase, call)

class Run:
    def __init__(self, cfg, adw_id: str, tracer, engineer: str):
        self.cfg, self.adw_id, self.tracer = cfg, adw_id, tracer
        self.console   = Console(tracer, adw_id)
        self.engineer  = engineer
        self.phases: list[Phase] = []
        self.tokens, self.cost   = 0, 0.0
        self.seq       = tracer.max_phase_seq(adw_id)  # a joined run continues the sequence
        self.repo_root = git_helper.repo_root()        # where every agent is spawned to work
```

Note `self.seq = tracer.max_phase_seq(adw_id)` — **rejoining an existing ADW ID resumes the phase sequence rather than restarting it.**

### 3.5 The config file (`sssf.config.yaml`, 118 lines — read verbatim at `[18:22]`–`[19:45]`)

```yaml
# sssf.config.yaml — the factory's agent roster. One agent, one prompt, one purpose.
# v1 runs the Pi coding agent only; coding_agent: claude_code arrives in v2.
defaults:
  coding_agent: pi
  model: google/gemini-3.6-flash   # provider/id — a bare pattern is ambiguous across providers
  thinking: medium                 # off | minimal | low | medium | high | xhigh | max
  harness_engineering: []          # pi extensions loaded into the harness (-e)
  # Roster-wide allowlist; any agent may override with its own list.
  # NOTE: --tools filters extension and custom tools too, not just builtins. An agent
  # whose harness_engineering extension registers a tool MUST name that tool in its own
  # tools list — otherwise the extension loads and its tool is silently filtered out.
  tools: …
  data_dir: adws/adw_data          # runtime home: {data_dir}/sessions/{adw_id}/{agent_name}/

observability:
  db: adws/adw_data/sssf.db        # tracer writes here directly; the UI polls it
  poll_ms: 500                     # visualizer live-poll cadence

agents:
  - name: planner
    model: fireworks/accounts/fireworks/models/kimi-k3
    thinking: high
    color: "#a78bfa"               # optional hex — the agent's lane color in the visualizer
    purpose: Turn a request into a plan the builder can implement without asking questions.
    prompt_engineering:
      system: adws/adw_data/prompt_engineering/planner/system.md
      user:   adws/adw_data/prompt_engineering/planner/user.md
    harness_engineering:
      - adws/adw_data/harness_engineering/subagents.ts  # registers the four subagent_* tools below
    tools:                # full recon + write for plan.md; no edit — the planner never touches repo files
      - read
      - grep
      - find
      - ls
      - bash
      - write
      - subagent_create   # extension tools MUST be named here or they are filtered out
      - subagent_continue
      - subagent_list
      - subagent_remove

  - name: builder
    tools:                # the only agent that mutates the repo — everything on
      - find
      - ls
      - bash
      - edit
      - write

  - name: scout
    color: "#fbbf24"
    purpose: Find and report where things live; change nothing.
    prompt_engineering:
      system: adws/adw_data/prompt_engineering/scout/system.md
      user:   adws/adw_data/prompt_engineering/scout/user.md
    harness_engineering:
      - adws/adw_data/harness_engineering/subagents.ts
    tools:                # search-heavy recon; write only so scout_findings.md lands without a bash heredoc
      - read, grep, find, ls, bash, write, subagent_create, subagent_continue, subagent_list, subagent_remove

  # No tester agent: running the suite is a known command, so it is a kind="code"
  # phase over adw_modules/quality.py. See SKILL.md hard rule 8.

  - name: reviewer      (lines 87–102)
  - name: documenter    (lines 103–118)
```

Design points worth stealing wholesale:

- **`model` must be `provider/id`.** The comment is explicit: *"a bare pattern is ambiguous across providers."* Directly relevant to a multi-provider build.
- **Tool allowlists are per-agent and are a security/scope boundary, not a convenience.** Planner: no `edit`. Builder: *"the only agent that mutates the repo."* Scout: *"change nothing."*
- **The tools filter also filters extension-registered tools.** Register a tool in a harness extension and forget to list it → it loads and is silently dropped. This is called out as a trap in the config comments themselves.
- **The absence of a tester agent is a deliberate, documented decision** ("hard rule 8"). Running a known command is code, not an agent.
- **Swapping the whole model roster = passing a different `--config`.** Nothing else changes.

---

## 4. Observability

Everything lives at `localhost:4601` (the SSSF visualizer). Route scheme: `/#/{adw_id}` and `/#/{adw_id}/{adw_id}_{NN}_{phase}` (e.g. `ad066baa_02_plan`, `_03_build`, `_04_test_1`, `d140d7dd_08_changes`).

**Sessions gallery** (`[28:20]`): "54 runs", card per run — ADW ID, ADW name, the request text, a mini swim lane, status pill, cost, wall time, tokens.

**Run view (swim lanes)** — one lane per actor:

```
IndyDevDan  / engineer
code        / workspace          [P] … [R] … [L][D] … [S]   ← small deterministic blocks
planner     / claude-opus-5   CONTEXT 6%      ┃ plan   3m10s ┃
builder     / kimi-k3         CONTEXT 4%             ┃ build  2m31s ┃
reviewer    / claude-opus-5   CONTEXT 5%                    ┃ re… 1m27s ┃
documenter  / kimi-k3         CONTEXT 3%                          ┃ Write… ┃
```

Run header carries: status · start time · **cost ($)** · duration · total tokens · context tokens · diff lines. Example (`[20:48]`, `d140d7dd`): `success · started Jul 29 11:57:31 · $2.08 · 7m 49s · 1.39M · 191.0k · 28.8k`.

**Phase drawer** (click any node) exposes, `[02:36]`–`[13:11]`:

- `agent config` — the resolved core four: tools, coding agent, agent harness
- `description`
- `compiled prompts (2)` — **system prompt** and **user prompt**, fully rendered, with line counts (e.g. 22 / 56 lines for plan; 14 / 54 for build)
- `gates (n)` — each with name, `checks N`, `attempt N`, timestamp
- `cost` — per-phase, per-agent
- `outputs (n)` — the envelope JSON, tagged `agent {name} | attempt N | valid`
- `events (n)` — full stream: `phase_start`, `log`, `agent_start`, `tool_call` (with the literal command + elapsed), `gate_pass`, `handoff`, `agent_end`, `phase_end`
- Chip metadata on every phase: `owner … | kind … | attempt 0/0`

Real `PlanOutput` envelope (`[11:40]`):

```json
{
  "status": "success",
  "summary": "Plan to refactor inkwell's stylesheet into named design-token themes (dark default + new light theme), with a CSS-driven theme registry, a sidebar toggle button, and localStorage persistence so future themes require only one new token block in style.css.",
  "artifacts": [
    "adws/adw_data/sessions/ad066baa/context_handoff/plan.md",
    "specs/ad066baa_inkwell-theme-tokens.md"
  ],
  "notes_for_next_agent": "Only three files change: apps/inkwell/public/style.css (all hardcoded colors become tokens; dark stays default; add [data-theme=\"light\"] block and a --themes registry custom property), index.html (inline head script to apply stored theme pre-paint + a #theme-toggle button …"
}
```

Real `BuildOutput` envelope (`[13:05]`):

```json
{
  "artifacts": [],
  "notes_for_next_agent": "Run `bun test` in root or `apps/inkwell`. Verify dark theme remains default on first load and switching to light theme persists across reloads via localStorage 'inkwell-theme'. Adding a third theme requires only adding a [data-theme=\"...\"] token set and updating `--themes: dark light ...;` in style.css.",
  "changed_files": ["apps/inkwell/public/app.js", "apps/inkwell/public/index.html",
                    "apps/inkwell/public/style.css", "apps/inkwell/server.test.ts"],
  "commit_message": "Add light mode theme tokens and theme toggle persistence"
}
```

The `notes_for_next_agent` field is the mechanism for `[11:58]` "this agent has left a note for the next agent. Kind of a nice way to hand off things."

Prompt template shape (`[12:54]`): **Instructions · Variables · Workflow · Report.** The rendered build user prompt showed headings `Build Task` / `Variables` / `prompt` / `Where` / `Done means`.

Determinism claim (`[12:07]`):

> "my agents are outputting JSON, it's getting formatted, it's getting validated. If it fails, the agent must properly output it… **Determinism is wired into every one of my agent steps. They must output specific types, specific structures.**"

---

## 5. Multi-model / multi-agent routing and cost

He does **not** pick one model. `[01:59]` "The best engineers now are building systems of agents. They're not debating which model is the best anymore."

**Model stack tier list** (his own tracker at `localhost:8787`, `[05:18]`):

| Band | Tier | Models |
|---|---|---|
| SOTA (frontier ceiling) | S+ | Mythos 5, Fable 5, Opus 5 |
| | S | Opus 4.8, GPT 5.6 Sol, Kimi K3, Kimi K3 US |
| WORKHORSE (daily) | A | GPT 5.6 Terra, Grok 4.5, Sonnet 5, GLM-5.2, GPT 5.6 Luna, Gemini 3.6 Flash, Gemini 3.5 Flash |
| | B | MiniMax-M3, DeepSeek V4 Pro, DeepSeek V4 Flash, Kimi K2.6, Gemini 3.1 Pro, Gemini 3.5 Flash-Lite |
| LIGHTWEIGHT (own-it floor) | C | Qwen3.6-35B-A3B, Qwen3.6-27B, Gemma 4 31B |
| | D | gpt-oss-20b, Gemma 4 12B, Qwen3.5-4B |

The C/D band is labelled **"OWN-IT FLOOR"** — models that run on your device. Gemini 3.6 Flash is his A-tier default workhorse at **$1.50 in** (`[05:24]` "beating out pretty much every model above it, minus Luna").

**Observed per-run routing and cost** (from the sessions gallery + run headers):

| ADW ID | ADW | Roster | Cost | Time | Tokens |
|---|---|---|---|---|---|
| `048f96d8` | `adw_scout` | scout = gemini-3.6-flash | $0.3489 | 45.3s | 792.2k |
| `ad066baa` | `adw_plan_build_test` | planner = kimi-k3, builder = gemini-3.6-flash | $0.6742 | 2m 41s | 1.11M |
| `27ef9462` | `adw_build_review` + `adw_document` | — | $0.6479 | 3m 05s | 3.48M |
| `806adbfc` | `adw_simple_sdlc` | — | $0.7240 | 6m 07s | 5.20M |
| `e2688070` | `adw_simple_sdlc` | planner = kimi-k3, builder = gemini-3.6-flash, reviewer = gpt-5.6-terra, documenter = gpt-5.6-luna | $1.24 | 8m 07s | 7.74M |
| `d140d7dd` | `adw_simple_sdlc` (**frontier roster**) | planner = claude-opus-5, builder = kimi-k3, reviewer = claude-opus-5, documenter = kimi-k3 | $2.08 | 7m 49s | 1.39M |

The frontier roster costs ~1.7× and puts the expensive model on **plan and review** (the judgement phases) while a cheaper strong model does the mechanical building. That is the whole routing thesis in one data point.

**Model opinions expressed** (dated, treat as commentary not fact):
- `[07:46]` Kimi K3 — "the first open weights model inside of the state-of-the-art tier, which is an impressive feat… **this model thinks a lot, so it's not actually as fast or as performant** as Opus or Sol."
- `[08:10]` He serves Kimi K3 via **Fireworks** — "fast and a priority serverless tier, US only serverless endpoints, one of the first to do this." Not sponsored. Framed as an **AI-ownership** play.
- `[15:20]` "it's reportedly above Fable 5. I'm not quite feeling that… I'm just still using Fable 5 when I can here in the really, really critical situations."
- `[15:44]` Opus 5 "half the price obviously makes it the model of choice over Fable 5."

**How you request a roster**: in natural language to the orchestrator. `[14:31]` the prompt ended *"Use the state-of-the-art configuration for this work."* The orchestrator then (`[15:00]`) ran `head -4 adws/adw_sssf_config/sssf.frontier.config.yaml`, read the header comment, and reported: `Confirmed: "sota roster" = sssf.frontier.config.yaml. Launching.` It also wrote the request to `requests/split-view-editor.md` via heredoc before launching.

---

## 6. How you operate it (agentic access)

Two modes, explicitly:

1. **By hand** — `[03:52]` "if we wanted to, we could boot up just commands and we could operate this ourselves… you can see we have the plan workflow, plan build, so on and so forth."
2. **Through an orchestrator agent** — `[04:03]` "**But, why would we do that when we can move at the agentic speed and have an agent orchestrate the system on our behalf?**"

Mode 2 is the intended path. The `sssf` skill teaches an agent how to drive the factory.

**SKILL.md frontmatter** (`[25:02]`):

```yaml
name: sssf
description: Super Simple Software Factory — deploy and operate repeatable agents+code
  workflows (ADWs) in any codebase. Use when the user says /install (sssf), wants to
  create/run/update an ADW, manage the agent roster in sssf.config.yaml, or observe running
  agent workflows. Keywords: sssf, software factory, ADW, AI developer workflow,
  agent pipeline, install factory.
argument-hint: "[install | create adw | run adw | update config | ...]"
```

**SKILL.md sections**: `## Startup` · `## Orchestrator rules` · `## Request routing (lazy-load the cookbook, then follow it)` · `## Hard rules (enforced across everything the factory generates)` · `## v1 scope`.

One visible orchestrator rule (`[26:06]`): *"…engineer asked about, never to volunteer a status report nobody requested. • Report phase status plainly: name, owner, status, error if any."*

**Request routing table** — the router that keeps the skill small:

| Request | Cookbook |
|---|---|
| `/install`, set up the factory in this repo | `cookbooks/install.md` |
| create a new ADW / workflow | `cookbooks/create_adw.md` |
| modify an existing ADW chain | `cookbooks/update_adw.md` |
| create the config / agent roster | `cookbooks/create_config.md` |
| add or retune an agent (model, thinking, tools, prompts) | `cookbooks/update_config.md` |
| extend `adw_modules` with new low-level logic | `cookbooks/update_modules.md` |
| run / monitor an ADW | `cookbooks/how_to_prompt_for_the_eng.md` **first**, then `cookbooks/run_adw.md` |
| turn a request into an ADW prompt | `cookbooks/how_to_prompt_for_the_eng.md` |

Deep specs, loaded only when needed: `references/config.md` · `references/handoff.md` · `references/observability.md`.

His stated skill-design philosophy (`[25:44]`): *"there's a central idea… and then the cookbook is the kind of lazy-loaded actions, the incrementally adoptable contexts that the agent can look at to execute."*

---

## 7. Install / prerequisites

From `cookbooks/install.md`, read verbatim at `[25:16]`:

```
## Run it
uv run .claude/skills/sssf/scripts/install.py

Run from the **target repo root** — the cwd is where everything lands. If the skill lives in
your user scope, the path is `~/.claude/skills/sssf/scripts/install.py`.
```

**What gets stamped** (`install.py` copies `templates/` into the cwd):

| Stamped | From | Tracked? |
|---|---|---|
| `adws/adw_sssf_config/sssf.config.yaml` | `templates/sssf.config.yaml` | yes — the agent roster |
| `.env.sample` | `templates/env.sample` | yes |
| `adws/adw_*.py` | `templates/adws/` | yes — **the twelve starter ADWs** |
| `adws/adw_modules/` | `templates/adws/adw_modules/` | yes — all low-level logic |
| `adws/adw_data/prompt_engineering/{planner,builder,scout,reviewer,documenter}/` | `templates/prompt_engineering/` | yes — **the user-owned home for prompts** |
| `adws/adw_data/harness_engineering/` | `templates/harness_engineering/` | yes — **the user-owned home for pi extensions** |
| `adws/adw_data/sessions/`, `adws/adw_data/sssf.db` | created at runtime | no — gitignored |

Followed by:

> "The two `*_engineering` dirs mirror the two config keys of the same name: `prompt_engineering` is what an agent is told, `harness_engineering` is what its harness can do. **Both are yours the moment they are stamped. Edit them in `adws/adw_data/`, never back inside the skill.**"
>
> "`harness_engineering/` ships with `subagents.ts` — the pi extension backing `subagent_create` / `_continue` / `_list` / `_remove`, wired to the planner and scout in the starter roster."

There is an `## Idempotency` section immediately after (not read on screen).

**Prerequisites observable in the video**: `uv` (Python runner), Python 3.12.8, git, a `justfile`, the **Pi coding agent** (v1 only), API keys via `.env`, SQLite, and Bun for the demo app's tests (`bun test`).

**His own tooling** (not required, but stated): **Herder** as terminal multiplexer — `[03:26]` "I've transitioned away from tmux. Great tool, but Herder gives me everything I need and a little more. It's more customizable. It's more configurable. It's simpler, and it's faster." VS Code for code viewing only.

---

## 8. THE 27:00+ SECTION (flagged as notable)

Visually this stretch is the sessions dashboard and the closing slides. Substantively it is the **thesis restatement plus the single roadmap sentence in the whole video**. Full reconstruction:

**`[27:01]` — the leverage formula, restated as the closing frame**

> "Software factories give you more leverage on your prompt. **How well is based on the effort, time, and investment you put into your AI developer workflows, which make up your software factory.**"

This is the structural claim: *ADWs are the unit of investment; the factory is their sum; leverage is the output.*

**`[27:05]` — the guilt line**

> "There's a ton of engineering work you just don't need to be doing anymore. That continues to be true. **So, why are you?** This is something I think about. This is something I tell myself and other engineers when I'm sitting here working, **prompting back and forth like an idiot.**"

The named failure mode is interactive ping-pong with a chat agent. The factory exists to eliminate it.

**`[27:21]` — THE CLOUD SENTENCE (the reason this timestamp was flagged)**

> "So, it's time to shift. It's time to make that next jump. **Build your software factory. Deploy it into the cloud. Set up sandboxes so that you can push all the 80% junk work of engineering away off to your agent stack in a reliable, repeatable way so that you can focus on the real net new hard work your agents can't do without you.**"

Four distinct instructions packed into one sentence:

1. **Build your software factory** — the ADW layer.
2. **Deploy it into the cloud** — not your laptop.
3. **Set up sandboxes** — isolate each agent run.
4. **Push the 80% junk work to the agent stack** — reserve yourself for net-new hard work.

**Be clear about what is and is not shown.** This is the *only* cloud statement in the video. There is no cloud deployment, no remote runner, no container, no CI integration, no queue, no webhook, no auth demonstrated anywhere. He runs everything locally in Herder against `localhost:4601`. It is an instruction, not a walkthrough.

The architecture is nonetheless *already* cloud-shaped, and this is the useful read:
- Every ADW is a plain `argparse` CLI with `--config` and `--adw-id` — no TTY required.
- Return code is a real exit status: `return 0 if run.succeeded and verified else 1`.
- All state is one SQLite file (`sssf.db`, WAL mode) plus a session directory.
- The UI is a **read-only 500 ms poller** — "reads only · never blocked". It never writes, so it can live anywhere with read access to the DB.
- Agents are spawned at `git_helper.repo_root()`.

The pieces he explicitly says are **missing** are exactly the cloud-hardening pieces — see `[21:26]` in §9.

**`[27:38]` — the licence to fork**

> "Feel free to use the super simple software factory. **Pull in ideas. Steal it. Roll it into your own software factory.** It's here for you."

**`[28:00]` — the framing claim**

> "Those who can orchestrate intelligence at the highest level to accomplish work are winning. They're just in the lead right now, and the software factory is the next permutation."

**`[28:11]` — the warning**

> "It's not just about agents. It's about agents plus code. We're getting to a key point in the age of AI where **if you're not running a software factory, you're going to be behind.** We're just at another branding point here, and I want to make sure I say it clearly and concisely to you so you're aware."

**`[28:27]` — cost admission**

> "Building these out, **it takes time.** I wanted to give you a head start here with the super simple software factory."

**`[28:32]` — the definition worth memorising**

> "**Vibe coding is not knowing how your system works and not looking. Agentic engineering is knowing how your system works so well you don't have to look. You want to rise with the ceiling of agentic engineering, not the floor of vibe coding.**"

**`[28:45]`–`[29:20]` — TAC promo.** The course page slide (`[29:05]`) carries its own framing worth noting: *"You, the engineer, are the bottleneck — not the models - not the tools - not the agents"*; *"Agentic Engineering isn't about models, prompting, or agents — it's about composing the old world of software engineering with the new world of agents… It's about stepping out of the loop entirely. It's about building systems that build systems. It's about encoding your engineering excellence into your agents with **templates and ADWs** so they ship on your behalf while maintaining your engineering standards, **while you're AFK**."* Also: *"95% of all codebases are now outdated and inefficient."*

**`[29:29]` — the loop-engineering disclaimer**

> "if you want to understand why I didn't mention loop engineering once in this video, watch the first video linked in the description. **What you're really looking for is the software developer life cycle, not loop engineering.**"

He treats "loop engineering" as a bad rebrand (`[03:08]`: *"what's inaccurately called loop engineering, which is really all about managing the software developer life cycle"*; `[03:17]`: *"It's a terrible rebrand of the software developer life cycle."*).

---

## 9. Explicit opinions, warnings, and failure modes

Collected because these are the parts most likely to save you rework.

**Don't make everything agentic.**
> `[09:24]` "Just chain together some agents while understanding that **all this doesn't need to be agentic.** This is like a really big idea that I think engineers are going to miss and miss pretty seriously. Right now everyone is like very agent pilled."

**The specific anti-pattern he names: tests.**
> `[13:44]` "There are just things you likely are having your agents do like execute tests that you could run into deterministic paths of code and then if something goes wrong, hand it back to your agent. **Tell me why you would need to pass successful passing tests back into your agent's context window.**"

Encoded structurally: the config comment *"No tester agent: running the suite is a known command, so it is a `kind="code"` phase over `adw_modules/quality.py`. See SKILL.md hard rule 8."* And the `test_1` phase drawer description (`[21:55]`): *"Run the suite — a known command, so code runs it and no agent has to rediscover it."*

**Skill-dumping will cost you.**
> `[13:28]` "A lot of engineers are just going to start throwing everything into skills, everything into a bunch of agents. **Down the road you will pay for it.** You'll pay for it in some way, whether it's mistakes, hallucinations… It's not just that, right? There is cost, there is speed, there is performance."

**You own code; you rent models.**
> `[09:41]` "everyone in their AI psychosis has seemed to have gotten that code cost nothing, literally runs at the speed of light, and can be changed in instant. And a big thing people are re-realizing now is that **you actually own your code. Whereas we don't actually own any of our AI models. We're renting them.** Code is an essential piece for this… I'm treating it as a first-class citizen here in the software factory. **I recommend you do the same.**"

**Don't invent a DSL.**
> `[20:22]` "We're **staying in distribution**. What does that mean? **I'm not inventing a DSL.** The only customized thing I have here is this config file, which is just YAML. With the super simple software factory, we're just staying in distribution of what these models know, what they're trained on. **It's just Python. It's just YAML. It's just agents. And it's just a skill.**"

**Read your own critical code.**
> `[11:43]` "I am, by the way, **still reading the kind of essential pieces of my code base.** It's not all of the code, but the essential pieces… **the more you're going to productionize something, the more you should dig in and understand what's happening.**"
> `[17:09]` "I know like everyone's shocked right now and you can't bear the sight of looking at code. **Yes, I do actually still look at the critical code in the main line of my code** to make sure it is going to scale and to make sure that my agents can operate it properly."

**What is deliberately missing from v1 — his own list (`[21:26]`):**
> "There's a lot missing from this. There's a lot you can do with this. For instance, **I'm just running this on the main branch. Of course, you're going to want a branch. You're going to want to put your agent in a sandbox. You're going to want to isolate the agent run, and then there's going to be a merge step later on.**"

So: **no branch isolation, no sandbox, no merge step.** Commits land directly on `main`. This is the #1 thing to fix before running it unattended, and it is the same gap as the cloud gap.

**Design for run #1000, not run #1.**
> `[12:23]` "I'm not doing one-off work here. **I need these systems to work reliably over hundreds and thousands of executions without me.** And that's the key we're moving toward here. **The software factory lets your agents run, if you do it well, without you.**"
> `[22:14]` "We're not just throwing a state-of-the-art model. **We're not just torching tokens. We're not just token maxing.** We're thinking about what our system needs to win over and over and over."
> `[24:22]` "**Please think a little further than that. Think about scale. Think about production. Think about standards. Think about the thousandth run, not the first, not the tenth.**"

**He concedes the scale objection himself.**
> `[23:50]` "I know a lot of engineers watching this is just going to be like, at what scale do you need something like this? **This probably isn't the scale.** We're getting close, but this will absolutely save you time at some point. Cuz **at some point your system will get so large, so complex, that validation will be the only way forward.** And whether you hand that to an agent, it's going to be more expensive across some dimension, likely time or cost, you will pay that cost."

Also `[23:47]`: for the markdown-viewer feature specifically — *"this is something you probably could have just thrown in a single agent and got the work done. I fully acknowledge that."*

**The starter config is a starting point, not an answer.**
> `[26:41]` "after that, the whole goal is that you should customize it to make it your own. **The tests I have set up here are not the tests you need. The plan quality is not the plan quality you need**, so on and so forth."

**Silent-failure trap, from the config comments themselves:** an agent whose `harness_engineering` extension registers a tool must also name that tool in its own `tools:` list — otherwise "the extension loads and its tool is **silently filtered out**."

---

## 10. How to customize and extend

Five extension points, in increasing order of depth:

1. **Retune an agent** — edit an entry in `sssf.config.yaml`: `model`, `thinking`, `color`, `purpose`, `tools`. Cookbook: `update_config.md`. The `[19:08]` overlay: *"turn one dial, not the whole system."*
2. **Rewrite prompts** — `adws/adw_data/prompt_engineering/{agent}/{system,user}.md`. Yours the moment they're stamped; never edit them back inside the skill.
3. **Extend a harness** — drop a `.ts` extension into `adws/adw_data/harness_engineering/` and list it under that agent's `harness_engineering:`, *and* name any tools it registers in the agent's `tools:`. Shipped example: `subagents.ts` gives planner and scout `subagent_create/_continue/_list/_remove`. `[19:19]` "if it needs to, it can spin up its own sub-agents. Just one simple example… **The implications of this are massive.**"
4. **New or modified ADW** — write/edit a `adws/adw_*.py` script: compose `with run.phase(...)` blocks, choose `kind`, pick gates, thread envelopes with `previous=`. Cookbooks: `create_adw.md`, `update_adw.md`.
5. **New low-level logic** — extend `adws/adw_modules/`. Cookbook: `update_modules.md`. This is where a new coding-agent adapter would go (`agent_pi.py` / `agent_cc.py` are the existing pattern).

Add a whole new roster by copying the config file — `sssf.frontier.config.yaml` is proof the pattern works, and its header says *"Nothing here but the roster changes. Same ADW scripts, same prompts."*

---

## 11. Quotes worth keeping

| Time | Quote |
|---|---|
| `[00:21]` | "They give you more leverage on your prompt. That's it." |
| `[00:39]` | "you build a system of agents plus code that operates without you just as well and sometimes even better than you would." |
| `[01:35]` | "If you can't measure your agents, you can't improve them." |
| `[01:59]` | "The best engineers now are building systems of agents. They're not debating which model is the best anymore." |
| `[02:06]` | "Software factories are the system you use to scale your compute, to scale your impact." |
| `[02:29]` | "Agents plus code beats agents alone." |
| — (README) | "Agent proposes. Code disposes." / "Deterministic Python owns the graph. Coding agents are bounded nodes inside it." |
| — (README) | "every phase defaults to fail · success is earned" |
| `[05:31]` | "I'm using the right model at the right cost, at the right speed, at the right price, at the right performance. It's about your model stack now." |
| `[09:26]` | "all this doesn't need to be agentic." |
| `[09:56]` | "you actually own your code. Whereas we don't actually own any of our AI models. We're renting them." |
| `[12:17]` | "Determinism is wired into every one of my agent steps." |
| `[12:30]` | "The software factory lets your agents run, if you do it well, without you." |
| `[13:54]` | "Tell me why you would need to pass successful passing tests back into your agent's context window." |
| `[14:05]` | "that's that fine line between vibe coding and agentic engineering." |
| `[18:26]` | "If you match the core four, you'll master the agent." |
| `[20:24]` | "I'm not inventing a DSL… It's just Python. It's just YAML. It's just agents. And it's just a skill." |
| `[21:29]` | "I'm just running this on the main branch. Of course, you're going to want a branch. You're going to want to put your agent in a sandbox." |
| `[22:30]` | "It's about the thousandth time, and it's about scaling your compute to scale your impact." |
| `[24:05]` | "at some point your system will get so large, so complex, that validation will be the only way forward." |
| `[26:22]` | "You are moving too slowly if you are doing pretty much anything by hand unless you're building the system that builds a system." |
| `[26:31]` | "If you're doing something you can teach your agents to do, why aren't you?" |
| `[26:44]` | "The tests I have set up here are not the tests you need. The plan quality is not the plan quality you need." |
| `[27:21]` | "Build your software factory. Deploy it into the cloud. Set up sandboxes so that you can push all the 80% junk work of engineering away off to your agent stack." |
| `[28:19]` | "if you're not running a software factory, you're going to be behind." |
| `[28:32]` | "Vibe coding is not knowing how your system works and not looking. Agentic engineering is knowing how your system works so well you don't have to look." |

---

## 12. Decisions this raises for a custom build

Open questions a builder has to answer for themselves. The video sets up all of these and answers almost none of them.

### A. Isolation and merge strategy — the biggest gap
SSSF v1 commits straight to `main` (`[21:26]`, and `baseline = git_helper.rev("HEAD")` in the source). Before anything runs unattended you must decide:
- Branch-per-ADW-run, worktree-per-run, or container-per-run?
- Where does the merge step live — a new `kind="code"` phase at the tail of every ADW, or a separate `adw_merge` ADW?
- What is the sandbox boundary: OS user, container, VM, or ephemeral cloud workspace? Note the builder is the *only* agent with `edit` — that's a policy you can enforce at the sandbox level too, not just the tool allowlist.
- `changeset.base` and the pinned `baseline` assume a single linear run. What happens with two concurrent ADWs on the same repo?

### B. Cloud/headless topology
He says "deploy it into the cloud" and stops. You must decide:
- **What's the trigger?** CLI-only today. Do you add a queue, a webhook, a cron, a chat command, an issue-opened event?
- **Where does `sssf.db` live?** SQLite + WAL is single-writer and assumes a local filesystem. Multiple machines writing it will not work. Options: keep one runner box (simplest, matches the design), swap the tracer for Postgres/Turso/LiteFS, or shard one DB per runner and aggregate for the UI.
- **How does the visualizer reach the DB?** It is read-only and polls at 500 ms — that's friendly to a read replica, a mounted volume, or an HTTP read API, but a 500 ms poll across the internet is a different cost profile than across a loopback.
- **Secrets**: `.env.sample` is the only mechanism shown. Multiple providers (Anthropic, OpenAI, Google, Fireworks, xAI, Ollama) means multiple keys on a box that runs untrusted-ish agent output.
- **Session durability**: `--adw-id` "join or pin an existing session" and `tracer.max_phase_seq()` suggest resume is intended. Is a killed run resumable *mid-phase*, or only re-joinable at phase boundaries? Not shown. If your cloud box gets preempted, this determines your blast radius.
- **What is the human-in-the-loop channel** when the factory is remote? He gestures at it (`[23:02]` "when you need to human in the loop, there's many next directions to take that. Maybe that's a great place for us to go next") and does not answer.

### C. Coding-agent adapter layer — the direct blocker for multi-agent use
v1 is `coding_agent: pi` **only**; the config header says `claude_code` "arrives in v2". `adw_modules/agent_cc.py` exists alongside `agent_pi.py`, so the seam is `agents.execute(run, phase, call)` → a per-agent adapter.
- To run Claude Code, Codex, ollama-cloud, Grok and pi, you need an adapter per harness that normalizes four things: **spawn/invoke**, **tool allowlisting**, **structured JSON output + validation/retry**, and **token+cost accounting** (the dashboard depends on the last one).
- `harness_engineering` is currently *pi extensions in TypeScript*. That concept does not port cleanly — Claude Code's analogue is skills/MCP/subagents, Codex's is different again. Decide whether `harness_engineering` becomes a per-adapter free-form blob or a normalized abstraction.
- Should `coding_agent` be settable **per agent** rather than only in `defaults:`? The config shows it under `defaults:` only. Per-agent is what you'd need to put Codex on `builder` and Claude Code on `planner` in the same run.
- Cost accounting for subscription-billed agents (Claude Code Max, ollama-cloud) has no dollar figure. Does your dashboard show `$0.00`, "n/a", or an imputed rate? This affects whether the cost column stays trustworthy.

### D. Gate design — where your real leverage is
Only three gates were named (`artifacts_exist`, `files_non_empty`, `diff_matches_claims`) and only `diff_matches_claims` is semantically interesting. Decisions:
- What is your gate catalogue? Candidates: schema validation, lint/typecheck, test pass, diff-size ceiling, forbidden-path guard, no-secrets scan, coverage delta, migration-safety check.
- Gates are pass/fail. What is the retry policy — `retries=` is a phase param and appeared as `retries=1` on `document`, and phase chips show `attempt 0/0`. Where's the global bound? README shows `bounded ×3` on the test→fix loop. Pick your numbers deliberately.
- When a gate fails permanently, what happens: abort the run, escalate to a bigger model, or park for a human? Not shown.

### E. Model routing policy and its cost envelope
Two rosters (default + frontier) is the shipped answer. Ask:
- Is two enough, or do you want per-ADW rosters (`adw_scout` never needs a frontier planner) and per-repo rosters?
- Should routing be **static config** (his choice) or **dynamic** (escalate to a stronger model after N gate failures)? Dynamic routing is where his gate/attempt data would pay off, and he doesn't build it.
- The observed spread is ~$0.35 (scout) to ~$2.08 (frontier SDLC) per run. At "hundreds and thousands of executions" that's $350–$2,000 per thousand runs. Set a per-run and per-day budget ceiling — there is no budget cap anywhere in what was shown.
- Local models are on his tier list as the "own-it floor". Which phases can a local/ollama-cloud model actually hold? `commit_plan`, `changes`, `quality` are code, not agents — free. `document` may be the cheapest agent phase to downgrade.

### F. Scope of the initial ADW set
He ships 12 and says the starter tests and plan-quality are wrong for you.
- Which of the 12 do you actually keep? `adw_prompt`, `adw_scout`, `adw_plan_build_test` cover most real use; the rest are compositions.
- Do you add ADWs he doesn't have — `adw_merge`, `adw_triage`, `adw_migrate`, `adw_release`, `adw_bugfix_from_issue`?
- Which phases in *your* SDLC should be `kind="code"` that you're currently tempted to make agents? Apply his test: *is this a known command?* If yes, it's code.

### G. Prompt and envelope contracts
- Envelope types are the API between phases. Adding a field is a breaking change across every ADW that reads it. Decide now whether envelopes are versioned.
- `notes_for_next_agent` is free-text and unvalidated — it's the one place where a phase can inject arbitrary instructions into a downstream agent. Worth a length cap or a sanitiser if agents are ever driven by untrusted input (e.g. an ADW triggered from a public issue).
- Prompt format is Instructions/Variables/Workflow/Report. Keep it or replace it, but pick one and enforce it across all five agents — his `## Hard rules` section exists precisely to enforce this on generated code.

### H. Observability you'd want that he doesn't have
Present: per-phase cost, tokens, context %, tool calls, gates, envelopes, live poll, session gallery. Absent from what was shown:
- Cross-run aggregates (cost per week, gate failure rate by gate, per-model success rate)
- Alerting on a failed or stalled run
- Any auth on `localhost:4601` — fine locally, not fine in the cloud
- Retention/rotation for `sssf.db` and `adw_data/sessions/` (7.74M tokens of events per run adds up fast)

### I. When to actually build this
His own concession (`[23:50]`) is that his demo features didn't need the factory. Decide your **trigger condition** for justifying the investment — his stated one is *"at some point your system will get so large, so complex, that validation will be the only way forward"* (`[24:05]`). Write down what "large and complex enough" means for your repo before you spend weeks on scaffolding.
