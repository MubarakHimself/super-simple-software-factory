# Pi Provider Mechanism — How Providers, Auth, and Multi-Account Lanes Actually Work

**Researched:** 2026-08-15. **Method:** this repo's own already-proven mechanism (`installer/steps.py`,
the vendored ollama-cloud scripts, `sssf.config.yaml`/`sssf.shipping.config.yaml`, `specs/installer-wizard.md`,
`MAP.md`), cross-checked against pi's own docs (`pi.dev/docs/latest`, mirrored from
`github.com/earendil-works/pi/packages/coding-agent/docs/*.md`), and the npm/GitHub record for the one
extension that actually does multi-account. Every non-obvious claim carries a source. Where the repo's own
recorded, empirically-verified behavior conflicts with what the hosted docs say, both are stated and the
conflict is flagged rather than silently resolved — this is **mechanism** research; which models to run on
which lane is the operator's call and stays out of this document.

---

## Verdict (read this first)

**A new provider is a JSON object, not code.** `~/.pi/agent/models.json` under `providers.<id>` is the whole
mechanism for a static OpenAI-compatible provider (Ollama Cloud, DeepSeek, Z.ai) — this repo already proved
it once, byte-for-byte, for `ollama-cloud`, and nothing about DeepSeek or Z.ai needs anything more.
**The extension API is real and pi does expose `pi.registerProvider()`, but it is the right layer for exactly
two things this repo needs: OAuth-subscription multi-account rotation, and a provider whose model catalog
must be fetched live at startup** — not for adding a plain API-key provider, which is what this repo already
does without one. **The operator's "opencode-go-2" instinct is correct for API-key providers and does not
exist for OAuth-subscription providers**: `models.json`'s `providers` object is a plain dict keyed by any
string you choose, so a second Ollama Cloud or OpenCode Go account is legitimately `ollama-cloud-2` — pi has
no opinion on the name, no built-in dedup, and no quota awareness across it; it is exactly as manual as this
repo's own key-script mechanism already is. **For OAuth-login providers (xai, openai-codex, claude-bridge's
underlying `anthropic`) there is no equivalent facility in pi itself** — the maintainers were asked for
native multi-profile `/login` support and explicitly declined, closing the request in favor of "build an
extension" (GitHub discussion #1666 → #1770). The one extension that does this, **`pi-multi-account`**, is a
**third-party, unaudited npm package** (author `sars267`, repo `Sarrius/pi-multi-account`, not
`earendil-works`), current as of 2026-08-02 — real and apparently well-designed, but a trust decision this
document surfaces rather than makes. **The sharpest correction to the repo's own record**: `installer-wizard.md`
§6.8 states "pi composes models from `models.json` at
startup" and requires a restart; pi's own hosted docs for `/models.md` say the opposite — "the file reloads
each time you open `/model`; no restart is needed." This is an open, testable discrepancy, not resolved here
(see §7).

---

## 1. How a NEW provider is registered

### 1.1 The file, and where it lives

**`~/.pi/agent/models.json`** — global, per-user, one file, not per-project. This is not inferred; it is the
exact path this repo's installer already reads and writes
(`installer/steps.py:1255` `models_path = ctx.home / ".pi" / "agent" / "models.json"`; confirmed again at
`installer/steps.py:1012` where `PI_MODELS_PATH` is derived from the same path and written into `.env`).
pi's own docs corroborate the path and add the one thing the repo's code doesn't need to say because it
already assumes it: *"Configuration is stored at `~/.pi/agent/models.json`."*
(`github.com/earendil-works/pi/packages/coding-agent/docs/models.md`, "File Location"). There is no
per-project variant of this specific file documented anywhere I could find — `.pi/settings.json` (project
overrides for `packages`/`extensions`/`skills`/`prompts`/`themes`) is the one file pi documents as
project-scoped (`pi.dev/docs/latest/settings`, "Settings File Locations and Scope"); `models.json` was not
listed alongside it.

### 1.2 The schema (verified twice — against this repo's live seed and against pi's docs)

This repo's own seed asset is the ground truth for what pi actually accepts, because it has been running:

```json
{
  "api": "openai-completions",
  "apiKey": "!python 'REPLACED-AT-INSTALL-TIME'",
  "authHeader": true,
  "baseUrl": "https://ollama.com/v1",
  "compat": {
    "maxTokensField": "max_tokens",
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": true,
    "supportsUsageInStreaming": true
  },
  "models": [ { "id": "...", "name": "...", "input": ["text"], "contextWindow": 262144,
                "maxTokens": 32768, "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } } ]
}
```
(`installer/assets/pi/ollama-cloud.provider.json`, byte-identical to what `installer/steps.py:apply_ollama_provider`
merges into `providers["ollama-cloud"]`.)

pi's docs give the same fields plus the ones this repo's single provider never needed:

| Field | Required | Meaning | Source |
|---|---|---|---|
| `baseUrl` | required once `models` is set | API endpoint | `custom-provider.md` |
| `api` | required once `models` is set | one of `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai` | `models.md` |
| `apiKey` | required unless OAuth | literal, `$ENV_VAR`/`${ENV_VAR}`, or `!command` | `custom-provider.md`, `models.md` |
| `authHeader` | optional | `true` → adds `Authorization: Bearer <resolved key>` | `custom-provider.md` |
| `headers` | optional | custom headers, same value-resolution syntax as `apiKey` | `models.md` |
| `models` | optional | array of model entries; **if provided, replaces all existing models for this provider** | `custom-provider.md` |
| `modelOverrides` | optional | per-model tweaks to a provider's *built-in* models, without replacing the whole list | `models.md` — and this repo already threads it through: `merge_ollama_provider` in `installer/steps.py:574` explicitly preserves a hand-added `modelOverrides` block across every re-merge |
| `compat` | optional, provider- or model-level | `supportsDeveloperRole`, `supportsReasoningEffort`, `supportsUsageInStreaming`, `maxTokensField`, plus `thinkingFormat`/`cacheControlFormat` per `custom-provider.md` | both |

Per-model fields (`models.md`, "Model Schema"): `id` (required), `name`, `reasoning` (bool, default `false`),
`input` (`["text"]` or `["text","image"]`), `contextWindow` (default 128000), `maxTokens` (default 16384),
`cost` (`{input, output, cacheRead, cacheWrite}`, plus an optional `tiers` array for context-length pricing
breaks), `thinkingLevelMap`, `samplingParams`.

**Composition, not replacement, at the provider-list level.** Adding `providers["ollama-cloud"]` does not
remove `anthropic`, `openai`, `xai`, etc. — pi's built-in catalog and your `models.json` catalog merge.
Confirmed both ways: pi's docs state it plainly (*"Custom models and provider overrides compose with the
built-in catalog... Built-in models remain available unless explicitly replaced by matching `id`"*,
`models.md`), and this repo's own merge function is written to the same assumption —
`merge_ollama_provider` deep-copies `existing`, touches only `providers["ollama-cloud"]`, and leaves every
sibling provider byte-identical (`installer/steps.py:574-585`, docstring: *"preserving every sibling
provider untouched"*).

### 1.3 The programmatic path (extensions) — the other half of the mechanism

pi also exposes `pi.registerProvider(name, config)` from inside an extension, taking the same `ProviderConfig`
shape as the static file, plus two things the file cannot do: an **`async refreshModels({signal})`** callback
for a live-fetched catalog, and OAuth `login()`/`refreshToken()` callbacks for subscription providers
(`pi.dev/docs/latest/extensions`, "Provider Registration"; example given for a local llama.cpp catalog and
for overriding an existing provider's `baseUrl`). This is documented as additive to, not a replacement for,
`models.json` — the same doc says extensions **cannot** write `models.json`/`settings.json` directly; they
call `pi.registerProvider()` instead, which is a runtime registration, not a file edit.

This repo already demonstrates the file path (`ollama-cloud`, zero extension code) and the extension path is
one hop away, already visible in the shipping config's own comments:
`sync-ollama-cloud-models.py` does the live-catalog fetch this repo needs, but does it **as a separate
Python script the installer runs**, then writes the result into `models.json` as a static array — not as a
pi extension's `refreshModels()`. Both get the same live catalog; the difference is *when* it refreshes
(installer run, vs. every pi startup) and *where* the fetch logic lives (a vendored Python script the
installer owns, vs. a TypeScript extension pi loads). See §4 for which is the better fit going forward.

---

## 2. How auth is stored per provider, and what must never sync

### 2.1 pi's own auth store

**`~/.pi/agent/auth.json`**, mode `0600`, one entry per provider name:
```json
{ "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "openai": { "type": "api_key", "key": "sk-..." } }
```
(`pi.dev/docs/latest/providers`, "Auth File Location & Schema"). OAuth tokens land here automatically after
`/login` and auto-refresh (same page, "OAuth Login Flow"). An optional `"env"` sub-object can carry
provider-scoped env values.

**Credential resolution order** (`pi.dev/docs/latest/providers`, "Credential Resolution Order"):
1. CLI `--api-key` flag
2. `auth.json` entry (API key or OAuth token)
3. Environment variable
4. Custom provider keys from `models.json` (i.e. the `apiKey` field on the provider block itself)

This repo's own `AUTH_LANES` detection in `installer/steps.py:1602-1630` reads exactly this store for the
three lanes that have no dedicated install step (`xai`, `openai-codex` via `~/.codex/auth.json`, and
`claude-bridge` via `~/.claude/.credentials.json` or `CLAUDE_CODE_OAUTH_TOKEN`), and the code comment is
explicit about *why* it never asks pi instead: **`pi auth check` is disqualified** — *"it reported ready on
an expired token and not_ready on a working one in the same session"* (`specs/installer-wizard.md:621-623`,
citing `STATE.md`). This is an empirical finding from operating this exact tool, not a documentation claim,
and it should carry more weight than anything pi's docs say about its own `auth check` command.

### 2.2 What must NEVER be git-synced

Three things, confirmed at three separate places in this repo:

- **`~/.pi/agent/auth.json`** and **OpenCode's own `auth.json`** (`%LOCALAPPDATA%\opencode\auth.json` on
  Windows, `~/.local/share/opencode/auth.json` on POSIX) — both are per-host credential stores under the
  user's home directory, never under the repo. Nothing in `installer/steps.py` or the vendored scripts ever
  writes a key into a repo-tracked path; `sync-ollama-cloud-models.py` writes only to those two OS-specific
  home-dir locations (`local_opencode_auth_paths()`, `seed_local_opencode_auth()`).
- **`CLAUDE_CODE_OAUTH_TOKEN`** — written to `~/.sdl-factory/secrets.env`, mode `0600`, explicitly *"never
  to the repo, never to the run log, never to stdout"* (`installer/steps.py:1562-1563`,
  `apply_oauth_token`). The repo's `.env` gets only a **comment** naming where the real secret lives
  (`# secrets live in ~/.sdl-factory/secrets.env - source with: set -a; . ~/.sdl-factory/secrets.env; set +a`).
- **The `apiKey` field in `models.json` itself never holds a literal key** in this repo's working pattern —
  it holds a **command** (`"!python '.../ollama-cloud-key.py'"`), so `models.json`'s *shape* could in
  principle be git-tracked (structure, not secret) while the actual key lives in a file the command reads at
  call time. This is a genuinely useful property for the registry proposal in §8: the provider *definition*
  (baseUrl, api, compat, model list, and an `apiKey` command *template*) is inert without the credential the
  command resolves, so a definition file is safe to track while the thing it shells out to is not.

Acceptance test A12 in the wizard's own spec makes this a hard, checked property, not a hope: *"No token, key
or secret appears in `~/.sdl-factory/install/*.log`, in stdout, or in the JSON output"*
(`specs/installer-wizard.md:838`).

---

## 3. Multiple accounts of one provider becoming distinct lanes — the "opencode-go-2" pattern

**This splits into two genuinely different mechanisms depending on the provider type, and the operator's
instinct is right for one and doesn't apply to the other.**

### 3.1 API-key / OpenAI-compatible providers (Ollama Cloud, OpenCode Go, DeepSeek, Z.ai) — CONFIRMED

`models.json`'s `providers` object is a plain JSON dict keyed by whatever string you choose
(`providers.setdefault("providers", {})` in `installer/steps.py:578` — an ordinary Python dict, no schema on
the key itself; `merge_ollama_provider` never validates the key name against a fixed list). **Nothing stops
`providers["ollama-cloud-2"]` from existing beside `providers["ollama-cloud"]`, each with its own `baseUrl`
(if different), its own `apiKey` command, and its own model list.** pi resolves `provider/model-id` by
matching the leading segment against the provider list (`.claude/skills/sssf/references/config.md:99`, "The
leading segment is matched against the provider list first"), so `ollama-cloud-2/kimi-k2.7-code` is a
perfectly ordinary, independent lane the moment that key exists in `models.json`.

**What this buys you, and what it doesn't:** it buys a second, independently-tracked quota bucket — a second
Ollama Cloud account's 3-concurrent-model ceiling is a *second* 3, not a shared 3 (see
`docs/research/provider-limits-and-models.md` §1.3 for the documented Ollama Cloud Pro concurrency figure).
It does **not** buy any of what a real multi-account tool gives you: no automatic failover, no cooldown
tracking, no dedup if the two blocks accidentally point at the same underlying key, no rotation. Distinct
lane naming is entirely manual and entirely the sssf lane-balancer's job (`MAP.md:161-168`,
"Balancing: least-connections weighted by remaining weekly headroom") — pi itself has zero opinion once the
provider block exists.

**Correction to volunteer, unprompted:** this repo's own record currently says something narrower than the
mechanism actually allows, and the gap matters for this exact question. `specs/installer-wizard.md:493-495`
states *"ollama-cloud and opencode-go surface the same
models — they are one subscription, one quota"* — because the key script reads OpenCode's shared
`auth.json`, and `opencode-go` and `ollama-cloud` are both read from that single store today. That is an
accurate description of the **current single-account wiring**, but it is not a mechanism limit: it's a
consequence of both provider blocks' `apiKey` commands resolving to the *same* underlying credential file.
A second account of either service is a `models.json` question (a second block, a second key-resolution
path), never a "pi won't let you" question. The independent research doc already on file corroborates that
Ollama Cloud and OpenCode Go are in fact two *separate, differently-priced* subscription products ($20/mo
Ollama Cloud Pro vs. $10/mo OpenCode Go — `docs/research/provider-limits-and-models.md` §1.3–1.4), which
makes "one subscription" read as shorthand for "the wizard currently only wires one shared key source,"
not a fact about either vendor's billing. Worth a operator-level clarification pass on that line
independent of this document.

### 3.2 OAuth-subscription providers (xai, openai-codex, anthropic/claude-bridge) — NO NATIVE MECHANISM

pi's own `auth.json` schema (§2.1) has **one entry per provider name** — there is no namespacing for a
second Claude Pro/Max login, a second xAI subscription, or a second ChatGPT/Codex login inside core pi.
This was asked for directly: **GitHub discussion #1666**, *"Multi-profile support for OAuth providers
(`/login`)"* (opened 2026-02-27 by `psg2`), proposed exactly the pattern you'd expect —
`/login anthropic work`, `/profile anthropic work`, namespaced `"anthropic:work"` entries in `auth.json` —
estimated by its own author at *"approximately 40 lines in AuthStorage."* **It was not merged.** The
maintainers closed it (tracked as #1770); the author's own follow-up (2026-03-05) says the feature became
*"a personal extension for themselves"* (`github.com/psg2/agent-stuff/tree/main/pi/extensions/multi-profile`)
rather than core functionality. Core pi's position, read from that outcome, is: **multi-account OAuth is an
extension's job, not the platform's.**

**One extension does exist and does this at real scope: `pi-multi-account`.**
- npm: `pi-multi-account`, current version **1.14.3** (published 2026-06-09, last updated 2026-08-02) —
  `registry.npmjs.org/pi-multi-account`.
- **Third-party, not `earendil-works`.** Author `sars267`, repo `github.com/Sarrius/pi-multi-account`.
  Install: `pi install npm:pi-multi-account` (same imperative path this repo already uses for
  `pi-claude-bridge`/`@tintinweb/pi-subagents`).
- **Covers exactly four provider families**: Anthropic (Claude Pro/Max), OpenAI/ChatGPT Codex, Qwen/Alibaba,
  and **Ollama** — notably, Ollama is covered here too, as an OAuth-style account rather than the
  API-key-command pattern this repo built by hand.
- **Naming convention, from its own README/docs**: `/login`, choose **"Use a subscription"**, then pick a
  numbered slot — e.g. `anthropic-account-3`, `openai-codex-account-5`. This is auto-discovered from
  `auth.json` on the next sweep; nothing is hand-edited.
- **Mechanism**: auto-discovers every authenticated account already in `auth.json`, builds a failover
  rotation dynamically, deduplicates identical accounts, and switches to the next account on 429/402/403 —
  putting the exhausted one on a cooldown parsed from the provider's own reset metadata where available,
  not permanently invalidating it. State lives in two files, both under `~/.pi/agent/`:
  `provider-failover.json` (config: `autoContinue`, `autoDiscover`, provider ordering, cooldown timing,
  reasoning-level preference) and `provider-failover-state.json` (cooldowns, invalidations, catalog cache,
  resume markers — explicitly discarded, not durable).
- **Its own privacy claim, worth stating verbatim since it bears on trust**: *"Reads auth.json but never
  writes credentials; tokens reduced to SHA-256 fingerprints; sent only to their own providers; state
  contains no credentials; debug log safe to share."* (npm README.) Not independently audited here —
  stated, not verified.

**So: the "opencode-go-2" instinct is right in shape (a suffix distinguishes a second account) but applies
to the wrong provider family.** For `opencode-go` and `ollama-cloud` specifically — both API-key providers
in this repo's current wiring — a hand-named second `models.json` block (`opencode-go-2`, `ollama-cloud-2`,
whatever string the settings pane writes) is the correct, sufficient, zero-dependency mechanism, and it is
literally the same pattern already proven for the first account. For `xai`/`openai-codex`/`anthropic`, the
equivalent second-account story runs through pi's numbered-slot OAuth convention
(`<provider>-account-<n>`) — either driven by hand through `/login`, or automated by installing the
third-party `pi-multi-account` extension.

---

## 4. Is the extension API the right layer? — an honest assessment

**The operator's suspicion is half right, sharply split by provider type.**

**Not needed, and would be over-engineering, for a static OpenAI-compatible provider.** This repo already
has the counter-example running: `ollama-cloud` is wired with **zero extension code** — a JSON seed asset, a
Python key script, a Python sync script, all owned and vendored by the installer
(`installer/assets/pi/ollama-cloud.provider.json` + `scripts/`). DeepSeek and Z.ai (§5) need nothing more
than the same shape: a `baseUrl`, `api: "openai-completions"`, and an `apiKey` string or command. Building a
pi extension to register these would mean writing and maintaining TypeScript, loading it via
`harness_engineering`/`-e` on every agent that might resolve the model, and giving up the plain-JSON
git-syncability that §8's registry proposal depends on — a straightforward MAP standing rule 1 violation
("If a ticket's answer is 'add a system,' it is probably wrong").

**Genuinely the right layer for exactly two things, both already visible in this repo or its research:**

1. **OAuth-subscription multi-account.** Per §3.2, pi core deliberately does not do this; the only paths are
   a hand-rolled extension (`psg2`'s) or the third-party `pi-multi-account`. If the operator wants a second
   xAI or a second Claude subscription to become a real failover lane rather than a manual `/login` swap,
   an extension is not a choice among several mechanisms — it is the only one that exists.
2. **A live-fetched model catalog at pi startup**, via `refreshModels({signal})` on a registered provider.
   This repo currently gets the equivalent behavior a different way — `sync-ollama-cloud-models.py` runs at
   *install time* (or on demand), not at every pi launch, and writes a static array into `models.json`. That
   is arguably *better* for this factory's KISS/no-ambient-state rules (MAP rule 12: "factory-critical config
   never lives only in files pi rewrites") — a model list that only changes when the installer explicitly
   reconverges is more auditable and more git-trackable than one a `refreshModels` extension silently
   refreshes on every launch. **Recommendation: keep the vendored-script pattern for anything the registry
   proposal in §8 needs to stay git-trackable; reserve `refreshModels` for a provider whose catalog changes
   fast enough that install-time staleness would be a real problem** — none of the candidates here (Ollama
   Cloud, DeepSeek, Z.ai) obviously qualify.

**What extensions cannot do, worth stating because it closes off a plausible-sounding shortcut**: they
cannot write `models.json` or `settings.json` directly (`pi.dev/docs/latest/extensions`, "Extensions
Capabilities" — file system access is real, but the model/provider surface is the `pi.registerProvider()`
runtime call, not a file edit). So an extension is never a way to make the settings pane's writes
disappear — the pane (or the installer) still owns the file; an extension only ever adds a *second*,
in-memory registration on top, scoped to whatever session loaded it.

---

## 5. OpenAI-compatible providers — DeepSeek and Z.ai, minimal config

Both are documented, first-party, OpenAI-SDK-compatible endpoints — same shape as `ollama-cloud`, no
extension needed.

### DeepSeek

```json
"deepseek": {
  "api": "openai-completions",
  "apiKey": "!python '<abs path to a key-reading script, same pattern as ollama-cloud-key.py>'",
  "authHeader": true,
  "baseUrl": "https://api.deepseek.com",
  "models": [
    { "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "contextWindow": 128000 },
    { "id": "deepseek-v4-pro",   "name": "DeepSeek V4 Pro",   "contextWindow": 128000 }
  ]
}
```
Base URL and OpenAI-SDK compatibility confirmed directly against DeepSeek's own docs
(`api-docs.deepseek.com`, "Your First API Call": *"an API format compatible with OpenAI/Anthropic"*, base
URL `https://api.deepseek.com`). Model IDs `deepseek-v4-flash`/`deepseek-v4-pro` match both DeepSeek's own
docs and this repo's existing research (`docs/research/provider-limits-and-models.md` §1.9, "DeepSeek direct
API" row — 2,500 concurrent requests on `deepseek-v4-flash`, published on DeepSeek's pricing page).
`contextWindow`/`cost` values above are placeholders — pull DeepSeek's published context/pricing figures
before shipping this block; not re-verified in this pass.

### Z.ai (GLM)

```json
"zai": {
  "api": "openai-completions",
  "apiKey": "!python '<abs path to a key-reading script>'",
  "authHeader": true,
  "baseUrl": "https://api.z.ai/api/paas/v4/",
  "models": [
    { "id": "glm-5.2", "name": "GLM 5.2", "contextWindow": 1000000, "reasoning": true }
  ]
}
```
Base URL and header convention confirmed against Z.ai's own quick-start (`docs.z.ai`, "OpenAI-Compatible API
Details": base URL `https://api.z.ai/api/paas/v4/`, `Authorization: Bearer <key>`). **One caveat surfaced by
a broader search and not independently re-verified against Z.ai's own docs in this pass**: if the operator's
Z.ai account is on their *Coding Plan* subscription rather than pay-as-you-go, the OpenAI-compatible base URL
may need to be the coding-specific path (`/api/coding/paas/v4`) rather than the general one
(`/api/paas/v4`) — third-party sources disagree on whether these are interchangeable for a Coding Plan
account. **NOT VERIFIED** — confirm against the operator's actual Z.ai plan tier before wiring.

Z.ai also publishes an **Anthropic-compatible** endpoint (`https://api.z.ai/api/anthropic`) for using GLM as
a drop-in Claude replacement via `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` — not the same as registering
it as a pi provider, mentioned here only because it's a real alternative wiring path if `claude-bridge`
compatibility ever matters more than a native `openai-completions` lane.

Both blocks follow the exact shape `merge_ollama_provider` already generalizes (a named provider key, an
`apiKey` command, `authHeader: true`, a `models` array) — no new merge logic needed, only a new seed asset
and a new key-reading script per provider, mirroring `ollama-cloud-key.py`.

---

## 6. The two-device story: what syncs by git vs. what the app must write server-side over SSH

**Ratified shape, already recorded in `MAP.md`, not re-litigated here**: *"connect-server with autonomous
provisioning — SSH under the hood (ratified): host + credentials once in Settings, then the app converges
the factory on the server itself; the operator never sees a terminal"* (`MAP.md:41-43`). This section states
what that split means concretely for providers specifically.

**Git-tracked (definitions, no secrets):**
- The provider **shape** — `baseUrl`, `api`, `compat`, `authHeader`, the `models` array, and the `apiKey`
  field as a **command template** rather than a literal (e.g. `"!python 'scripts/<name>-key.py'"`). This is
  exactly what `installer/assets/pi/ollama-cloud.provider.json` already is — a seed asset committed to the
  repo, with `apiKey` a placeholder string (`"REPLACED-AT-INSTALL-TIME"`) the installer rewrites per-host
  before merge (`installer/steps.py:1191-1199`, `_seed_provider_block`).
- The lane names themselves, as `provider/model-id` strings in `sssf.config.yaml` /
  `sssf.shipping.config.yaml` — plain text, no credential content, already git-tracked today.
- The **key-reading script's logic** (which files it checks, in what order) — already vendored and hashed
  in `installer/assets/pi/scripts/`, with provenance and sha256 recorded in `installer/assets/pi/SOURCES.md`.

**Never git-synced, must be written server-side over SSH or read from a per-host store:**
- `~/.pi/agent/auth.json` and OpenCode's `auth.json` — per-host, per-OS paths, containing live keys/tokens
  (§2.1–2.2).
- `~/.sdl-factory/secrets.env` (mode 0600) — the one file this repo already uses for exactly this pattern
  today, for `CLAUDE_CODE_OAUTH_TOKEN` (`installer/steps.py:1546-1551`). The comment left in `.env` — *"secrets
  live in ~/.sdl-factory/secrets.env"* — is the whole cross-reference; nothing sensitive touches the
  git-tracked file.
- `provider-failover.json`/`provider-failover-state.json` if `pi-multi-account` is ever adopted (§3.2) — both
  under `~/.pi/agent/`, both explicitly host-local (the state file is described as disposable, not synced).

**Prior art for the laptop→server credential path already exists in this repo, and is deliberately
unused.** `sync-ollama-cloud-models.py --from-server` reads the VPS's own OpenCode `auth.json` over an SSH
connection (via `paramiko`) whose host/user/password come from a *personal* babysitter script path
(`~/.pi/qmx-babysitter/qmx-bmad-watcher.py`), and copies that one key into the laptop's local OpenCode auth
store. `specs/installer-wizard.md:487-489` explicitly says **not to build on this**: *"Do not use the sync
script's `--from-server` flag. It reads connection details out of a personal babysitter script path. It is
recorded here as prior art for the local↔server credential problem, and left alone."* The mechanism it
demonstrates — SSH in, read the remote `auth.json`, extract one provider's key, done — is exactly the shape
the settings pane's "connect-server" flow needs, minus the hard-coded personal script and minus the
password-based auth. Read direction matters too: today's script pulls *from* server *to* laptop; the
ratified UI design in `MAP.md` runs the opposite way — the operator enters credentials once in Settings on
the laptop, and the app pushes/writes them to the server over SSH, never the reverse. Building that push path
is genuinely new work; the pull path is the one piece of runnable prior art to study before writing it, not
to copy directly.

---

## 7. Open discrepancy: does `models.json` need a pi restart?

Stated plainly because it is testable and currently unresolved, not because either side is obviously wrong:

| Source | Claim |
|---|---|
| `specs/installer-wizard.md:491` | *"**Restart required:** pi composes models from `models.json` at startup."* |
| `pi.dev/docs/latest` / `github.com/earendil-works/pi/.../docs/models.md` | *"The file reloads each time you open `/model`; no restart is needed."* |

Two sources, not three: this repo's claim rests on `specs/installer-wizard.md` alone.
`.claude/skills/sssf/references/config.md` says nothing about `models.json` composition or a
restart — it was cited here in an earlier draft and the citation was wrong.

The repo's claim is recorded as coming from live host inspection on 2026-08-12
(`specs/installer-wizard.md:860`, "Live host inspection... `~/.pi/agent/{settings,models}.json`") — i.e. it
was observed, not assumed. It's possible pi's behavior changed between whatever version was inspected then
and whatever version the hosted docs describe now (`pi-coding-agent` ships fast; the multi-account package
alone had two releases in the two months this research covers). It's also possible the "reloads on `/model`"
claim is narrower than it reads — reloading the picker's list is not the same as an *already-running* agent
session picking up a newly-added provider mid-task. **Not resolved here.** Cheapest real test: add a
harmless new model id to an existing provider block while a pi session is open, then check whether `/model`
shows it without restarting — the exact acceptance-test shape this repo already uses elsewhere.

---

## 8. Proposed registry shape — what the settings pane should write

Small, and deliberately shaped to match what pi already reads rather than inventing a new abstraction. Two
files, same split as everything else in this repo: one git-tracked and secret-free, one host-local and
never synced.

### 8.1 `installer/assets/pi/providers/<id>.provider.json` — one file per provider, git-tracked

Exactly the `ollama-cloud.provider.json` shape this repo already has, generalized from one file to a
directory of them:

```json
{
  "id": "deepseek",
  "api": "openai-completions",
  "apiKey": "!python 'REPLACED-AT-INSTALL-TIME'",
  "authHeader": true,
  "baseUrl": "https://api.deepseek.com",
  "compat": { "supportsReasoningEffort": false },
  "keyScript": "deepseek-key.py",
  "models": [
    { "id": "deepseek-v4-flash", "name": "deepseek-v4-flash (DeepSeek)", "contextWindow": 128000,
      "cost": { "input": 0.14, "output": 0.28, "cacheRead": 0, "cacheWrite": 0 } }
  ]
}
```
- `id` is new relative to today's single-provider seed — needed once there's more than one file, and it's
  also the field that makes `<id>-2` (§3.1) a same-shape sibling file rather than a special case: a second
  account is `deepseek-2.provider.json` with a different `keyScript` target, nothing else structurally
  different.
- `keyScript` names a vendored script under `installer/assets/pi/scripts/` (same directory, same sha256
  provenance discipline already in `SOURCES.md`) — the installer resolves it to an absolute path and
  rewrites `apiKey` exactly as `_seed_provider_block` does today (`installer/steps.py:1191-1199`).
- `apiKey` stays a placeholder in the tracked file, always. Nothing here is a secret; the whole point of the
  split is that this file is safe in git even fully populated.

### 8.2 A per-host key store the scripts read — not new, already exists, just generalized

Today's `ollama-cloud-key.py` reads OpenCode's `auth.json` because that happened to be where the one key
already lived. A registry with more providers needs a store that isn't borrowed from a different tool's
convention. Simplest fit, staying inside what pi already reads: **one JSON file per host under
`~/.sdl-factory/provider-keys.json`, mode 0600, never git-synced** — same protection level as
`secrets.env` today, same "app writes this, SSH-side on the server, local file on the laptop" split from
§6:
```json
{ "deepseek": "sk-...", "deepseek-2": "sk-...", "zai": "..." }
```
Each provider's `keyScript` becomes a five-line, shared script (or one script taking a `--provider` arg)
that reads its own key out of this one file — the same shape as `ollama-cloud-key.py`, minus the multi-path
OpenCode fallback search, since there'd be exactly one place to look. The settings pane's job, per provider
row the operator adds: write one entry into this file (server-side over SSH if the target is the server,
locally if the target is the laptop — the existing `secrets.env` write path is the template), and write or
update one `<id>.provider.json` seed (git-tracked, PR-able, reviewable).

### 8.3 What this deliberately does NOT do

- **No new merge engine.** `merge_ollama_provider`'s pattern — deep-copy, touch only your own provider key,
  preserve every sibling and any hand-added `modelOverrides` — already generalizes to N providers without
  changing its shape; it becomes "for each `<id>.provider.json` in the directory, merge
  `providers[id]`" instead of one hard-coded call.
- **No extension.** Per §4, none of the candidate providers (Ollama Cloud, DeepSeek, Z.ai, a second OpenCode
  Go account) need `pi.registerProvider()` — the file mechanism already proven for `ollama-cloud` covers
  all of them.
- **No native multi-account for OAuth providers.** This proposal is scoped to API-key providers, per §3.1's
  boundary. If the operator later wants a second xAI or Claude account to be a real rotation lane rather
than a manual `/login` swap, that is a separate decision (adopt `pi-multi-account`, or write the repo's own
  extension) — not something the registry above can express, because pi's own `auth.json` can't express it
  either (§3.2). Worth its own ticket if wanted, not folded into this one.
- **Does not resolve §7.** If `models.json` genuinely needs a restart, the settings pane's "provider added"
  flow needs an explicit "restart pi" step in its own UI, same as the installer already prints today
  (`specs/installer-wizard.md:755`, *"restart pi to pick up models.json and packages"*). Confirm §7 before
  deciding whether that instruction is still true.

---

## Sources

- This repo, primary: `installer/assets/pi/ollama-cloud.provider.json`, `installer/assets/pi/SOURCES.md`,
  `installer/assets/pi/scripts/ollama-cloud-key.py`, `installer/assets/pi/scripts/sync-ollama-cloud-models.py`,
  `installer/steps.py` (functions `merge_ollama_provider`, `_seed_provider_block`, `_try_key_script`,
  `apply_ollama_provider`, `apply_pi`, `apply_oauth_token`, `AUTH_LANES`/`apply_auth`),
  `specs/installer-wizard.md` §§6.6–6.8, 6.12, 6.14, and §14 Sources,
  `.claude/skills/sssf/references/config.md` ("Model resolution", "Harness engineering"),
  `adws/adw_sssf_config/sssf.config.yaml`, `adws/adw_sssf_config/sssf.shipping.config.yaml`,
  `MAP.md` (Standing rules, Roster, Platform landmines, the UI addition row),
  `apps/ui-v2/src/settings/ProvidersPane.tsx` (current, deliberately-scoped-out state of the settings pane),
  `docs/research/provider-limits-and-models.md` §§1.2–1.4, 1.9 (pi-claude-bridge, Ollama Cloud, OpenCode
  Go/Zen, DeepSeek concurrency).
- pi docs, mirrored: `pi.dev/docs/latest/custom-provider`, `/providers`, `/settings`, `/extensions`;
  `github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/{custom-provider,providers,models,extensions}.md`.
- Multi-account: `github.com/earendil-works/pi/discussions/1666` ("Multi-profile support for OAuth providers
  (`/login`)", opened by `psg2`, 2026-02-27, closed via #1770; author's own follow-up extension at
  `github.com/psg2/agent-stuff/tree/main/pi/extensions/multi-profile`); `registry.npmjs.org/pi-multi-account`
  (raw registry JSON: v1.14.3, author `sars267`, repo `github.com/Sarrius/pi-multi-account`, created
  2026-06-09, last modified 2026-08-02); `pi.dev/packages/pi-multi-account`.
- OpenAI-compatible providers: `api-docs.deepseek.com` ("Your First API Call"); `docs.z.ai` (quick-start,
  OpenAI-compatible endpoint section).

## NOT VERIFIED — collected

- Whether `models.json` provider/model additions take effect without a pi restart (§7) — the repo's own
  live-inspection record and pi's hosted docs disagree; not independently re-tested in this pass.
- The exact Z.ai base URL for Coding-Plan-subscription accounts vs. pay-as-you-go (§5) — general PAYG
  endpoint confirmed against Z.ai's own docs; the coding-plan-specific path came from a secondary search
  result, not confirmed against Z.ai's own docs directly.
- `pi-multi-account`'s privacy claim ("never writes credentials... debug log safe to share") is stated from
  its own README, not independently audited.
- Whether OpenCode Go and Ollama Cloud are truly "one subscription" at the vendor level, or whether that is
  purely an artifact of this repo's shared key-reading script (§3.1) — flagged for an operator-level
  clarification, not resolved here.
- DeepSeek/Z.ai `contextWindow` and `cost` figures in the §5 example blocks are illustrative placeholders,
  not pulled fresh from either vendor's current pricing page in this pass.
