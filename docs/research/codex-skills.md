# Codex skills compatibility

Research for the MAP open question *"Codex skills compatibility"*. Question as posed: the operator
plans in Claude Code (Fable) normally and in **Codex CLI with GPT 5.6 Sol** when Claude quota is
out; his planning stack (Pocock chain + `documentation-factory` + the new `queue-publish`) must work
in both. The premise carried into this research was that *"Codex has a specific way of doing its own
skills; even Matt Pocock faced the same issue."*

**Headline: the premise is half right, and the expensive half is already solved.** Codex reads
`~/.agents/skills` — the *same physical directory* skills.sh installs into and that `~/.claude/skills`
symlinks to. The Pocock chain is already live in Codex on this machine; nothing needs porting. The
real gap is narrow: the two skills that are **not** in that tree (`documentation-factory`, and
`queue-publish` once it exists) are invisible to Codex. Fix is a move plus a symlink.

Date: 2026-08-12. Codex CLI version on this machine: **0.147.0**.

---

## 1. How Codex CLI actually loads skills

### 1.1 Discovery paths

Codex scans a fixed set of locations, in precedence order
([OpenAI, *Build skills*](https://learn.chatgpt.com/docs/build-skills.md) — canonical URL
`https://developers.openai.com/codex/skills` 308-redirects there):

| Scope | Location |
|---|---|
| `REPO` | `$CWD/.agents/skills` |
| `REPO` | `$CWD/../.agents/skills` |
| `REPO` | `$REPO_ROOT/.agents/skills` |
| `USER` | **`$HOME/.agents/skills`** |
| `ADMIN` | `/etc/codex/skills` |
| `SYSTEM` | bundled with Codex by OpenAI |

The user scope is `~/.agents/skills` — **not** `~/.codex/skills`. This is the single most important
fact in this document, because it is exactly where skills.sh puts everything (§3).

`~/.codex/skills/` is not dead, though: Codex's own bundled `skill-creator` tells authors to
"place it in `$CODEX_HOME/skills` (or `~/.codex/skills` when `CODEX_HOME` is unset)"
(string extracted from `C:\Users\Mubarak\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`). Treat
it as a Codex-only side door; `.agents/skills` is the cross-harness one and the one to use.

Corroboration from the installed binary rather than the docs — and stated with its limits, because
it is suggestive rather than conclusive. `codex.exe` (0.147.0) contains the string constants
`.agents` (34 occurrences), `codex/skills` (3), `skills.config` (3), `allow_implicit_invocation`
(15), `SKILL.md` (125), and `openai.yaml` (31). The **contiguous** literal `.agents/skills` does
**not** appear (0 hits), nor does `/etc/codex/skills` — the path segments are interned separately
and joined at runtime, which is normal for Rust. What does appear are the adjacent-constant
fragments `.agentsskills`, `.cursor.claude.agents`, and `.git.agents.codex`, i.e. `.agents` and
`skills` sitting side by side in the string table, and harness-directory names enumerated together.
The three `codex/skills` hits are all from the embedded Python `skill-creator` documentation, not
from discovery code. Read this as consistent with the documented `.agents/skills` scan, not as proof
of it; §6 gives the check that would settle it.

### 1.2 Skill format

Only two frontmatter fields are mandatory in `SKILL.md`: **`name`** and **`description`**
([*Build skills*](https://learn.chatgpt.com/docs/build-skills.md)). That is the same floor Claude
Code requires, which is why a single `SKILL.md` genuinely serves both harnesses.

Codex-specific metadata is optional and lives in a sibling file, `<skill>/agents/openai.yaml`. Local
spec, shipped inside Codex itself at
`C:\Users\Mubarak\.codex\skills\.system\skill-creator\references\openai_yaml.md`:

```yaml
interface:
  display_name: "…"        # UI title
  short_description: "…"   # 25–64 chars
  icon_small / icon_large / brand_color / default_prompt
dependencies:
  tools: [ { type: "mcp", value: …, transport: …, url: … } ]
policy:
  allow_implicit_invocation: true   # default
```

That file's own words on the field that matters: *"When false, the skill is not injected into the
model context by default, but can still be invoked explicitly via `$skill`. Defaults to true."*

### 1.3 What triggers a skill

Two paths ([*Build skills*](https://learn.chatgpt.com/docs/build-skills.md)):

- **Explicit** — type `$` in Codex CLI to mention a skill (`$wayfinder`). This is Codex's equivalent
  of Claude Code's `/skill`. In ChatGPT it is `@skill`.
- **Implicit** — "ChatGPT or Codex can choose a skill when your task matches the skill
  `description`." Model-invoked, on by default.

So **Codex does support model-invoked skills.** There is no fundamental capability gap to work
around and nothing to degrade to.

### 1.4 config.toml

`config.toml` is not how skills are *installed*; it is how individual ones are *switched off*:

```toml
[[skills.config]]
path = "/path/to/skill/SKILL.md"
enabled = false
```

Restart Codex after editing. Local `~/.codex/config.toml` contains **no** `skills` section (only an
unrelated `skill = "#b06dff"` theme colour at line 113), i.e. nothing is being suppressed here.

### 1.5 AGENTS.md is a different mechanism, and is not a skills bridge

`AGENTS.md` is Codex's always-on instruction file, not a skill loader — it has no discovery,
no `$`-invocation, and no per-skill gating. The skills doc does not mention it at all. Local state:
`~/.codex/AGENTS.md` exists but is **0 bytes**, and `C:\Users\Mubarak\Documents\sdl-factory\` has
**no AGENTS.md at all** (repo root listing). An AGENTS.md pointer was one of the candidate fixes in
the brief; §5 rejects it, because it would inline instructions permanently into every Codex session
instead of loading them on demand.

---

## 2. What Matt Pocock actually hit, and what he shipped

The issue, verbatim title: **"Codex does not respect disable-model-invocation without
agents/openai.yaml"** — [mattpocock/skills#516](https://github.com/mattpocock/skills/issues/516),
opened 2026-07-11, **closed 2026-07-13**.

The problem was *not* "Codex can't load my skills." It was the inverse of what the MAP question
assumed: Codex loaded them **too eagerly**. Claude Code's `disable-model-invocation: true`
frontmatter marks a skill user-invoked-only; Codex ignores that field, so skills meant to fire only
when the human types their name were being offered to the model for implicit selection.

The fix he shipped: an `agents/openai.yaml` beside every user-invoked `SKILL.md` carrying
`policy.allow_implicit_invocation: false`, the Codex analog of `disable-model-invocation: true`.

His standing rule, from
[`.agents/invocation.md`](https://github.com/mattpocock/skills/blob/main/.agents/invocation.md):
set `disable-model-invocation: true` in frontmatter *for Claude Code* **and**
`policy.allow_implicit_invocation: false` in `agents/openai.yaml` *for Codex* — and keep them
aligned, because *"a skill is user-invoked in both harnesses or neither."*

Related upstream Codex issues (context, not blockers):
[openai/codex#10585](https://github.com/openai/codex/issues/10585),
[openai/codex#19695](https://github.com/openai/codex/issues/19695).

---

## 3. Local ground truth

**Codex CLI is installed.** `codex --version` → `codex-cli 0.147.0`, binary at
`C:\Users\Mubarak\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`. There is no `codex skills`
subcommand (`codex --help`); skills are filesystem-discovered only.

**`~/.codex/` holds no user skills.** `C:\Users\Mubarak\.codex\skills\` contains exactly one entry,
`.system` (OpenAI's bundled `imagegen`, `openai-docs`, `plugin-creator`, `review-agent`,
`skill-creator`, `skill-installer`). Nothing from skills.sh was written here — and per §1.1, nothing
needed to be.

**skills.sh installed one copy at `~/.agents/skills`, and Claude Code sees it by symlink.** 29 skill
directories live in `C:\Users\Mubarak\.agents\skills\`. In `C:\Users\Mubarak\.claude\skills\`, 29 of
the 32 entries are **directory symlinks** pointing at `C:\Users\Mubarak\.agents\skills\<name>`.
Only three are real directories: `documentation-factory`, `migrate-radix-to-base`, `shadcn`.

**Codex was explicitly among the selected harnesses.** `C:\Users\Mubarak\.agents\.skill-lock.json`
records `"lastSelectedAgents"` including `"codex"` (alongside `claude-code`, `pi`, `opencode`,
`cursor`, and others), with the Pocock skills installed 2026-08-11.

**Pocock's Codex fix is present on disk.** 27 of the 29 skills carry `agents/openai.yaml`
(only `find-skills` and `watch` lack it). Example —
`C:\Users\Mubarak\.agents\skills\wayfinder\agents\openai.yaml`:

```yaml
interface:
  display_name: "Wayfinder"
  short_description: "Map a large effort as decision tickets"
policy:
  allow_implicit_invocation: false
```

Per-skill invocation policy as installed:

| Explicit-only (`$skill` required) | Model-invocable |
|---|---|
| ask-matt, grill-me, grill-with-docs, handoff, implement, improve-codebase-architecture, loop-me, setup-matt-pocock-skills, teach, to-questionnaire, **to-spec**, **to-tickets**, **triage**, wait-what, **wayfinder** | code-review, codebase-design, diagnosing-bugs, **domain-modeling**, find-skills, **grilling**, prototype, research, resolving-merge-conflicts, scaffold-exercises, tdd, watch, wizard, writing-for-agents |

Note this mirrors the Claude Code side exactly — `wayfinder/SKILL.md` and `to-spec/SKILL.md` both
carry `disable-model-invocation: true` in frontmatter. Pocock's "user-invoked in both harnesses or
neither" rule is holding on this machine.

**`queue-publish` does not exist yet**, anywhere: not in `~/.claude/skills`, not in
`~/.agents/skills`, not in the repo. The repo's only local skill tree is
`C:\Users\Mubarak\Documents\sdl-factory\.claude\skills\` containing one entry, `sssf`.

**Verification not performed.** I did not launch a Codex session to watch a skill load — that would
spend the operator's Codex quota, and MAP records the Codex lane as expired pending re-login. The
discovery claim rests on three independent sources: the official docs, the string constants inside
the installed 0.147.0 binary, and the fact that skills.sh wrote Codex-only `openai.yaml` metadata
into `~/.agents/skills` after selecting `codex` as a target. §6 gives the one-command check to close
this the next time Codex is logged in.

---

## 4. Gap analysis for our three skill families

| Family | In `~/.agents/skills`? | Codex status | Gap |
|---|---|---|---|
| **Pocock chain** — wayfinder, to-spec, to-tickets, triage, grilling, domain-modeling, handoff, … | Yes (29 skills) | **Works today.** Explicit-only ones via `$wayfinder`, `$to-spec`, …; `grilling` and `domain-modeling` model-invocable. Identical semantics to Claude Code. | **None.** |
| **documentation-factory** | **No** — real directory at `C:\Users\Mubarak\.claude\skills\documentation-factory` | **Invisible to Codex.** | Not on a path Codex scans. |
| **queue-publish** | **No** — does not exist | n/a | Must be authored into the right tree from day one, or it inherits the same gap. |

`documentation-factory` needs no rewriting to work under Codex. Its `SKILL.md` already has valid
`name` + `description` frontmatter (the only required fields, §1.2), and its `references/`,
`scripts/`, `stages/` subdirectories are the ordinary skill layout. It has no
`disable-model-invocation` in frontmatter and no `agents/` directory — so once it sits on a scanned
path it is model-invocable in Codex, which matches its Claude Code behaviour. **The only thing wrong
with it is its address.**

Worth stating plainly, since the brief asked: **nothing degrades.** Codex is not limited to
paste-the-skill or explicit-only invocation. It supports both implicit and explicit invocation, and
the explicit-only behaviour our planning chain does exhibit is *deliberate* — Pocock set it, it
matches MAP standing rule 9 ("Pin skills per phase — never model-chosen"), and it is the same
behaviour in Claude Code. `$wayfinder` in Codex is the peer of `/wayfinder` in Claude Code, not a
downgrade from it.

---

## 5. Recommendation (KISS)

**Adopt the layout skills.sh already uses, for our own skills too: one real copy in
`~/.agents/skills/<name>/`, and a symlink at `~/.claude/skills/<name>` pointing to it.**

That is the whole fix. No sync script, no second copy, no AGENTS.md bridge, no Codex-specific
install step — the operator's machine is already running this exact pattern for 29 skills, and both
harnesses read the same bytes.

Concretely, two moves:

1. **`documentation-factory`** — move
   `C:\Users\Mubarak\.claude\skills\documentation-factory` → `C:\Users\Mubarak\.agents\skills\documentation-factory`,
   then create the directory symlink back. It becomes visible to Codex, pi, and Claude Code at once.
2. **`queue-publish`** — author it directly at `~/.agents/skills/queue-publish/` and symlink into
   `~/.claude/skills/`. Never create it as a real directory under `~/.claude/skills`.

Optionally, and only where MAP rule 9 wants invocation pinned rather than model-chosen, add
`<skill>/agents/openai.yaml` with `policy.allow_implicit_invocation: false` **and** matching
`disable-model-invocation: true` in the `SKILL.md` frontmatter — both together, per Pocock's
"user-invoked in both harnesses or neither." For `documentation-factory` specifically, the current
model-invocable behaviour is probably right and this can be skipped.

Wizard integration (MAP standing rule 14, *installation converges in the wizard*) is a small
idempotent step, not a new system: for each of our own skills, if `~/.claude/skills/<name>` is a real
directory, move it to `~/.agents/skills/<name>` and replace it with a symlink; if it is already a
symlink, do nothing. That satisfies rule 8 as an orchestrator-invoked step with an observable exit
code, and rule 5 (park, never delete) since it is a move.

Two cautions worth carrying:

- **Windows symlink privilege.** Creating directory symlinks needs Developer Mode or elevation. It
  demonstrably works on this machine (29 of them exist), so this is a precondition to assert in the
  wizard, not a blocker. If it ever fails, a directory **junction** (`mklink /J`) is the
  no-privilege fallback and Codex/Claude both traverse it fine.
- **skills.sh ownership of `~/.agents/skills`.** skills.sh manages that tree via
  `~/.agents/.skill-lock.json`. Our skills are not in that lock file, so an update run has no record
  telling it to touch them — but this is inference, not something I tested. Confirm once by running
  a skills.sh update and checking `documentation-factory` survives.

Repo-scoped alternative, noted and **not** recommended for the planning chain: Codex also scans
`$REPO_ROOT/.agents/skills`, so a project-specific skill could be committed to
`sdl-factory/.agents/skills/` and travel with the repo. Attractive for something like `queue-publish`
if it ever becomes repo-specific — but it would need a committed symlink for Claude Code's
`.claude/skills`, and git symlinks on Windows are exactly the kind of ambient-state dependency MAP
rule 12 warns about. Keep the planning chain at user scope.

---

## 6. One-command verification, for when the Codex lane is back

After the operator re-logs into Codex, this closes the one unverified link without burning a real
planning session — start `codex` in any directory, type `$`, and confirm the skill picker lists
`wayfinder`, `to-spec`, `to-tickets`, and `triage`. If it does, discovery via `~/.agents/skills` is
proven and this document's core claim is settled. Then, after the §5 move, confirm
`documentation-factory` appears in the same list.

---

## Sources

Primary:

- OpenAI, *Build skills* — <https://learn.chatgpt.com/docs/build-skills.md>
  (canonical <https://developers.openai.com/codex/skills>, 308-redirects)
- mattpocock/skills#516, *"Codex does not respect disable-model-invocation without
  agents/openai.yaml"* — <https://github.com/mattpocock/skills/issues/516>
- mattpocock/skills, `.agents/invocation.md` —
  <https://github.com/mattpocock/skills/blob/main/.agents/invocation.md>
- openai/codex#10585 — <https://github.com/openai/codex/issues/10585>
- openai/codex#19695 — <https://github.com/openai/codex/issues/19695>

Local ground truth (this machine, 2026-08-12):

- `C:\Users\Mubarak\.codex\skills\.system\skill-creator\references\openai_yaml.md` — the
  `openai.yaml` field spec, shipped inside Codex
- `C:\Users\Mubarak\.agents\.skill-lock.json` — install manifest, `lastSelectedAgents` includes
  `codex`
- `C:\Users\Mubarak\.agents\skills\wayfinder\agents\openai.yaml` — `allow_implicit_invocation: false`
- `C:\Users\Mubarak\.agents\skills\wayfinder\SKILL.md`,
  `C:\Users\Mubarak\.agents\skills\to-spec\SKILL.md` — `disable-model-invocation: true` frontmatter
- `C:\Users\Mubarak\.claude\skills\` — 29 symlinks into `~/.agents/skills`, 3 real directories
- `C:\Users\Mubarak\.claude\skills\documentation-factory\SKILL.md` — valid `name`/`description`
  frontmatter, no `agents/` directory
- `C:\Users\Mubarak\.codex\config.toml` — no `[[skills.config]]` section
- `C:\Users\Mubarak\.codex\AGENTS.md` — 0 bytes
- `C:\Users\Mubarak\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe` — version 0.147.0; contains
  string constants `.agents`, `codex/skills`, `skills.config`, `allow_implicit_invocation`,
  `disable-model-invocation`; contiguous `.agents/skills` absent (see §1.1 for how to read this)

---

## Verification corrections

Adversarial pass, 2026-08-12, same day as authoring. Re-fetched the three most load-bearing cited
sources, re-ran the local ground-truth checks, and checked the recommendation against MAP rule 1
(KISS). One live, time-sensitive finding; the rest of the document holds up.

### 1. The three sources, re-fetched — all check out

- **OpenAI, *Build skills*** (`https://learn.chatgpt.com/docs/build-skills.md`): re-fetched
  independently. Confirms the exact REPO > USER > ADMIN > SYSTEM precedence order and all six paths
  as quoted (including `$HOME/.agents/skills` as the USER-scope location); confirms `name` and
  `description` are the only mandatory `SKILL.md` fields; confirms explicit (`$`/`@`) vs. implicit
  (model-matches-`description`, on-by-default) invocation; confirms the `[[skills.config]]` /
  `enabled = false` disable mechanism; confirms `agents/openai.yaml` →
  `policy.allow_implicit_invocation` (default `true`) as described. One fact the document didn't
  surface but doesn't contradict it either: the source adds "If two skills share the same `name`,
  Codex doesn't merge them; both can appear in skill selectors" — worth knowing if `documentation-factory`
  or `queue-publish` ever gets installed from an upstream source under the same name later, but not
  a correction to anything claimed here.
- **mattpocock/skills#516**: re-fetched via `gh issue view`. Title, body, the `agents/openai.yaml` /
  `policy.allow_implicit_invocation: false` fix, and the closed state all match verbatim.
  `createdAt: 2026-07-11T08:53:36Z`, `closedAt: 2026-07-13T12:00:58Z` — confirms "opened 2026-07-11,
  closed 2026-07-13" exactly.
- **`.agents/invocation.md`**: re-fetched via raw.githubusercontent.com (the `github.com/blob` URL
  itself hung on first attempt — use the raw URL). Confirms the `disable-model-invocation: true`
  (Claude Code) + `policy.allow_implicit_invocation: false` (Codex) pairing and the verbatim quote
  "a skill is user-invoked in both harnesses or neither."

No inaccuracies found in what these three sources are cited as saying.

### 2. Local ground truth, re-run — matches, with one important drift since authoring

- `codex --version` → `codex-cli 0.147.0`. Matches.
- `~/.codex` listing (filenames only) → matches the document's claims exactly: `AGENTS.md` is 0
  bytes; `config.toml` has no `[[skills.config]]` section (only `skill = "#b06dff"` at line 113,
  confirmed at that exact line); `skills/` contains exactly one entry, `.system`, containing
  `imagegen`, `openai-docs`, `plugin-creator`, `review-agent`, `skill-creator`, `skill-installer`.
  `codex --help` confirms there is no `skills` subcommand. Repo root has no `.agents/` and no
  `AGENTS.md`, confirming §1.5.
- Also re-checked (beyond the two items named in the brief, because the document's own claims
  depend on it): 27 of 29 `~/.agents/skills` entries carry `agents/openai.yaml` — missing exactly
  `find-skills` and `watch`, as claimed. Exactly 15 `SKILL.md` files carry
  `disable-model-invocation: true`, and they are exactly the 15 named in the explicit-only column
  of §3's table. `.skill-lock.json`'s `lastSelectedAgents` includes `"codex"`, confirmed at line
  317. All of this holds.

**Drift found — `queue-publish` now exists, and it landed in the wrong place.** Between this
document being finished (`docs/research/codex-skills.md` last-write: **2026-08-12 22:57:37**) and
this verification pass, something authored a real `queue-publish` skill directly under
`C:\Users\Mubarak\.claude\skills\queue-publish\` (created **2026-08-12 22:58:48**, ~71 seconds
later — evidently a concurrent session, since a `queue-publish` skill also appeared in *this*
session's own skill listing mid-task). As of this check it is a fully-formed skill, not a stub:
valid `name`/`description` frontmatter and a `scripts/validate_brief.py`. It is a real directory,
not a symlink.

This falsifies §3's sentence *"`queue-publish` does not exist yet, anywhere: not in
`~/.claude/skills`, not in `~/.agents/skills`, not in the repo"* and the corresponding "n/a" /
"does not exist" cells in §4's gap table — both were true at the moment they were written and are
false now. It also means the two counts in the Sources list above (*"29 symlinks into
`~/.agents/skills`, 3 real directories"*) are stale: `~/.claude/skills` now holds **33** entries,
**4** of them real (`documentation-factory`, `migrate-radix-to-base`, `queue-publish`, `shadcn`),
29 still symlinks.

The practical significance is higher than a stale count: `queue-publish` is being built **right
now, in exactly the location §5's own recommendation calls out as the anti-pattern** ("Never create
it as a real directory under `~/.claude/skills`"). This is the single most actionable thing to
surface — whoever owns the `queue-publish` build should be told before more work stacks on top of
the wrong address, since moving it later is strictly more disruptive (git history if it gets
committed anywhere, in-flight edits from the concurrent session) than starting it in the right place.
Confirm with the operator/other session before touching it, since this document's write permission
is scoped to itself only.

### 3. KISS check on the §5 recommendation

The core move — one real copy under `~/.agents/skills/<name>`, one symlink from
`~/.claude/skills/<name>` — is not "adding a system." It reuses the exact layout already proven on
this machine for 29 skills, and it's the right direction to match skills.sh's own convention (real
copy in the tree skills.sh manages, symlink pointing out to it), which matters because §5 already
flags that skills.sh owns `~/.agents/skills` via its lock file and might not preserve entries it
doesn't recognize on an update pass — so directional consistency with what skills.sh already does is
a real argument, not cosmetic.

That said, the recommended fix for `documentation-factory` is a **move-then-symlink-back** (two
operations, and the move briefly makes the skill invisible to Claude Code mid-operation). A smaller
diff exists and is worth naming as an alternative: **leave the real `documentation-factory` directory
exactly where it is under `~/.claude/skills`, and add a single one-way symlink at
`~/.agents/skills/documentation-factory` pointing back to it.** Net effect for Codex and pi is
identical — both discover the skill by walking `~/.agents/skills`, and directory-symlink resolution
doesn't care which side is "real" — while Claude Code's existing working path is never touched at
all, not even transiently. That's one filesystem operation instead of two, with strictly less risk
to what already works. The trade-off is real, not free: it breaks the directional convention
skills.sh set for its other 29 entries, which is the reason the document didn't propose it. Given
`documentation-factory` is not skills.sh-managed either way (it's outside the lock file regardless of
which side holds the real directory), the inconsistency is cosmetic, not functional — so the smaller
diff is a defensible KISS call, not just the current recommendation's. Not a correction to what's
recommended, since both are legitimate; worth a sentence in §5 if this document gets revised, and
directly relevant to `queue-publish` given the finding in §2 above — whichever fix that skill gets,
the one-symlink version is the smaller one.

No other part of the recommendation reads as bigger than the problem: the wizard-step framing (move
if real, no-op if already a symlink) is already the minimal idempotent shape, the two cautions
(Developer Mode / junction fallback, confirm skills.sh survives an update) are appropriately hedged
rather than resolved by invented process, and the repo-scoped alternative is correctly rejected for
git-symlink-on-Windows reasons already on record (MAP rule 12).
