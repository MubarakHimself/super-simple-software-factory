/**
 * The diff rail (spec 2.5.4): a scope selector, the file list, and nothing
 * that writes.
 *
 * "read-only - no commit/push controls on a factory run. Honest empty: render
 * `resolveDiff`'s own `base` string (`no diff available`), add nothing."
 * That last clause is why there is no empty-state heading here and no
 * sentence explaining why a run has no diff: the server's own string is the
 * whole answer, and every run in this db returns it.
 *
 * ── The scope list, and where it comes from ────────────────────────────────
 * `availableScopes()` lives server-side inside the diff handler and is not
 * exposed by any `/api/app/*` route (flagged to the night's build as a
 * cross-chunk gap). It is derived from the run's commit-log events, which the
 * work log has ALREADY folded and handed us - so the scopes are rebuilt here
 * from the same rows the server derives them from, with the label read off
 * the phase (`03 build`) instead of off the commit event's own name. On this
 * db the question is moot: no run has a commit, so `Whole run` is the only
 * scope and the selector does not render.
 */
import { useMemo, useState } from "react";
import { useResource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { isFactoryAbsent, type DiffResponse, type DiffScope, type PhaseWithBeat, type WorkLogEntry } from "./types.ts";

const WHOLE_RUN: DiffScope = { id: "run", label: "Whole run" };

export function buildScopes(entries: WorkLogEntry[], phases: PhaseWithBeat[]): DiffScope[] {
  const seqByPhase = new Map<string, PhaseWithBeat>();
  for (const p of phases) seqByPhase.set(p.phase_id, p);

  const scopes: DiffScope[] = [WHOLE_RUN];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "commit" || !entry.phase_id || seen.has(entry.phase_id)) continue;
    seen.add(entry.phase_id);
    const phase = seqByPhase.get(entry.phase_id);
    const seq = phase?.seq !== null && phase?.seq !== undefined ? String(phase.seq).padStart(2, "0") : "??";
    scopes.push({ id: entry.phase_id, label: `${seq} ${phase?.name ?? entry.phase_id}` });
  }
  return scopes;
}

export function DiffRail({
  projectId,
  adwId,
  entries,
  phases,
}: {
  projectId: string;
  adwId: string;
  entries: WorkLogEntry[];
  phases: PhaseWithBeat[];
}) {
  const scopes = useMemo(() => buildScopes(entries, phases), [entries, phases]);
  const [scope, setScope] = useState<string>("run");
  const active = scopes.some((s) => s.id === scope) ? scope : "run";
  const [patchOpen, setPatchOpen] = useState(false);

  const { data, error } = useResource<DiffResponse | { factory: "absent" }>(
    `${projectId}|diff|${adwId}|${active}`,
    `/api/app/p/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(adwId)}/diff?scope=${encodeURIComponent(active)}`,
  );
  const diff = data && !isFactoryAbsent(data) ? data : null;

  return (
    <section className="flex h-full min-h-0 flex-col border-l border-hairline bg-chrome">
      <div className="flex h-topbar shrink-0 items-center gap-2 border-b border-hairline px-3">
        <h2 className="text-head font-semibold text-t1">Diff</h2>
        {diff && !diff.empty ? (
          <span className="ml-auto font-mono text-meta">
            <span className="text-ok">+{diff.added}</span> <span className="text-fail">−{diff.deleted}</span>
          </span>
        ) : null}
      </div>

      {scopes.length > 1 ? (
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-hairline px-3 py-2">
          {scopes.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setScope(s.id)}
              className={[
                "h-5 rounded-chip px-2 font-mono text-meta",
                s.id === active ? "bg-accent-surface text-accent" : "text-t3 hover:text-t2",
              ].join(" ")}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? <ReadFailure error={error} /> : null}
        {diff ? (
          <>
            <p className="px-3 py-2 font-mono text-meta text-t3">{diff.base}</p>
            {diff.files.map((file) => (
              <p key={file.path} className="flex items-center gap-2 px-3 py-[3px] font-mono text-mono">
                <span className="min-w-0 flex-1 truncate text-t2" title={file.path}>
                  {file.path}
                </span>
                <span className="shrink-0 text-ok">+{file.added}</span>
                <span className="shrink-0 text-fail">−{file.deleted}</span>
              </p>
            ))}
            {diff.patch ? (
              <>
                <button
                  type="button"
                  onClick={() => setPatchOpen((v) => !v)}
                  className="mt-1 px-3 py-1 font-mono text-meta text-t3 hover:text-t2"
                >
                  {patchOpen ? "hide patch" : "show patch"}
                </button>
                {patchOpen ? (
                  <pre className="mx-3 mb-3 max-h-64 overflow-auto rounded-control border border-hairline bg-raised px-2 py-1 font-mono text-mono text-t2">
                    {diff.patch}
                  </pre>
                ) : null}
                {diff.truncated ? <p className="px-3 pb-2 font-mono text-meta text-warn">patch truncated</p> : null}
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
