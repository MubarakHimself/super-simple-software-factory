/**
 * Lanes (per project) — J6.2 and change-list #5, with the switches connected.
 *
 * A lane is one PROVIDER ACCOUNT: one rate-limit bucket, one quota pool. It is
 * not a model family — `ollama-cloud` is an account that happens to serve a
 * Kimi model, and the Roster pane reads the family from the model name. This
 * pane deals only in accounts.
 *
 * Reads `GET /api/app/p/:id/lanes`, which derives a lane the way
 * `engine.py:roster_lanes` does — the distinct provider prefixes of the
 * roster's `provider/model` strings — and now also of `router.builder_pool`,
 * because a pool entry draws on its provider account exactly like a roster
 * model does.
 *
 * ── What is written, and what is not ──────────────────────────────────────
 * Per-lane `slots` has a home: the config's OPTIONAL `lanes:` block, the shared
 * schema the factory's engine reads.
 *
 *   lanes:
 *     ollama-cloud: { slots: 2 }
 *     xai: { slots: 2 }
 *
 * It is written by `POST /api/app/p/:id/config/lanes`, one lane at a time, with
 * the same discipline as every other write into that file: the block is
 * replaced, the rest of the document is proved byte-identical, the previous
 * file is kept beside it. `slots` is end to end — `engine.py:config_lanes`
 * reads it, `resolve_lanes` applies it, `--lanes` / `$SSSF_LANES` still win.
 *
 * The on/off switch is NOT. `engine.py` reads `slots` and nothing else out of
 * that block (`grep -n "enabled" adws/engine.py` finds only `worktrees.enabled`),
 * so a lane written `enabled: false` keeps taking dispatches. A switch that
 * persists, confirms, and changes nothing is worse than one that is plainly
 * inert, so it is drawn disabled and says why — the same honesty the Failover
 * select and the retry-budget field already use. Switching a lane off for real
 * needs the engine to skip it (its `resolve_lanes` / `pick_pool_model`), which
 * is a change to the factory core this pane does not own.
 *
 * What is still NOT written, and says so: the engine's own concurrency cap
 * (`--lanes` / `SSSF_LANES` on the machine running the service — a running
 * process's startup argument, not a file this app can reach), the retry budget
 * (no backend at all), and "reviewer gets its own lane" (no field anywhere).
 */
import { useCallback, useState } from "react";
import { useShell } from "../App.tsx";
import { apiPost } from "../lib/api.ts";
import type { Resource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import type { SaveReporter } from "./save.ts";
import { familyOf, type LaneEditResult, type LanesResponse } from "./types.ts";

/** The slot counts the write endpoint accepts. 0 is not one of them, for the
 * reason engine.py's own parser refuses it: a lane with no slots holds every
 * card that draws on it forever. */
const SLOT_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8];

export function Lanes({
  projectName,
  report,
  lanes,
}: {
  projectName: string;
  report: SaveReporter;
  /** Fired once by the Settings surface (the tab count reads the same
   * response), handed down so this tab costs no second request. */
  lanes: Resource<LanesResponse>;
}) {
  // The project id is read from the shell rather than taken as a prop: the
  // Settings surface that mounts this pane belongs to another chunk this wave,
  // and this is the same context it reads the id from itself.
  const { projectId } = useShell();
  const [busy, setBusy] = useState<string | null>(null);

  const { refresh } = lanes;
  const write = useCallback(
    async (body: { lane: string; slots?: number | null }, what: string) => {
      setBusy(body.lane);
      report.saving(what);
      try {
        const result = await apiPost<LaneEditResult>(`/api/app/p/${encodeURIComponent(projectId)}/config/lanes`, body);
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

  const rows = lanes.data?.lanes ?? [];
  const slotsDefault = lanes.data?.slots_default ?? 2;

  return (
    <div className="form-body-content fade-in">
      <div className="form-panel-title">
        Rate-limit buckets · <span className="scope-name-inline">{projectName}</span>
      </div>
      <div className="form-panel-sub">
        Each provider account is one rate-limit bucket — a &ldquo;lane.&rdquo; The factory spreads work across lanes so no
        single account hits its rate limit. A lane appears here because this project&apos;s roster or its builder pool
        names that provider.
      </div>

      <div className="lane-callout">
        <div className="lc-title">What is a lane?</div>
        <div className="lc-body">
          A lane is one provider account = one rate-limit bucket. If you have one xAI account and one Z.ai account, you
          have two lanes. The factory can run two runs concurrently — one per lane — without either hitting the
          other&apos;s rate limit. Add more provider accounts in the Providers tab to get more lanes. A lane is an
          account, never a model family: one account can serve models from several families.
        </div>
      </div>

      {lanes.error ? <ReadFailure error={lanes.error} /> : null}

      <div className="form-section">
        <div className="form-section-title">
          <span>
            Active lanes <span className="section-plain">— slots cap the runs one account carries at once</span>
          </span>
        </div>

        {rows.length === 0 ? (
          <p className="section-empty">
            {lanes.loading
              ? "Reading the roster…"
              : lanes.error && !lanes.data
                ? "The lanes read failed, so there is nothing to list — the line above carries the server's own words."
                : (lanes.data?.reason ??
                  "No lanes — a lane is the provider prefix of a roster model, and this project's roster names none.")}
            {lanes.data ? <span className="se-note">{lanes.data.config_path}</span> : null}
          </p>
        ) : (
          <div className="lane-list">
            {rows.map((lane) => {
              const saving = busy === lane.name;
              // A model can be both a roster model and a pool entry (the
              // builder's primary is both by design) - it is still one model
              // drawing on one account, so it is listed once.
              const drawn = [...new Set([...lane.models, ...lane.pool_models])];
              const families = [...new Set(drawn.map((model) => familyOf(model)?.label ?? "unknown family"))];
              const envPinned = lane.slots_source === "SSSF_LANES";
              return (
                // The row is never drawn "off": the engine dispatches onto this
                // lane whatever the file's `enabled` says, so dimming it would
                // be the same claim the switch used to make.
                <div className="lane-row" key={lane.name}>
                  <span className="lane-id" title={lane.name}>
                    {lane.name}
                  </span>

                  <div className="lane-body">
                    <div className="lane-models">
                      <span className="lm-model" title={drawn.join(", ")}>
                        {drawn.length ? drawn.join(", ") : "no model on this lane"}
                      </span>
                      <span className="lm-agents">
                        {lane.agents.length === 1 ? "agent: " : "agents: "}
                        {lane.agents.join(", ")}
                        {families.length ? ` · ${families.join(", ")}` : ""}
                      </span>
                    </div>

                    <label className="lane-slots-edit">
                      <span className="lse-label">slots</span>
                      <select
                        className="role-select"
                        value={lane.slots_config ?? slotsDefault}
                        disabled={busy !== null}
                        onChange={(event) => {
                          const next = Number.parseInt(event.target.value, 10);
                          void write({ lane: lane.name, slots: next }, `${lane.name}'s slots`);
                        }}
                      >
                        {SLOT_CHOICES.map((count) => (
                          <option key={count} value={count}>
                            {count}
                          </option>
                        ))}
                      </select>
                      <span className="lse-source">
                        {lane.slots_config === null
                          ? `default ${slotsDefault} — not yet in the file`
                          : "in the config file"}
                        {lane.slots_config !== null ? (
                          <button
                            type="button"
                            className="rt-clear"
                            disabled={busy !== null}
                            onClick={() => void write({ lane: lane.name, slots: null }, `${lane.name}'s slots`)}
                          >
                            use the default
                          </button>
                        ) : null}
                      </span>
                    </label>

                    <span
                      className="lane-status idle"
                      title="free slots are the running engine's own count, and this machine has no engine to ask"
                    >
                      ○ {lane.free === null ? "no engine here" : `${lane.free} free`}
                    </span>
                    {lane.enabled ? null : (
                      <span
                        className="lane-status"
                        style={{ color: "var(--warn, var(--t2))" }}
                        title="an earlier build of this pane wrote enabled: false into the lanes block; the engine reads slots out of that block and nothing else"
                      >
                        the config file says off — the engine still dispatches here
                      </span>
                    )}
                    {saving ? <span className="rt-busy">saving…</span> : null}
                  </div>

                  <button
                    type="button"
                    className="form-toggle on"
                    disabled
                    aria-label={`${lane.name} cannot be switched off — no engine reads that switch`}
                    title="Drawn and disabled on purpose: the engine reads slots out of the lanes block and nothing else, so a lane switched off here would keep taking runs."
                  />

                  {envPinned ? (
                    <span className="lane-pinned" title={`SSSF_LANES = ${lanes.data?.env ?? ""}`}>
                      running at {lane.slots} · SSSF_LANES in this process
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        <p className="section-note">
          Slots are written into the <strong>lanes:</strong> block of{" "}
          <strong>{lanes.data?.config_path ?? "this project's config"}</strong>, one lane at a time, with the previous
          file kept beside it, and the engine reads them. A lane the block never mentions runs at the engine&apos;s
          default of {slotsDefault}. How many slots are free right now, and whether a lane is in cooldown, belongs to the
          running engine — which is not this machine.
        </p>
        <p className="section-note">
          The on/off switch beside each lane is drawn and disabled on purpose. The engine reads <strong>slots</strong>{" "}
          out of that block and nothing else, so a lane switched off here would go on taking runs while this pane said it
          was off. Switching a lane off for real means teaching the engine to skip it — the factory core, not this app.
          To stop work reaching an account today, take its model out of the roster or the builder pool.
        </p>
      </div>

      <div className="form-section">
        <div className="form-section-title">
          <span>Balancing</span>
        </div>

        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Max concurrent runs</div>
            <div className="form-hint">
              The engine&apos;s own cap across all lanes — a startup argument of the running service (<code>--lanes</code>{" "}
              / <code>SSSF_LANES</code>), not a field in any file this app can reach
            </div>
            <div className="form-hint mono">
              SSSF_LANES {lanes.data?.env ? `= ${lanes.data.env}` : "is not set in this process"}
            </div>
          </div>
          <span className="honest-value">
            {lanes.data?.env ?? "unknown"}
            <span className="hv-note">set on the engine service</span>
          </span>
        </div>

        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Slots per lane</div>
            <div className="form-hint">
              How many runs one lane carries at once. Set per lane above; a lane the config does not name runs at the
              engine&apos;s default.
            </div>
          </div>
          <span className="honest-value">
            {slotsDefault}
            <span className="hv-note">the engine&apos;s default</span>
          </span>
        </div>

        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Retry budget per lane</div>
            <div className="form-hint">Retries before parking the run — lands with the balancer round (no backend today)</div>
          </div>
          <input className="form-input" type="number" style={{ width: 80, minWidth: 80 }} placeholder="—" disabled readOnly />
        </div>

        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Auto-pick from Ready</div>
            <div className="form-hint">
              Always on: the engine pulls ready work whenever a lane frees up. There is no dispatch button anywhere in
              this app, by design — and nothing to switch off, so this one is drawn as the fact it is.
            </div>
          </div>
          <button type="button" className="form-toggle on" disabled aria-label="auto-pick from Ready is always on" />
        </div>

        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Reviewer gets its own lane</div>
            <div className="form-hint">
              Drawn, not built — there is no field for it in any config file today; it lands with the balancer round
            </div>
          </div>
          <button type="button" className="form-toggle" disabled aria-label="reviewer lane setting is not available yet" />
        </div>

        {lanes.data ? <p className="section-note mono">lanes derived from {lanes.data.config_path}</p> : null}
        {lanes.data?.writes_reason ? <p className="section-note">{lanes.data.writes_reason}</p> : null}
      </div>
    </div>
  );
}
