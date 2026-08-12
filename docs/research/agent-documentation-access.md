# Agent Documentation Access for a Self-Hosted Factory

**Research date:** 2026-08-11
**Question:** How should a self-hosted, autonomous agent factory give its agents access to documentation, without paying for a hosted docs service?
**Constraints honored:** no Context7 (rejected on cost), no NotebookLM as corpus of record, strong preference for plain files in the repo, one server, Python-driven, `pi` coding agent, solo engineer, must run unattended.

---

## Verdict

Vendor documentation into a plain markdown tree in the repo (`docs/vendor/<library>/`), let agents find it with `rg`/`fd` — which `pi` already ships and already exposes as its `grep` and `find` tools — and expose it to agents as an **Agent Skill** (`SKILL.md` + a `references/` directory), because that is the only file-based pattern with a real published spec, a validator, and native `--skill` support in `pi`. Adopt **OKF's frontmatter conventions** (`type`, `sources`, `generated`, `verified`, `status`, `stale_after`, plus `index.md`) as your file format — it is a real Google Cloud spec, it is exactly the "markdown files an agent greps" model you already wanted, and adopting it costs nothing because you would have invented something similar anyway. Do **not** build the corpus around `llms.txt`: use it as a free *acquisition* channel (curl a library's `llms-full.txt` into your tree), not as the format of record, because v2 explicitly removed the context-expansion tooling and the spec is about publishing on a public website, not describing a private local tree.

The single highest-leverage decision, beyond format: **gate retrieval by role using `pi --tools` and `--skill`**, so the Scout gets doc search and the Build agent does not.

---

## 1. OKF — "Open Knowledge Format"

### Disambiguation first

"OKF" resolves to two unrelated things. In an agent-documentation context, the user means the first.

| Name | Who | What | Since |
|---|---|---|---|
| **Open Knowledge *Format*** | Google Cloud (Data Cloud team) | Markdown + YAML frontmatter files as a portable knowledge bundle for AI agents | June 12, 2026 |
| Open Knowledge *Foundation* | okfn.org, a non-profit | Open-data advocacy; publishes **Frictionless Data** / **Data Package** (tabular data containerisation, v2 released 2024) | 2004 |

The Foundation is a red herring here — Data Package describes CSV/tabular datasets, not prose documentation. Everything below is the Format.

Sources: [Google Cloud blog](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing) · [blog.okfn.org — Data Package 2.0](https://blog.okfn.org/2024/06/26/data-package-version-2-0-release/)

### What it actually is

OKF is **real, live, and small**. It is not vaporware, and it is not a heavyweight standard either.

- **Publisher:** Google Cloud. Spec authors named as Sam McVeety and Amir Hormati. Announced **June 12, 2026**.
- **Spec location:** [`GoogleCloudPlatform/knowledge-catalog/okf/SPEC.md`](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) — **Apache 2.0**, in a repo with ~8.5k stars / ~720 forks.
- **Version drift already:** the blog announced **v0.1**; the spec in the repo is now **v0.2** (README links "Read the Open Knowledge Format v0.2 specification"), last touched July 24, 2026. v0.2 introduced two breaking field renames. Most secondary coverage still says v0.1 — treat blog posts as stale.
- **Origin:** it formalizes Andrej Karpathy's ["LLM wiki" gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — raw sources → an agent-maintained markdown wiki → a schema doc telling the agent how to maintain it, with `index.md` as catalog and `log.md` as append-only history, and ingest/query/lint as the three operations. The Google blog cites Karpathy directly.

### The format

A bundle is a directory. Every non-reserved `.md` file is one *concept*, with YAML frontmatter and a free-form markdown body.

```
bundle/
  index.md          # reserved — directory listing, for progressive disclosure
  log.md            # reserved — chronological update history
  <concept>.md
  <subdir>/
    index.md
    <concept>.md
```

**Exactly one field is required: `type`.** The spec states a concept carrying just `type` is fully conformant. Recommended-but-optional: `title`, `description`, `resource`, `tags`.

The genuinely interesting part for an *unattended* factory is the provenance/freshness block:

```yaml
type: Library Reference
title: FastAPI dependency injection
sources:
  - id: fastapi-docs
    resource: https://fastapi.tiangolo.com/tutorial/dependencies/
    last_modified: 2026-05-02
generated: { by: scout_agent/claude-opus-4, at: 2026-08-11T09:00:00Z }
verified:  { by: "human:mubarak", at: 2026-08-11T10:00:00Z }
status: stable          # draft | stable | deprecated
stale_after: 2026-11-01
```

- **Actors** use three forms: `<producer>/<version>` for agents/tools, `human:<id>` for people, `process:<id>` for automation.
- **Trust tiers** derive from `verified`: *unverified* (no key) → *machine-confirmed* (non-human actor) → *human-reviewed* (a `human:` actor).
- **Cross-links** are ordinary markdown links; bundle-relative absolute form `[title](/path/to/concept.md)` is recommended. Links are untyped; broken links are tolerated.
- **Conformance** is permissive by design: consumers **must not** reject a bundle for missing optional fields, unknown `type` values, unknown extra keys, broken cross-links, or missing `index.md`.

The spec's own summary of its philosophy: *"If you can `cat` a file, you can read OKF; if you can `git clone` a repo, you can ship it."* It explicitly declines to specify storage, serving, query infrastructure, a schema registry, or a central authority.

### Tooling and adoption — the honest read

**What ships officially** ([okf/ directory](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)): a `reference_agent` (Python 3.13, walks a **BigQuery** dataset and enriches concepts via a web-crawl pass with Gemini), a `visualize` subcommand producing a self-contained interactive HTML graph viewer (Cytoscape.js + marked, CDN-loaded), four sample bundles, and pytest tests. The README is unusually candid that these are *proofs of concept*: "The agent below is a **proof of concept** demonstrating *one* way to produce OKF bundles automatically. The format itself is the contribution."

**Critically: the official tooling is BigQuery-shaped and requires GCP credentials** (`gcloud auth application-default login`, a billing project, `GEMINI_API_KEY` or Vertex). It is useless for your use case. **You want the format, not the tooling.** That is fine and is what the spec invites.

**Adoption beyond Google is unproven.** Google Cloud Knowledge Catalog ingests OKF. Outside Google:
- A **W3C Holon Community Group** launched June 19, 2026 ([w3c-cg/holon](https://github.com/w3c-cg/holon)) and is developing "DataBook," a profile adding formal semantics on top of OKF bundles. **Caveat: a W3C Community Group is not the W3C standards track.** CGs are open to anyone and produce Reports, not Recommendations. This is a signal of interest, not ratification.
- Community tooling exists: **`okf-author`** ([writeup](https://ap7i.com/posts/open-knowledge-format-okf-claude-code-plugin/)) authors, converts existing markdown repos to OKF, and **validates with clean exit codes** — shipped as a Claude Code plugin, a Codex skill, and a Python installer. Its author's own assessment is measured: the open question is "whether anyone outside Google ends up speaking it."
- A community FAQ site exists at [okf.md](https://okf.md/faq/) (not a Google domain).

**Assessment for this factory:** OKF is a *good, cheap, low-risk* choice — but adopt it for the right reason. The reason is **not** interoperability (nobody you need to interoperate with speaks it yet). The reason is that it is a well-thought-through, Apache-2.0, one-page answer to a question you have to answer anyway: *what frontmatter goes on my vendored doc files?* Its provenance and staleness fields (`generated`, `verified`, `stale_after`, `status`) are exactly what an unattended factory needs to avoid silently trusting a two-year-old scrape. Copying those conventions costs one afternoon and zero dependencies. Treat conformance as a nice-to-have, not a goal.

---

## 2. `llms.txt` / `llms-full.txt` / "LLM wiki"

### The spec

[llmstxt.org](https://llmstxt.org/) · repo [AnswerDotAI/llms-txt](https://github.com/AnswerDotAI/llms-txt) (Apache-2.0, ~2.6k stars). Author **Jeremy Howard**. First published **2024-09-03**; **v2 published 2026-08-10** — i.e. one day before this research. Anything you read about llms.txt written before that date describes v1.

The format is deliberately tiny. In order:
1. optional BOM
2. **H1** with the project name — *the only required section*
3. a **blockquote** summary
4. zero or more non-heading markdown sections
5. zero or more **H2** sections, each containing a "file list": markdown list items of `[name](url)`, optionally `: notes`

```markdown
# Title

> Optional description goes here

Optional details go here

## Section name

- [Link title](https://link_url): Optional link details

## Optional

- [Link title](https://link_url)
```

v2 also proposes serving a clean markdown twin of every page at `page.html.md` *or* `page.md`, discoverable via `rel="alternate" type="text/markdown"` and `rel="describedby"` link relations (HTML `<link>` or an HTTP `Link:` header).

### What changed in v2 — and why it matters to you

From the [changes page](https://llmstxt.org/changes.html), two changes are directly load-bearing for a private corpus:

1. **The context-expansion tooling was removed from the proposal.** v1 described `llms_txt2ctx`, which expanded an llms.txt into a single LLM context blob. v2: *"The context-expansion tooling is no longer part of the proposal, and with it goes the special meaning of the `Optional` section."* The one piece of llms.txt machinery that would have been useful for assembling a local corpus is now explicitly out of scope.
2. **v2 states the consumption model is fetch-and-follow:** *"agents view or search the llms.txt to find what they need, then follow the relevant links."* The file is an index of **URLs**. It is not a container of content.

### `llms-full.txt` is not in the spec

This matters and is widely misreported. `llms-full.txt` appears **nowhere** in the llmstxt.org spec, in v1 or v2. It is a **community convention** that grew out of a FastHTML internal `llms-ctx-full.txt` pattern and was popularised when **Mintlify** rolled it out platform-wide (November 2024). It is a bulk single-file dump of a whole docs site. It is extremely useful to you — just don't call it a standard.

### Adoption

Real, and concentrated in exactly the place you care about. Per llmstxt.org v2: thousands of sites publish one; Mintlify, GitBook, Yoast, AIOSEO and Wix generate them automatically; **Chrome Lighthouse audits for one** under agentic-browsing checks; and OpenAI ([developers.openai.com/llms.txt](https://developers.openai.com/llms.txt)), Anthropic ([docs.anthropic.com/llms.txt](https://docs.anthropic.com/llms.txt)) and Gemini all publish one for their own developer docs.

The important counterweight: **no major consumer AI search engine has publicly committed to consuming llms.txt** — not ChatGPT search, Perplexity, Google AI Overviews, Gemini, Copilot or Claude.ai search. The real consumers are documentation-fetching coding agents. Reported adoption figures (~2% of sites, with a large fraction being empty plugin stubs) come from SEO-vendor surveys and should be treated as low-confidence.

Directories: [llmstxt.site](https://llmstxt.site/), [directory.llmstxt.cloud](https://directory.llmstxt.cloud/), [llmstxthub.com](https://llmstxthub.com/).

### Verdict for a PRIVATE corpus

**Use it as an intake pipe, not as the corpus format.**

- ❌ **As the format of record: no.** The spec is explicitly about a *website* publishing an index of *URLs* under a *path*. Every mechanism in v2 — link relations, HTTP `Link:` headers, path-scoped coverage, "the most specific file applies" — presupposes an HTTP origin. Nothing prohibits pointing it at local files, but you would be using a link-index format to describe a directory you already control, and you'd get no tooling benefit, because the tooling that expanded it was removed in v2.
- ✅ **As an acquisition channel: yes, and it's free.** When a library publishes `llms-full.txt`, `curl` it into `docs/vendor/<lib>/` and you have that library's entire documentation as one greppable markdown file, licensed-as-published, for zero dollars and zero ops. This is the single cheapest way to get third-party docs locally (§5).
- ✅ **As a courtesy index inside your own bundle: harmless and mildly useful.** Writing an `llms.txt`-shaped index at the root of your docs tree costs nothing. But OKF's `index.md` already fills that role and is designed for local paths.

**"LLM wiki"** as a term is Karpathy's, and OKF is its formalization — see §1. If someone says "LLM wiki" in an agent-docs context, they mean the Karpathy gist or OKF, not llms.txt.

---

## 3. File-based, repo-native documentation patterns for agents

### `AGENTS.md` — the only cross-vendor format, and it has no schema

[agents.md](https://agents.md/). *"Think of it as a README for agents."* Now stewarded by the **Agentic AI Foundation under the Linux Foundation**.

The FAQ is blunt: *"Are there required fields? No. AGENTS.md is just standard Markdown."* There is no JSON Schema, no frontmatter, no validator. Nesting works by proximity: *"Agents automatically read the nearest file in the directory tree… The closest AGENTS.md to the edited file wins."* The site notes OpenAI's main repo has 88 of them, and claims 60k+ open-source projects — though that number is a live GitHub code-search count, not an audit.

Read by: Codex, Cursor, Copilot coding agent, Jules, Gemini CLI, Aider, Junie, Windsurf, Devin, Zed, Amp, opencode, goose, Warp and others (Aider and Gemini CLI need a config line). **The only place a precise algorithm is specified is a vendor's own docs** — e.g. Codex builds an instruction chain root→cwd, at most one file per directory, concatenated with later files winning, truncated at a 32 KiB default (`project_doc_max_bytes`).

**For you: `pi` loads `AGENTS.md` (or `CLAUDE.md`) from `~/.pi/agent/`, every parent directory, and cwd, concatenating all matches.** Disable with `--no-context-files` / `-nc`. This is your always-on channel — it should contain a *pointer* to the docs tree, not the docs.

### `CLAUDE.md` — precise, but Anthropic-only

[code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory). Locations: managed policy → user (`~/.claude/CLAUDE.md`) → project (`./CLAUDE.md` or `./.claude/CLAUDE.md`) → local (`./CLAUDE.local.md`). Discovered files are **concatenated, not overridden**.

The mechanism worth stealing is `@path/to/import`, with a documented **maximum depth of four hops**, relative to the importing file, and skipping code spans/fences. Note the sharp edge: **imports load at launch, so they organize context but do not reduce it.** Anthropic explicitly states *"Claude Code reads `CLAUDE.md`, not `AGENTS.md`"*, recommending `@AGENTS.md` as a bridge. Guidance: keep it under 200 lines.

More interesting for docs: **`.claude/rules/*.md` with YAML `paths:` frontmatter** — glob-scoped files loaded only when Claude touches a matching file. That is Anthropic's answer to "docs that shouldn't always be in context."

### `.cursor/rules` — the best-designed conditional-loading model

[cursor.com/docs/rules](https://cursor.com/docs/rules). `.cursor/rules/*.mdc`, markdown + YAML frontmatter. *"A plain `.md` file in `.cursor/rules` is ignored because it has no frontmatter."* **Three fields only** — `description`, `globs`, `alwaysApply` — producing four behaviours:

| Frontmatter | Behaviour |
|---|---|
| `alwaysApply: true` | Always in context |
| `alwaysApply: false` + `globs` | Auto-attached when a matching file enters context |
| `alwaysApply: false` + `description` | Agent decides from the description |
| neither | Manual only, via `@rule-name` |

Cursor explicitly advises *"Reference files instead of copying their contents."* Cap: under 500 lines per rule. `pi` does not read `.cursor/rules`, but the **frontmatter-as-routing-metadata idea is the transferable lesson**, and it is the same idea as an OKF `type`/`tags` block plus a skill `description`.

### Skills as docs — the one with a real spec, a validator, and `pi` support

This is the winner for your architecture. [agentskills.io/specification](https://agentskills.io/specification.md) · [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills) · [anthropics/skills](https://github.com/anthropics/skills) (Apache-2.0).

Layout: `skill-name/SKILL.md` (required) plus optional `scripts/`, `references/`, `assets/`. `name` must match the parent directory name. The standard's **complete** frontmatter field set is six fields: `name` (≤64 chars, `[a-z0-9-]`), `description` (≤1024 chars, "what it does and when to use it"), `license`, `compatibility`, `metadata`, and `allowed-tools` (marked *Experimental*).

**Progressive disclosure is specified in three explicit levels:**
1. **Metadata (~100 tokens)** — `name` + `description` only, loaded at startup for *all* skills
2. **Instructions (<5000 tokens recommended)** — the SKILL.md body, loaded on activation
3. **Resources (as needed)** — files under `references/`/`scripts/`/`assets/`, loaded only when required

Guidance: SKILL.md under 500 lines, file references one level deep. A validator exists: `skills-ref validate ./my-skill`.

**`pi` implements this standard.** Confirmed from its docs: at startup pi scans skill locations, extracts names and descriptions, and injects them into the system prompt in XML per [agentskills.io/integrate-skills](https://agentskills.io/integrate-skills); the agent then `read`s the full SKILL.md on demand. Its own docs call this out: *"This is progressive disclosure: only descriptions are always in context, full instructions load on demand."* Since pi 0.20.0 (2025-12-13), skills **must** be `SKILL.md` inside a directory (matching Codex CLI).

pi skill discovery locations: `~/.pi/agent/skills/`, `.pi/skills/` (project, only once trusted), `~/.agents/skills/` and `.agents/skills/` (cwd + ancestors up to git root), package `skills/` dirs, and a settings `skills` array. Plus `--skill <path>` — **repeatable, and additive even with `--no-skills`.**

### Vendored docs directories — folklore, not standard

**There is no specification, RFC, or vendor doc defining `ai_docs/`, `docs/vendor/`, or `.agent/docs/`.** Being explicit, since this was asked:

- `ai_docs/` is a real, widely-copied convention originating in agent-workflow repos (e.g. [disler/benchy](https://github.com/disler/benchy/tree/main/ai_docs), holding files like `vue-store.md`). GitHub code search returns tens of thousands of hits. **Nothing defines it and no tool reads it automatically** — it works only because an AGENTS.md points at it.
- `.agents/` proposals exist ([bgreenwell/dotagents](https://github.com/bgreenwell/dotagents), "A proposed convention") but are one-person drafts adopted by no vendor.
- **Committing a third party's `llms.txt` into your repo is not part of the llms.txt spec** — the spec is about publishing on your own site.

The nearest thing to a standard-backed home for vendored docs is a **skill's `references/` directory**, which has a documented loading model, or Anthropic's `.claude/rules/` with `paths:`. `ai_docs/` is folklore that happens to work.

### MCP servers that serve local files — heavier than grep, and weaker

- **Official filesystem server** ([modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)) exposes `read_text_file`, `read_multiple_files`, `search_files`, `directory_tree`, etc., scoped by CLI args or MCP Roots. **Its `search_files` is glob/filename matching — it does not search file contents.** Strictly weaker than `rg` for grepping vendored docs.
- **There is no official "docs" MCP server.** The reference list is exactly: Everything, Fetch, Filesystem, Git, Memory, Sequential Thinking, Time.
- For llms.txt: `server-llm-txt` (linked from llmstxt.org) and the better-maintained **[langchain-ai/mcpdoc](https://github.com/langchain-ai/mcpdoc)**, which exposes just `list_doc_sources` and `fetch_docs` with a domain allowlist.

**Cost/ops honesty:** every MCP server is a process to install, version, sandbox and keep alive, and its tool definitions consume context in *every* session whether used or not. For docs already in the repo, `rg` plus a pointer in AGENTS.md is cheaper and more capable. MCP earns its keep only when docs are *remote* and must be fetched live.

`pi` has **no built-in MCP support** and its author argues against needing it. From ["What if you don't need MCP?"](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/): *"Playwright MCP has 21 tools using 13.7k tokens (6.8% of Claude's context). Chrome DevTools MCP has 26 tools using 18.0k tokens (9.0%)."* His README-based replacement used **225 tokens**, because *"I can pull in the README whenever I need it and don't pay for it in every session."* This is the same progressive-disclosure argument, from the author of your harness. **Given your constraints, this is decisive: don't add an MCP server for local docs.**

---

## 4. Retrieval without a vector DB — is `rg` enough?

Short answer: **yes for your situation, and the evidence is more balanced than either camp admits.**

### The "grep is enough" case is *asserted*, not measured

Anthropic's [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) is the clearest official statement, and it describes a **hybrid**, not grep-purism:

> "Rather than pre-processing all relevant data up front, agents built with the 'just in time' approach maintain lightweight identifiers (file paths, stored queries, web links, etc.) and use these references to dynamically load data into context at runtime using tools."

> "Claude Code is an agent that employs this hybrid model: CLAUDE.md files are naively dropped into context up front, while primitives like glob and grep allow it to navigate its environment and retrieve files just-in-time."

The widely-repeated "we removed RAG" claim traces to Claude Code's creator on X, not a published post — Boris Cherny: *"Early versions of Claude Code used RAG + a local vector db, but we found pretty quickly that agentic search generally works better. It is also simpler and doesn't have the same issues around security, privacy, staleness, and reliability."* **The supporting evals were never published.**

[Cline](https://cline.bot/blog/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing) is the most explicit vendor rejection — *"No RAG, no embeddings, no vector databases. This isn't a limitation — it's a deliberate design choice."* — citing chunking destroying code semantics, index staleness on every merge, and a doubled security surface. Again: **asserted, no benchmark.**

### The counter-case has the only real numbers, and it's Cursor

[cursor.com/blog/semsearch](https://cursor.com/blog/semsearch) reports an offline eval on an internal "Cursor Context Bench," same agent with and without semantic search:

- **+12.5% average accuracy** (range **6.5%–23.5%** by model)
- Online A/B: **+0.3% code retention overall, +2.6% on codebases with 1,000+ files**
- **+2.2% dissatisfied follow-up requests** when semantic search was removed

But Cursor does **not** claim embeddings replace grep: *"Our agent makes heavy use of grep as well as semantic search, and the combination of these two leads to the best outcomes."* They also ship "Instant Grep," a custom exact-match engine they say "outperforms `ripgrep` on large codebases" ([codebase indexing docs](https://cursor.com/docs/context/codebase-indexing)). Caveats: single vendor, internal non-reproducible benchmark, and the online deltas are small.

### Published research does not settle it

There is no clean academic grep-vs-RAG-for-code-agents benchmark. The closest primary source, **Agentless** ([FSE 2025](https://lingming.cs.illinois.edu/publications/fse2025.pdf), [arXiv 2407.01489](https://arxiv.org/abs/2407.01489)), resolves **32.0% of SWE-bench Lite (96/300) at ~$0.70/problem**, with localization accuracy of **69.7% file-level / 52.0% function-level / 35.3% line-level**. **It is frequently miscited as proof that grep beats embeddings — it is not.** Agentless's pipeline explicitly combines LLM-prompting-based localization *with* embedding-based retrieval. Derivative work like [Agentless-Lite](https://github.com/sorendunn/Agentless-Lite) is explicitly RAG-based.

### Where this lands for you

The embedding delta that Cursor measured **grows with repository size** and was measured on *code*, not on a curated prose docs tree. Your corpus is:
- **curated by you**, not an arbitrary 100k-file monorepo
- **prose markdown with headings**, which grep handles far better than minified or generated code
- **structured with frontmatter**, so `rg '^type: Library Reference'` and `rg -l 'tags:.*fastapi'` are precise filters a vector DB doesn't give you
- **small enough** that an `index.md` tree fits the "browse, don't search" path

A vector DB would add an embedding model, an index, a staleness problem, a re-index job, and a failure mode that breaks silently at 3am while unattended. The published evidence does not justify that for a solo engineer.

**`pi` already has everything needed.** Confirmed from its docs and changelog: built-in tools are **`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`**. It **downloads `fd` and `ripgrep` on first run** into its own `tools/` directory (on Windows, `fd.exe` and `rg.exe`). Its `grep` tool formats match lines from **ripgrep JSON output**; its `find` tool drives `fd`, switching to full-path mode when the pattern contains `/`, and it honours nested `.gitignore` rules. So grep-based retrieval over a markdown tree is not something you build — it is the default.

**Practical mitigation for grep's real weakness (vocabulary mismatch — the agent greps "auth" when the doc says "credentials"):** put an `index.md` at every directory level listing each concept with its `description`, and add a `tags:` line to frontmatter with synonyms. Both are OKF conventions. The agent reads the index first and greps second — which is precisely Karpathy's LLM-wiki query flow and OKF's stated progressive-disclosure rationale.

---

## 5. Free / self-hosted ways to get third-party library docs locally

Ranked by cost-benefit for one person.

### 1. `llms-full.txt` — zero effort, do this first
Where a library publishes one, `curl` it into `docs/vendor/<lib>/llms-full.txt` and you have the whole docs site as one greppable markdown file. Free, no ops, licensed-as-published. Directories: [directory.llmstxt.cloud](https://directory.llmstxt.cloud/), [llmstxt.site](https://llmstxt.site/), [llms-txt-hub](https://github.com/thedaviddias/llms-txt-hub). **Limitation: coverage skews heavily to AI/devtool vendors; long-tail libraries mostly don't publish one.** Check for staleness — there's no version signal, which is exactly what an OKF `sources[].last_modified` + `stale_after` wrapper is for.

### 2. Sparse-checkout of the library's own docs repo — cheapest and freshest
Most libraries keep `docs/` in-repo as md/rst.

```bash
git clone --filter=blob:none --no-checkout <url> repo && cd repo
git sparse-checkout init --cone
git sparse-checkout set docs
git checkout main
```

`--filter=blob:none` avoids pulling blob history; add `--depth 1` for a shallow clone. Maintenance is a cron'd `git pull` per repo — a ~20-line shell loop over a repo list is the honest answer; there is no dominant purpose-built tool. **Advantage over scraping: it is the licensed source, it is versioned, and you can pin it to the version you actually depend on.** For a factory that must be reproducible, this is the strongest option.

### 3. DevDocs self-hosted — best coverage, and **not** locked in the browser
[freeCodeCamp/devdocs](https://github.com/freeCodeCamp/devdocs), MPL-2.0.

```bash
docker run --name devdocs -d -p 9292:9292 ghcr.io/freecodecamp/devdocs:latest
```

Then `thor docs:list`, `thor docs:download --all|--installed|<slug>`, `thor docs:generate`, `thor docs:package`.

**The key finding: the docs are extractable as files.** The browser offline mode uses a service worker, but server-side each doc lives at `public/docs/<slug>/` as **`index.json`** (search index), **`db.json`** (all page HTML keyed by path), and **`meta.json`**. `db.json` is plain JSON of normalized HTML partials — an agent can grep it directly, or a ~15-line script splits it into one file per path. This is the best answer to "greppable third-party docs, free, broad coverage." Maintenance: re-run `thor docs:download --installed` monthly.

### 4. Dash / Zeal docsets — yes, SQLite + HTML
Format documented at [kapeli.com/docsets](https://kapeli.com/docsets): a bundle with `Info.plist`, a `Documents/` folder of **raw HTML**, and `Contents/Resources/docSet.dsidx`, a **SQLite** DB with `searchIndex(id, name, type, path)`. So `sqlite3` queries it directly and the HTML greps on disk. [dasht](https://github.com/sunaku/dasht) already ships CLI query tools. [Zeal](https://github.com/zealdocs/zeal) consumes Kapeli's user-contributed feeds. Free, but user-contributed docsets go stale more than DevDocs. **Lower priority given DevDocs covers the same ground with fresher data.**

### 5. Site scrapers — last resort
[Crawl4AI](https://docs.crawl4ai.com/core/self-hosting/) (Apache-2.0, Docker, HTML→markdown built in), or self-hosted [Firecrawl](https://github.com/firecrawl/firecrawl) (**AGPL-3.0**, `docker compose`, API on `localhost:3002`).

Two real caveats: (a) **AGPL is a genuine obligation** — modify Firecrawl and offer it as a network service and you must publish your modifications; and self-hosted Firecrawl fetches with plain Playwright, without the managed anti-bot layer, so it's weak against Cloudflare-class protection. (b) **ToS/copyright:** docs sites are usually copyrighted and some ToS prohibit automated scraping. DevDocs already did this work under license with per-doc attribution. Maintenance is the worst of the five — selectors break silently, which is the exact failure mode an unattended factory cannot tolerate.

### Recommended mix for one person
`llms-full.txt` opportunistically → sparse-checkout for anything you pin a version of → DevDocs + a `db.json` splitter for broad coverage → scraping only when nothing else works.

---

## 6. Which agent roles actually need doc search

### Your factory already has the right shape

Per `docs/research/video-1-notes.md`, the architecture separates a **Scout Agent** ("look for all the code, all the tickets, all the documentation, all previous spec files") from a **Plan Agent** and a **Build Agent** — and searching is *deliberately* split from planning. The model-tier guidance in the same source: *"your planner and your scouters are going to be state-of-the-art models so nothing gets missed"*, while Build gets a workhorse model. **Doc-search allocation should follow the same seam.**

### What's officially documented

**The mechanism is real and shipped by two vendors.** Claude Code subagents ([code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents)) take a `tools` frontmatter field — *"Inherits every tool available to subagents if omitted"* — plus `disallowedTools` as a denylist, applied first. The docs list *"**Enforce constraints** by limiting which tools a subagent can use"* as a first-class reason to define a subagent, and each runs in its own context window. **Anthropic's own shipped `Explore` agent is read-only** (Write and Edit denied) — i.e. their default is a search-heavy scout separated from the implementer. Cursor ships the mirror image: an "Explore subagent" that "executes many parallel searches without bloating the main conversation, returning only the relevant findings."

**Anthropic's [multi-agent research system post](https://www.anthropic.com/engineering/multi-agent-research-system)** describes "a lead agent [that] coordinates the process while delegating to specialized subagents" where "subagents act as intelligent filters by iteratively using search tools." Its tool heuristics: *"prefer specialized tools over generic ones"* and *"Bad tool descriptions can send agents down completely wrong paths."* Their headline number — multi-agent outperformed single-agent Opus 4 by **90.2%** on an internal research eval, at **~15× the tokens** — is about research breadth, not about denying implementers search.

**The "fewer tools" evidence.** [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents): *"More tools don't always lead to better outcomes… Too many tools or overlapping tools can also distract agents from pursuing efficient strategies."* And Chroma's [Context Rot](https://research.trychroma.com/context-rot) study (18 models) measures non-uniform degradation as input grows, with **distractors specifically hurting** — the mechanistic argument for keeping bulky search output out of the implementer's window.

### Honest assessment

The *mechanism* (per-agent tool allowlists) and the *scout/implementer split* are both officially documented and shipped. But **"an implementer performs better without a doc-search tool" is folk practice** — I found no published A/B isolating that variable. The support is indirect: tool distraction (asserted), context rot (measured, but about input length generally), and subagent context isolation (a documented design goal, not a measured win).

That said, for an *unattended* factory the argument is stronger than the evidence, because the failure mode isn't quality — it's **cost and termination**. An implementer with a search tool and a vague spec can burn tokens wandering the docs tree with nobody watching. Denying the tool converts "wanders for 40 minutes" into "fails fast, routes back to the Scout."

### Concrete allocation for `pi`

`pi` supports exactly this, natively. Confirmed flags:

| Flag | Effect |
|---|---|
| `--tools <list>`, `-t <list>` | **Allowlist** specific tool names across built-in, extension and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-ins, keep extension/custom tools |
| `--skill <path>` | Load a specific skill; **repeatable, additive even with `--no-skills`** |
| `--no-skills` | Disable skill *discovery* |
| `--skills <patterns>` | Glob-filter discovered skills |
| `--no-context-files`, `-nc` | Disable AGENTS.md / CLAUDE.md discovery |

pi's own docs give the read-only recipe verbatim: `pi --tools read,grep,find,ls -p "Review the code"`.

Proposed per-role invocation:

```bash
# SCOUT — full doc search, read-only, docs skill loaded
pi --tools read,grep,find,ls \
   --no-skills --skill ./skills/vendor-docs \
   -p "$SCOUT_PROMPT"

# PLANNER — reads what Scout found; no independent crawling
pi --tools read,grep,find,ls \
   --no-skills --skill ./skills/vendor-docs \
   -p "$PLAN_PROMPT"

# BUILD — writes code; docs skill deliberately NOT loaded.
# Grep stays available for the *codebase*; the docs tree is out of cwd
# or excluded, and the skill that documents it is absent from context.
pi --tools read,grep,find,ls,edit,write,bash \
   --no-skills \
   -p "$BUILD_PROMPT"
```

The `--no-skills` + explicit `--skill` combination is the clean lever: it makes the docs skill's `description` — the ~100-token metadata that would otherwise sit in *every* agent's system prompt — present only for the roles that should act on it. That is per-role progressive disclosure with no custom code.

---

## Comparison table

| Option | Cost | Setup effort | Maintenance | Fits constraints |
|---|---|---|---|---|
| **Vendored markdown tree + `rg`/`fd`** | $0 | Low — dir + AGENTS.md pointer | Low — refresh script | **Yes** |
| **OKF frontmatter conventions** | $0 (Apache-2.0) | Low — copy 6 field names | Low — `stale_after` does the nagging | **Yes** |
| **Agent Skill (`SKILL.md` + `references/`)** | $0 | Low — native `pi --skill` | Low | **Yes** |
| **`llms-full.txt` intake (curl)** | $0 | Very low | Low — re-curl; no version signal | **Yes** (as intake only) |
| **`llms.txt` as corpus format** | $0 | Low | Medium — fights the spec's intent | **No** — spec is web/URL-shaped; v2 dropped the expansion tooling |
| **Sparse-checkout of docs repos** | $0 | Low — ~20-line loop | Low — cron `git pull` | **Yes** |
| **DevDocs self-hosted** | $0 (MPL-2.0) | Medium — Docker + `db.json` splitter | Low — monthly `docs:download` | **Yes** |
| **Zeal/Dash docsets** | $0 | Medium — feeds + sqlite queries | Medium — user-contributed, stale | Yes, but redundant with DevDocs |
| **Crawl4AI / self-hosted Firecrawl** | $0 (Apache-2.0 / **AGPL-3.0**) | Medium–High — Docker stack | **High** — selectors break silently | Marginal — last resort |
| **OKF official reference agent** | GCP billing (BigQuery + Gemini) | High — gcloud auth, GCP project | Medium | **No** — requires GCP, BigQuery-shaped |
| **MCP filesystem server** | $0 | Medium — extra process | Medium — process to keep alive | **No** — `search_files` is filename-only, weaker than `rg`; pi has no built-in MCP |
| **mcpdoc (llms.txt MCP)** | $0 | Medium | Medium | **No** for local docs; only for live remote fetch |
| **Vector DB / embedding index** | $0–$$ (self-host + embed calls) | High | **High** — re-index, staleness, silent failure | **No** |
| **Context7** | Paid | Low | Low | **No** — rejected on cost |
| **NotebookLM as corpus** | Costly | Low | Low | **No** — rejected by user |

---

## What I could not verify

Being explicit about dead ends and low-confidence claims.

1. **OKF v0.1 vs v0.2 discrepancy.** The Google Cloud blog and virtually all secondary coverage describe **v0.1**; the spec in the repo now self-identifies as **v0.2** with two breaking field renames. I fetched the spec and read v0.2 fields, but **I did not diff v0.1 against v0.2 directly** — I could not retrieve the v0.1 text to confirm exactly which two fields were renamed. If you adopt OKF frontmatter, read `SPEC.md` yourself before committing to field names.

2. **OKF adoption outside Google is essentially unmeasured.** I found one community CLI (`okf-author`), one community FAQ site (okf.md), and the W3C Holon CG. **I found no production user outside Google.** Claims in secondary coverage that "community-maintained libraries are available in Python and TypeScript" and that an "official CLI/validator" and "MCP support" are planned came from vendor/SEO blog posts, **not** from Google or the repo. Treat as unconfirmed roadmap chatter.

3. **The W3C Holon Community Group / DataBook relationship to OKF.** The CG and its repo ([w3c-cg/holon](https://github.com/w3c-cg/holon)) are real and the June 19, 2026 launch date appears in its meeting minutes. But my characterization of DataBook as "a W3C profile adding formal semantics on top of OKF bundles" comes from a community FAQ and a Substack post, **not from a W3C document I read directly**. Also note: **a W3C Community Group is not the standards track** — CG Reports are not Recommendations, and anyone can start a CG.

4. **No published head-to-head benchmark of grep vs embeddings for coding agents exists** that I could find. Anthropic's and Cline's positions are asserted on operational grounds with unpublished internal evals. Cursor's numbers are the only measured ones and are single-vendor on a private benchmark. **The honest state of the art is "unsettled, but embeddings' measured advantage is modest and grows with repo size."**

5. **The Boris Cherny "we removed RAG" quote is from X, not a published Anthropic post.** I have not independently verified the post still exists at that URL. Anthropic's *published* position (the context-engineering post) describes a **hybrid**, which is a weaker claim than the folklore version.

6. **`llms.txt` adoption percentages** (commonly cited as ~2% of sites, ~40% of files being plugin stubs) come from SEO-vendor surveys, not from llmstxt.org or any primary measurement I could verify. Low confidence. The *qualitative* adoption claims — Mintlify/GitBook auto-generation, Lighthouse auditing, OpenAI/Anthropic/Gemini publishing their own — **are** on llmstxt.org itself and are high confidence.

7. **The agents.md "60k+ open-source projects" figure is a live GitHub code-search count**, not an audited number, and code search excludes forks/archived repos inconsistently. Similarly "88 AGENTS.md files in OpenAI's main repo" is the site's own claim, unverified by me.

8. **pi's exact bundled-binary behaviour on your machine.** I confirmed from pi's changelog that it *downloads* `fd` and `ripgrep` on first run into its `tools/` directory (with a fix increasing the download timeout from 10s to 120s, and Windows-specific handling of `fd.exe`/`rg.exe`). **I did not inspect your actual pi installation** to confirm the binaries are present or where. The premise that "pi ships `rg.exe` and `fd.exe` in its own bin directory" is consistent with what I found but is a download-on-first-run, not a bundled-at-install, mechanism — worth noting for an air-gapped or offline server.

9. **pi's `--tools` allowlist semantics under skills.** I confirmed the flag exists and pi's own docs give `pi --tools read,grep,find,ls` as a read-only recipe. **I did not verify** whether a loaded skill can reintroduce a tool that `--tools` excluded, or how `allowed-tools` in SKILL.md frontmatter (marked *Experimental* in the Agent Skills spec) interacts with it. Test this before relying on it as a hard security boundary — treat it as a steering mechanism, not a sandbox.

10. **"Withholding search from implementers improves outcomes" has no published evidence.** The mechanism is documented; the benefit is folk practice. My cost/termination argument for it is reasoning, not a citation.

11. **DevDocs `db.json` structure.** Reported as normalized HTML partials keyed by path. I did not run DevDocs and inspect the file myself; the splitter script is described as trivial but is unwritten and untested.

12. **`llms_txt2ctx` current status.** v2 removed it from the *proposal*, and the `llms_txt` Python package still exists in the repo (last touched May 2026). Whether the CLI still works is unverified — but since v2 disowned it, don't build on it either way.
