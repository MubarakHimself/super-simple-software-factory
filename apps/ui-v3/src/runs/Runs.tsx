/**
 * Runs — run list · detail pane · merge-queue rail (runs-gate-v3.html, J4/J5,
 * change-list #2/#3/#4/#8/#9/#15).
 *
 * Four reads, and each one is read at the cadence its own truth changes at:
 *
 *   runs, cards            2s — the same beat as the shell's live poll
 *   runs/:id, worklog      2s while the run is in flight, once when it is not
 *   runs/:id/diff          once, and only for a run whose diff is on screen
 *   ship/report            ONCE, plus Sync, plus after a ship. It shells
 *                          `uv run adws/ship_report.py`; polling a subprocess
 *                          every two seconds would be a self-inflicted load,
 *                          and the report only changes when the engine parks a
 *                          card or the operator ships one.
 *
 * The cut lives here, as one string: the card name the line is cut at. Every
 * derived thing (which rows are selected, what POST /ship is given, which range
 * the confirm modal previews) is computed from it in model.ts, so there is
 * exactly one source for "what is about to ship".
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useShell } from "../App.tsx";
import { LIVE_INTERVAL_MS, useResource, type Resource } from "../lib/poll.ts";
import { EmptyState, ReadFailure } from "../shell/EmptyState.tsx";
import {
  buildQueueRows,
  buildRunRows,
  cardForRun,
  cooldownSignal,
  cooldownTexts,
  cutIndex,
  cutPayload,
  isFactoryAbsent,
  parkBelow,
  present,
  rangeForCut,
  runStatus,
  selectedCards,
  shipCardFor,
  type QueueRowModel,
} from "./model.ts";
import { buildShipCheckPrompt, type PromptCard } from "./prompt.ts";
import { Detail } from "./Detail.tsx";
import { MergeQueue } from "./MergeQueue.tsx";
import { RunList } from "./RunList.tsx";
import { ShipModal } from "./ShipModal.tsx";
import "./runs.css";
import type {
  CardsResponse,
  DiffResponse,
  FactoryAbsent,
  RunDetail,
  RunsResponse,
  ShipReport,
  ShipResult,
  WorkLogPage,
} from "./types.ts";

/** What this app itself shipped, this session. The card record cannot name a
 * chunk's commit (it only knows the card is in main's tree), so a shipped view
 * says "chunk of N · sha" only for a chunk this app authored, and says plainly
 * that it cannot otherwise. */
interface ShippedChunk {
  names: string[];
  commit: string;
  count: number;
}

export default function Runs() {
  const { projectId, project } = useShell();
  const { adwId } = useParams();
  const navigate = useNavigate();
  const encoded = encodeURIComponent(projectId);

  // The four db-backed reads answer 200 `{factory:"absent"}` for a project
  // with no sssf.db, so each one is read as that union and narrowed by
  // `present()` - "no factory here" and "no runs yet" are different sentences
  // and this surface must never print the second when the first is true.
  const runs = useResource<RunsResponse | FactoryAbsent>(
    `${projectId}|runs`,
    `/api/app/p/${encoded}/runs`,
    LIVE_INTERVAL_MS,
  );
  const runsData = present(runs.data);
  const noFactory = isFactoryAbsent(runs.data);
  const cards = useResource<CardsResponse>(`${projectId}|cards`, `/api/app/p/${encoded}/cards`, LIVE_INTERVAL_MS);
  const report = useResource<ShipReport>(`${projectId}|ship-report`, `/api/app/p/${encoded}/ship/report`);

  // One clock for the whole surface, so every elapsed reading on screen is the
  // same reading.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const [cut, setCut] = useState<string | null>(null);
  const [shipped, setShipped] = useState<ShippedChunk | null>(null);

  const rows = useMemo(
    () => buildRunRows(runsData?.runs ?? [], cards.data?.items ?? [], now),
    [runsData, cards.data, now],
  );

  // No adw id in the path: land on the first row (in flight first) and put it
  // in the URL, so the pane on screen is always a place that can be linked to.
  useEffect(() => {
    const first = rows[0];
    if (!adwId && first) navigate(`/p/${encoded}/runs/${encodeURIComponent(first.adwId)}`, { replace: true });
  }, [adwId, rows, navigate, encoded]);

  const row = useMemo(() => rows.find((candidate) => candidate.adwId === adwId) ?? null, [rows, adwId]);
  // The list's own phases for the selected run, which is what the beat rail
  // falls back to before (or instead of) the per-run detail read. It matters
  // now that the list can hold runs recorded on a MACHINE: `/runs/:adw_id`
  // reads this checkout's db and answers `{factory:"absent"}` for those, so
  // without this the rail would be empty for exactly the runs the operator
  // opened the surface to look at. Detail's own prop already documents this
  // fallback ("the list's own until then"); the call site simply never passed it.
  const listPhases = useMemo(
    () => (row ? (runsData?.runs.find((candidate) => candidate.adw_id === row.adwId)?.phases ?? []) : []),
    [row, runsData],
  );
  const inFlight = row?.status.state === "running" || row?.status.state === "cooldown";
  const wantsDiff = row?.status.state === "integrated" || row?.status.state === "shipped" || row?.status.state === "done";

  // A row the list read off a MACHINE (`row.machine` is the host chip beside
  // it) has its detail, its work log and its diff in THAT machine's record.
  // These three reads are this checkout's only - `/runs/:adw_id` and its two
  // siblings look the id up in the local sssf.db - so asking them about such a
  // run answers a bare 404 "no run <id>" on any laptop that holds an sssf.db of
  // its own, and the pane would print that as a read failure THREE TIMES over
  // (detail, work log, diff) about a run that is running perfectly well four
  // thousand kilometres away. So they are not asked. The pane already has the
  // list's own phases for the beat rail and a "this stays on <host>" sentence
  // for the bodies, which is the truth rather than an alarm.
  const local = row && !row.machine ? row : null;

  const detail = useResource<RunDetail | FactoryAbsent>(
    local ? `${projectId}|run|${local.adwId}` : null,
    local ? `/api/app/p/${encoded}/runs/${encodeURIComponent(local.adwId)}` : null,
    inFlight ? LIVE_INTERVAL_MS : undefined,
  );
  const worklog = useResource<WorkLogPage | FactoryAbsent>(
    local ? `${projectId}|worklog|${local.adwId}` : null,
    local ? `/api/app/p/${encoded}/runs/${encodeURIComponent(local.adwId)}/worklog` : null,
    inFlight ? LIVE_INTERVAL_MS : undefined,
  );
  const diff = useResource<DiffResponse | FactoryAbsent>(
    local && wantsDiff ? `${projectId}|diff|${local.adwId}` : null,
    local && wantsDiff ? `/api/app/p/${encoded}/runs/${encodeURIComponent(local.adwId)}/diff` : null,
  );
  const detailData = present(detail.data);
  const worklogData = present(worklog.data);
  const diffView: Resource<DiffResponse> = { ...diff, data: present(diff.data) };
  const worklogView: Resource<WorkLogPage> = { ...worklog, data: worklogData };

  // The list decides a run's state from the phases it already carries; the pane
  // can do better, because it has the run's work log open in front of it - a
  // rate limit recorded there and nowhere else still reads as cooldown here.
  const status = useMemo(() => {
    if (!row) return null;
    const run = runsData?.runs.find((candidate) => candidate.adw_id === row.adwId);
    if (!run) return row.status;
    const phases = detailData?.phases ?? run.phases;
    const cooldown =
      run.status === "running" ? cooldownSignal(cooldownTexts(phases, worklogData?.entries ?? [])) : null;
    return runStatus(run, cardForRun(cards.data?.items ?? [], run.adw_id), cooldown);
  }, [row, runsData, detailData, worklogData, cards.data]);

  /* ── the merge queue and the cut ─────────────────────────────────────── */

  const queueRows = useMemo(
    () => buildQueueRows(report.data?.cards ?? [], cards.data?.items ?? [], rows),
    [report.data, cards.data, rows],
  );
  const index = cutIndex(report.data?.cards ?? [], cut);
  const chunk = useMemo(() => selectedCards(report.data?.cards ?? [], index), [report.data, index]);
  const chunkRows = index < 0 ? [] : queueRows.slice(0, index + 1);

  // A report re-read (a Sync, a ship, a newly parked card) can retire the card
  // the cut named. Rather than ship something the operator did not point at,
  // the cut is dropped and the rail goes back to nothing selected.
  useEffect(() => {
    if (cut && report.data && cutIndex(report.data.cards, cut) === -1) setCut(null);
  }, [cut, report.data]);

  const shipCard = shipCardFor(report.data ?? null, row?.card?.name);

  // Park for later = lower the cut below THIS card (change-list #3). It is
  // offered only for a card the current report actually holds - parking a card
  // that is not in the line would move a cut nothing points at.
  const queue = report.data;
  const parkTarget = row?.card?.name ?? null;
  const park =
    queue && parkTarget && cutIndex(queue.cards, parkTarget) >= 0
      ? () => setCut(parkBelow(queue.cards, parkTarget))
      : null;

  /* ── the /ship-check handoff ─────────────────────────────────────────── */

  const promptCards: PromptCard[] = useMemo(() => {
    const source = index >= 0 ? chunk : (report.data?.cards ?? []);
    return source.map((card) => ({
      name: card.name,
      title: card.title,
      adwId: cards.data?.items.find((item) => item.name === card.name)?.adw_id ?? null,
      sha: card.sha,
    }));
  }, [index, chunk, report.data, cards.data]);

  const prompt = useMemo(
    () =>
      buildShipCheckPrompt({
        projectName: project?.name ?? projectId,
        projectRoot: project?.root ?? "the repo this app is pointed at",
        range: index >= 0 && report.data ? (rangeForCut(report.data, index) ?? report.data.range) : (report.data?.range ?? null),
        reportReason: report.data && !report.data.available ? report.data.reason : (report.error ?? null),
        cards: promptCards,
        cutName: cut,
        run: row && status ? { adwId: row.adwId, title: row.title, sentence: status.sentence } : null,
      }),
    [project, projectId, index, report.data, report.error, promptCards, cut, row, status],
  );

  /* ── the one write ───────────────────────────────────────────────────── */

  const payload = report.data ? cutPayload(report.data.cards, index) : null;

  // What the confirm modal is asking about is FROZEN when it opens, not
  // re-derived while it is open. Two reasons, both load-bearing: the operator
  // must confirm exactly the chunk he was shown (a report re-read underneath
  // an open modal would silently change what the button does), and after the
  // ship the cut is cleared - a live-derived modal would unmount itself at the
  // exact moment it has the result to report.
  const [pending, setPending] = useState<{
    cut: string;
    cards: QueueRowModel[];
    range: string | null;
    previewRange: string | null;
    markdown: string | null;
  } | null>(null);

  const openConfirm = () => {
    if (!payload || !report.data) return;
    setPending({
      cut: payload,
      cards: chunkRows,
      range: rangeForCut(report.data, index) ?? report.data.range,
      previewRange: payload === "all" ? null : rangeForCut(report.data, index),
      markdown: report.data.markdown,
    });
  };

  const onShipped = (result: ShipResult) => {
    setShipped({ names: result.cards, commit: result.commit, count: result.cards.length });
    setCut(null);
    report.refresh();
    cards.refresh();
    runs.refresh();
  };

  const shippedChunk =
    row?.card && shipped && shipped.names.includes(row.card.name)
      ? { commit: shipped.commit, count: shipped.count }
      : null;

  return (
    <>
      <RunList
        rows={rows}
        selectedAdwId={row?.adwId ?? null}
        onSelect={(id) => navigate(`/p/${encoded}/runs/${encodeURIComponent(id)}`)}
        hiddenSelfChecks={runsData?.hidden_self_checks ?? 0}
        error={runs.error}
        loading={runs.loading}
        factoryAbsent={noFactory}
        source={runsData?.source ?? null}
      />

      {row && status ? (
        <Detail
          row={row}
          status={status}
          phases={detailData?.phases ?? listPhases}
          branch={detailData?.branch ?? null}
          runStart={detailData?.session.started_at ?? null}
          detailError={detailData ? null : detail.error}
          worklog={worklogView}
          diff={diffView}
          shipCard={shipCard}
          onPark={park}
          shippedChunk={shippedChunk}
          prompt={prompt}
        />
      ) : (
        <div className="detail-pane">
          {runs.error && !runsData ? (
            <EmptyState heading="Runs unread" sentence="The run record could not be read on this machine.">
              <ReadFailure error={runs.error} />
            </EmptyState>
          ) : adwId && rows.length > 0 ? (
            <EmptyState
              heading="Run not listed"
              sentence={`This project's record holds no run ${adwId} — it may have been recorded on another machine.`}
            />
          ) : noFactory ? (
            <EmptyState
              heading="No factory record"
              sentence="There is no sssf.db in this project, so no run can be read here. The merge queue on the right still reads git."
            />
          ) : (
            <EmptyState
              heading="No run selected"
              sentence="Runs appear here as the engine picks up ready cards; nothing on this surface dispatches one."
            />
          )}
        </div>
      )}

      <MergeQueue
        rows={queueRows}
        report={report.data}
        reportError={report.data ? null : report.error}
        loading={report.loading}
        cutName={cut}
        onCut={setCut}
        highlightAdwId={row?.adwId ?? null}
        onMerge={openConfirm}
        busy={pending !== null}
      />

      {pending ? (
        <ShipModal
          projectId={projectId}
          cut={pending.cut}
          cards={pending.cards}
          range={pending.range}
          previewRange={pending.previewRange}
          fallbackMarkdown={pending.markdown}
          onCancel={() => setPending(null)}
          onShipped={onShipped}
        />
      ) : null}
    </>
  );
}
