# Provider Limits & Model Research — Sizing an Autonomous Multi-Agent Coding Factory

**Researched:** 2026-08-11. **Method:** official docs, official repos, provider pricing/status pages, and the `anthropics/claude-code` issue tracker. Every non-obvious claim carries a source URL. Claims I could not source are marked **NOT VERIFIED** and collected at the end.

---

## Verdict (read this first)

**No subscription provider publishes an account-level concurrent-session cap, and the real ceilings are far lower than the plan price suggests** — Max 20x users hit a 529 throttle at ~4–6 parallel sessions (Anthropic's own docs recommend 3–5 agents), OpenAI defaults subagent fan-out to 6 to avoid tripping its DDoS heuristics, and Ollama Cloud Pro documents a hard 3 concurrent models. **Your "older models give more headroom" strategy is false at the boundary you picked and true one notch lower**: Opus 5 and Opus 4.8 are identical in price and share one "Opus" quota bucket, but Anthropic states Claude 4.7-and-later use a tokenizer producing ~30% more tokens for the same text at the same $/MTok — so Opus/Sonnet **4.6** genuinely stretch a quota further, while the far bigger lever is *tier*, where GPT-5.6 Luna costs 1/25th of Sol and GPT-5.5 costs exactly what Sol does. **Two structural risks outrank all the tuning**: Anthropic's legal page says advertised Pro/Max limits "assume ordinary, individual usage", and `claude -p --bare` — the mode Anthropic recommends for scripted runs and the future default — deliberately ignores OAuth subscription credentials and requires an API key. **The sharpest finding is one you didn't ask for**: DeepSeek's own API publishes **2,500 concurrent requests** on `deepseek-v4-flash` at $0.14/$0.28 per Mtok — three orders of magnitude more width than any flat-rate plan, for a price that makes the flat-rate framing largely moot.

---

## Question 1 — Concurrency and usage headroom per provider

### 1.1 Claude / Claude Code subscription (Max 20x)

#### What is actually documented

| Mechanism | Documented behaviour | Source |
|---|---|---|
| **Session window** | Rolling **5-hour** window. "Your session-based usage limit will reset every five hours." | [What is the Max plan?](https://support.claude.com/en/articles/11049741-what-is-the-max-plan) |
| **Weekly window** | "Max plans also have a weekly usage limit that applies across all models." | same |
| **Opus-specific limit** | A **third, separate** limit. Error string: `You've hit your Opus limit · resets 3:45pm`. Session/weekly limits are shared across all models; the Opus limit applies to Opus only, and `/model` switching keeps you working. | [Claude Code errors](https://code.claude.com/docs/en/errors) |
| **Tier multipliers** | Max 5x = "five times more usage per session than the Pro plan"; Max 20x = "20 times more usage per session". **No absolute numbers are published anywhere.** | [What is the Max plan?](https://support.claude.com/en/articles/11049741-what-is-the-max-plan) |
| **Metering basis** | Not messages. Driven by "Message length, File attachment size, Current conversation length, Tool usage, **Model choice**, **Effort level**, Artifact creation". | [Usage limit best practices](https://support.claude.com/en/articles/9797557-usage-limit-best-practices) |
| **Shared across surfaces** | "Both Pro and Max plans offer usage limits that are shared across Claude and Claude Code, meaning all activity in both tools counts against the same usage limits." | [Use Claude Code with Pro or Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan) |
| **Discretion clause** | "we may limit your usage in other ways, such as weekly and monthly caps or model and feature usage, at our discretion." | [What is the Max plan?](https://support.claude.com/en/articles/11049741-what-is-the-max-plan) |
| **May 6, 2026 change** | Anthropic **doubled Claude Code's five-hour rate limits** for Pro, Max, Team and seat-based Enterprise, and **removed the peak-hours limit reduction**. No numbers given. | [Higher usage limits](https://www.anthropic.com/news/higher-limits-spacex) |
| **Overflow** | Usage credits (pay-as-you-go) via `/usage-credits`. Note: on credits the prompt-cache lifetime **drops from 1 hour to 5 minutes** unless you set `ENABLE_PROMPT_CACHING_1H=1`. | [Manage costs](https://code.claude.com/docs/en/costs) |

**There is no documented concurrent-*session* cap tied to the account or plan.** I searched the Max plan article, the Claude Code usage article, the pricing page, the costs doc, the errors doc, and the legal page. None mentions a per-account concurrency limit.

**But there IS a documented concurrent-*subagent* cap, enforced client-side per session** ([sub-agents](https://code.claude.com/docs/en/sub-agents)) — this matters directly because your agents spawn sub-agents:

| Limit | Default | Env var | Behaviour at the cap |
|---|---|---|---|
| Concurrent subagents **per session** | **20** | `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | Spawning another fails with `Concurrent subagent limit reached`; "the error tells Claude not to retry". Slots free as runs finish. Requires v2.1.217+. `/subtask` forks and resumed subagents occupy slots and can push the count past the limit. |
| Subagent nesting **depth** | **3 layers** below the main conversation | `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | At the limit Claude Code withholds the `Agent` tool, so the subagent does the work itself. (History: v2.1.172–216 defaulted to 5 and was unchangeable; v2.1.217–218 defaulted to 1; v2.1.219 set 3.) |
| Total subagents per session | **none** | — | "There's no limit on the total number of subagents Claude can spawn over a session." |
| Concurrent agents **per workflow run** | **16** | — | *"Up to 16 concurrent agents, fewer on machines with limited CPU cores"* — "Bounds local resource use". A `Large workflow` warning fires above **25 scheduled agents or a projected 1.5M tokens**, but it is advisory and does not pause the run. ([workflows](https://code.claude.com/docs/en/workflows)) |

Two behaviours to design around: **subagents run in the background by default as of v2.1.198**, with a *reduced* built-in tool set (no `Task`-adjacent tools beyond the listed set), and a background subagent that dies on a usage-limit or overload error **"is marked failed"** — while a *foreground* one returns partial output with a cut-off note. In a deterministic Python driver, a silently-failed background subagent is the failure mode most likely to corrupt a phase's output. Agent-team teammates and workflow agents "follow their own limits instead", which are not published.

#### What actually caps concurrency (three separate ceilings)

Anthropic's own error documentation distinguishes three failure modes, and practitioners consistently hit the *second* one first:

1. **Quota** — `You've hit your session limit` / `weekly limit` / `Opus limit`. Token-budget exhaustion. Not concurrency-driven per se, but N parallel agents burn it N times faster. Docs explicitly warn: *"A single burst of heavy activity, such as a large workflow fanout, can exhaust the weekly allowance before the session window resets."* ([errors](https://code.claude.com/docs/en/errors))
2. **Capacity (529)** — `API Error: Repeated 529 Overloaded errors`. Anthropic states this "is **not** your usage limit and doesn't count against your quota", is server-side, and — critically — **"capacity is tracked per model"**, so `/model` switching is a documented mitigation. ([errors](https://code.claude.com/docs/en/errors))
3. **Request-rate (429)** — `Request rejected (429)`. Documented recovery is literally *"Reduce concurrency: Lower `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`; Avoid running many parallel subagents; Switch to smaller model with `/model` for high-volume scripted runs."* ([errors](https://code.claude.com/docs/en/errors))

**Empirical evidence from the official issue tracker** (user reports, not Anthropic statements — treat as *inferred*):

- [Issue #62426](https://github.com/anthropics/claude-code/issues/62426) — "highest paid plan tier", 5–6 concurrent instances, Opus: *"Frequently hitting: API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited... Makes multi-instance Claude Code work effectively non-viable for sustained use even at the top paid tier."* A commenter: *"I have to rate limit to 2 parallel workflows for now which is quite frankly ludicrous for a $200/m subscription."* Another: *"Same problem with 20x Max Plan. Can't use workflows."*
- [Issue #68502](https://github.com/anthropics/claude-code/issues/68502) — ~5–10 parallel sessions with subagent fan-out; the reporter captured **171/171 structured occurrences as `529 overloaded_error`**, and notes it "blocks unrelated sessions (including on other machines), clears after a cooldown, then recurs under sustained parallel load." Subagents **hard-fail without backoff** rather than retrying.
- [Issue #26271](https://github.com/anthropics/claude-code/issues/26271) — Max 20x, three concurrent projects, ~5–6h/day: weekly Opus limit hit **50% by day 2, fully depleted by day 3**.

**Anthropic's own recommended parallelism**, from the agent-teams doc: *"There's no hard limit on the number of teammates, but practical constraints apply... **Start with 3-5 teammates for most workflows.**"* And: agent teams *"use approximately 7x more tokens than standard sessions when teammates run in plan mode."* ([agent teams](https://code.claude.com/docs/en/agent-teams), [costs](https://code.claude.com/docs/en/costs))

#### Levers Anthropic documents for your factory

| Lever | Effect | Source |
|---|---|---|
| `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` | Caps in-session parallel tool calls — the documented fix for 429 | [errors](https://code.claude.com/docs/en/errors) |
| `CLAUDE_CODE_MAX_RETRIES` | Default **10** attempts | [errors](https://code.claude.com/docs/en/errors) |
| `CLAUDE_CODE_RETRY_WATCHDOG=1` | **Retries 429 and 529 indefinitely** instead of failing after max retries — explicitly "for unattended sessions (CI jobs)". **This is the single most important setting for a headless factory.** | [errors](https://code.claude.com/docs/en/errors) |
| **`--fallback-model sonnet,haiku`** (or `fallbackModel` in settings) | **The direct answer to the 529 wall.** "When the primary model is overloaded, unavailable, or returns another non-retryable server error, Claude Code can switch to a fallback model instead of failing the request." Since capacity is tracked per model, this converts a hard 529 failure into a degraded-but-completed run. **Caveat: "Authentication, billing, rate-limit, request-size, and transport errors never trigger a switch"** — so it rescues 529s, not 429s and not quota exhaustion. Chain capped at 3 models; the switch lasts one turn; `/status` does not display it. | [model config](https://code.claude.com/docs/en/model-config) |
| **Per-phase effort** | The biggest quota dial after model tier. `CLAUDE_CODE_EFFORT_LEVEL` takes precedence over everything; `effort` in **skill or subagent frontmatter** overrides the session level per phase. `low`/`medium` are explicitly for "cost-sensitive work". Note `max` and `ultracode` are session-only and rejected in `effortLevel` settings. **Avoid `ultracode` in a factory** — it is exempt from the 20-subagent concurrency cap and orchestrates dynamic workflows, i.e. it removes exactly the guardrail you want. | [model config](https://code.claude.com/docs/en/model-config), [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `ENABLE_PROMPT_CACHING_1H=1` | Keeps 1-hour cache lifetime once you're on usage credits | [costs](https://code.claude.com/docs/en/costs) |
| `--output-format json` | Returns `total_cost_usd` + per-model breakdown per invocation → build your own token-budget governor | [headless](https://code.claude.com/docs/en/headless) |
| `system/api_retry` stream event | With `--output-format stream-json`, emits `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, and `error` category (`rate_limit`, `overloaded`, …) — **this is your live backpressure signal** | [headless](https://code.claude.com/docs/en/headless) |
| Status-line JSON `rate_limits` | **The governor input you want.** A status-line script receives on stdin: `rate_limits.five_hour.used_percentage` and `rate_limits.seven_day.used_percentage` (0–100), plus `rate_limits.five_hour.resets_at` / `.seven_day.resets_at` (Unix epoch seconds). Have your Python scheduler read these and stop spawning above a threshold. **Note: no Opus-specific field is exposed here** — the Opus window is invisible to this signal. | [statusline](https://code.claude.com/docs/en/statusline) |

#### Anthropic's own parallel-session machinery (worth stealing from, or using)

Claude Code already ships a supervisor for exactly your pattern ([agent view](https://code.claude.com/docs/en/agent-view), research preview):

- Background sessions are hosted by a **per-user supervisor process** that survives terminal close; `claude daemon status` reports liveness, PID, socket dir, and live session count.
- **`claude agents --json` prints active sessions as a JSON array and exits** — a ready-made poll target for a Python driver. `--all` includes completed, `--cwd <path>` scopes it.
- Each background session **auto-isolates into a git worktree** under `.claude/worktrees/`, and Claude Code then blocks edits reaching the main checkout "for the session and for any subagents it spawns." Outside a git repo there is **no isolation** — parallel sessions will collide.
- Each session gets `CLAUDE_JOB_DIR` (`~/.claude/jobs/<id>`) for collision-free temp files.

And the quota warning is unambiguous, in Anthropic's own words:

> "**Rate limits apply**: background sessions consume your subscription usage the same as interactive sessions, so **running ten agents in parallel uses quota roughly ten times as fast** as running one."

Note the phrasing: parallelism does not buy you quota efficiency of any kind. Ten workflows finish sooner in wall-clock terms and burn the same weekly allowance ten times faster — which is precisely the mechanism behind the Max-20x "weekly gone in 2–3 days" reports.

#### Two structural risks

**a) `--bare` breaks subscription auth.** Anthropic says `--bare` is "the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release" — and in the same paragraph: *"In bare mode, Claude Code never reads OAuth credentials or the system keychain... bare mode doesn't use your subscription login."* You must set `ANTHROPIC_API_KEY`. So the recommended headless path is **incompatible with flat-rate subscription billing**. ([headless](https://code.claude.com/docs/en/headless))

**b) The policy language.** Anthropic's Claude Code legal page states:

> "Advertised usage limits for Pro and Max plans **assume ordinary, individual usage** of Claude Code and the Agent SDK."
> "**OAuth authentication is intended exclusively for purchasers** of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support **ordinary use**..."
> "Anthropic **reserves the right to take measures to enforce these restrictions and may do so without prior notice**."

([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). A solo engineer running their own factory on their own account is *not* the "third-party developers... route requests through Free, Pro, or Max plan credentials on behalf of their users" case that page prohibits outright — but "ordinary, individual usage" is a judgment call Anthropic reserves, and sustained many-agent parallelism is not obviously ordinary. **This is a real business-continuity risk, not a theoretical one.**

#### The Opus-4.8-vs-Opus-5 quota question — answered

| Claim | Verdict | Evidence |
|---|---|---|
| Opus 4.8 is cheaper against the *subscription quota* than Opus 5 | **False** | The subscription's model-specific bucket is just "Opus" — Anthropic's error doc shows only `You've hit your Opus limit` and **does not distinguish Opus versions**. And the live pricing page confirms **Opus 5, 4.8, 4.7, 4.6 and 4.5 are all $5 / $25 per MTok** with identical cache multipliers and identical $2.50/$12.50 batch rates. ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)) |
| …but *Opus 4.6* really is cheaper per unit of work than 4.7/4.8/5 | **True — this is the real version effect, one notch older than you thought** | Anthropic's pricing page: *"**Claude 4.7 and later models** and Claude Mythos Preview use a newer tokenizer... This tokenizer produces **approximately 30% more tokens for the same text**. Claude Sonnet 4.6 and earlier models use the previous tokenizer."* Same $/MTok, ~30% more tokens ⇒ **Opus 4.6 does roughly 30% more work per unit of quota than Opus 4.7/4.8/5** on identical input. The same boundary separates Sonnet 4.6 from Sonnet 5. Weigh against 4.6's lower capability and its 4096-token prompt-cache minimum (vs 512 on Opus 5). |
| Older Opus gives more *capacity* headroom | **Partly true** | For 529 overload, Anthropic states "capacity is tracked per model" and recommends `/model` switching. ([errors](https://code.claude.com/docs/en/errors)) |
| Opus 5 and Opus 4.x are separate rate-limit buckets | **True — but on the API, not the subscription** | Footnote on the API rate-limits page: *"Opus rate limit is a total limit that applies to combined traffic across Claude Opus 4.8, Opus 4.7, Opus 4.6, and Opus 4.5. **Claude Opus 5 has a separate rate limit and is not part of this combined bucket.**"* Same for Sonnet 5 vs Sonnet 4.x. ([rate limits](https://platform.claude.com/docs/en/api/rate-limits)) |
| There is *some* reason to keep Opus 4.8 configured | **True, but not for quota** | Opus 5 runs cybersecurity/biology safety classifiers. **"Opus 5: cybersecurity-flagged requests re-run on Opus 4.8."** Biology-flagged requests just refuse. If your factory touches security-adjacent code, Opus 4.8 is the documented rescue target — and if you restrict `availableModels` and block it, "no fallback occurs" and you get a hard refusal. ([model config](https://code.claude.com/docs/en/model-config)) |
| Newer models use fewer tokens per unit of work | **False, sometimes inverted** | Opus 4.7 introduced a new tokenizer: the same text tokenizes to roughly **1×–1.35×** as many tokens as on Opus 4.6. Sonnet 5 is **~30% more tokens** than Sonnet 4.6 for the same text. Opus 5 also **turns thinking on by default** where Opus 4.8 did not — a silent per-request cost increase. |

**Anthropic does weight quota by model — but by capability tier, not by vintage.** The clearest documented proof is the Fable 5 article:

> "Fable 5 draws from your plan's regular weekly usage limits and **uses them faster than other Claude models**." / "you can use up to **50% of your weekly usage limits** on Fable 5 at no extra cost" / "When you reach your Fable 5 limit, you can keep using Fable 5 with usage credits, or switch to another model."

([Claude Fable 5 on your plan](https://support.claude.com/en/articles/15424964-claude-fable-5-on-your-plan)). So the subscription has at least **four** buckets: session, weekly, Opus-only, and Fable-only (50% sub-cap). Every one of them is drawn along a price/capability axis — **none along a version axis**.

**The lever that actually works is tier, not vintage: Fable → Opus → Sonnet → Haiku.** The Opus bucket is separate from the general session/weekly bucket, so routing non-critical phases to Sonnet leaves the Opus allowance intact for the phases that need it. Anthropic's own guidance: *"Sonnet handles most coding tasks well and costs less than Opus. Reserve Opus for complex architectural decisions."* ([costs](https://code.claude.com/docs/en/costs)) For subagents specifically, Anthropic recommends `model: haiku`.

---

### 1.2 `pi-claude-bridge`

**The repo is not Mario Zechner's.** Corrections to your premises:

- `pi` lives at **[github.com/earendil-works/pi](https://github.com/earendil-works/pi)** (87.5k stars), *not* `mariozechner/pi-coding-agent` — that path 404s.
- `pi-claude-bridge` is **[github.com/elidickinson/pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge)** by Eli Dickinson, a fork of `prateekmedia/claude-agent-sdk-pi`. npm: [`pi-claude-bridge`](https://www.npmjs.com/package/pi-claude-bridge).

**How it works** (from the [README](https://raw.githubusercontent.com/elidickinson/pi-claude-bridge/main/README.md)): a pi extension that integrates Claude Code via the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). It spawns the `claude` binary as a subprocess (`provider.pathToClaudeCodeExecutable` is configurable) and bridges pi's tools into it. Two surfaces: a **provider** (`claude-bridge/<model>` in `/model`) and an opt-in **AskClaude tool** for delegation from another provider.

**Models exposed:** `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5`.

**Does it inherit the subscription's limits? Yes — confirmed on both sides.**

- README: *"It currently uses your regular subscription quota just like Claude Code."*
- Anthropic: *"We're pausing the changes to Claude Agent SDK usage described below. For now, nothing has changed: **Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits.**"* ([Use the Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), last updated 2026-06-15)

So the bridge gives you **no extra headroom** — it is the same account, the same 5-hour/weekly/Opus buckets, the same 429/529 ceilings.

**Concurrency: not documented.** The README says nothing about concurrent sessions, rate limits, or 429 handling. **NOT VERIFIED.** Structurally it inherits whatever the Agent SDK subprocess does, so the Claude Code numbers above should apply.

**Cost gotcha you should know about before building on it.** The README's own "Known issues":

> "**Sessions get rebuilt more often than they need to be, and a rebuild is expensive.** ... Measured over this repo's own bridge log, a rebuild boundary loses the prompt cache roughly **58% of the time** against **26%** for a plain resume, so an abort-heavy session costs noticeably more than a clean one. Aborts alone are 46% of rebuilds."

For a factory where deterministic Python drives phases and may abort/restart agents, that is a direct multiplier on quota burn. Also: *"Files Claude Code edits are not carried across a rebuild."*

**Also relevant:** Anthropic's paused-change article notes that *"Teams running shared production automation should use Claude Platform with an API key for predictable pay-as-you-go billing"* — a signal about intent even while the metering change is paused. And the Agent SDK overview carries a standing warning aimed squarely at tools of this shape:

> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits **for their products**, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead." ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview))

Read carefully, that prohibits *offering* subscription login to other people's users — which is not what you are doing on your own account. But it is the same clause under which the bridge's whole mechanism operates, so treat continued subscription support in `pi-claude-bridge` as a policy that could change without notice, and keep an API-key code path ready.

---

### 1.3 Ollama Cloud

**The paid plan is $20/mo Pro** ([ollama.com/pricing](https://ollama.com/pricing)):

| Tier | Price | Concurrent cloud models | Usage |
|---|---|---|---|
| Free | $0 | 1 | "Light usage" |
| **Pro** | **$20/mo** ($200/yr) | **3** | "50x more cloud usage than Free" |
| Max | $100/mo | 10 | "5x more than Pro" — **new sign-ups paused** |
| Team | $25/seat/mo, 5-seat min | not stated | waitlist only |

Max is closed: *"demand is growing faster than we can add capacity... new Max subscriptions are paused."* **So $20 Pro / 3 concurrent slots is effectively your ceiling today.**

**Concurrency is DOCUMENTED and it is the binding constraint:**

> "Concurrency limits ensure dedicated capacity for workflows that need multiple models running simultaneously... **Requests beyond your plan's concurrency limit are queued and processed as soon as a slot is available. Queued requests are held up to a fixed limit — if the queue is full, the request will be rejected until one of your concurrency slots opens.**"

**Ambiguity to resolve empirically:** the heading says concurrent *models*, the body says *requests* beyond the limit get queued. Whether Pro's 3 means "3 in-flight requests" or "3 distinct model tags" is a ~10× difference in factory width. Queue depth ("a fixed limit") is **NOT VERIFIED** — no number published.

**Token/request caps: none published at all.** *"Each plan has session limits that reset every 5 hours and weekly limits that reset every 7 days... **They don't cap you at a fixed number of tokens** because different models use different amounts of compute."* Instead there is a per-model **"usage level" 1–4**, which is the only quota-weighting signal Ollama gives you. Verified on the model pages:

| Ollama Cloud tag | Usage level | Context | Note |
|---|---|---|---|
| `deepseek-v4-flash:cloud` | **medium** | — | cheapest of your candidates against the pool |
| `qwen3.5:397b-cloud` | **medium** | 256K | sparse MoE w/ Gated Delta Networks; also `qwen3.5:cloud` (same digest) |
| `minimax-m3:cloud` | **high** | 1M (512K guaranteed via Ollama) | your proposed scout is the *second-most* expensive option here |
| `deepseek-v4-pro:cloud` | **extra high** | — | avoid for bulk work |

**Routing implication:** on a 3-slot Ollama Pro plan, a MiniMax M3 scout costs meaningfully more of the weekly pool than a DeepSeek V4 Flash or Qwen 3.5 scout, and `deepseek-v4-pro` is the worst possible choice for high-volume phases. (Note: the historical hourly/daily limit documentation is gone — the scheme is now 5-hour + weekly.)

**429 is documented** ([docs.ollama.com/api/errors](https://docs.ollama.com/api/errors)); rate-limit headers (`X-RateLimit-*`, `Retry-After`) are **NOT VERIFIED**.

**Account sharding is prohibited:** *"Can I have multiple Ollama accounts? **No. Ollama is one account per person.**"*

**Your roster, verified against [ollama.com/search?c=cloud](https://ollama.com/search?c=cloud):**

| You listed | Status | Correct tag |
|---|---|---|
| `deepseek-v4-flash` | exists | `deepseek-v4-flash:cloud` |
| `deepseek-v4-pro` | exists | `deepseek-v4-pro:cloud` |
| `qwen3.5:397b` | **wrong tag — will fail** | `qwen3.5:397b-cloud` (alias `qwen3.5:cloud`) |
| MiniMax | two exist | `minimax-m3`, `minimax-m2.7` |

Full current cloud roster: `glm-5.2`, `deepseek-v4-flash`, `kimi-k3`, `gemma4`, `qwen3.5`, `glm-5.1`, `minimax-m2.7`, `nemotron-3-super`, `minimax-m3`, `kimi-k2.7-code`, `kimi-k2.6`, `deepseek-v4-pro`, `nemotron-3-ultra`, `nemotron-3-nano`, `mistral-large-3`, `gpt-oss`. `minimax-m2.5` and `kimi-k2.5` were **retired 2026-07-31**. Naming trap: the direct `ollama.com/api/*` path uses bare tags; the `-cloud` suffix is for the local daemon's offload path.

**Privacy:** *"Prompt or response data is never logged or trained on"*, NCP partners under "no logging, no training, and zero data retention." Hosted "primarily in the United States", may route to Europe/Singapore — **no region pinning on Pro**. Team tier adds ZDR as a contractual bullet; individual tiers get a policy statement, not a signed DPA.

---

### 1.4 OpenCode Zen vs OpenCode **Go** — you conflated two products

**OpenCode Zen is NOT a subscription.** It is a pay-as-you-go AI gateway: *"You are charged per request and you can add credits to your account... We support a **pay-as-you-go** model."* ([opencode.ai/docs/zen](https://opencode.ai/docs/zen/)) Auto-reloads $20 when balance drops below $5. Sold at cost. **It fails your flat-rate framing entirely.**

**OpenCode Go IS the $10/month subscription** ([opencode.ai/docs/go](https://opencode.ai/docs/go)) — $5 first month, then $10/mo. Provider prefix `opencode-go/<model-id>`; endpoint `https://opencode.ai/zen/go/v1/`. **It is the best-documented option in this entire report:**

> - **5 hour limit — $12 of usage**
> - **Weekly limit — $30 of usage**
> - **Monthly limit — $60 of usage**
>
> "Limits are defined in dollar value. This means your actual request count depends on the model you use." / "we aim to give you 6x that in usage."

Documented per-model request estimates per 5-hour window (their table, labelled estimates):

| Model | req / 5h | req / week | req / month |
|---|---|---|---|
| DeepSeek V4 Flash | 31,650 (63,300 during current 2× promo) | 79,050 | 158,150 |
| MiMo-V2.5 | 30,100 | 75,200 | 150,400 |
| DeepSeek V4 Pro | 3,450 | 8,550 | 17,150 |
| MiniMax M3 | 3,200 | 8,000 | 16,000 |
| GPT 5.6 Luna | 2,050 | 5,100 | 10,250 |
| Kimi K2.7 Code | 1,350 | 3,380 | 6,750 |
| GLM-5.2 / 5.1 | 880 | 2,150 | 4,300 |
| Grok 4.5 | 120 | 300 | 600 |
| **Kimi K3** | **110** | 250 | 490 |

**Overflow behaviour is exactly what a factory wants:** *"If you also have credits on your Zen balance, you can enable the **Use balance** option... Go will fall back to your Zen balance after you've reached your usage limits instead of blocking requests."* Flat-rate floor + metered safety valve.

**Concurrency for Zen and Go: NOT VERIFIED.** No documented RPS cap, concurrent-connection limit, 429 semantics, or rate-limit headers anywhere on `/docs/zen`, `/docs/go`, `/docs/providers`, `/docs/troubleshooting`, `/docs/config`, `/zen`, `/go`, or `/enterprise`. The only documented limits are spend/usage.

**"opencode-go" naming, resolved.** Three different things get confused:
1. `opencode-ai/opencode` — a **Go** TUI agent, **archived**; continued as `charmbracelet/crush`.
2. `charmbracelet/crush` — the Go continuation.
3. `sst/opencode` → now **`anomalyco/opencode`** (TypeScript) — the live project behind opencode.ai.

**There is no Go-language port called "opencode-go."** The string is the *provider ID for the OpenCode Go subscription*.

**Go privacy:** all models "Not used" for training; 0-day retention except Grok 4.5 and GPT 5.6 Luna (30-day abuse monitoring). **DeepSeek V4 Flash's ZDR agreement is renewed monthly and is valid only through 2026-08-31** — 20 days out. Re-check before routing proprietary code there.

---

### 1.5 OpenAI Codex on ChatGPT subscriptions

**Docs moved:** `developers.openai.com/codex/*` now 301s to **`learn.chatgpt.com/docs/*`**. Canonical pages: [pricing/limits](https://learn.chatgpt.com/docs/pricing), [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan), [Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card). Append `.md` to any docs URL for markdown; index at `learn.chatgpt.com/llms.txt` — useful for scripted monitoring.

**Your model names are CONFIRMED.** GPT-5.5 and GPT-5.6 Sol / Terra / Luna are all real. GPT-5.6 launched **2026-07-09**; Luna's price dropped 80% and Terra's 20% on **2026-07-30**. Model IDs: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-cyber`, `gpt-5.3-codex-spark` (Pro only, separate limit).

**Metering: two layers running simultaneously.** (a) message counts per **rolling 5-hour window**, published as ranges per model per plan; (b) **credits** derived from token usage — OpenAI replaced per-message pricing with token-based credit metering on **2026-04-02**. A weekly window exists (the CLI renders a `Weekly limit` row) but **its allowance is never published — NOT VERIFIED.**

**Local messages per 5-hour window** ([pricing](https://learn.chatgpt.com/docs/pricing)):

| Model | Plus ($20) | Pro 5x ($100) | Pro 20x ($200) | Business |
|---|---|---|---|---|
| GPT-5.6 Sol | 10–100 | 50–500 | 200–2,000 | 10–100 |
| GPT-5.6 Terra | 25–200 | 125–1,000 | 500–4,000 | 25–200 |
| **GPT-5.6 Luna** | **250–2,000** | **1,250–10,000** | **5,000–40,000** | **250–2,000** |
| GPT-5.5 | 15–80 | 75–400 | 300–1,600 | 15–80 |

Two structural notes: *"The usage limits for local messages and cloud chats **share a five-hour window**."* And — the most important sentence in the document for you — ***"For Enterprise/Edu users with flexible pricing, there are no fixed rate limits — usage scales with credits."*** Also note **a Business seat gets identical per-seat limits to $20 Plus**; Business buys admin controls, not throughput.

**Concurrency: no account-level cap documented** (checked `/docs/pricing`, `/docs/cloud`, `/docs/codex-sdk`, `/docs/non-interactive-mode`, `/docs/automations`, `/docs/enterprise/usage-limits`, and the `openai/codex` repo + `docs/`). **NOT VERIFIED / NOT DOCUMENTED.**

**But there is one hard number, and it is the best available signal about backend tolerance.** `codex-rs/core/src/config/mod.rs`: `DEFAULT_AGENT_MAX_THREADS: Option<usize> = Some(6)`. An OpenAI maintainer on [issue #11083](https://github.com/openai/codex/issues/11083):

> "This is likely because you're running 25 subagents. This may produce enough requests that it will look like a **DDoS attack to our backend**. That could result in 429s. **By default, we cap the number of agents at 6 for this reason.**"

Configurable via `features.multi_agent_v2.max_concurrent_threads_per_session`; the CLI warns above 8.

**Codex's quota telemetry is the best of any provider here** — build your admission control on it:
- **`account/rateLimits/read`** JSON-RPC on the app-server → `rateLimits`, `rateLimitsByLimitId`, `rateLimitResetCredits`. Typed in the official Python SDK (`RateLimitSnapshot`, `RateLimitWindow` with `usedPercent` / `windowDurationMins` / `resetsAt`, `CreditsSnapshot`).
- Response headers: `x-codex-primary-used-percent`, `x-codex-secondary-used-percent`, `x-codex-primary-reset-at`, `x-codex-limit-name`, `x-codex-rate-limit-reached-type`, `x-codex-credits-balance`, `x-codex-credits-unlimited`.
- A streaming `codex.rate_limits` SSE event carries the same payload; `/status` renders it interactively.

**⭐ Do older/smaller models consume less quota? On Codex, YES — explicitly and enormously.** Credits per 1M tokens ([rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)):

| Model | Input | Cached input | Output | Output vs Sol |
|---|---|---|---|---|
| GPT-5.6 Sol / GPT-5.5 | 125 | 12.5 | 750 | 1× |
| GPT-5.5 Cyber | 312.5 | 31.25 | 1,875 | 2.5× |
| GPT-5.6 Terra | 50 | 5 | 300 | **0.4×** |
| **GPT-5.6 Luna** | **5** | **0.5** | **30** | **0.04× — 25× cheaper** |

The message-count table mirrors this exactly (Luna = 25× Sol's messages on every plan), so the two systems are consistent. OpenAI says it outright: *"Switch to a smaller model for routine tasks. Using GPT-5.6 Terra or GPT-5.6 Luna can extend your local-message usage limits."* **Note the axis is again capability tier, not vintage — GPT-5.5 costs exactly the same as GPT-5.6 Sol.** Multipliers that cut the other way: fast mode "consumes credits at a higher rate"; image generation burns limits **3–5× faster**; ultra reasoning spawns subagents. Cache writes are free and cached reads are 10× cheaper than fresh input.

**Overflow is fully documented** ([Using credits](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-freegopluspro)): Plus/Pro can buy credits on hitting limits; **auto top-up with a maximum monthly spend** exists (wire this up and cap it); credits expire 12 months; balances **can go negative** — *"If a task starts while your balance is positive but finishes after **concurrent usage** depletes it, your balance can go negative"* — an official acknowledgement that concurrent usage is expected. All users may run extra local chats with an API key at standard rates.

**🔴 Time-critical: GPT-5.4 and GPT-5.4-mini are removed from Codex on 2026-08-31 — 20 days out.** *"Update any workspace defaults, saved model settings, managed configurations, or automations before August 31."* Replace with Terra / Luna respectively. Your own API key is unaffected; only ChatGPT sign-in.

**Structural escape hatch.** Three non-equivalent paths: Plus/Pro/Business seats (fixed windows); **Enterprise/Edu/Gov/Health flexible pricing — "no fixed rate limits"** plus *priority request processing*; and the usage-based Business Codex seat, which **closed to new workspaces on 2026-06-24**. Enterprise/Business also unlock **Codex access tokens** — credentials explicitly for *"trusted non-interactive local workflows, including Codex CLI and app-server-based automation"* ([docs](https://learn.chatgpt.com/docs/enterprise/access-tokens)). That is the officially-blessed credential for exactly your architecture, and it is not available on Plus/Pro.

**ToS exposure** ([Pro tiers](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-plans)): prohibits "abusive usage, such as automatically or programmatically extracting data", "sharing your account credentials", and "reselling access or using ChatGPT to power third-party services". Headless automation itself is plainly sanctioned (OpenAI ships `codex exec`, SDKs, GitHub Actions recipes, access tokens). The risk is credential sharing and powering third-party services; the practical enforcement surface is the DDoS heuristic above.

---

### 1.6 xAI / Grok

**Two facts invalidate anything you knew before May 2026:**
1. The official coding agent is **"Grok Build"** (binary `grok`) at [github.com/xai-org/grok-build](https://github.com/xai-org/grok-build) (Apache-2.0, Rust), announced [2026-07-15](https://x.ai/news/grok-build-open-source) — **not** "grok-cli".
2. **`grok-code-fast-1` is retired**, now aliasing `grok-build-0.1`. Also gone: `grok-4-fast-*`, `grok-4-1-fast-*`, `grok-4-0709`, `grok-3` — all silently redirect to `grok-4.3` **at grok-4.3 pricing** ([May 15 retirement](https://docs.x.ai/developers/migration/may-15-retirement)). Grep your config.

**Limits are measured as a weekly pooled compute budget, expressed only as a percentage** ([docs.x.ai/grok/faq](https://docs.x.ai/grok/faq), updated 2026-07-06):

> "you get **one shared weekly usage pool** that you can spend however you like across any Grok product." / "The usage pool is shown as a **percentage used**." / "Different products cost different amounts... A chat message uses little compute; **running a long coding task uses far more**."

**🔴 xAI publishes ZERO numeric subscription limits.** No queries/hour, no token allowance, no credit count, for any tier (Free, SuperGrok Lite, SuperGrok $30, SuperGrok Plus $100, SuperGrok Heavy, Business, Enterprise). [x.ai/pricing](https://x.ai/pricing) uses only comparative prose. Numbers circulating on third-party blogs are non-official, mutually contradictory, and several still describe the retired Grok 4 Heavy and pre-June-2026 daily limits. **Do not plan capacity against them.**

**⭐ Unlike Codex, a Grok subscription DOES grant agentic-coding access with no API key** — and xAI explicitly supports headless/VPS auth. Verbatim from [x.ai/news/grok-opencode](https://x.ai/news/grok-opencode):

> Pick the sign-in method that fits your setup — **both use your Grok subscription**: xAI Grok OAuth (SuperGrok Subscription); **xAI Grok OAuth (Headless / Remote / VPS)** — prints a code and URL for SSH or remote hosts.

Grok Build is fully headless: `grok -p`, `--output-format plain|json|streaming-json`, `--session-id`/`--resume`/`--continue`, `--always-approve`, and `grok agent stdio` (JSON-RPC/ACP).

**But it is a different inference plane from the pay-per-token API** ([docs.x.ai/build/enterprise](https://docs.x.ai/build/enterprise)):

| | Subscription plane | API plane |
|---|---|---|
| Endpoint | `cli-chat-proxy.grok.com` | `api.x.ai/v1` |
| Auth | OAuth / device code | `xai-...` API key |
| Billing | Weekly usage pool (flat) | Per-token |
| Published limits | **none** (percentage only) | full RPS/TPM tables |

Credential precedence is `model.api_key` > `model.env_key` > active session token > `XAI_API_KEY`, so a hybrid fleet is natively supported.

**Concurrency: no text-model concurrency limit documented — only RPS and TPM, and only on the API plane.** ([rate limits](https://docs.x.ai/developers/rate-limits)) Tier 0 → Tier 4 unlocks by cumulative spend and never downgrades: `grok-4.5` 150→500 RPS / 50M→100M TPM; `grok-build-0.1` and `grok-4.3` 37→208 RPS / 10M→85M TPM. **Gotcha: "Cached prompt tokens still count toward TPM"** — caching cuts cost but gives zero TPM relief, the opposite of Codex. Interestingly, xAI *does* model concurrency explicitly, but only for voice: realtime/TTS/STT models carry `"basis": "CONCURRENCY"` with `concurrentSessions` tiers 10→400. Text models carry no such field.

**Evidence xAI expects heavy parallelism on subscriptions:** [Workflows](https://x.ai/news/workflows) (2026-07-23) *"fans it out across hundreds of parallel agents... Runs get a budget of **128 agents, and up to 1,024** for big jobs"* — the only hard concurrency figure xAI publishes. Subagents: "Each child runs in parallel with its own context window", **no cap documented**. Background tasks: "at most **50 scheduled tasks** can be active at once."

**429s come in three flavours** — the Grok Build changelog v0.2.101 notes rate-limit errors "now show specific server messages (**capacity, team limits, free-usage**)... with correct copy based on auth type." None are numerically documented.

**No quota telemetry at all.** A grep of the full xAI docs corpus (`docs.x.ai/llms.txt`, ~1.4M chars) for `x-ratelimit`, `Retry-After`, `max concurrent` returned **zero hits**. xAI's own recommended handling is blind exponential backoff. No live-quota endpoint; the consumer weekly percentage is UI-only. **This is a decisive operational disadvantage versus Codex.**

**⚠️ AUP conflict, materially worse than OpenAI's.** [x.ai/legal/acceptable-use-policy](https://x.ai/legal/acceptable-use-policy) (effective 2026-06-26) prohibits *"**Accessing the Services through automated or non-human means, whether through a bot, script, or otherwise**"* and *"circumventing any rate limits or restrictions"*. The clause is **unscoped** — nothing carves out xAI's own first-party CLI, even though xAI ships headless mode, ACP, device-code VPS auth, and 1,024-agent Workflows. The Enterprise ToS governing the API path is the cleaner legal footing.

**Model IDs** ([models](https://docs.x.ai/developers/models)): `grok-4.5` (500k ctx, $2.00/$6.00, cached in $0.30 — aliased by `grok-build-latest`), `grok-build-0.1` (256k, $1.00/$2.00, aliased by `grok-code-fast-1`), `grok-4.3` (1M, $1.25/$2.50), `grok-4.20-*` variants. **Pin dated slugs** — bare names float. Operational footnote: SSE per-chunk idle timeout defaults to **600s**; set any intermediary proxy idle timeout ≥10 min or you'll see phantom mid-response disconnects. Pass `--no-auto-update` in headless runs.

---

### 1.7 Not in your brief, but it should be: Alibaba Model Studio **Coding Plan**

You didn't ask about this one, and it has the clearest published request budget of any flat-rate plan in this report ([Coding plan docs](https://www.alibabacloud.com/help/en/model-studio/coding-plan)):

- **$50/month, Pro tier** (the Lite tier stopped accepting new subscriptions on 2026-03-20).
- **Limits are request-denominated, not dollar- or token-denominated:** **6,000 requests / 5 hours**, **45,000 / week**, **90,000 / month**. 5-hour quotas roll over automatically; weekly resets Monday 00:00 UTC+08:00; monthly resets on the renewal date.
- Quota consumption is by model call: *"Simple tasks typically use 5–10 calls, while complex tasks may use 10–30 or more."* So 6,000 req/5h ≈ **200–1,200 complete agent tasks per 5-hour window**.
- **No concurrency limit stated** — but *"Slots are limited and available on a first-come, first-served basis."*

**Why this matters for your sizing:** because the budget is *requests*, not dollars, an expensive model costs no more against the plan than a cheap one — the exact inverse of OpenCode Go, where Kimi K3 gets 110 requests per 5 hours and DeepSeek V4 Flash gets 31,650. If your phases are few-call-but-heavy, request-denominated is strictly better for you.

**Caveats:** the documented model list reads stale — `qwen3.7-plus`, `qwen3.6-plus`, `kimi-k2.5`, `glm-5`, `MiniMax-M2.5`, plus `qwen3.5-plus`, `qwen3-coder-next`, `qwen3-coder-plus` — and does **not** list Qwen3.8-Max, which only launched 2026-08-03. Whether the newest models are in-plan is **NOT VERIFIED**. Also unverified: concurrency, 429 semantics, rate-limit headers, and data-retention terms for proprietary code.

### 1.8 Also not in your brief: the **MiniMax Token Plan** — the clearest budget of any flat-rate plan here

From MiniMax's own [M3 launch post](https://www.minimax.io/blog/minimax-m3) ([subscribe page](https://platform.minimax.io/subscribe/token-plan)):

| Tier | Price | M3 tokens / month |
|---|---|---|
| Plus | **$20/mo** | **~1.7 B** |
| Max | **$50/mo** | **~5.1 B** |
| Ultra | **$120/mo** | **~9.8 B** |

**This is the only flat-rate plan in the entire report that states its budget in tokens.** No percentage-of-an-unpublished-pool (xAI), no "20× an undefined baseline" (Anthropic), no ranges spanning 10× (Codex). 1.7B tokens/month ≈ 2.4M tokens/hour sustained — enough for roughly 17,000 scout calls a month at 100K tokens each.

**Caveats:** no concurrency figure, no per-window (5h/weekly) breakdown, and no 429 semantics are published — **NOT VERIFIED**. And the 512K cliff below applies to plan usage as much as to PAYG.

### 1.9 Per-provider concurrency table — the key deliverable

| Provider | Documented limit | Inferred concurrent agent sessions | Confidence | What to measure |
|---|---|---|---|---|
| **Claude Max 20x** | 4 quota windows (5h, weekly, Opus-only, Fable 50%). **No account-level session-concurrency cap published.** Client-side: **20 concurrent subagents/session** (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), **depth 3**. 5h limits doubled 2026-05-06. | **~3–5 top-level sessions sustained; ~2 if all-Opus.** Anthropic's agent-teams guidance says "start with 3–5 teammates". Max-20x users report 529 storms at 5–6 and one settling at 2. The 20-subagent cap is *not* your ceiling — the server-side 529 wall arrives long before it. | **Subagent cap: documented. Session concurrency: inferred, medium** | Ramp 1→8 parallel `claude -p` runs; plot `claude_code.api_error{status_code}` (429 vs 529) and `system/api_retry` `error` category against worker count. Run once all-Opus, once all-Sonnet. |
| **pi-claude-bridge** | None of its own. Inherits the Claude subscription's limits (confirmed by Anthropic + README). | Same as Claude Code, **minus** the session-rebuild cache tax (58% cache loss at rebuild boundaries vs 26% for plain resume). | **Inheritance: documented. Concurrency: unknown** | Whether N bridge instances each spawn an independent `claude` subprocess (likely) and whether they contend; measure rebuild frequency in `~/.pi/agent/claude-bridge.log`. |
| **Ollama Cloud Pro ($20)** | **3 concurrent cloud models** (hard, published). Excess queued to an unpublished depth, then rejected. 5h + weekly windows, **no numeric token caps published at all.** | **3 generating agents.** Maybe 6–10 *logical* sessions if they spend most wall-clock in tool execution and ride the queue — but queue depth is unknown. | **Concurrency: documented. Budget: unknown** | Does "3" gate requests or model tags? Fire 6 concurrent requests to one model, then to three. Then measure queue depth before rejection, and whether any undocumented `Retry-After`/`X-RateLimit-*` headers come back. |
| **OpenCode Go ($10)** | **No concurrency cap documented** (absent, not "unlimited"). Hard throughput: **$12/5h, $30/wk, $60/mo**. | Width unknown; **throughput** is the real wall. ~31,650 req/5h on DeepSeek V4 Flash ≈ **1.76 req/s sustained**; DeepSeek V4 Pro ≈ 0.19 req/s; **Kimi K3 ≈ 1 request per 2.7 minutes.** | **Throughput: documented. Concurrency: unknown** | Ramp 5→10→25→50 parallel and watch for 429/connection resets — **this is the single biggest unknown in the whole report.** Also validate their cached-token assumption (50k–86k cached/req); a cold-cache workload burns the $12 far faster. |
| **OpenCode Zen** | Pay-per-token credits, not a subscription. No rate/concurrency limits documented. | N/A for a flat-rate design; useful only as Go's overflow valve. | **Documented: pricing only** | Same ramp test; capture headers. |
| **MiniMax Token Plan ($20 / $50 / $120)** | **~1.7 B / 5.1 B / 9.8 B M3 tokens per month** — the only flat-rate plan here that states a token budget. No concurrency, window breakdown, or 429 semantics published. | ~2.4M tokens/hour sustained on the $20 tier ≈ **~17,000 scout calls/month** at 100K tokens each. Concurrency **unknown**. | **Budget: documented. Concurrency: unknown** | Ramp concurrency to find the wall. Confirm whether the >512K long-context tier is reachable on a plan (it is access-limited on PAYG) and that plan tokens are metered at the same 2× above 512K. |
| **DeepSeek direct API** (not flat-rate, but read this row) | **2,500 concurrent requests on `deepseek-v4-flash`; 500 on `deepseek-v4-pro`** — published on the pricing page. | **2,500.** The only provider here that documents concurrency in the thousands rather than the single digits. | **Documented** | Whether the published concurrency holds in practice, and your real cache-hit ratio (cache-hit input is 50× cheaper than cache-miss — it dominates your cost model). |
| **Alibaba Coding Plan ($50)** | **6,000 req / 5h**, 45,000 / week, 90,000 / month — **request-denominated, model-agnostic**. No concurrency limit stated ("slots are limited, first-come first-served"). | **~200–1,200 complete tasks per 5h window** at the docs' own 5–30 calls/task. Width unstated; budget is generous enough that concurrency, not budget, would likely bind. | **Budget: documented, unusually clearly. Concurrency: unknown** | Ramp concurrency to find the wall; confirm whether Qwen3.8-Max is in-plan (the docs list only up to qwen3.7-plus); check data-retention terms before sending proprietary code. |
| **OpenAI Codex Pro 20x** | 5h rolling window, message ranges **published per model per tier**. Weekly window exists, allowance **not published**. **No account concurrency cap.** Subagent fan-out default **6**. | **~6–15 concurrent on Luna/Terra; ~1–2 on Sol.** Budget math on Pro 20x + Luna (5,000–40,000 msgs/5h ÷ ~300 msgs/session) allows 17–133, but OpenAI's own 6-agent default exists *specifically* to avoid tripping DDoS heuristics — treat single digits of in-flight requests as the engineering ceiling and scale by duty cycle. | **Budget: documented. Concurrency: inferred, moderate** (published ranges span 8–10×) | Ramp `codex exec` 1→2→4→8→16 and record where 429 trips, capturing `x-codex-rate-limit-reached-type`. Also: does the 6-agent cap apply across separate CLI processes or per-process? And what is the weekly allowance in credits (burn a known workload, diff the `secondary` window)? |
| **xAI Grok (consumer sub)** | **Nothing numeric published at any tier.** One weekly pooled compute budget, shown only as % used. No RPS/TPM/concurrency figures. | **UNKNOWN — genuinely.** Limits are weekly-pooled *compute*, so parallelism is bounded by total burn rate, not session count (50 sessions × 2h ≈ 5 × 20h). Failure mode is exhausting the week and hard-pausing, not a concurrency wall. xAI's own Workflows run 128–1,024 agents on subscription accounts, so dozens of concurrent sessions look within design intent. | **Unknown** | Instrument one session and diff the Settings→Usage percentage to size the pool in real tokens; find the exact reset instant; ramp `grok -p` and capture the 429 body (it names `capacity`/`team limits`/`free-usage`); check the wire for undocumented `x-ratelimit-*` headers (absence from docs ≠ absence in responses). |
| **xAI Grok (API plane)** | Tier 0 `grok-4.5`: 150 RPS / 50M TPM, rising to 500 / 100M at Tier 4. | **~100–500 concurrent on `grok-4.5` at Tier 0.** TPM is the binding dimension, not RPS: at ~100k avg context × 2 turns/min ≈ 220k TPM/session, 50M ÷ 220k ≈ 225 sessions. Swings ±3× on context length. | **Limits: documented. Session count: inferred** | Your actual avg context and turns/min — the whole estimate hinges on them. Note cached tokens still count toward TPM. |

### 1.10 How to measure Claude concurrency empirically (Anthropic gives you the instruments)

You do not have to guess. Claude Code exports OpenTelemetry events that separate the three ceilings cleanly ([monitoring usage](https://code.claude.com/docs/en/monitoring-usage)):

- **`claude_code.api_error`** — attributes include **`status_code`** (a number: 429 vs 529 vs 5xx), **`attempt`** (total attempts including the initial), `model`, `duration_ms`, `request_id`, **`query_source`** (`"repl_main_thread"`, `"compact"`, or a subagent name — so you can tell whether subagent fan-out or the main thread is triggering the throttle), and `effort`. Note Claude Code emits this **only after it gives up retrying**, so it is a terminal signal, not a per-attempt one.
- **`claude_code.api_retries_exhausted`** — `total_attempts`, `total_retry_duration_ms`, `status_code`.
- **`claude_code.token.usage`** / **`claude_code.cost.usage`** — segmentable by `model`, `agent.name`, `skill.name`, `plugin.name`. Filter to `query_source == "main"` to avoid attributing subagent burn to the wrong phase.

**The experiment to run:** ramp parallel `claude -p` workers 1 → 2 → 4 → 6 → 8, holding phase and model fixed, and plot the rate of `api_error{status_code=529}` and `{status_code=429}` against worker count. Run the sweep twice — once all-Opus, once all-Sonnet — to size the per-model capacity difference Anthropic alludes to. Cross-check against `rate_limits.*.used_percentage` from the status-line JSON to separate quota exhaustion from capacity throttling. Set `CLAUDE_CODE_RETRY_WATCHDOG=1` for the production runs but **unset it for the measurement runs**, or infinite retries will mask the knee you are trying to find.

**Overflow economics if you exceed the plan:** usage bundles give up to a **30% discount** over standard usage-credit rates, work across Claude Code and third-party products, and are capped at **$2,000/month of discounted bundles** for individual Pro/Max (beyond that, standard rates). ([Buy usage bundles](https://support.claude.com/en/articles/14246112-buy-usage-bundles))

---

### 1.11 The "older models give more headroom" claim — verdict across all providers

**Restated precisely:** you believe running an older model version (Opus 4.8 instead of Opus 5, GPT-5.5 instead of GPT-5.6) buys extra quota on a flat-rate subscription.

**Verdict: false at the boundary you named, true at a different one.** Every provider that publishes per-model quota weighting weights along a **capability/price tier** axis, never along a version axis. The one genuine version effect is a *tokenizer* change, and it sits at the **Opus 4.6 / 4.7 boundary — not the 4.8 / 5 boundary you were targeting**: Anthropic states that "Claude 4.7 and later models... produce approximately 30% more tokens for the same text" at the same $/MTok. So Opus 4.6 (and Sonnet 4.6) genuinely stretch a fixed quota ~30% further per unit of input than anything newer, while Opus 4.8 and Opus 5 are indistinguishable from each other.

| Provider | Weighting axis | Same-tier older vs newer | Cross-tier |
|---|---|---|---|
| Claude subscription | Price/capability. Buckets: session, weekly, **Opus-only**, **Fable 50% sub-cap**. Fable "uses them faster than other Claude models". | **Opus 4.8 = Opus 5** — identical $5/$25 list, identical batch and cache rates, same "Opus" bucket, no version distinction in the error strings. **But Opus 4.6 ≈ 30% cheaper in tokens** than 4.7/4.8/5 for the same text (tokenizer change at 4.7). | Opus → Sonnet → Haiku is a real, large lever, and Sonnet doesn't touch the Opus bucket. |
| OpenAI Codex | Explicit published credit multipliers. | **GPT-5.5 = GPT-5.6 Sol, exactly** (125/12.5/750 credits per 1M). Zero benefit to the older model. | **Sol → Luna is 25×.** The single biggest capacity lever in this entire report. |
| xAI Grok | "Different products cost different amounts depending on how much compute" — unquantified. | Unknown. | Unknown. |
| Ollama Cloud | Per-model "usage level" 1–4. `deepseek-v4-pro` = extra high, `deepseek-v4-flash` = medium. | n/a | Real, but unquantified. |
| OpenCode Go | Dollar-denominated, so weighting *is* the model's token price. | n/a | ~300× between Kimi K3 and DeepSeek V4 Flash. |

**Three ways the claim actively backfires:**

1. **Newer models can be more token-hungry per unit of work.** Opus 4.7's tokenizer produces roughly **1×–1.35×** the tokens of Opus 4.6 on the same text; Sonnet 5 is **~30% more** than Sonnet 4.6. And Opus 5 **turns thinking on by default** where Opus 4.8 did not — so an unmodified Opus-4.8 workload silently costs more on Opus 5 unless you set `thinking: disabled` (allowed only at effort `high` or below) or lower effort. That is a real reason to prefer 4.8 — but it is about *token volume*, not quota weighting, and it is fixable by configuration.
2. **Retirements bite.** GPT-5.4 / GPT-5.4-mini leave Codex on **2026-08-31**. `grok-code-fast-1`, `grok-4-fast-*`, `grok-3` already silently redirect to `grok-4.3` **at grok-4.3 pricing**. `minimax-m2.5` and `kimi-k2.5` left Ollama Cloud on 2026-07-31. A factory pinned to old IDs is a factory that breaks or silently gets upcharged.
3. **You lose documented fallback targets.** Opus 5's cyber-flagged requests re-run on Opus 4.8 — but only if 4.8 is *reachable*, not if it is your primary.

**What to do instead:** route by phase difficulty across *tiers*. Bulk phases (scaffolding, mechanical refactors, test generation, doc updates) → Luna / Sonnet / Haiku / DeepSeek V4 Flash. Judgement phases (architecture, review, debugging) → Terra / Opus / Sonnet 5. Reserve the top tier for the handful of phases that demonstrably fail one tier down. On Codex that's worth ~25×; on Claude it protects the Opus bucket; on OpenCode Go it's worth ~300×.

---

## Question 2 — Model capability research

### 2.1 DeepSeek V4 — identity and benchmark reality check

**Your roster names are real.** Both `deepseek-v4-flash` and `deepseek-v4-pro` exist (verified on their Ollama library pages; correct cloud tags carry the `:cloud` suffix):

| Model | Architecture | Context | Modes | Ollama usage level |
|---|---|---|---|---|
| **DeepSeek V4 Flash** | MoE, **284B total / 13B active** | **1M** | no-thinking / thinking / **max thinking** | medium |
| **DeepSeek V4 Pro** | MoE, **1.6T total / 49B active** | **1M** | no-thinking / thinking / max thinking | **extra high** |

The 13B active-parameter count on Flash is what makes it fast and cheap; the 49B active on Pro is what makes it "extra high" against Ollama's pool. Tags: `deepseek-v4-flash:cloud` (also `:0731-cloud`, `:preview-cloud`) and `deepseek-v4-pro:cloud`. **`deepseek-v4-flash` and `deepseek-v4-pro` are DeepSeek's own API model IDs**, not Ollama inventions — confirmed on [api-docs.deepseek.com](https://api-docs.deepseek.com/quick_start/pricing/).

#### Cost — yes, it really is that cheap

Official pricing, per 1M tokens USD ([DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/)):

| | Context | Max output | Input (cache hit) | Input (cache miss) | Output |
|---|---|---|---|---|---|
| **deepseek-v4-flash** | 1M | 384K | **$0.0028** | **$0.14** | **$0.28** |
| **deepseek-v4-pro** | 1M | 384K | $0.003625 | $0.435 | $0.87 |

Against the models you'd otherwise use:

| Model | Input $/Mtok | Output $/Mtok | Output vs V4 Flash |
|---|---|---|---|
| Claude Opus 5 / Opus 4.8 | $5.00 | $25.00 | **89× more** |
| Claude Fable 5 | $10.00 | $50.00 | 179× more |
| Claude Sonnet 5 (intro) | $2.00 | $10.00 | 36× more |
| Grok 4.5 | $2.00 | $6.00 | 21× more |
| Claude Haiku 4.5 | $1.00 | $5.00 | 18× more |
| DeepSeek V4 Pro | $0.435 | $0.87 | 3.1× more |
| **DeepSeek V4 Flash** | **$0.14** | **$0.28** | — |

Cache-hit input is **$0.0028/Mtok on Flash — a 50× discount** off cache-miss, far steeper than Anthropic's 10×. For a factory that re-sends a stable repo prefix every turn, that is the number that matters most.

**Two caveats.** (1) **No off-peak discount is documented any more** — the historical DeepSeek off-peak pricing does not appear on the current page. (2) DeepSeek itself warns of *"pricing for DeepSeek API services in the near future"* likely increasing, and recommends users *"plan your usage accordingly."* Do not build a cost model that assumes these prices persist.

#### Speed — your "faster than Grok" claim is VERIFIED per token, and inverted per job

Head-to-head on [Artificial Analysis](https://artificialanalysis.ai/models/comparisons/deepseek-v4-flash-vs-grok-4-5), DeepSeek V4 Flash 0731 (Reasoning, Max Effort) vs Grok 4.5 (high), first-party APIs:

| | DeepSeek V4 Flash | Grok 4.5 (high) | |
|---|---|---|---|
| **Output speed** | **130.9 tok/s** | 56.8 tok/s | **DeepSeek 2.3× faster** |
| **Time to first token** | **1.44 s** | 9.60 s | **DeepSeek 6.7× lower latency** |
| Blended price / 1M (7:2:1 cache-hit:input:output) | **$0.06** | $1.21 | DeepSeek 20× cheaper |
| AA Intelligence Index | 52 | **56** | Grok more capable |
| Context window | **1M** | 500k | |
| Open weights | **Yes** | No | |

**So: you are right about raw speed, and by a wide margin.** The 6.7× TTFT advantage matters even more than the token rate for a factory that makes many short agent calls.

**But the per-token win does not carry to per-job.** On Datacurve's DeepSWE, DeepSeek V4 Flash needed **153 steps** to Grok 4.5's **61** for a near-identical score (53% vs 54%). At 2.3× the token rate and 2.5× the steps, wall-clock per completed task is roughly a wash — and the step count is also a direct multiplier on your request budget on any request-denominated plan. **Fast tokens, verbose trajectories.** Benchmark your own phases on completed-task latency, not tokens/sec.

#### 🔑 DeepSeek documents concurrency explicitly — the only provider in this report that does so generously

From the same pricing page: **`deepseek-v4-flash` supports 2,500 concurrent requests; `deepseek-v4-pro` supports 500.**

That is two to three orders of magnitude above every subscription option here (Ollama Pro: 3; Claude Max 20x: ~4–6 before 529s; Codex: ~6 by convention). **If concurrency is genuinely your binding constraint, DeepSeek's own API is the only substrate that removes it** — at the cost of leaving the flat-rate model. At $0.14/$0.28 per Mtok with a 50× cache discount, "leaving flat-rate" is a much smaller concession than it sounds.

#### The benchmark reality check

**The single most important finding: every DeepSeek coding claim that an independent evaluator has re-measured comes in 4–6 points low, and on the two benchmarks built specifically against contamination, the model falls off a cliff.**

#### Vendor claim vs independent measurement

| Metric | DeepSeek claims | Independent measurement | Source | Gap |
|---|---|---|---|---|
| SWE-bench Verified | **80.6** | **74%** | [NIST CAISI evaluation](https://www.nist.gov/news-events/news/2026/05/caisi-evaluation-deepseek-v4-pro) | −6.6 |
| Terminal-Bench 2.1 | **82.7** | **78.7%** (Terminus 2) | [Artificial Analysis](https://artificialanalysis.ai/evaluations/terminalbench-v2-1) | −4.0 |
| LiveCodeBench | **93.5** | **87.48% ± 0.95** | [Vals AI](https://www.vals.ai/benchmarks/lcb), 2026-08-09 | −6.0 |
| DeepSWE | **54.4** | **53% ± 4** | [Datacurve DeepSWE v1.1](https://deepswe.datacurve.ai/) | **✓ holds** |
| SWE-bench Pro | 55.4 | *not measured anywhere* | — | unverified |
| SWE-bench Multilingual | 76.2 | *not measured anywhere* | — | unverified |
| Codeforces Elo | 3206 | *not measured anywhere* | — | unverified |
| Contamination-free SWE | — | **40.2%** | [SWE-rebench](https://swe-rebench.com/) | — |
| Agentic coding composite | "open-source SOTA" | **31 — last of 15** | [AA Coding Agent Index](https://artificialanalysis.ai/agents/coding-agents) | — |

**DeepSeek has submitted to none of swebench.com, Scale's SWE-bench Pro, or tbench.ai**, and its agentic numbers were produced with a harness it has never released. Any DeepSeek SWE-bench figure quoted without a named scaffold is uninterpretable — on swebench.com, open-scaffold submissions score **4–9 points higher than the fixed mini-SWE-agent harness on identical models**.

#### SWE-rebench (Nebius, contamination-free) — the most damaging result

Window 2026-05-14 → 2026-06-30, 111 problems across 65 repos ([swe-rebench.com](https://swe-rebench.com/)):

| Rank | Model | Resolved | Pass@5 | Cost/problem |
|---|---|---|---|---|
| 1 | Claude Fable 5 [high] | 64.5% ± 1.41 | 78.4% | $4.40 |
| 2 | Grok 4.5 [high] | 63.8% ± 0.60 | 77.5% | $1.47 |
| 3 | Claude Opus 5 [high] | 63.4% ± 1.35 | 74.8% | $3.47 |
| 4 | GLM-5.2 [high] | 62.9% ± 1.19 | 81.1% | $1.40 |
| 5 | GPT-5.6 Sol [medium] | 62.3% ± 1.83 | 79.3% | $0.85 |
| 11 | MiniMax M3 | 47.2% ± 1.13 | 69.4% | $0.95 |
| 12 | MiMo V2.5 Pro | 46.5% ± 0.54 | 65.8% | $0.10 |
| **14** | **DeepSeek V4 Pro [high]** | **40.2% ± 1.29** | **64.0%** | **$0.15** |

**DeepSeek V4 Pro places last among frontier models — below MiniMax M3 and MiMo V2.5 Pro**, against its own SWE-bench Verified claim of 80.6%. It burns **3.96M tokens per problem** (91.2% cached). V4 Flash shows N/A for this window.

#### DeepSWE (Datacurve, contamination-free, fixed mini-SWE-agent) — where DeepSeek looks genuinely good

v1.1, updated 2026-08-07, 113 tasks / 91 repos / 5 languages ([deepswe.datacurve.ai](https://deepswe.datacurve.ai/)):

| Model | Pass@1 | Cost/task | Steps |
|---|---|---|---|
| claude-opus-5 [max] | 74% ± 4 | $11.84 | 99 |
| gpt-5.6-sol [max] | 73% ± 3 | $8.39 | 61 |
| kimi-k3 [max] | 69% ± 5 | $4.65 | 98 |
| claude-opus-4.8 [max] | 59% ± 2 | $13.22 | 120 |
| qwen3.8-max [xhigh] | 57% ± 3 | $3.73 | 111 |
| grok-4.5 [high] | 54% ± 2 | $2.42 | **61** |
| **deepseek-v4-flash [max]** | **53% ± 4** | **$0.10** | **153** |
| glm-5.2 [max] | 44% ± 2 | $3.92 | 129 |

**This is the strongest honest case for DeepSeek: V4 Flash is roughly Grok-4.5-class on a fixed harness at ~1/24th the cost per task.** But note the **153 steps vs Grok's 61** for the same score — the verbosity tax, and a direct hit on your wall-clock throughput and on any per-request budget.

⚠️ **Do not cite the widely-circulated "DeepSeek V4 Pro = 8% on DeepSWE."** That v1 figure is publicly contested — an audit at [datacurve-ai/deep-swe#21](https://github.com/datacurve-ai/deep-swe/issues/21) alleges pricing, provider-routing, and effort-config errors and states *"the 8% DeepSWE pass rate for V4 Pro is wrong."* V4 Pro was not re-run in v1.1. Treat as disputed.

#### Where the commonly-cited leaderboards actually stand (all verified stale for V4)

| Leaderboard | State | Latest DeepSeek entry |
|---|---|---|
| **Aider Polyglot** | **Dead.** All 69 entries extracted; newest embedded run date is **2025-10-03**, zero 2026 dates. | V3.2-Exp Reasoner, 74.2% |
| **LiveCodeBench (official)** | Problem window frozen 2024-08 → 2025-05, 454 problems, 28 models, **zero 2026 models**. The "93.5" figure circulating for V4 Pro **does not come from this leaderboard** — it is the model card, mirrored by aggregators. | R1-0528, 73.1 |
| **Terminal-Bench 2.0 / 2.1** | 142 entries; **no V4 on either**. | V3.2, 39.6% (rank 86) |
| **swebench.com Verified** | Default fixed-harness (mini-SWE-agent v2.0.0) view tops at Claude 4.5 Opus **76.80%**. | V3.2, 70.00% |
| **SWE-bench Multilingual** | 13 submissions total; only `20260213_mini-v2.0.0a0_deepseek-3-2`. ([submission repo](https://github.com/SWE-bench/experiments/tree/main/evaluation/multilingual)) | V3.2 |
| **SWE-bench Pro** (Scale AI — a *separate* benchmark, no tab on swebench.com) | **No V4.** | `deepseek-v3p2`, 15.56 ± 2.63 ([scale.com](https://scale.com/leaderboard/swe_bench_pro_public)) |
| **Arena.ai Code/WebDev** (ex-LMArena; `lmarena.ai` now redirects) | 564,272 votes / 112 models. `deepseek-v4-flash-high` sits **rank 8 (1585)** but flagged **Preliminary** on only 2,605 votes (±13 CI), while its `-preview` sibling with 9,493 votes sits at **rank 54 (1431)** and `deepseek-v4-pro` at **rank 45 (1445)** on 12,982 votes. | Read cautiously — human preference is not capability, and the flattering number is the low-N one. |

**Implication for your factory:** if you are choosing models on published DeepSeek numbers, you are choosing on numbers that are 4–6 points optimistic where checked and unmeasured where not. The one number that survives contact with an independent evaluator is DeepSWE.

#### Weaknesses specific to autonomous agentic coding

The US government's [NIST CAISI evaluation of DeepSeek V4 Pro](https://www.nist.gov/news-events/news/2026/05/caisi-evaluation-deepseek-v4-pro) is the most authoritative independent read, and its weakest results are precisely on the agentic axis:

| Benchmark | DeepSeek V4 Pro | Leading US models | Domain |
|---|---|---|---|
| **PortBench** (CAISI-developed, non-public — *"assesses the ability of AI models to port command line interface (CLI) tools"*) | **44%** | **60–78%** | **Agentic software engineering** |
| ARC-AGI-2 (semi-private) | 46% | 63–79% | Abstract reasoning |
| CTF-Archive-Diamond (285 challenges) | 32% | — | Cyber reasoning |
| SWE-bench Verified | 74% (vs 80.6 vendor) | — | Single-shot SWE |

CAISI's summary: ***"DeepSeek V4's capabilities lag behind the frontier by about 8 months."*** Note the shape — DeepSeek is near-frontier on *static* benchmarks (GPQA-Diamond 90%, AIME 97%) and falls furthest behind on the **agentic, multi-step, tool-driven** ones. That is exactly the axis your factory runs on. PortBench at 44% against 60–78% is the single most relevant number in this document for a "can it drive a CLI autonomously" decision.

Corroborating evidence from elsewhere in this report:
- **Trajectory verbosity:** 153 DeepSWE steps to Grok's 61 for the same score; 3.96M tokens per SWE-rebench problem.
- **Contamination sensitivity:** 40.2% on SWE-rebench (contamination-free) against a vendor claim of 80.6% on SWE-bench Verified — the largest vendor/independent gap of any model here.
- **Agentic composite:** dead last (31 of 15 entries) on AA's Coding Agent Index, which composites DeepSWE + Terminal-Bench v2 + SWE-Atlas-QnA.

**NOT VERIFIED / not covered by any source I found:** DeepSeek-specific measurements of tool-call schema reliability (BFCL has no V4 entry — the board is frozen pre-release), long-context degradation curves past 128K, stub/TODO/mock-data emission rates, and premature success-claim rates. These are the failure modes that matter most for an unattended loop and **nobody publishes them** — you must measure them yourself.

**Practical stance:** use V4 Flash for bulk, supervised phases behind hard external gates it cannot talk past (real test runs, real linters, real type-checkers whose exit codes your Python driver reads — never the model's own claim that it verified something). Do not put it on the critical path of an unattended loop.

### 2.2 Qwen 3.5 — real, but three generations stale

**It exists, and your tag is wrong.** The Ollama Cloud tag is **`qwen3.5:397b-cloud`** (alias `qwen3.5:cloud`, same digest) — a bare `qwen3.5:397b` will fail, because `397b` exists **only** as a cloud tag; the largest local tag is `122b`. Confirmed on the [Ollama library page](https://ollama.com/library/qwen3.5), which describes the 397B variant as a **sparse Mixture-of-Experts with Gated Delta Networks**, **256K context**, medium Ollama usage level. (The exact total-vs-active parameter split is **NOT VERIFIED** — Ollama's page doesn't state it.) The family spans 0.8b / 2b / 4b / 9b / 27b / 35b / 122b locally, plus MLX variants, and claims 201 languages.

**But Qwen 3.5 is not the current Qwen.** **Qwen3.8-Max launched 2026-08-03** — eight days before this research — with **2.4T parameters and a 1M context window**, ranking 5th in Text Arena, 2nd in Vision Arena, and 4th in Frontend Code Arena ([Alibaba Cloud announcement](https://www.alibabacloud.com/en/press-room/alibaba-unveils-qwen3-8-max)). Independent measurements put Qwen3.8-Max at **87.85% ± 0.95 on Vals AI's LiveCodeBench (#6 of 135)** and **57% ± 3 on DeepSWE at $3.73/task** — i.e. above DeepSeek V4 Flash and Grok 4.5 on DeepSWE, and comfortably above anything Qwen 3.5 is credited with.

**As a reporting/scout model, Qwen 3.5 is disqualified on hallucination.** Its non-hallucination rate is **11.1%** and its Agentic Index **19.8** — both far below MiniMax M3's figures. For a role whose entire output is a factual report about a codebase, that rules it out.

**Verdict:** if you want a Qwen in the roster, use **Qwen3.8-Max** via Alibaba Model Studio (or check whether it lands on Ollama Cloud), not `qwen3.5`. Keep `qwen3.5:397b-cloud` only as a cheap medium-usage-level bulk worker on Ollama, never as a reporter.

### 2.3 MiniMax M3 as a read-only "scout"

This is the role you proposed, so it gets the most scrutiny. **Verdict: plausible on paper, but there are three open, unfixed, silent-failure bugs sitting directly on the read-tool path. Do not deploy it as a scout without the six guards below.**

#### Where the benchmark picture is weaker than the marketing

| Signal | Number | Read |
|---|---|---|
| AA-LCR (long-context reasoning) | **74.0%, #9 of 157** ([BenchLM mirror of the AA card](https://benchlm.ai/benchmarks/lcr), snapshot 2026-08-10) — OpenRouter renders the same AA card as 80.3% | **Disputed.** 74.0 is better corroborated (M2.7 sits at 68.7 on the same board; launch coverage describes a "+5 point jump from M2.7's 69%"). Plan against 74.0. That puts M3 roughly *tied* with Qwen3.5, not clearly ahead. |
| AA-LCR scope | **Only tests 10k–100k tokens** ([AA methodology](https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning)) | Says nothing about 200K–1M — exactly where a 1M-context scout lives. |
| τ²-Bench Airline (tool calling) | **69.7% (±6.8pp), #52 of 110** — *below its own predecessor M2.7 at 71.2%, #47* ([OpenRouter](https://openrouter.ai/benchmarks/tau2-bench-airline)) | OpenRouter picked this benchmark because "it exercises every tool-calling failure mode." M3 **regressed** on it. Wide run-to-run variance. |
| τ²-Bench Telecom (AA) | M3 **88.9%** vs **MiniMax-M2.5's 95.3%** | Same regression direction on a second independent measurement. |
| Non-hallucination rate | 81.6% — but AA notes M3 **"attempts only 30.9% of questions,"** producing *"artificially low hallucination through avoidance rather than accuracy"* ([AA writeup](https://artificialanalysis.ai/articles/minimax-m3)) | Cuts both ways for a scout: it won't invent, but it may **under-report real findings**. |
| Independent agentic probe | M3 **19/21** vs Codex 21/21 — and both failures "completed with a final answer, no tool errors, no iteration-limit hits" | The author flags this as significant "since users may trust completed answers without stronger self-checks." Silent wrong answers, not loud failures. |

#### The three open bugs that hit the scout pattern directly

**1. [Issue #29](https://github.com/MiniMax-AI/MiniMax-M3/issues/29) — silent array-entry loss in tool arguments.** Open, labeled `bug`, no maintainer response.

- Expected `{"groups":[{"item_ids":["a1","a2"]},{"item_ids":["b1","b2"]},{"item_ids":["c1","c2"]}]}`
- Received `{"groups":[{"item_ids":["a1","a2"]}],"item":{"item_ids":["c1","c2"]}}` — **the middle group silently vanished** into an invented top-level `item` key not in the schema.

Trigger needs both a property named `item_ids` (or any `item*` prefix) **and** a prompt that never says the word "item." **15–35% across runs; 27% with both triggers; 0% with either removed. Persists at `temperature: 0`.** Hits `/v1/chat/completions`, `/v1/responses`, *and* `/anthropic/v1/messages`. Returns `finish_reason: "tool_calls"`, `status_code: 0` — **no error signal at all**, and syntactically valid JSON. A Grep or Glob tool returning `{"matches": [...]}` or `{"items": [...]}` is squarely in the blast radius.

**2. [Issue #19](https://github.com/MiniMax-AI/MiniMax-M3/issues/19) — tool output not propagated between chained calls.** The second tool receives a *reconstructed, invalid* version of the first tool's return. Scored **M3 2/5, M2.7 3/5, M2.5 5/5**. The reporter's own workaround: *"exclude M2.7/M3 from sequential tool workflows."* This is precisely a read→filter→read scout chain.

**3. [Issue #28](https://github.com/MiniMax-AI/MiniMax-M3/issues/28) — answer tokens emitted before the closing `</think>`.** When reasoning is stripped per the docs, the user-facing response **starts mid-sentence, on ~25% of requests** on simple prompts, reproduced with raw curl, streaming and non-streaming. M2.7 did not do this. A scout's entire deliverable is prose; a 25% truncated-report rate is disqualifying until guarded.

Also [#25](https://github.com/MiniMax-AI/MiniMax-M3/issues/25) (duplicate of #16, unfixed ~5 weeks): 8.2M tokens in a 17-minute session, **97.3% of it `cache_read`**, growing monotonically while new input stayed flat at ~5.2k/turn — suspected thinking-blocks-in-cached-prefix re-billing on the Anthropic-compatible endpoint. A scout *is* a long multi-turn read loop.

#### Two operational catches

- **`adaptive` thinking ≈ always-on for a scout.** The chat template primes thinking *"for complex decision-making, multi-step reasoning, **or when analyzing function/tool results**"* — and every scout turn analyzes tool results. ~89% of AA's output tokens for M3 were reasoning tokens; on live OpenRouter traffic reasoning (968M) exceeds visible completion (727M) by ~33%.
- **You cannot strip the thinking to save money.** MiniMax's [function-call docs](https://platform.minimax.io/docs/guides/text-m3-function-call): *"the entire `response_message` — including the `reasoning_details` field — **must** be preserved in the message history and passed back... This is essential for achieving the model's best performance."* A harness that strips `<think>` blocks between turns runs M3 degraded — and this interacts badly with #28.

#### Cost and the 512K cliff

M3 is a **~428B-total / ~23B-active** MoE with a 1M context window (512K guaranteed). Pricing ([launch post](https://www.minimax.io/blog/minimax-m3); MiniMax lists $0.60/$2.40 with a "permanent 50% off" applied):

| Tier | Input | Output | Cache read |
|---|---|---|---|
| **Standard (≤512K input)** | **$0.30** | **$1.20** | $0.06 |
| **Long context (>512K input)** | $0.60 | $2.40 | $0.12 |

**The cliff is brutal and easy to trip:** the moment input crosses 512K, **the entire request — input, output, and cache reads — bills at 2×**. A 600K-token request does not cost slightly more than a 500K one; it costs roughly twice as much per token across the whole call. MiniMax names "full-repository code understanding" as the intended >512K use case, which is exactly what a scout does. The >512K tier is also **access-limited right now** (limited quantity, contact sales). **Keep every scout turn under 512K input** — chunk the repo rather than feeding it whole.

Compare: at $0.30/$1.20 M3 is ~2× DeepSeek V4 Flash's input price and ~4× its output price, while ranking above it on SWE-rebench (47.2% vs 40.2% for V4 Pro; V4 Flash unmeasured on that board). Fireworks caps M3 at 512K context outright.

#### Provider variance is large, so pin one

MiniMax's own [Provider-Verifier](https://github.com/MiniMax-AI/MiniMax-Provider-Verifier) has M3 data **only for the official endpoint**: ToolCalls-Match-Rate 98.80%, Schema-Accuracy 98.93% — so even best case ~1.1% of calls carry a wrong name or args. The historical M2.1 rows show why third-party matters: `openRouter-gmicloud/fp8` scored Query-Success **83.72%** / Finish-ToolCalls **55.5%** against 100% / 83.33% on the official endpoint — **on identical weights**. No third-party M3 rows exist yet. On OpenRouter, Venice leads on tool-call error rate (0.94%), throughput (101 tps) and uptime (99.88%); Parasail leads τ²-Bench (74.5%); the first-party MiniMax endpoint leads on neither (2.91% error, 73.2%). Fireworks caps M3 context at **512K**; Novita/Together cap max output at 131.1K.

#### If you deploy it as a scout, do these six things

1. **Purge `item*`-prefixed property names** from every read/search tool schema. Use `paths`, `matches`, `entries`, `member_ids`. Naming the property verbatim in the tool description also suppresses #29.
2. **Validate every tool-call payload against your schema at the harness level and fail loud.** #29 gives you `status_code: 0` and no error — your harness is the only detector.
3. **Pin a provider** (or use `minimax/minimax-m3:exacto`). Do not let a gateway route you across backends.
4. **Add a `</think>`-integrity guard** before consuming any report (#28, ~25%).
5. **Preserve `reasoning_details` verbatim** across turns.
6. **Keep scans under 512K tokens** to stay below the 2× pricing cliff — MiniMax explicitly names "full-repository code understanding" as the expensive tier.

**Before committing, run a ~50-task internal harness measuring one thing: "did it quote a file it actually read, with the correct path and line numbers."** No published benchmark covers that, and neither #19 nor #29 would show up in any leaderboard number.

### 2.4 Model comparison table

Prices are per 1M tokens USD, first-party API list rates. Benchmark figures prefer **independent** measurement over vendor claims; vendor-reported numbers are marked *(vendor)*.

| Model | Provider | Independent coding benchmarks | Speed | Cost in/out | Good for which role |
|---|---|---|---|---|---|
| **Claude Opus 5** | Anthropic | SWE-rebench **63.4%** (#3); DeepSWE **74%** (#1, $11.84/task); Vals LiveCodeBench **89.03%** (#2); AA Coding Agent Index **67** (#1, tied) | — | $5 / $25 | **Hard phases**: architecture, review, debugging, long-horizon autonomous runs. Your default for anything where being wrong is expensive. |
| **Claude Opus 4.8** | Anthropic | DeepSWE **59%** ($13.22/task); Vals LiveCodeBench **87.82%** (#7) | — | $5 / $25 | Same quota bucket and price as Opus 5, measurably weaker. Keep it configured **only** as Opus 5's documented cyber-refusal fallback target. |
| **Claude Sonnet 5** | Anthropic | *(see Opus rows for the tier gap)* | — | $2 / $10 (intro, → $3/$15 on 2026-09-01) | **Bulk phases.** Doesn't touch the Opus quota bucket — the single best Claude-side lever for factory width. |
| **Claude Haiku 4.5** | Anthropic | — | — | $1 / $5 | Subagents. Anthropic's own recommendation for simple subagent tasks. |
| **GPT-5.6 Sol** | OpenAI | SWE-rebench **62.3%** (#5, $0.85/problem); DeepSWE **73%** ($8.39/task, **61 steps**); AA Coding Agent Index **67** (#1, tied) | — | 125 / 750 credits per 1M | Hard phases on the Codex side. Note the 61-step efficiency — half the trajectory length of most rivals. |
| **GPT-5.6 Terra** | OpenAI | — | — | 50 / 300 credits | Everyday workhorse; **0.4×** Sol's quota cost. |
| **GPT-5.6 Luna** | OpenAI | — | — | 5 / 30 credits | **Bulk phases. 1/25th of Sol.** The largest single capacity lever in this report. |
| **Grok 4.5** | xAI | SWE-rebench **63.8%** (#2, $1.47/problem); DeepSWE **54%** ($2.42/task, **61 steps**); Vals LiveCodeBench 87.35% (#10); AA Intelligence 56 | 56.8 tok/s; **9.60 s TTFT** | $2 / $6 (cache in $0.30) | Strong and cheap on contamination-free SWE — but the **9.6 s TTFT is the worst here**, and cached tokens still count against TPM. |
| **DeepSeek V4 Flash** | DeepSeek | DeepSWE **53% ± 4** ($0.10/task, **153 steps**); Arena WebDev rank 8 *(preliminary, low-N)*; AA Intelligence 52 | **130.9 tok/s; 1.44 s TTFT** | **$0.14 / $0.28** (cache hit **$0.0028**) | **Bulk, supervised, gated.** Grok-4.5-class on a fixed harness at ~1/24th cost/task, 2.3× the token rate, 1M context, 2,500 concurrent. Verbose trajectories. |
| **DeepSeek V4 Pro** | DeepSeek | SWE-rebench **40.2%** — **last of 14 frontier models**; AA Coding Agent Index **31 — last of 15**; Vals LiveCodeBench 87.48% (#9); NIST CAISI SWE-bench Verified **74%** vs 80.6 *(vendor)* | — | $0.435 / $0.87 | **Hard to justify.** 3× Flash's price for a *worse* contamination-free SWE score, "extra high" on Ollama, only 500 concurrent. Skip. |
| **MiniMax M3** | MiniMax | SWE-rebench **47.2%** (#11); τ²-Bench Airline **69.7%** (#52/110, *below* its own M2.7); AA-LCR **74.0%** (#9, disputed vs 80.3) | Venice 101 tps | **$0.30 / $1.20** ≤512K; **2× above 512K on the whole request**; cache read $0.06 | **Scout — with guards.** ~428B/23B MoE, 1M context, cheap, high long-context rank. But three open silent-failure bugs on the read-tool path and a tool-calling regression vs its own predecessor. |
| **Qwen 3.5 (397b)** | Alibaba | Non-hallucination **11.1%**; Agentic Index **19.8**; AA-LCR 72.7% | — | — | **Not a reporter.** 256K context, medium Ollama usage level. Bulk worker at best. |
| **Qwen3.8-Max** | Alibaba | Vals LiveCodeBench **87.85%** (#6); DeepSWE **57% ± 3** ($3.73/task); 4th in Frontend Code Arena | — | — | The Qwen you should actually be looking at (launched 2026-08-03, 2.4T params, 1M ctx) — **not** Qwen 3.5. |
| **Kimi K3** | Moonshot | DeepSWE **69%** (#3, $4.65/task); AA Coding Agent Index 61 (#8); Arena WebDev #2 | — | $3 / $15 (OpenCode Zen) | Genuinely strong. But on OpenCode Go it gets **110 requests per 5 hours** — a hard cap on how much you can use it. |
| **GLM-5.2** | Z.ai | SWE-rebench **62.9%** (#4, **Pass@5 81.1% — highest of any model**); DeepSWE 44% | — | $1.40 / $4.40 (OpenCode Zen) | Best Pass@5 on the board — strong candidate where you can afford retries and pick the winner. |

---

## What I could not verify

Explicit and complete. Nothing below should be treated as known.

### Concurrency (Question 1)

| Gap | Why it matters | Status |
|---|---|---|
| **Any account-level concurrent-session cap for Claude Code, Codex, or Grok subscriptions** | This is your headline question. **No provider publishes one.** Everything in the "inferred" column of §1.9 is arithmetic plus practitioner reports, not documentation. | **NOT DOCUMENTED anywhere** |
| The exact 529/429 knee on Claude Max 20x | Determines your factory width. Community reports cluster at 4–6, one user settled at 2, Anthropic recommends 3–5 teammates. None of these is a measurement of *your* workload. | **Inferred only** |
| Absolute numbers behind Max 5x / 20x | "20× Pro" with Pro itself undefined. Anthropic publishes no message, token, or hour figure for any tier. | **NOT PUBLISHED** |
| Whether the Claude subscription's "Opus" bucket is weighted differently per Opus version | I found no version distinction in any error string, price, or doc. Absence of evidence, not evidence of absence. | **NOT VERIFIED** (inferred equal) |
| Whether agent-team teammates and workflow agents share the 20-subagent cap | Docs say they "follow their own limits instead" and do not publish them. | **NOT PUBLISHED** |
| Codex weekly/monthly allowance in credits | The CLI renders a `Weekly limit` row; the number is never published. | **NOT PUBLISHED** |
| Whether Codex's 6-agent cap applies across separate CLI processes or per-process | Decides whether you can run N processes × 6 agents or N processes sharing 6. | **NOT VERIFIED** |
| Every numeric limit on any xAI consumer subscription tier | Queries/hour, tokens, credits, RPS, TPM, concurrency — **zero published, any tier**. Third-party blog numbers are contradictory and several describe retired products. | **NOT PUBLISHED** |
| Whether undocumented `x-ratelimit-*` headers exist on xAI responses | A docs-corpus grep found zero mentions; absence from docs ≠ absence on the wire. | **NOT VERIFIED** |
| What the "API" line item in xAI's consumer usage breakdown actually meters | Suggests some API-metered use is bundled into the weekly pool; no page explains the boundary. | **NOT VERIFIED** |
| Whether Ollama Pro's "3" gates concurrent *requests* or distinct *model tags* | A ~10× difference in factory width. The FAQ heading and body disagree. | **AMBIGUOUS — must test** |
| Ollama's queue depth before rejection, and any rate-limit headers | "Queued requests are held up to a fixed limit" — the number is not published. | **NOT PUBLISHED** |
| Ollama Cloud's absolute token/request budget per 5h and per week | Only relative multipliers (Pro = 50× Free) with Free undefined, plus a 1–4 "usage level" per model. | **NOT PUBLISHED** |
| Ollama Team/Enterprise concurrency | Max (10 slots) is closed to new signups; Team/Enterprise numbers aren't published. | **NOT PUBLISHED** |
| Any RPS / concurrency / 429 semantics for OpenCode Zen or Go | Checked `/docs/zen`, `/docs/go`, `/docs/providers`, `/docs/troubleshooting`, `/docs/config`, `/zen`, `/go`, `/enterprise`. Only spend limits are documented. | **NOT DOCUMENTED** |
| Alibaba Coding Plan: concurrency, 429 semantics, headers, data retention, and whether Qwen3.8-Max is in-plan | The documented model list stops at qwen3.7-plus. | **NOT VERIFIED** |
| `pi-claude-bridge` concurrency behaviour | The README documents no concurrency, rate limits, or 429 handling. Whether N bridge instances contend is unknown. | **NOT DOCUMENTED** |
| Whether DeepSeek's published 2,500 / 500 concurrency holds in practice | Documented, but unvalidated by me. | **Documented, untested** |

### Models (Question 2)

| Gap | Status |
|---|---|
| **DeepSeek tool-call schema reliability** — BFCL has no V4 entry (board frozen pre-release) | **NOT MEASURED by anyone** |
| **DeepSeek stub/TODO/mock-data emission rate, premature success-claim rate, long-context degradation past 128K** | **NOT MEASURED by anyone** — the failure modes that matter most for unattended loops are exactly the ones nobody benchmarks |
| DeepSeek vendor claims for SWE-bench Pro (55.4), SWE-bench Multilingual (76.2), Codeforces Elo (3206) | **Unmeasured by any independent evaluator** |
| The circulating "DeepSeek V4 Pro = 8% on DeepSWE" | **Publicly contested** ([audit](https://github.com/datacurve-ai/deep-swe/issues/21)); V4 Pro not re-run in v1.1. Do not cite. |
| MiniMax M3's AA-LCR: 80.3% (OpenRouter's AA render) vs 74.0% (BenchLM's AA mirror) | **Unresolved conflict.** Plan against 74.0. |
| MiniMax M3's AA Intelligence Index: 55 (launch article) vs 45.4 (current cards) | **Unresolved conflict** |
| MiniMax M3: MRCR, RULER, HELMET, NIAH, fiction.liveBench, BFCL, MCP-Mark; context-rot curve past 128K; whether it invents file contents it never read; citation/line-number accuracy | **NOT MEASURED / model absent from those boards.** Note: the circulating MCP-Mark 81.1 belongs to **Kimi K2.7 Code**, not M3. |
| MiniMax M3 tool-reliability delta across `enabled` / `adaptive` / `disabled` thinking | **NOT PUBLISHED** |
| MiniMax M3 license | **llm-stats.com wrongly lists it as MIT** — it is the MiniMax Community License |
| Qwen 3.5 397b total-vs-active parameter split | **NOT VERIFIED** — Ollama's page doesn't state it |
| Qwen 3.5 SWE-bench Verified / Terminal-Bench / Aider figures, price per Mtok, tokens/sec | **NOT RETRIEVED** in this pass |
| Speed (tok/s, TTFT) for DeepSeek V4 Pro, Claude models, and the GPT-5.6 family | **NOT RETRIEVED** — only the V4 Flash vs Grok 4.5 head-to-head was measured directly |

### Leaderboards that are stale or frozen (so any 2026 number attributed to them is wrong)

- **Aider Polyglot** — all 69 entries extracted; **newest embedded run date 2025-10-03, zero 2026 dates.** Effectively dead.
- **LiveCodeBench (official)** — problem window frozen 2024-08 → 2025-05; 28 models; **zero 2026 models**. The widely-quoted "DeepSeek V4 Pro = 93.5 LiveCodeBench" **does not come from this leaderboard**; it is the model card, mirrored by aggregators.
- **BFCL** — board frozen 2026-04-12, before these releases.
- **Terminal-Bench 2.0 / 2.1** — no DeepSeek V4 entry.
- **SWE-bench Multilingual** — 13 submissions total; no V4.
- **`lmarena.ai`** now redirects to **`arena.ai`**; the live path is `arena.ai/leaderboard/code/webdev`.

### Method notes / caveats on my own inferences

- All "inferred concurrent sessions" figures assume a session issues roughly one model request per minute. That assumption swings the result by ±3×, and I did not measure it.
- The AA Coding Agent Index per-model values were read from a rank-ordered chart; **rank ordering is certain, exact values are approximate.**
- GitHub issue reports are user claims, not Anthropic/OpenAI/MiniMax statements. I have labelled them as inferred throughout.
- Ollama's own `docs.ollama.com/cloud` page is **stale** — it lists already-passed retirements as "upcoming" and writes `qwen3.5:397b` without the required `-cloud` suffix. Trust the live model pages and `ollama.com/search?c=cloud` over it.
