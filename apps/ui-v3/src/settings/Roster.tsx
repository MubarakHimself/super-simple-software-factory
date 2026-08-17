/**
 * Roster (per project) — the factory's real agents, in the order they run.
 *
 * ── What changed, and why ─────────────────────────────────────────────────
 * The previous version drew the mock's "workhorses + reviewer" table: a list of
 * rows with an "+ Add workhorse" button, split by "every agent except the one
 * named reviewer". That is not the shape of this factory. The roster is a
 * PIPELINE of five named agents — scout, planner, builder, reviewer,
 * documenter (`adws/adw_sssf_config/sssf.config.yaml`) — and adding a sixth
 * "workhorse" means nothing, because there is no phase for it to run. So the
 * pane is the pipeline, in pipeline order, and the add button is gone rather
 * than drawn-and-disabled.
 *
 * Within that pipeline one agent is different: THE BUILDER. It runs longest and
 * it is the one the engine runs in parallel, so it is the one agent that gets a
 * POOL of models instead of a single model — up to five provider/model entries
 * the router spreads concurrent runs across. That pool lives in the shared
 * config schema both this app and the engine read:
 *
 *   router:
 *     builder_pool:
 *       - model: "ollama-cloud/kimi-k2.7-code"
 *       - model: "xai/grok-4.5"
 *
 * Entry #1 IS the builder's own `model:`, mirrored — so the engine has one
 * place to read the whole pool, and the primary keeps its existing mechanism
 * (the agent's own `model:` line, spliced by the roster endpoint). Changing the
 * primary writes both; a file edited by hand into disagreement says so and
 * offers the one fix.
 *
 * ── The vocabulary law ────────────────────────────────────────────────────
 * A PROVIDER is an account and a lane. A FAMILY is the model's family, read
 * from the model id. The old cross-family box compared provider prefixes and
 * therefore reported "ollama-cloud" as a review family — a confirmed bug.
 * `familyOf()` in `./types.ts` is the correction, and this pane compares the
 * reviewer's family against the family of EVERY model in the builder pool.
 *
 * ── Reads and writes ──────────────────────────────────────────────────────
 *   GET  /api/app/p/:id/config          the roster and its `defaults:` block
 *   GET  /api/app/p/:id/config/router   the builder pool
 *   GET  /api/app/models                pi's own catalog, for every dropdown
 *   GET  /api/app/p/:id/factory/providers   what Authentication can honestly say
 *   POST /api/app/p/:id/config/roster   one agent's model / thinking (splice)
 *   POST /api/app/p/:id/config/router   the whole pool (block replace)
 *
 * Every write is auto-save and reports itself through the save bar in the
 * server's own words.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiPost } from "../lib/api.ts";
import { useResource, type Resource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { InitializeFactory } from "../shell/InitializeFactory.tsx";
import { PlusIcon } from "./icons.tsx";
import { HowThisWorks } from "./notices.tsx";
import type { SaveReporter } from "./save.ts";
import {
  familyOf,
  FAMILY_LABELS,
  FAMILY_WORDS,
  isFactoryAbsent,
  providerOf,
  UNKNOWN_FAMILY,
  type BuilderPoolEntry,
  type CatalogModel,
  type ConfigRead,
  type ConfigResponse,
  type ModelCatalog,
  type ModelFamily,
  type ProviderDefinition,
  type ProviderDefinitionsResponse,
  type RosterAgent,
  type RouterEditResult,
  type RouterRead,
  type RosterEditBody,
  type RosterEditResult,
} from "./types.ts";

/** The seven words `sssf.config.yaml`'s own comment documents and the write
 * endpoint validates against — the fallback for a `/api/app/models` read that
 * did not land. */
const THINKING_FALLBACK = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const CONFIG_PATH = "adws/adw_sssf_config/sssf.config.yaml";

/** The factory's real pipeline, in the order a run walks it. The names are the
 * roster's own; the sentence is what that agent is FOR in the run, not a
 * description of the model. */
const PIPELINE: { name: string; step: string; role: string }[] = [
  { name: "scout", step: "1", role: "finds where things live · changes nothing" },
  { name: "planner", step: "2", role: "turns the request into a plan" },
  { name: "builder", step: "3", role: "writes the code · runs longest, and in parallel" },
  { name: "reviewer", step: "4", role: "checks the work against the ask · changes nothing" },
  { name: "documenter", step: "5", role: "writes up the change from the diff" },
];

const POOL_SENTENCE =
  "The router spreads concurrent runs across this pool - one model per run, picked by lane availability.";

function encode(id: string): string {
  return encodeURIComponent(id);
}

function sameName(agent: RosterAgent, name: string): boolean {
  return agent.name.trim().toLowerCase() === name;
}

/** The Authentication cell. `auth_status` is `"unknown"` from every code path on
 * this machine and always will be — nothing in this app reads a credential. */
function AuthCell({ definition, lane }: { definition: ProviderDefinition | null; lane: string | null }) {
  if (!lane) {
    return (
      <span className="auth-badge" title="this model names no provider, so there is no account to authenticate">
        <span className="dot" /> no provider named
      </span>
    );
  }
  if (!definition) {
    return (
      <span
        className="auth-badge"
        title={`no ${lane}.provider.json in this repo - it is either one of pi's built-in providers or registered only on the factory machine`}
      >
        <span className="dot" /> no definition here
      </span>
    );
  }
  return (
    <span className="auth-badge" title={definition.auth_reason}>
      <span className="dot" /> not checked here
    </span>
  );
}

/** The family chip. A model whose id matches no family reads as unknown, in
 * words, rather than borrowing its provider's name. */
function FamilyChip({ model }: { model: string }) {
  const found = familyOf(model);
  return (
    <span className={`family-chip${found ? "" : " unknown"}`} title={found ? `family read from "${model}"` : UNKNOWN_FAMILY}>
      {found?.label ?? "unknown family"}
    </span>
  );
}

function ModelSelect({
  value,
  catalog,
  loading,
  disabled,
  className = "roster-select",
  onPick,
}: {
  value: string;
  catalog: ModelCatalog | null;
  /** the read is still in flight - NOT the same as `catalog === null`, which is
   * also what a failed read leaves behind */
  loading: boolean;
  disabled: boolean;
  className?: string;
  onPick: (model: string) => void;
}) {
  const known = useMemo(() => {
    const all = new Set<string>();
    for (const provider of catalog?.providers ?? []) {
      for (const model of provider.models) all.add(`${provider.id}/${model.id}`);
    }
    return all;
  }, [catalog]);

  return (
    <select
      className={className}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        if (event.target.value !== value) onPick(event.target.value);
      }}
    >
      {/* The value the file actually holds always appears, even when this
          machine's pi catalog has never heard of it — a select that silently
          shows a different model than the file is the worst outcome here.
          Before the catalog lands there is exactly this one option, and it must
          not claim the list was read and came back without it. Nor may it claim
          the list is still being read after the read has FAILED: `catalog` is
          null in both cases, so `loading` is what tells them apart, and the
          three sentences match the line above the table. */}
      {known.has(value) ? null : (
        <option value={value}>
          {value}
          {catalog !== null
            ? " — not in this machine's catalog"
            : loading
              ? " — reading pi's model list…"
              : " — pi's model list could not be read here"}
        </option>
      )}
      {(catalog?.providers ?? []).map((provider) => (
        <optgroup key={provider.id} label={provider.id}>
          {provider.models.map((model) => (
            <option key={model.id} value={`${provider.id}/${model.id}`}>
              {provider.id}/{model.id}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

// ── thinking is a per-MODEL capability, not a per-agent preference ──────────
//
// Ported from ui-v2's RosterPane (`findLane` / `thinkingOptions`), which is
// where this was first read correctly. pi has ONE level vocabulary for every
// provider (`pi --help`), and one honest narrowing: `--list-models` carries a
// per-model `thinking` yes/no column, which `/api/app/models` already serves as
// `CatalogModel.thinking`. So a level is offered when the model supports one,
// and named as unsupported when it does not. Nothing here guesses: a model pi's
// list does not name has UNKNOWN support, says so, and keeps its dropdown.

/** The catalog entry for a `provider/id`, or null when pi's list does not name
 * it (a model registered since the probe, or a hand-edited config line). */
function findModel(catalog: ModelCatalog | null, model: string): CatalogModel | null {
  const cut = model.indexOf("/");
  if (!catalog || cut === -1) return null;
  const provider = catalog.providers.find((entry) => entry.id === model.slice(0, cut));
  return provider?.models.find((entry) => entry.id === model.slice(cut + 1)) ?? null;
}

type Thinks = "yes" | "no" | "unknown";

function thinksOn(catalog: ModelCatalog | null, model: string): Thinks {
  const found = findModel(catalog, model);
  if (found) return found.thinking ? "yes" : "no";
  return "unknown";
}

const NO_THINKING = "no thinking - not supported by this model";

/** The Thinking cell: the level dropdown, or - when pi's own list marks this
 * model without thinking support - the sentence that says so instead. The
 * config's own word is never rewritten from here; it is only stopped from being
 * offered as a choice that means nothing. */
function ThinkingCell({
  model,
  catalog,
  value,
  levels,
  source,
  disabled,
  onPick,
}: {
  model: string;
  catalog: ModelCatalog | null;
  value: string;
  levels: string[];
  /** "inherited" / "set on this agent" - unchanged by this cell */
  source: string;
  disabled: boolean;
  onPick: (level: string) => void;
}) {
  const thinks = thinksOn(catalog, model);

  if (thinks === "no") {
    return (
      <>
        <span
          className="no-thinking"
          title={`pi's own model list marks ${model} without thinking support. The config still says thinking: ${value}; it simply means nothing to this model.`}
        >
          {NO_THINKING}
        </span>
        <div className="ar-source">{source}</div>
      </>
    );
  }

  return (
    <>
      <select
        className="role-select"
        value={value}
        disabled={disabled}
        title={thinks === "unknown" ? `pi's model list does not name ${model}, so its thinking support is unknown here` : undefined}
        onChange={(event) => {
          if (event.target.value !== value) onPick(event.target.value);
        }}
      >
        {levels.includes(value) ? null : <option value={value}>{value}</option>}
        {levels.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
      <div className="ar-source">
        {source}
        {thinks === "unknown" ? " · support unknown" : ""}
      </div>
    </>
  );
}

export function Roster({
  projectId,
  projectName,
  report,
  config,
  definitions,
}: {
  projectId: string;
  projectName: string;
  report: SaveReporter;
  /** Fired once by the Settings surface (it needs the same read for the tab
   * count), handed down so opening this tab costs no second request. */
  config: Resource<ConfigRead>;
  definitions: Resource<ProviderDefinitionsResponse>;
}) {
  // Two reads nothing else on this surface wants, so they stay here and fire
  // only while this tab is open.
  const catalog = useResource<ModelCatalog>("models", "/api/app/models");
  const router = useResource<RouterRead>(`${projectId}|router`, `/api/app/p/${encode(projectId)}/config/router`);

  /** What the last accepted write returned, held until the re-read lands so the
   * pane never shows the old value for a beat after a successful save. */
  const [applied, setApplied] = useState<ConfigResponse | null>(null);
  const [appliedPool, setAppliedPool] = useState<BuilderPoolEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** null = the operator has not said; the pool's own size decides. */
  const [poolOpen, setPoolOpen] = useState<boolean | null>(null);
  useEffect(() => {
    setApplied(null);
    setAppliedPool(null);
    setPoolOpen(null);
  }, [projectId]);

  const { refresh: refreshConfig } = config;
  const { refresh: refreshRouter } = router;

  const editAgent = useCallback(
    async (body: RosterEditBody, what: string, marker: string) => {
      setBusy(marker);
      report.saving(what);
      try {
        const result = await apiPost<RosterEditResult>(`/api/app/p/${encode(projectId)}/config/roster`, body);
        setApplied({ roster: result.roster, defaults: result.defaults });
        report.saved(`${result.changed.join(" · ")} — the previous file is at ${result.backup}`);
        refreshConfig();
        return true;
      } catch (failure) {
        report.failed(what, (failure as Error).message);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [projectId, refreshConfig, report],
  );

  const editPool = useCallback(
    async (pool: BuilderPoolEntry[], what: string, marker: string) => {
      setBusy(marker);
      report.saving(what);
      try {
        const result = await apiPost<RouterEditResult>(`/api/app/p/${encode(projectId)}/config/router`, {
          builder_pool: pool,
        });
        setAppliedPool(result.builder_pool);
        report.saved(`${result.changed.join(" · ")} — the previous file is at ${result.backup}`);
        refreshRouter();
        return true;
      } catch (failure) {
        report.failed(what, (failure as Error).message);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [projectId, refreshRouter, report],
  );

  if (isFactoryAbsent(config.data)) {
    return (
      <div className="form-body-content fade-in">
        <div className="form-panel-title">
          Agent roster · <span className="scope-name-inline">{projectName}</span>
        </div>
        <div className="form-panel-sub">The five agents a run walks through, and the model each one runs on.</div>
        <p className="section-empty">
          This project has no roster file, so there is nothing to edit yet. The factory installer writes one, and it
          runs from right here.
          <span className="se-note">{CONFIG_PATH}</span>
        </p>
        {/* This used to say "or `uv run` the sssf installer in the repo",
            which sends the operator out of the app to a terminal for a command
            the app is allowed to run itself. It is one of the two commands
            this app may ever run — so it is offered here, with the job's own
            output, instead of being described. */}
        <InitializeFactory projectId={projectId} projectName={projectName} onInitialized={config.refresh} />
      </div>
    );
  }

  const data = applied ?? (config.data as ConfigResponse | null);
  const roster = data?.roster ?? [];
  const defaults = data?.defaults ?? null;
  const levels = catalog.data?.thinking_levels?.length ? catalog.data.thinking_levels : THINKING_FALLBACK;
  const defaultThinks = thinksOn(catalog.data, defaults?.model ?? "");
  /** pi's model list takes seconds to come back on a cold process, and until it
   * does every model dropdown holds exactly one option: the value the file
   * already has. That reads as "this row is locked" - the reviewer's row is the
   * one an operator goes looking for, and it is the one that got reported. So
   * the pane says which of the three states the list is in, once, above the
   * table. */
  const catalogLine = catalog.loading
    ? "Reading pi's model list — the model dropdowns fill in when it lands."
    : (catalog.data?.providers.length ?? 0) === 0
      ? (catalog.data?.detail ?? "pi's model list could not be read here, so no other model can be offered.")
      : null;
  const byProvider = new Map((definitions.data?.providers ?? []).map((provider) => [provider.id, provider]));

  // Pipeline order first, then anything else the file names, so an agent this
  // app does not know about is still visible instead of being swallowed.
  const inPipeline = PIPELINE.map((step) => ({ step, agent: roster.find((agent) => sameName(agent, step.name)) ?? null }));
  const extras = roster.filter((agent) => !PIPELINE.some((step) => sameName(agent, step.name)));

  const builder = roster.find((agent) => sameName(agent, "builder")) ?? null;
  const reviewer = roster.find((agent) => sameName(agent, "reviewer")) ?? null;

  const pool = appliedPool ?? router.data?.builder_pool ?? [];
  const maxPool = router.data?.max_pool ?? 5;
  const poolModels = pool.map((entry) => entry.model);
  /** What the builder actually runs on, pool or no pool: the pool when there is
   * one, its single `model:` when there is not. */
  const builderModels = poolModels.length > 0 ? poolModels : builder ? [builder.model] : [];
  /** The pool's first entry is meant to BE the builder's model. A file edited
   * by hand can disagree, and the pane says so rather than hiding it. */
  const drifted = builder !== null && poolModels.length > 0 && poolModels[0] !== builder.model;

  /** Writing the primary: the agent's own `model:` line (unchanged mechanism),
   * and — when a pool exists — entry #1 of the pool, so the two never drift on
   * this app's own account. Two writes, each reported by the bar in turn. */
  const setPrimary = async (model: string) => {
    if (!builder) return;
    const ok = await editAgent({ target: "agent", agent: builder.name, model }, "the builder's model", "builder");
    if (ok && poolModels.length > 0) {
      const next = [{ model }, ...pool.slice(1).filter((entry) => entry.model !== model)];
      await editPool(next, "the pool's first entry", "pool");
    }
  };

  const setPoolAt = (index: number, model: string) => {
    if (index === 0) return void setPrimary(model);
    const next = pool.map((entry, at) => (at === index ? { model } : entry));
    void editPool(next, `pool entry ${index + 1}`, `pool:${index}`);
  };

  const movePool = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 1 || to >= pool.length) return; // entry #1 is the primary and stays
    const next = [...pool];
    [next[index], next[to]] = [next[to]!, next[index]!];
    void editPool(next, `the pool's order`, `pool:${index}`);
  };

  const removePool = (index: number) => {
    void editPool(
      pool.filter((_, at) => at !== index),
      `pool entry ${index + 1}`,
      `pool:${index}`,
    );
  };

  // Adding is a PICK, not a button: a button would have to write some model,
  // and the one model this pane must never write is one the operator did not
  // choose. So the control is the catalog itself, minus what is already here.
  const addPool = (model: string) => void editPool([...pool, { model }], "a model into the pool", "pool:add");

  const startPool = () => {
    if (!builder) return;
    void editPool([{ model: builder.model }], "the builder pool", "pool:add");
  };

  const agentRow = (agent: RosterAgent, step: { step: string; role: string } | null) => {
    const lane = providerOf(agent.model);
    const marker = `agent:${agent.name}`;
    const saving = busy === marker;
    return (
      <div className="agent-row" key={agent.name}>
        <div className="ar-who">
          <span className="ar-step">{step?.step ?? "·"}</span>
          <span className="ar-name">{agent.name}</span>
          <span className="ar-role">{step?.role ?? agent.purpose ?? "named in this roster, not in the pipeline"}</span>
        </div>

        <div className="ar-model">
          <ModelSelect
            value={agent.model}
            catalog={catalog.data}
            loading={catalog.loading}
            disabled={busy !== null}
            onPick={(model) => void editAgent({ target: "agent", agent: agent.name, model }, `${agent.name}'s model`, marker)}
          />
          <div className="ar-source">
            <span className="mono">{lane ?? "no provider named"}</span>
            <span className="ar-sep">·</span>
            {agent.model_inherited ? (
              <span>inherited from defaults</span>
            ) : (
              <>
                <span>set on this agent</span>
                <button
                  type="button"
                  className="rt-clear"
                  disabled={busy !== null}
                  onClick={() => void editAgent({ target: "agent", agent: agent.name, model: null }, `${agent.name}'s model`, marker)}
                >
                  inherit again
                </button>
              </>
            )}
            {saving ? <span className="rt-busy">saving…</span> : null}
          </div>
        </div>

        <div className="ar-thinking">
          <ThinkingCell
            model={agent.model}
            catalog={catalog.data}
            value={agent.thinking}
            levels={levels}
            source={agent.thinking_inherited ? "inherited" : "set on this agent"}
            disabled={busy !== null}
            onPick={(thinking) =>
              void editAgent({ target: "agent", agent: agent.name, thinking }, `${agent.name}'s thinking level`, marker)
            }
          />
        </div>

        <div className="ar-family">
          <FamilyChip model={agent.model} />
        </div>

        <div className="ar-auth">
          <AuthCell definition={lane ? (byProvider.get(lane) ?? null) : null} lane={lane} />
        </div>
      </div>
    );
  };

  const missingRow = (step: { name: string; step: string; role: string }) => (
    <div className="agent-row missing" key={step.name}>
      <div className="ar-who">
        <span className="ar-step">{step.step}</span>
        <span className="ar-name">{step.name}</span>
        <span className="ar-role">{step.role}</span>
      </div>
      <div className="ar-missing">
        No agent named <strong>{step.name}</strong> in this roster. A phase that names it has nothing to run — add it in{" "}
        <span className="mono">{CONFIG_PATH}</span>.
      </div>
    </div>
  );

  const poolPane = () => {
    if (!builder) return null;
    if (router.error) return <ReadFailure error={router.error} />;
    if (router.loading && !router.data) return <p className="section-empty">Reading the builder pool…</p>;

    // The editor is a lot of controls for a setting most projects never touch,
    // so it lives behind one word-button on the builder's own row. Collapsed by
    // default until there is more than one model - which is the state in which
    // there is something to spread and something to reorder.
    //
    // NO POOL AND A ONE-ENTRY POOL ARE NOT THE SAME CONFIG, and this count used
    // to report both as "1". `adws/engine.py:plan_run` takes the classical path
    // only when the pool is EMPTY (`if not engine.builder_pool:` - dispatch runs
    // `engine.config` itself). One entry is enough to put every builder run
    // through `pick_pool_model` + `derive_config` (a per-card temp roster) and
    // to make a full lane hold the card in the pool's own words. So the number
    // is the pool's real size, and "no pool" says no pool.
    const inPool = poolModels.length;
    const open = poolOpen ?? inPool > 1;

    return (
      <div className="pool-block">
        <div className="pool-bar">
          <button type="button" className="pool-toggle" aria-expanded={open} onClick={() => setPoolOpen(!open)}>
            Pool · {inPool === 0 ? "none" : inPool}
          </button>
          {open ? null : (
            <span className="pool-bar-note">
              {inPool === 0
                ? "No pool — the builder runs its own model and the router dispatches this roster as it stands."
                : inPool === 1
                  ? "One model — every builder run is routed through it."
                  : `${inPool} models, one per run.`}
            </span>
          )}
        </div>

        {open ? (
          <div className="pool-pane">
            {poolModels.length === 0 ? (
              <div className="pool-empty">
                <p>
                  The builder runs one model — <span className="mono">{builder.model}</span>. A pool lets the router hand
                  concurrent runs to different providers, so one account&apos;s rate limit does not stall the rest.
                </p>
                <button type="button" className="pool-add" disabled={busy !== null} onClick={startPool}>
                  <PlusIcon /> Start a pool from {builder.model}
                </button>
              </div>
            ) : (
              <>
                {drifted ? (
                  <div className="pool-drift">
                    The pool&apos;s first entry is <strong>{poolModels[0]}</strong> while the builder&apos;s own model is{" "}
                    <strong>{builder.model}</strong>. The router reads the pool; entry 1 is meant to be the builder&apos;s
                    model.
                    <button
                      type="button"
                      className="rt-clear"
                      disabled={busy !== null}
                      onClick={() => void editPool([{ model: builder.model }, ...pool.slice(1).filter((e) => e.model !== builder.model)], "the pool's first entry", "pool")}
                    >
                      make entry 1 the builder&apos;s model
                    </button>
                  </div>
                ) : null}

                {pool.map((entry, index) => (
                  <div className="pool-row" key={`${entry.model}:${index}`}>
                    <span className={`pool-index${index === 0 ? " primary" : ""}`}>{index === 0 ? "1 · primary" : index + 1}</span>
                    <ModelSelect
                      value={entry.model}
                      catalog={catalog.data}
                      loading={catalog.loading}
                      disabled={busy !== null}
                      className="roster-select pool-select"
                      onPick={(model) => setPoolAt(index, model)}
                    />
                    <span className="pool-provider mono">{providerOf(entry.model) ?? "no provider named"}</span>
                    <FamilyChip model={entry.model} />
                    <div className="pool-actions">
                      <button
                        type="button"
                        className="pool-btn"
                        disabled={busy !== null || index <= 1}
                        title={index === 0 ? "the primary is entry 1" : index === 1 ? "already first after the primary" : "move up"}
                        onClick={() => movePool(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="pool-btn"
                        disabled={busy !== null || index === 0 || index === pool.length - 1}
                        title={index === 0 ? "the primary is entry 1" : "move down"}
                        onClick={() => movePool(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="pool-btn danger"
                        disabled={busy !== null}
                        /* While a pool exists the router only ever picks FROM
                           it (`pick_pool_model`), and the builder's own `model:`
                           line is never dispatched - so removing entry 1 takes
                           that model out of dispatch entirely, it does not fall
                           back to it. Emptying the pool is the only thing that
                           hands the builder its own model back. */
                        title={
                          index === 0
                            ? pool.length === 1
                              ? "empties the pool - the builder goes back to running its own model, dispatched from this roster as it stands"
                              : "while a pool exists the router only picks from it, so this drops the model out of dispatch entirely - the builder runs the rest of the pool"
                            : "remove from the pool"
                        }
                        onClick={() => removePool(index)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}

                <div className="pool-foot">
                  <select
                    className="role-select pool-pick"
                    value=""
                    disabled={busy !== null || pool.length >= maxPool}
                    onChange={(event) => {
                      if (event.target.value) addPool(event.target.value);
                    }}
                  >
                    <option value="">
                      {pool.length >= maxPool ? `pool full — ${maxPool} models` : "+ Add a model from…"}
                    </option>
                    {(catalog.data?.providers ?? []).map((provider) => {
                      const options = provider.models
                        .map((model) => `${provider.id}/${model.id}`)
                        .filter((model) => !poolModels.includes(model));
                      if (options.length === 0) return null;
                      return (
                        <optgroup key={provider.id} label={provider.id}>
                          {options.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                  <span className="pool-note">
                    {pool.length >= maxPool
                      ? `the pool holds at most ${maxPool} models`
                      : `${maxPool - pool.length} more can go in this pool`}
                  </span>
                </div>
              </>
            )}

            <p className="section-note">{POOL_SENTENCE}</p>
            {router.data?.reason ? <p className="section-note mono">{router.data.reason}</p> : null}
          </div>
        ) : null}
      </div>
    );
  };

  // ── cross-family review, on the vocabulary law ──────────────────────────
  const reviewerFamily: ModelFamily | null = reviewer ? familyOf(reviewer.model) : null;
  const builderFamilies = builderModels.map((model) => ({ model, family: familyOf(model) }));
  const conflicts = reviewerFamily ? builderFamilies.filter((entry) => entry.family?.id === reviewerFamily.id) : [];
  const unknowns = builderFamilies.filter((entry) => entry.family === null);
  const verdict: "ok" | "warn" | "fail" =
    reviewer === null || reviewerFamily === null || unknowns.length > 0 ? "warn" : conflicts.length > 0 ? "fail" : "ok";

  return (
    <div className="form-body-content fade-in">
      <div className="form-panel-title">
        Agent roster · <span className="scope-name-inline">{projectName}</span>
      </div>
      <div className="form-panel-sub">The five agents a run walks through, in order, and the model each one runs on.</div>

      {config.error ? <ReadFailure error={config.error} /> : null}

      <div className="form-section">
        <div className="form-section-title">
          <span>
            Pipeline <span className="section-plain">— scout, planner, builder, reviewer, documenter</span>
          </span>
        </div>

        {catalogLine ? <p className="catalog-state">{catalogLine}</p> : null}

        {roster.length === 0 ? (
          <p className="section-empty">
            {config.loading
              ? "Reading the roster…"
              : config.error && !config.data
                ? "The roster read failed, so there is nothing to list — the line above carries the server's own words."
                : "This config names no agents at all."}
          </p>
        ) : (
          <div className="agent-list">
            <div className="agent-head">
              <span>Agent</span>
              <span>Model</span>
              <span>Thinking</span>
              <span>Family</span>
              <span>Authentication</span>
            </div>
            {inPipeline.map(({ step, agent }) => (
              <div key={step.name} className="agent-block">
                {agent ? agentRow(agent, step) : missingRow(step)}
                {agent && sameName(agent, "builder") ? poolPane() : null}
              </div>
            ))}
            {extras.length > 0 ? (
              <>
                <div className="agent-extra-label">
                  Also in this file — named in the roster, not part of the five-phase pipeline
                </div>
                {extras.map((agent) => agentRow(agent, null))}
              </>
            ) : null}
          </div>
        )}

        {/* Standing mechanism truth — where the write goes, what the backup is,
            why there are five rows and no add button. True, not urgent, and the
            exact category `HowThisWorks` exists for. */}
        <HowThisWorks label="Where these settings are written">
          <p>
            Model and thinking level are written one line at a time into <code>{CONFIG_PATH}</code>, and the pool into
            that same file&apos;s <code>router.builder_pool</code> block. The previous file is kept beside it on every
            save.
          </p>
          <p>
            Which agents exist is the pipeline&apos;s own shape — a run walks these five phases — so this pane changes
            what they run on, never how many there are.
          </p>
        </HowThisWorks>
      </div>

      <div className="form-section">
        <div className="form-section-title">
          <span>
            Cross-family review <span className="section-plain">— the writer&apos;s family never reviews its own code</span>
          </span>
        </div>

        <div className="review-family-box">
          <div className="rf-header">
            <span className="rf-label">Reviewer family · read from the model name</span>
            <span className={`rf-badge ${verdict}`}>
              {reviewer === null ? "no reviewer" : (reviewerFamily?.label ?? "unknown family")}
            </span>
          </div>
          <div className="rf-body">
            {reviewer === null ? (
              "No agent named reviewer in this roster. The review phase runs the agent with that name, so there is no family to compare."
            ) : reviewerFamily === null ? (
              <>
                The reviewer runs <strong>{reviewer.model}</strong>, and its model name matches no family this app knows —{" "}
                {UNKNOWN_FAMILY}. A family is read from the model ({FAMILY_WORDS.join(", ")}), never from the provider
                account that serves it.
              </>
            ) : conflicts.length > 0 ? (
              <>
                Conflict — the reviewer is <strong>{reviewerFamily.label}</strong>, and so{" "}
                {conflicts.length === 1 ? "is" : "are"}{" "}
                {conflicts.map((entry, index) => (
                  <span key={entry.model}>
                    {index > 0 ? ", " : ""}
                    <strong>{entry.model}</strong>
                  </span>
                ))}{" "}
                in the builder pool. The same family writes the code and reviews it. Move the reviewer to a different
                family, or drop {conflicts.length === 1 ? "that model" : "those models"} from the pool.
              </>
            ) : unknowns.length > 0 ? (
              <>
                The reviewer is <strong>{reviewerFamily.label}</strong> and no builder model is — but{" "}
                {unknowns.map((entry, index) => (
                  <span key={entry.model}>
                    {index > 0 ? ", " : ""}
                    <strong>{entry.model}</strong>
                  </span>
                ))}{" "}
                {unknowns.length === 1 ? "matches" : "match"} no family this app knows, so {UNKNOWN_FAMILY}.
              </>
            ) : (
              <>
                Clear — the reviewer is <strong>{reviewerFamily.label}</strong> and no model in the builder pool is.
              </>
            )}
          </div>

          {builderFamilies.length > 0 ? (
            <div className="rf-grid">
              <div className="rf-grid-label">
                Builder {poolModels.length > 0 ? `pool · ${poolModels.length} model${poolModels.length === 1 ? "" : "s"}` : "· one model"}
              </div>
              {builderFamilies.map((entry) => {
                const clash = reviewerFamily !== null && entry.family?.id === reviewerFamily.id;
                return (
                  <div className={`rf-line${clash ? " clash" : ""}`} key={entry.model}>
                    <span className="mono">{entry.model}</span>
                    <span className="rf-arrow">→</span>
                    <span className={entry.family ? "" : "rf-unknown"}>{entry.family?.label ?? UNKNOWN_FAMILY}</span>
                    {clash ? <span className="rf-clash-tag">same family as the reviewer</span> : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* The de-texting pass owns this footnote only: it was four lines of
            glossary under a box that already names every family it read. One
            line stays, because provider-vs-family is the distinction the whole
            rule turns on; the rest is the tooltip. */}
        <p
          className="section-note"
          title={`A provider is an account and a lane — Ollama Cloud, OpenCode, xAI. A family is the model's — ${FAMILY_LABELS.join(", ")}. One account can serve several families, so the family is read from the model name and nothing else.`}
        >
          A <strong>provider</strong> is an account; a <strong>family</strong> is the model&apos;s.
        </p>
      </div>

      <div className="form-section">
        <div className="form-section-title">
          <span>
            Defaults <span className="section-plain">— what every agent without its own setting inherits</span>
          </span>
        </div>
        {defaults ? (
          <>
            {/* `.form-row` is a flex row: a control that asks for 100% of it
                leaves the label group nothing, and the hint wraps to one word
                per line (the operator's screenshot). `defaults-select` is the
                width cap that keeps the sentence a sentence. */}
            <div className="form-row">
              <div className="form-label-group">
                <div className="form-label">Model</div>
                <div className="form-hint">
                  {defaults.model
                    ? "Every agent without its own model runs this one."
                    : "No default model in this file — each agent names its own"}
                </div>
              </div>
              {defaults.model ? (
                <ModelSelect
                  value={defaults.model}
                  catalog={catalog.data}
                  loading={catalog.loading}
                  disabled={busy !== null}
                  className="roster-select defaults-select"
                  onPick={(model) => void editAgent({ target: "defaults", model }, "the default model", "defaults")}
                />
              ) : (
                <span className="form-hint mono">not set</span>
              )}
            </div>
            <div className="form-row">
              <div className="form-label-group">
                <div className="form-label">Thinking level</div>
                <div className="form-hint">pi&apos;s own vocabulary{catalog.data?.source ? `, read from ${catalog.data.source}` : ""}</div>
              </div>
              {defaults.thinking ? (
                defaultThinks === "no" ? (
                  // The default model itself cannot think: offering a level here
                  // would be offering a setting the engine cannot act on.
                  <span
                    className="no-thinking"
                    title={`pi's own model list marks ${defaults.model} without thinking support. The config still says thinking: ${defaults.thinking}; it simply means nothing to this model.`}
                  >
                    {NO_THINKING}
                  </span>
                ) : (
                  <select
                    className="form-select compact"
                    value={defaults.thinking}
                    disabled={busy !== null}
                    title={
                      defaultThinks === "unknown"
                        ? `pi's model list does not name ${defaults.model ?? "this model"}, so its thinking support is unknown here`
                        : undefined
                    }
                    onChange={(event) => {
                      if (event.target.value !== defaults.thinking) {
                        void editAgent({ target: "defaults", thinking: event.target.value }, "the default thinking level", "defaults");
                      }
                    }}
                  >
                    {levels.includes(defaults.thinking) ? null : <option value={defaults.thinking}>{defaults.thinking}</option>}
                    {levels.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                )
              ) : (
                <span className="form-hint mono">not set</span>
              )}
            </div>
          </>
        ) : (
          <p className="section-empty">{config.loading ? "Reading the roster…" : "This config has no defaults block."}</p>
        )}
      </div>

      {catalog.error ? <ReadFailure error={catalog.error} /> : null}
      {/* `catalog.data.detail` used to live here, a footnote away from the
          dropdowns it explains. It is now `catalogLine`, above the table. */}
      {definitions.error ? <ReadFailure error={definitions.error} /> : null}
      <HowThisWorks label="Where credentials live">
        <p>
          Authentication is never read on this machine. Credentials live in <code>~/.pi/agent/auth.json</code> (0600) on
          the machine that runs the factory, written over SSH and never in git — so the Authentication column says what
          it knows and no more.
        </p>
      </HowThisWorks>
    </div>
  );
}
