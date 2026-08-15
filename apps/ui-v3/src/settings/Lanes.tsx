/**
 * Lanes (per project) — J6.2 and change-list #5.
 *
 * Reads `GET /api/app/p/:id/lanes`, which derives a lane the way
 * `engine.py:roster_lanes` does: the distinct provider prefixes of the roster's
 * `provider/model` strings. One provider account = one rate-limit bucket = one
 * lane. Its `slots` (the engine's `DEFAULT_LANE_SLOTS`, 2, or an `SSSF_LANES`
 * override) cap how many runs draw on it at once — change-list #5's addition,
 * shown per lane in the row and once in Balancing.
 *
 * The endpoint answers `writes_supported: false`, and that is the whole truth
 * about this tab: none of the drawn switches has a field in any config file
 * today. So the enable toggles move on screen and say, in words, that they
 * moved on screen only; the Balancing controls are drawn and disabled, each
 * with the one sentence that says where the real number lives. Nothing here
 * pretends to have been written.
 */
import { useEffect, useState } from "react";
import type { Resource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import type { SaveReporter } from "./save.ts";
import type { LanesResponse } from "./types.ts";

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
  /** Screen-only: which lanes the operator has switched off in this session.
   * There is nowhere on disk for this to go, which is exactly what the note
   * under the section says. */
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const configPath = lanes.data?.config_path ?? null;
  useEffect(() => setOff(new Set()), [configPath]);

  const rows = lanes.data?.lanes ?? [];

  const toggle = (name: string) => {
    const next = new Set(off);
    const nowOff = !next.has(name);
    if (nowOff) next.add(name);
    else next.delete(name);
    setOff(next);
    report.local(
      `${name} shown as ${nowOff ? "disabled" : "enabled"} — on this screen only. Enabling a lane has no field in any config file yet.`,
    );
  };

  return (
    <div className="form-body-content fade-in">
      <div className="form-panel-title">
        Rate-limit buckets · <span className="scope-name-inline">{projectName}</span>
      </div>
      <div className="form-panel-sub">
        Each provider account is one rate-limit bucket — a &ldquo;lane.&rdquo; The factory spreads work across lanes so no
        single account hits its rate limit. A lane appears here because this project&apos;s roster names its provider.
      </div>

      <div className="lane-callout">
        <div className="lc-title">What is a lane?</div>
        <div className="lc-body">
          A lane is one provider account = one rate-limit bucket. If you have one xAI account and one Z.ai account, you
          have two lanes. The factory can run two runs concurrently — one per lane — without either hitting the
          other&apos;s rate limit. Add more provider accounts in the Providers tab to get more lanes.
        </div>
      </div>

      {lanes.error ? <ReadFailure error={lanes.error} /> : null}

      <div className="form-section">
        <div className="form-section-title">
          <span>Active lanes</span>
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
          rows.map((lane) => {
            const enabled = !off.has(lane.name);
            return (
              <div className="lane-row" key={lane.name}>
                <span className="lane-id" title={lane.name}>
                  {lane.name}
                </span>
                <div className="lane-body">
                  <div className="lane-models">
                    <span className="lm-model" title={lane.models.join(", ")}>
                      {lane.models.join(", ")}
                    </span>
                    <span className="lm-agents">
                      {lane.agents.length === 1 ? "agent: " : "agents: "}
                      {lane.agents.join(", ")}
                    </span>
                  </div>
                  <span className="lane-slots">
                    {lane.slots} {lane.slots === 1 ? "slot" : "slots"} ·{" "}
                    {lane.slots_source === "SSSF_LANES" ? "from SSSF_LANES" : "default"}
                  </span>
                  <span className="lane-status idle" title="free slots are the running engine's own count, and this machine has no engine to ask">
                    ○ {lane.free === null ? "no engine here" : `${lane.free} free`}
                  </span>
                </div>
                <button
                  type="button"
                  className={`form-toggle${enabled ? " on" : ""}`}
                  aria-label={`${lane.name} ${enabled ? "enabled" : "disabled"} on this screen`}
                  onClick={() => toggle(lane.name)}
                />
              </div>
            );
          })
        )}

        <p className="section-note">
          Enabling and disabling a lane changes <strong>this screen only</strong> — the lanes endpoint reports{" "}
          <strong>writes_supported: false</strong>, because a lane exists by virtue of the roster naming its provider and
          there is no per-lane switch in any config file yet. A lane&apos;s live state (how many slots are free, whether it
          is in cooldown) belongs to the running engine, which is not this machine.
        </p>
      </div>

      <div className="form-section">
        <div className="form-section-title">
          <span>Balancing</span>
        </div>

        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Max concurrent lanes</div>
            <div className="form-hint">
              The engine&apos;s own cap, set with <code>--lanes</code> / <code>SSSF_LANES</code> on the machine that runs it
            </div>
          </div>
          <select className="form-select compact" disabled value="unknown">
            <option value="unknown">set on the engine&apos;s machine</option>
          </select>
        </div>

        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Slots per lane</div>
            <div className="form-hint">
              How many runs one lane carries at once — the engine&apos;s default, overridable per lane with{" "}
              <code>SSSF_LANES</code>
            </div>
            <div className="form-hint mono">
              SSSF_LANES {lanes.data?.env ? `= ${lanes.data.env}` : "is not set in this process"}
            </div>
          </div>
          <input
            className="form-input"
            type="number"
            style={{ width: 80, minWidth: 80 }}
            value={lanes.data?.slots_default ?? ""}
            disabled
            readOnly
          />
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
              this app, by design.
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
      </div>
    </div>
  );
}
