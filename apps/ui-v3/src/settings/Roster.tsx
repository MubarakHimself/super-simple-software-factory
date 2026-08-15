/**
 * Roster (per project) — J6.3: "workhorses + the one reviewer + cross-family
 * auto-detection served as an API fact".
 *
 * Reads `GET /api/app/p/:id/config` (the roster and the `defaults:` block it
 * inherits from), `GET /api/app/models` (pi's own catalog, so the model control
 * is a list and not a memory test) and `GET /api/app/p/:id/factory/providers`
 * (what the Authentication column can honestly say).
 *
 * Writes `POST /api/app/p/:id/config/roster`, which edits exactly two fields -
 * `model` and `thinking` - one spliced line at a time, with the previous file
 * kept beside it. Everything else the drawing offers (adding a workhorse,
 * removing a row) is a write that endpoint refuses by design: *"this endpoint
 * never adds one"*. Those controls stay drawn and disabled, with the reason in
 * words underneath, rather than being wired to nothing.
 *
 * ── Two departures from the drawing, both forced by real data ─────────────
 * 1. The mock's workhorse caption reads "agents that write code". This repo's
 *    roster contains `scout`, whose whole purpose is "change nothing" - so the
 *    caption became "the agents that do the work" and the split is the one the
 *    journeys state: every agent except the one named `reviewer`.
 * 2. A Thinking column joins Provider / Model / Authentication, because
 *    `thinking` is half of what the write endpoint supports and the drawing had
 *    nowhere to put it. It uses the mock's own small in-row select shape
 *    (`.role-select`).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiPost } from "../lib/api.ts";
import { useResource, type Resource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import type { SaveReporter } from "./save.ts";
import {
  isFactoryAbsent,
  type ConfigRead,
  type ConfigResponse,
  type ModelCatalog,
  type ProviderDefinition,
  type ProviderDefinitionsResponse,
  type RosterAgent,
  type RosterEditBody,
  type RosterEditResult,
} from "./types.ts";

/** The seven words `sssf.config.yaml`'s own comment documents and the write
 * endpoint validates against - restated here ONLY as the fallback for a
 * `/api/app/models` read that did not land. It is not invented data: the server
 * prints this exact list in its refusal ("thinking must be one of off | minimal
 * | low | medium | high | xhigh | max"). */
const THINKING_FALLBACK = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Where the file being edited lives, relative to the repo -
 * `server/config.ts:configPathFromRepoRoot`, which is a fixed path. */
const CONFIG_PATH = "adws/adw_sssf_config/sssf.config.yaml";

/** The provider prefix of a `provider/model` string - the same split
 * `engine.py:roster_lanes` makes, and what this pane calls a "family": one
 * provider account, one quota pool, one vendor's models. */
function family(model: string): string | null {
  if (!model.includes("/")) return null;
  const prefix = model.split("/", 1)[0]!.trim();
  return prefix || null;
}

function isReviewer(agent: RosterAgent): boolean {
  return agent.name.trim().toLowerCase() === "reviewer";
}

function encode(id: string): string {
  return encodeURIComponent(id);
}

/** The Authentication cell. `auth_status` is `"unknown"` from every code path
 * on this machine and always will be - nothing in this app reads a credential -
 * so the cell says exactly that and carries the server's reason as its title. */
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
      <span className="auth-badge" title={`no ${lane}.provider.json in this repo - it is either one of pi's built-in providers or registered only on the factory machine`}>
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

function ModelSelect({
  value,
  catalog,
  disabled,
  onPick,
}: {
  value: string;
  catalog: ModelCatalog | null;
  disabled: boolean;
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
      className="roster-select"
      value={value}
      disabled={disabled}
      onChange={(event) => {
        if (event.target.value !== value) onPick(event.target.value);
      }}
    >
      {/* The value the file actually holds always appears, even when this
          machine's pi catalog has never heard of it - a select that silently
          shows a different model than the file is the worst outcome here. */}
      {known.has(value) ? null : <option value={value}>{value} — not in this machine&apos;s catalog</option>}
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
  // The model catalog is the one read nothing else on this surface wants, so it
  // stays here and is fetched only while this tab is open.
  const catalog = useResource<ModelCatalog>("models", "/api/app/models");

  /** What the last accepted write returned, held until the re-read lands so the
   * table never shows the old value for a beat after a successful save. */
  const [applied, setApplied] = useState<ConfigResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setApplied(null), [projectId]);

  const { refresh } = config;
  const edit = useCallback(
    async (body: RosterEditBody, what: string, marker: string) => {
      setBusy(marker);
      report.saving(what);
      try {
        const result = await apiPost<RosterEditResult>(`/api/app/p/${encode(projectId)}/config/roster`, body);
        setApplied({ roster: result.roster, defaults: result.defaults });
        report.saved(`${result.changed.join(" · ")} — the previous file is at ${result.backup}`);
        refresh();
      } catch (failure) {
        report.failed(what, (failure as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [projectId, refresh, report],
  );

  if (isFactoryAbsent(config.data)) {
    return (
      <div className="form-body-content fade-in">
        <div className="form-panel-title">
          Agent roster · <span className="scope-name-inline">{projectName}</span>
        </div>
        <div className="form-panel-sub">Pick which models do the work and which one reviews.</div>
        <p className="section-empty">
          This project has no roster file, so there is nothing to edit yet. The factory writes one when it is
          initialized — Settings · scope list · Add project runs that step, or <code>uv run</code> the sssf installer in
          the repo.
          <span className="se-note">{CONFIG_PATH}</span>
        </p>
      </div>
    );
  }

  const data = applied ?? (config.data as ConfigResponse | null);
  const roster = data?.roster ?? [];
  const defaults = data?.defaults ?? null;
  const workhorses = roster.filter((agent) => !isReviewer(agent));
  const reviewer = roster.find(isReviewer) ?? null;
  const levels = catalog.data?.thinking_levels?.length ? catalog.data.thinking_levels : THINKING_FALLBACK;
  const byProvider = new Map((definitions.data?.providers ?? []).map((provider) => [provider.id, provider]));

  const workhorseFamilies = [...new Set(workhorses.map((agent) => family(agent.model)).filter((name): name is string => name !== null))].sort();
  const reviewerFamily = reviewer ? family(reviewer.model) : null;
  const conflict = reviewerFamily !== null && workhorseFamilies.includes(reviewerFamily);

  const row = (agent: RosterAgent) => {
    const lane = family(agent.model);
    const marker = `agent:${agent.name}`;
    return (
      <tr key={agent.name}>
        <td>
          <div className="rt-name">
            <span className="rt-agent">{agent.name}</span>
            {agent.purpose ? <span className="rt-purpose">{agent.purpose}</span> : null}
          </div>
        </td>
        <td className="mono">{lane ?? "—"}</td>
        <td>
          <ModelSelect
            value={agent.model}
            catalog={catalog.data}
            disabled={busy !== null}
            onPick={(model) =>
              void edit({ target: "agent", agent: agent.name, model }, `${agent.name}'s model`, marker)
            }
          />
          <div className="rt-source">
            {agent.model_inherited ? (
              <span>inherited from defaults</span>
            ) : (
              <>
                <span>set on this agent</span>
                <button
                  type="button"
                  className="rt-clear"
                  disabled={busy !== null}
                  onClick={() =>
                    void edit({ target: "agent", agent: agent.name, model: null }, `${agent.name}'s model`, marker)
                  }
                >
                  inherit again
                </button>
              </>
            )}
            {busy === marker ? <span className="rt-busy">saving…</span> : null}
          </div>
        </td>
        <td>
          <select
            className="role-select"
            value={agent.thinking}
            disabled={busy !== null}
            onChange={(event) => {
              if (event.target.value !== agent.thinking) {
                void edit(
                  { target: "agent", agent: agent.name, thinking: event.target.value },
                  `${agent.name}'s thinking level`,
                  marker,
                );
              }
            }}
          >
            {levels.includes(agent.thinking) ? null : <option value={agent.thinking}>{agent.thinking}</option>}
            {levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
          <div className="rt-source">{agent.thinking_inherited ? <span>inherited</span> : <span>set on this agent</span>}</div>
        </td>
        <td>
          <AuthCell definition={lane ? (byProvider.get(lane) ?? null) : null} lane={lane} />
        </td>
        <td>
          <button type="button" className="remove-btn" disabled title="the roster write endpoint edits model and thinking only — it never adds or removes an agent">
            Remove
          </button>
        </td>
      </tr>
    );
  };

  const header = (
    <thead>
      <tr>
        <th>Agent</th>
        <th>Provider</th>
        <th>Model</th>
        <th>Thinking</th>
        <th>Authentication</th>
        <th />
      </tr>
    </thead>
  );

  return (
    <div className="form-body-content fade-in">
      <div className="form-panel-title">
        Agent roster · <span className="scope-name-inline">{projectName}</span>
      </div>
      <div className="form-panel-sub">
        Pick which models do the work and which one reviews. Cross-family review is the rule — the writer&apos;s family
        should never review its own code.
      </div>

      {config.error ? <ReadFailure error={config.error} /> : null}

      <div className="form-section">
        <div className="form-section-title">
          <span>
            Workhorses <span className="section-plain">— the agents that do the work</span>
          </span>
          <button type="button" className="section-action" disabled title="the roster write endpoint never adds an agent">
            + Add workhorse
          </button>
        </div>
        {workhorses.length === 0 ? (
          <p className="section-empty">
            {config.loading
              ? "Reading the roster…"
              : config.error && !config.data
                ? "The roster read failed, so there is nothing to list — the line above carries the server's own words."
                : "No agents in this roster yet — every agent in the file except the one named reviewer appears here."}
          </p>
        ) : (
          <table className="roster-table">
            {header}
            <tbody>{workhorses.map(row)}</tbody>
          </table>
        )}
        <p className="section-note">
          Model and thinking level are the two things this app writes, one line at a time, into <strong>{CONFIG_PATH}</strong>;
          the previous file is kept beside it on every save. Adding or removing an agent is a bigger edit than that, so
          those controls are drawn and disabled — do it in the file.
        </p>
      </div>

      <div className="form-section">
        <div className="form-section-title">
          <span>
            Reviewer <span className="section-plain">— the one agent that checks the work</span>
          </span>
          <button type="button" className="section-action" disabled title="the roster write endpoint never adds an agent">
            + Add reviewer
          </button>
        </div>
        {reviewer ? (
          <table className="roster-table">
            {header}
            <tbody>{row(reviewer)}</tbody>
          </table>
        ) : (
          <p className="section-empty">
            {config.loading
              ? "Reading the roster…"
              : config.error && !config.data
                ? "The roster read failed, so this section is empty — the line above carries the server's own words."
                : "No agent named reviewer in this roster. The factory's review phase runs the agent with that name, so a roster without one has no reviewer to check the work."}
          </p>
        )}

        <div className="review-family-box">
          <div className="rf-header">
            <span className="rf-label">Review family · auto-detected</span>
            <span className={`rf-badge ${reviewerFamily === null ? "warn" : conflict ? "fail" : "ok"}`}>
              {reviewerFamily ?? "none"}
            </span>
          </div>
          <div className="rf-body">
            {reviewer === null ? (
              "No reviewer is named in this roster, so there is no family to compare. Name an agent reviewer and this box checks it against the workhorses."
            ) : reviewerFamily === null ? (
              <>
                The reviewer runs <strong>{reviewer.model}</strong>, which names no provider — a family can only be read
                from a <code>provider/model</code> pair, so the cross-family rule cannot be checked.
              </>
            ) : conflict ? (
              <>
                Conflict — reviewer family <strong>{reviewerFamily}</strong> is also a workhorse family
                {workhorseFamilies.length > 1 ? <> (workhorses: <strong>{workhorseFamilies.join(", ")}</strong>)</> : null}. The
                same provider account writes the code and reviews it. Pick a reviewer model from a different provider.
              </>
            ) : (
              <>
                Workhorse families: <strong>{workhorseFamilies.length ? workhorseFamilies.join(", ") : "none"}</strong>.
                Reviewer family <strong>{reviewerFamily}</strong> is cross-family compatible — no conflict.
              </>
            )}
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">
          <span>
            Defaults <span className="section-plain">— what every agent without its own setting inherits</span>
          </span>
        </div>
        {defaults ? (
          <>
            <div className="form-row">
              <div className="form-label-group">
                <div className="form-label">Model</div>
                <div className="form-hint">
                  {defaults.model
                    ? `Every agent above marked "inherited from defaults" runs this one`
                    : "No default model in this file — each agent names its own"}
                </div>
              </div>
              {defaults.model ? (
                <ModelSelect
                  value={defaults.model}
                  catalog={catalog.data}
                  disabled={busy !== null}
                  onPick={(model) => void edit({ target: "defaults", model }, "the default model", "defaults")}
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
                <select
                  className="form-select compact"
                  value={defaults.thinking}
                  disabled={busy !== null}
                  onChange={(event) => {
                    if (event.target.value !== defaults.thinking) {
                      void edit({ target: "defaults", thinking: event.target.value }, "the default thinking level", "defaults");
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
      {catalog.data?.detail ? <p className="section-note mono">{catalog.data.detail}</p> : null}
      {definitions.error ? <ReadFailure error={definitions.error} /> : null}
      <p className="section-note">
        Authentication is never read on this machine. Credentials live in <strong>~/.pi/agent/auth.json</strong> (0600)
        on the machine that runs the factory, written over SSH and never in git — so this column says what it knows and
        no more.
      </p>
    </div>
  );
}
