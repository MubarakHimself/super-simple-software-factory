/**
 * Lanes (per project) — J6.2 and change-list #5.
 *
 * A lane is one PROVIDER ACCOUNT: one rate-limit bucket, one quota pool. It is
 * not a model family. Reads `GET /api/app/p/:id/lanes`, which derives a lane
 * the way `engine.py:roster_lanes` does — the distinct provider prefixes of the
 * roster's `provider/model` strings and of `router.builder_pool`.
 *
 * WRITES: per-lane `slots`, into the config's optional `lanes:` block, via
 * `POST /api/app/p/:id/config/lanes` — one lane at a time, the block replaced,
 * the rest of the document proved byte-identical, the previous file kept
 * beside it. `engine.py:config_lanes` reads it; `--lanes` / `$SSSF_LANES` win.
 *
 * DRAWS NOTHING for the on/off switch. `engine.py` reads `slots` out of that
 * block and nothing else, so `enabled: false` keeps taking dispatches. An
 * earlier build drew the switch disabled with five lines of apology beside it;
 * the operator's verdict was that the apology was the problem. A dead control
 * is now simply absent, and the one case that still matters — a config file an
 * older build wrote `enabled: false` into — is raised as an alert instead.
 *
 * Also absent, for the same reason: the retry-budget field (no backend), the
 * always-on auto-pick toggle (nothing to switch) and "reviewer gets its own
 * lane" (no field in any config file). Nothing that could be written was cut.
 */
import { useCallback, useState } from "react";
import { useShell } from "../App.tsx";
import { apiPost } from "../lib/api.ts";
import type { Resource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { Alert, HowThisWorks } from "./notices.tsx";
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
  const { projectId } = useShell();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const { refresh } = lanes;
  const write = useCallback(
    async (body: { lane: string; slots?: number | null }, what: string) => {
      setBusy(body.lane);
      setFailure(null);
      report.saving(what);
      try {
        const result = await apiPost<LaneEditResult>(`/api/app/p/${encodeURIComponent(projectId)}/config/lanes`, body);
        report.saved(`${result.changed.join(" · ")} — the previous file is at ${result.backup}`);
        refresh();
      } catch (caught) {
        const message = (caught as Error).message;
        report.failed(what, message);
        setFailure(`${what} was not saved — ${message}`);
      } finally {
        setBusy(null);
      }
    },
    [projectId, refresh, report],
  );

  const rows = lanes.data?.lanes ?? [];
  const slotsDefault = lanes.data?.slots_default ?? 2;
  /** A file an older build wrote `enabled: false` into. The engine ignores it,
   * so the pane says so once, where a mistake is actually being made. */
  const disabledInFile = rows.filter((lane) => !lane.enabled).map((lane) => lane.name);

  return (
    <div className="form-body-content fade-in">
      <div className="form-panel-title">
        Rate-limit buckets · <span className="scope-name-inline">{projectName}</span>
      </div>
      <div className="form-panel-sub">One provider account is one lane, and work spreads across them.</div>

      {lanes.error ? <ReadFailure error={lanes.error} /> : null}
      {failure ? <Alert onDismiss={() => setFailure(null)}>{failure}</Alert> : null}

      {disabledInFile.length > 0 ? (
        <Alert kind="warn">
          <strong>{disabledInFile.join(", ")}</strong> {disabledInFile.length === 1 ? "is" : "are"} written{" "}
          <code>enabled: false</code> in the config, but the engine reads only <code>slots</code> — work still goes there.
          Take the model out of the roster or the builder pool to stop it.
        </Alert>
      ) : null}

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
                ? "The lanes read failed."
                : (lanes.data?.reason ?? "No lanes — this project's roster names no provider.")}
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

                    <label className="lane-slots-edit" title="How many runs this one account carries at the same time">
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
                    </label>

                    <span className="lse-source">
                      {lane.slots_config === null ? (
                        `default ${slotsDefault}`
                      ) : (
                        <button
                          type="button"
                          className="rt-clear"
                          disabled={busy !== null}
                          title={`Take this lane out of the lanes: block so it runs at the engine's default of ${slotsDefault}`}
                          onClick={() => void write({ lane: lane.name, slots: null }, `${lane.name}'s slots`)}
                        >
                          use the default
                        </button>
                      )}
                    </span>

                    <span
                      className="lane-status idle"
                      title="Free slots are the running engine's own count, and the engine does not run on this machine"
                    >
                      ○ {lane.free === null ? "no engine here" : `${lane.free} free`}
                    </span>
                    {saving ? <span className="rt-busy">saving…</span> : null}
                  </div>

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
      </div>

      <div className="form-section">
        <div className="form-section-title">
          <span>Balancing</span>
        </div>

        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Max concurrent runs</div>
            <div className="form-hint" title="--lanes / SSSF_LANES is a startup argument of the running engine service, not a field in any file this app can reach">
              The engine&apos;s cap across all lanes, set where the service runs
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
            <div className="form-hint">Set per lane above; an unnamed lane runs at this default</div>
          </div>
          <span className="honest-value">
            {slotsDefault}
            <span className="hv-note">the engine&apos;s default</span>
          </span>
        </div>

        <HowThisWorks>
          <p>
            Slots are written into the <strong>lanes:</strong> block of{" "}
            <code>{lanes.data?.config_path ?? "this project's config"}</code>, one lane at a time, with the previous file
            kept beside it. The engine reads them; <code>--lanes</code> / <code>SSSF_LANES</code> still win.
          </p>
          <p>
            The engine reads <strong>slots</strong> out of that block and nothing else — there is no way to switch a lane
            off from a file, so this pane does not draw a switch. To stop work reaching an account, take its model out of
            the roster or the builder pool.
          </p>
          <p>
            How many slots are free right now, and whether a lane is in cooldown, belongs to the running engine — which
            is not this machine.
            {lanes.data?.writes_reason ? ` ${lanes.data.writes_reason}` : ""}
          </p>
        </HowThisWorks>
      </div>
    </div>
  );
}
