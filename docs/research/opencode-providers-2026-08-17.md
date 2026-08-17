# OpenCode & models.dev — How a Terminal Agent Gets 350+ Providers, and What's Worth Borrowing

**Researched:** 2026-08-17. **Method:** primary sources only — `opencode.ai`'s own docs, the `sst/opencode` and
`sst/models.dev` GitHub repos (both now hosted under the org `github.com/anomalyco` — see §1.1), models.dev's
live `https://models.dev/api.json` fetched and inspected directly (not summarized secondhand), and each named
provider's own docs (`console.groq.com`, `docs.mistral.ai`, `docs.together.ai`, `api-docs.deepseek.com`,
`openrouter.ai/docs`). Cross-referenced against `docs/research/pi-provider-mechanism-2026-08-15.md`, which is
the target data shape everything here gets mapped onto. Anything not confirmed against a primary source is
flagged explicitly rather than presented as fact — same discipline as the pi doc.

---

## Verdict (read this first)

**models.dev is a community-maintained, schema-validated TOML database — one provider folder, one model file
per model, compiled to JSON and served at `models.dev/api.json`.** It is created and run by the maintainers of
SST (`sst.dev`), stated verbatim in its own README. **opencode does not hardcode its provider list — it fetches
`models.dev/api.json` over the network at startup**, every time, via Bun's native `fetch()`. This is not
inferred: it is the subject of opencode's own open GitHub issue #4959, filed because that unconditional fetch
breaks for users behind corporate proxies (Bun's `fetch()` ignores `HTTP_PROXY`/`HTTPS_PROXY`). The same issue
names opencode's own fallback chain when the network call fails: a local cache at
`~/.cache/opencode/models.json`, then a **bundled snapshot compiled into the binary at build time** ("via
macro"). So the honest description is *live-fetch-with-local-fallback*, not "always live" and not "static
snapshot" — both would be wrong. **Adding a provider not in that registry is a plain JSON object in
`opencode.json`/`opencode.jsonc`**, an `@ai-sdk/openai-compatible` npm package reference plus a `baseURL` — the
exact same "provider is data, not code" shape the pi doc already established for `models.json`. **Both repos
this research depends on — `sst/opencode` and `sst/models.dev` — now resolve to a different GitHub org,
`anomalyco`** (confirmed via `gh api repos/sst/opencode` → `owner.login: "anomalyco"`, not a fork). Worth
flagging since the operator's ask named `sst/opencode` specifically; whether this is a rename, an org
restructuring, or something else is not stated anywhere fetched in this pass — **NOT VERIFIED**, noted once
here and not re-litigated below.

---

## 1. models.dev — what it is, who runs it, its exact schema

### 1.1 What it is, and the org-rename wrinkle

> "Models.dev is a comprehensive open-source database of AI model specifications, pricing, and capabilities.
> There's no single database with information about all the available AI models. We started Models.dev as a
> community-contributed project to address this. We also use it internally in opencode."
> — `README.md`, `github.com/anomalyco/models.dev` (fetched via `gh api`, branch `dev`)

> "Models.dev is created by the maintainers of [SST](https://sst.dev)." — same README, closing line.

Both `github.com/sst/opencode` and `github.com/sst/models.dev` currently resolve (via the GitHub API, not a
redirect guess) to owner `anomalyco`, with `isFork: null`/`false` — i.e. the canonical repo, not a downstream
fork. This research otherwise treats `anomalyco/opencode` and `anomalyco/models.dev` as the live, canonical
repos throughout, since that's what `sst/...` URLs resolve to today.

### 1.2 The data model — TOML in, JSON out

Confirmed straight from the README's own contributor instructions:

- **`providers/<id>/provider.toml`** — one file per provider: `name`, `npm` (AI SDK package name), `env`
  (array of env var names for auth), `doc` (link to the provider's own docs), and an optional `api` field —
  **"Required only when using `@ai-sdk/openai-compatible` as the npm package"** (verbatim, README "Schema
  Reference"). Providers with a dedicated AI SDK package (`@ai-sdk/mistral`, `@ai-sdk/groq`,
  `@ai-sdk/togetherai`) do **not** carry an explicit `api` base-URL field in models.dev's schema — the SDK
  package itself knows the endpoint. This matters for §6: three of the presets below had to be verified
  against the vendor's *own* docs for a base URL, because models.dev's schema doesn't require one for them.
- **`providers/<id>/models/<model-id>.toml`** — one file per model, provider-specific: `cost` (`input`,
  `output`, `reasoning`, `cache_read`, `cache_write`, `input_audio`, `output_audio` — all USD per million
  tokens), `[limit]` (`context`, `input`, `output`), plus overrides of the model-agnostic facts below.
- **`models/<id>.toml`** — provider-agnostic facts reusable across providers that serve the same model:
  `name`, `family`, `release_date`, `last_updated`, `knowledge` (cutoff date), `attachment`, `reasoning`,
  `tool_call`, `structured_output`, `temperature`, `open_weights`, `[modalities]`. A provider TOML can inherit
  these via `base_model = "<provider>/<model-id>"` and override only what differs (README, "Reuse Model
  Metadata with `base_model`") — this is how the same open-weight DeepSeek model shows up on OpenRouter, Fireworks,
  and Together AI with three different price tables but one shared capability description.
- Validated in CI: **"There's a GitHub Action that will automatically validate your submission against our
  schema"** — required fields, types, value ranges, valid TOML (README, "Validation").

### 1.3 The live API — fetched and inspected directly, not summarized

```
curl https://models.dev/api.json     # provider + model data together (what opencode consumes)
curl https://models.dev/models.json  # model-only metadata, provider-agnostic
curl https://models.dev/catalog.json # both combined
curl https://models.dev/logos/{provider}.svg
```
(README, "API" section — all four endpoints quoted verbatim there.)

`api.json`, downloaded and parsed directly in this pass: **188 top-level provider keys**, each keyed by
provider id. Actual schema of one entry (`data["deepseek"]`, fields in this exact order):

```json
{
  "id": "deepseek",
  "env": ["DEEPSEEK_API_KEY"],
  "npm": "@ai-sdk/openai-compatible",
  "api": "https://api.deepseek.com",
  "name": "DeepSeek",
  "doc": "https://api-docs.deepseek.com/quick_start/pricing",
  "models": { "deepseek-v4-flash": { /* … */ }, "deepseek-v4-pro": { /* … */ },
              "deepseek-chat": { /* … */ }, "deepseek-reasoner": { /* … */ } }
}
```

One full model entry (`data["deepseek"]["models"]["deepseek-v4-flash"]`), every field present, quoted exactly:

```json
{
  "id": "deepseek-v4-flash",
  "name": "DeepSeek V4 Flash",
  "description": "Official DeepSeek V4 Flash release with enhanced agentic capabilities and integrated DSpark speculative decoding",
  "family": "deepseek-flash",
  "attachment": false,
  "reasoning": true,
  "reasoning_options": [ { "type": "toggle" }, { "type": "effort", "values": ["low", "high", "max"] } ],
  "tool_call": true,
  "interleaved": { "field": "reasoning_content" },
  "structured_output": true,
  "temperature": true,
  "knowledge": "2025-05",
  "release_date": "2026-07-31",
  "last_updated": "2026-07-31",
  "modalities": { "input": ["text"], "output": ["text"] },
  "open_weights": true,
  "limit": { "context": 1000000, "output": 384000 },
  "cost": { "input": 0.14, "output": 0.28, "reasoning": 0.28, "cache_read": 0.0028 }
}
```

**Flagging a real discrepancy, not resolved here:** these `cost` figures (`input: 0.14`, `output: 0.28`,
`cache_read: 0.0028`) do not match what DeepSeek's own pricing page states for the same model as of this pass
(§5 — `input` cache-miss `$0.22`/`$0.44`, `cache_read` `$0.007`/`$0.014`, `output` `$0.66`/`$1.32`, split by
off-peak/peak hours). Possible explanations, none confirmed: models.dev showing a stale snapshot pending a PR
update, showing a blended/promotional rate, or DeepSeek's off-peak-only rate happening to be roughly half the
flagged numbers by coincidence of the peak/off-peak halving rule stated on their own page. **Do not treat
models.dev's `cost` block as the pricing source of truth for a fast-moving vendor like DeepSeek — treat it as
a routing/schema source, and pull live pricing from the vendor's own page before wiring a preset with real
numbers.**

---

## 2. How opencode actually consumes the registry

### 2.1 Fetched live at startup, not just "used somewhere"

opencode's own docs state the dependency plainly but not the mechanism:

> "OpenCode uses the [AI SDK](https://ai-sdk.dev/) and [Models.dev](https://models.dev) to support **75+ LLM
> providers**" — `opencode.ai/docs/providers/`.

The mechanism itself is documented by opencode's own issue tracker, not the marketing docs. **GitHub issue
#4959**, `anomalyco/opencode` ("Add option to disable models.dev fetch for corporate proxy environments"),
states as the reported bug: users behind corporate proxies hit failures "due to a network call made on startup
to `https://models.dev/api.json`," because "the `get()` function in
`packages/opencode/src/provider/models.ts` always calls `refresh()` which makes a network request" and that
call "does not respect `HTTP_PROXY`/`HTTPS_PROXY` environment variables since Bun's native `fetch()` doesn't
automatically handle proxy configuration." The issue also names opencode's own existing fallback chain when
that fetch is unavailable:

- **"Cached data at `~/.cache/opencode/models.json`"**
- **"Bundled model data (compiled via macro)"**

So: **fetch live on every startup → fall back to the last-known local cache → fall back to a snapshot baked
into the binary at build time.** This is a bug report describing real, current behavior (opencode 1.x per the
issue), not a design doc — treat it as strong but not architecture-committee-grade evidence; it is the
best primary source found for this question.

**Corroborating, independent evidence**: the models.dev README's own manual-testing instructions for
opencode contributors show an env var that only makes sense if opencode reads its provider/model data from a
resolvable path rather than a hardcoded compile-time constant:

```bash
$ bun run build
$ OPENCODE_MODELS_PATH="dist/_api.json" opencode
```
(`README.md`, "Manual testing with opencode", `anomalyco/models.dev`) — confirms the *shape* of the fetch
mechanism (a models-data path opencode consumes, overridable) without independently re-deriving issue #4959's
claims from opencode's own source tree in this pass.

**One thing not independently re-verified**: the exact current source file path. The issue names
`packages/opencode/src/provider/models.ts`; a direct repo-tree search in this pass (`gh api
repos/sst/opencode/git/trees/dev?recursive=1`) found no file at that path today — the `provider/` directory
now contains `auth.ts`, `error.ts`, `model-status.ts`, `provider.ts`, `transform.ts`. A grep of `provider.ts`
in full (2,042 lines) found no direct `fetch("https://models.dev...")` call in this pass — the live-fetch
logic evidently now lives elsewhere (possibly refactored under a V2 rearchitecture — a
`specs/v2/provider-model.md` design doc in the same repo defines a `ModelsDevPlugin` as the lowest-priority
("`Order.modelsDev: 0`") of a five-plugin resolution pipeline: models.dev → env → account → provider config →
discovery, each layer able to override the one before it). **NOT VERIFIED**: whether this V2 plugin pipeline
is shipped/stable or an in-progress redesign as of this pass — the spec file lives under `specs/v2/`, which
reads as forward-looking design, not confirmed-shipped behavior. The mechanism described by issue #4959
(fetch → cache → bundled fallback) is the safer claim to build on; the V2 plugin-order detail is offered only
as directional corroboration that models.dev sits at the base layer, underneath user config.

### 2.2 Adding a provider that isn't in the registry

Confirmed directly from `opencode.ai/docs/providers/`. Any OpenAI-compatible provider can be added by hand in
`opencode.json`/`opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My AI Provider Display Name",
      "options": {
        "baseURL": "https://api.myprovider.com/v1",
        "apiKey": "{env:MY_PROVIDER_API_KEY}",
        "headers": { "Authorization": "Bearer custom-token" }
      },
      "models": {
        "my-model-name": {
          "name": "My Model Display Name",
          "limit": { "context": 200000, "output": 65536 }
        }
      }
    }
  }
}
```

Field notes, from the same page: `npm` is `@ai-sdk/openai-compatible` for a standard OpenAI-shaped endpoint,
or `@ai-sdk/openai` specifically for a provider exposing the newer `/v1/responses` endpoint shape.
`options.apiKey` supports `{env:VAR_NAME}` interpolation syntax rather than a literal key in the tracked file
— directly analogous to pi's `$ENV_VAR`/`!command` resolution syntax in `models.json`'s `apiKey` field (pi doc
§1.2). `options.headers` allows arbitrary custom headers, same shape as pi's `headers` field. `models` is a
map keyed by model id, each entry carrying at minimum a display `name` and a `limit` object
(`context`/`output`) — narrower than pi's per-model schema (no `cost` shown in the docs example, though the
models.dev TOML schema in §1.2 does carry `cost` — the two surfaces are not identical schemas even though
they're clearly siblings).

### 2.3 Where opencode stores auth/API keys

> "When you add a provider's API keys with the `/connect` command, they are stored in
> `~/.local/share/opencode/auth.json`." — `opencode.ai/docs/providers/`.

`opencode auth login` is documented as the CLI-side equivalent of the in-TUI `/connect` flow for configuring a
provider's API key. For OpenCode's own hosted model gateway ("OpenCode Zen" — provider id `opencode` in
models.dev, `api: "https://opencode.ai/zen/v1"`), the docs instead point to a browser sign-in flow:
*"head to opencode.ai/auth to sign in and add your billing details"* — a separate mechanism from the generic
per-provider API-key store, specific to that one first-party gateway. This is consistent with, and does not
contradict, what the pi doc already recorded for OpenCode's Windows/POSIX `auth.json` split (pi doc §2.2 —
`%LOCALAPPDATA%\opencode\auth.json` on Windows, `~/.local/share/opencode/auth.json` on POSIX) — not
re-verified independently in this pass, cited there from this repo's own installer code, which is the
stronger source for that specific path-splitting claim.

---

## 3. What's worth borrowing for the providers pane

**The single most portable idea**: opencode's `provider.<id>.options.{baseURL,apiKey,headers}` +
`models.<model-id>.limit` shape is functionally the same "provider is a JSON object with a base URL, an
env-resolved key, and a model list" pattern the pi doc already proved out for `models.json`. Nothing here
argues for adopting opencode's exact schema — it argues that **a curated preset list, each preset already
carrying a verified `baseURL` + env var name + example model ids, is the reusable unit**, because that's
exactly what models.dev's `provider.toml` + `models/*.toml` pair already is for opencode. The pane doesn't
need to fetch models.dev live (pi doc §4's KISS/no-ambient-state argument against a live-refreshing extension
applies here too) — it needs a small, git-trackable, human-reviewed *subset* of models.dev's own data,
pre-mapped to pi's provider-block field names.

**Concretely, per preset, the pane needs to write:**

| pi provider-block field | models.dev source field | opencode config equivalent |
|---|---|---|
| the provider key itself (e.g. `"deepseek"`) | `id` | `provider.<id>` |
| `baseUrl` | `api` (only present for `@ai-sdk/openai-compatible` providers — §1.2) | `options.baseURL` |
| `api: "openai-completions"` | implied by `npm: "@ai-sdk/openai-compatible"` | implied by `npm` |
| `apiKey` (command/env template) | `env[0]` (the env var name to resolve, not a key) | `options.apiKey: "{env:VAR}"` |
| `authHeader: true` | not modeled in models.dev's schema at all | `options.headers.Authorization` (manual) |
| `models[].id` | `models.<id>` (TOML filename / JSON key) | `models.<id>` |
| `models[].name` | `models.<id>.name` | `models.<id>.name` |
| `models[].contextWindow` | `models.<id>.limit.context` | `models.<id>.limit.context` |
| `models[].maxTokens` | `models.<id>.limit.output` | `models.<id>.limit.output` |
| `models[].cost.{input,output,cacheRead,cacheWrite}` | `models.<id>.cost.{input,output,cache_read,cache_write}` | not exposed in the docs' config example |

Everything in the left column already exists in the pi doc's §1.2 field table; nothing new needs inventing —
this is a field-rename exercise, not a new abstraction, which keeps it inside the same "no new merge engine"
discipline the pi doc's §8.3 already committed to.

---

## 4. DeepSeek specifics

Primary source throughout: `api-docs.deepseek.com`.

**Base URL**: `https://api.deepseek.com` — *"The DeepSeek API uses an API format compatible with
OpenAI/Anthropic. By modifying the configuration, you can use the OpenAI/Anthropic SDK or softwares compatible
with the OpenAI/Anthropic API to access the DeepSeek API"* (`api-docs.deepseek.com`, front page / "Your First
API Call"). No separate `/v1` suffix is required in the base URL itself — the OpenAI SDK example sets
`base_url="https://api.deepseek.com"` and lets the client library append the path.

**Current model ids** (as of this pass, both from DeepSeek's own pricing page and confirmed present in
models.dev's `deepseek` entry): **`deepseek-v4-flash`** (snapshot `DeepSeek-V4-Flash-0731`) and
**`deepseek-v4-pro`** (snapshot `DeepSeek-V4-Pro-0813`). Two older aliases, `deepseek-chat` and
`deepseek-reasoner`, are still listed in models.dev's live `api.json` alongside the v4 ids — not independently
confirmed against DeepSeek's own docs in this pass whether these are still-live legacy aliases or deprecated
names DeepSeek's docs no longer surface; **NOT VERIFIED**.

**Pricing** (`api-docs.deepseek.com/quick_start/pricing`, fetched directly this pass — no date stamp on the
page itself, but the model snapshot dates `0731`/`0813` place it within the last few weeks of this research
date):

| Model | Input, cache miss | Input, cache hit | Output |
|---|---|---|---|
| `deepseek-v4-flash` | $0.22 / 1M (off-peak), $0.44 / 1M (peak) | $0.007 / 1M (off-peak), $0.014 / 1M (peak) | $0.66 / 1M (off-peak), $1.32 / 1M (peak) |
| `deepseek-v4-pro` | $0.66 / 1M (off-peak), $1.32 / 1M (peak) | $0.022 / 1M (off-peak), $0.044 / 1M (peak) | $1.98 / 1M (off-peak), $3.96 / 1M (peak) |

*"Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC"* — verbatim
from the same page. **This directly conflicts with models.dev's own `cost` block for `deepseek-v4-flash`**
(§1.3: `input: 0.14`, `output: 0.28`, `cache_read: 0.0028` — no peak/off-peak split modeled at all). Flagged,
not resolved: pull live from DeepSeek's own pricing page before wiring a preset with real cost numbers; don't
trust models.dev's `cost` block for a vendor whose pricing has a time-of-day split it doesn't even attempt to
model.

**Rate limits — DeepSeek's stated position, not a hard ceiling**: DeepSeek does not publish traditional
per-minute/per-day rate limits. Instead: *"For each account, the concurrency limits for different DeepSeek API
models are shown in the table below"* (500 concurrent requests for `deepseek-v4-pro`, 2,500 for
`deepseek-v4-flash` — matching the figure already on file in this repo's
`docs/research/provider-limits-and-models.md` §1.9). Crucially: *"If you need higher concurrency, you can
submit a capacity expansion request. We will match the appropriate concurrency based on your actual business
needs. There is no additional cost for capacity expansion."* (`api-docs.deepseek.com/quick_start/rate_limit`.)
This is the documented, current confirmation of what the operator's brief characterized as "not publishing
hard rate limits" — accurate: it's a per-account concurrency ceiling, expandable on request, not a published
fixed-quota rate limit in the OpenAI/Anthropic RPM/TPM sense.

**DeepSeek direct API vs. DeepSeek via OpenRouter — facts only, no recommendation:**

Going direct means one account, one key, and DeepSeek's own published pricing and concurrency terms exactly as
tabulated above — no intermediary, no additional account to manage. Going through OpenRouter means a
different pricing reality than "DeepSeek's price with a markup": OpenRouter's own FAQ states *"We pass through
the pricing of the underlying providers without any markup, so you pay the same rate as you would directly
with the provider"* — but the DeepSeek V4 Flash listing checked directly on `openrouter.ai` in this pass shows
**$0.0679 input / $0.168 output per 1M tokens**, roughly a third of DeepSeek's own official off-peak rate,
because that OpenRouter listing is served by "multiple companies" hosting the same open-weight model
(`open_weights: true` in models.dev's own entry), not necessarily DeepSeek's own first-party infrastructure —
OpenRouter's no-markup claim holds for whichever upstream host it happens to route to, which is not
automatically DeepSeek's own endpoint at DeepSeek's own price. OpenRouter's only stated fee is on funding the
account, not on inference: *"5.5% ($0.80 minimum)"* for card/Stripe purchases, *"5%"* for crypto — charged
once, on deposit, not per request. In exchange for accepting that pricing is host-dependent rather than
DeepSeek-guaranteed, OpenRouter gives one account and one key across every provider in its catalog (352 models
under the `openrouter` provider id in the same `api.json` pull), including automatic routing across whichever
upstream host is serving a given model at a given moment — a different reliability model than a single
vendor's own infrastructure, not stated here as better or worse.

---

## 5. Preset catalog proposal

Every `Base URL` and `Key env var` below is copied verbatim from a primary source — either models.dev's live
`api.json` (fetched and parsed directly in this pass) where the provider carries an explicit `api` field, or
the vendor's own docs where models.dev's schema doesn't require one (see §1.2's note on `npm`-package-only
providers). `Cost` figures are deliberately omitted from this table — §4 already demonstrated models.dev's own
`cost` block can be stale or under-modeled for a fast-moving vendor; pull pricing live at implementation time
from whichever source the pane displays it from, per-vendor, not from this document.

| Preset name | Base URL | Key env var | Example model ids (from models.dev, this pass) | Pi provider-block mapping notes |
|---|---|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | `deepseek-v4-flash`, `deepseek-v4-pro` | `api: "openai-completions"`, `authHeader: true`. §4's peak/off-peak split has no field in pi's `cost` schema (`input`/`output`/`cacheRead`/`cacheWrite`, no time dimension) — either seed off-peak numbers with a note, or omit `cost` and let it default. |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | any of 352 listed, e.g. `deepseek/deepseek-v4-flash`, `anthropic/claude-*` | `npm: "@openrouter/ai-sdk-provider"` in opencode terms — a dedicated SDK, not `@ai-sdk/openai-compatible`, but the REST surface is OpenAI-shaped so `api: "openai-completions"` still applies for pi. Model ids on OpenRouter are namespaced `vendor/model` — pi's `models[].id` should carry that full string. |
| Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `whisper-large-v3` | models.dev lists Groq under `npm: "@ai-sdk/groq"` with **no `api` field** (§1.2) — base URL confirmed instead from Groq's own docs (`console.groq.com/docs/openai`, quoted verbatim there). `api: "openai-completions"`, `authHeader: true`. |
| Mistral | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | `mistral-large-2411`, `mistral-medium-2508`, `devstral-medium-2507` | Same pattern as Groq — models.dev has no `api` field for `@ai-sdk/mistral`; base URL confirmed from `docs.mistral.ai/api/`'s own curl example. `api: "openai-completions"` (Mistral's REST surface is OpenAI-shaped for chat completions), `authHeader: true`. |
| Together AI | `https://api.together.ai/v1` (also documented as `api.together.xyz` in older material — this pass confirmed `.ai` from Together's current docs) | `TOGETHER_API_KEY` | `deepcogito/cogito-v2-1-671b`, `MiniMaxAI/MiniMax-M2.7` | models.dev lists as `togetherai` with `npm: "@ai-sdk/togetherai"`, no `api` field — base URL confirmed from `docs.together.ai/docs/openai-api-compatibility`. `api: "openai-completions"`, `authHeader: true`. |
| Fireworks AI | `https://api.fireworks.ai/inference/v1/` | `FIREWORKS_API_KEY` | `accounts/fireworks/routers/kimi-k2p7-code-fast`, `accounts/fireworks/routers/glm-5p2-fast` | Unlike Groq/Mistral/Together, Fireworks *is* modeled as `npm: "@ai-sdk/openai-compatible"` in models.dev, so its `api` field is directly authoritative here — no separate vendor-doc check needed. `api: "openai-completions"`, `authHeader: true`. Model ids are long `accounts/fireworks/routers/...` paths — copy verbatim into `models[].id`. |
| Z.AI (GLM) | `https://api.z.ai/api/paas/v4` | `ZHIPU_API_KEY` | `glm-4.6`, `glm-4.7`, `glm-4.5-flash` | **Correction to the pi doc's own §5**: that doc guessed the env var name as unspecified/implied "Z.AI"; models.dev's live entry names it explicitly as `ZHIPU_API_KEY` (Z.ai is the product brand, Zhipu is the underlying company — the env var reflects the latter). Also note the pi doc flagged an unresolved Coding-Plan-vs-PAYG base-URL question for Z.ai; models.dev's `api` field (`https://api.z.ai/api/paas/v4`, no trailing slash) matches the pi doc's PAYG path, not the `/api/coding/paas/v4` alternate — still doesn't resolve which one a Coding Plan account needs. `api: "openai-completions"`, `authHeader: true`. |

**What this table deliberately leaves out**: it does not attempt to guess pi's exact `apiKey` command syntax
per provider (that's a key-script implementation detail, §8.2 of the pi doc already generalizes it to "one
JSON file per host, one key-reading script per provider, same shape as `ollama-cloud-key.py`") and it does not
carry `cost`/`contextWindow`/`maxTokens` numbers into the table, for the reason stated above it — those belong
pulled live at implementation time, not frozen into a research doc a fast-moving vendor will outdate within
weeks.

---

## Sources

- models.dev: `README.md` (`github.com/anomalyco/models.dev`, branch `dev`, fetched via `gh api`) — "API",
  "Contributing", "Schema Reference" sections quoted verbatim; `https://models.dev/api.json` fetched and
  parsed directly in this pass (188 provider keys; `deepseek`, `openrouter`, `groq`, `mistral`, `togetherai`,
  `fireworks-ai`, `zai`, `opencode`, `anthropic`, `xai` entries inspected field-by-field).
- opencode: `opencode.ai/docs/providers/` (provider discovery statement, custom-provider JSON example, auth
  storage location, `/connect` and OpenCode Zen sign-in flow); `github.com/anomalyco/opencode` issue #4959
  ("Add option to disable models.dev fetch for corporate proxy environments" — startup fetch behavior, cache
  path, bundled-fallback description); `specs/v2/provider-model.md` in the same repo (V2 plugin-order design,
  cited as directional, not confirmed-shipped, evidence).
- DeepSeek: `api-docs.deepseek.com` — front page / "Your First API Call" (base URL, OpenAI/Anthropic
  compatibility statement), `quick_start/pricing` (model ids, peak/off-peak pricing table),
  `quick_start/rate_limit` (concurrency-not-rate-limit stance, capacity-expansion policy).
- OpenRouter: `openrouter.ai/deepseek/deepseek-v4-flash` (live listing, pricing, multi-host note);
  `openrouter.ai/docs/faq` (no-markup-on-inference statement, credit-purchase fee percentages).
- Groq: `console.groq.com/docs/openai` (OpenAI-compatible base URL, example config).
- Mistral: `docs.mistral.ai/api/` (base URL via curl example).
- Together AI: `docs.together.ai/docs/openai-api-compatibility` (base URL, Python/TypeScript config examples).
- This repo: `docs/research/pi-provider-mechanism-2026-08-15.md` (target data shape throughout — §1.2 field
  table, §4 KISS/no-extension reasoning, §5 DeepSeek/Z.ai provider blocks, §8 registry proposal).

## NOT VERIFIED — collected

- Whether the `anomalyco` GitHub org is a rename of `sst`, an org restructuring, or something else — only the
  ownership fact itself was confirmed (`gh api`), not the reason (§1.1).
- The current, shipped source-file path and exact mechanism for opencode's live models.dev fetch — issue #4959
  names `packages/opencode/src/provider/models.ts`, which no longer exists at that path in the repo's `dev`
  branch today; the fetch logic's current home was not located in this pass (§2.1).
- Whether opencode's `specs/v2/provider-model.md` plugin-order design (`ModelsDevPlugin` at priority 0) is
  shipped, in-progress, or purely aspirational as of this pass (§2.1).
- Whether `deepseek-chat`/`deepseek-reasoner` are still-live legacy aliases or deprecated names no longer
  surfaced in DeepSeek's own current docs — both still appear in models.dev's live `api.json` (§4).
- The reason for the gap between models.dev's `deepseek-v4-flash` cost block and DeepSeek's own pricing page
  figures for the same model (§1.3, §4) — flagged, not explained.
- Together AI's base URL: this pass's fetch of `docs.together.ai` returned `api.together.ai/v1`; older
  third-party material elsewhere on the web references `api.together.xyz` — not reconciled here, use the
  `.ai` domain per the primary source checked in this pass.
