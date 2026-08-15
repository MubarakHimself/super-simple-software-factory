/**
 * Home — the arrival surface (docs/user-journeys.md J5 step 1;
 * docs/design/ui-v3-mocks/home-v2.html).
 *
 * Two pieces:
 *   1. THE SHIPPING REPORT - "Shipping report" (change-list #1: this label
 *      was "Morning Brief" in the mock; the morning-brief *skill* is retired
 *      from the flow, so that string appears nowhere below), the question
 *      "Is this what we agreed?", `ship_report.py`'s own markdown shown as
 *      text (never re-narrated - a second summary of the summary is a second
 *      place for the two to disagree), and the CTA into Runs.
 *   2. Run groups - Running / Lane cooldown / In merge queue / Integrated /
 *      Shipped / Failed / Blocked, each reflecting one real state from
 *      `/cards` (server/app/cards.ts's own lifecycle:
 *      ready -> running -> blocked -> done -> integrated -> shipped) or
 *      `/runs` (a run's own `fail`, which no card state carries), plus the
 *      shell's already-shared `/live` for the Running group's live detail.
 *      A group renders only when it has a row - an empty bucket is not shown
 *      empty, it is simply not shown (the mock's own "no fifth state").
 *
 * Every row's meta line is the server's own `state_reason` (cards) or a
 * sentence built only from fields the API actually returned (runs/live) -
 * nothing here is invented text standing in for a friendlier version of the
 * record.
 */
import { Link } from "react-router-dom";
import { useState } from "react";
import { useShell } from "../App.tsx";
import { formatUptime } from "../lib/format.ts";
import { useResource, type Resource } from "../lib/poll.ts";
import { Dot, type Tone } from "../shared/Dot.tsx";
import { BookmarkIcon } from "../shared/Icons.tsx";
import { EmptyState, ReadFailure } from "../shell/EmptyState.tsx";
import type { CardsPayload, HomeCard, HomeLiveRun, HomeSession, RunsPayload, ShipReportPayload } from "./types.ts";
import "./home.css";

function greetingText(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Good night.";
  if (hour < 12) return "Good morning.";
  if (hour < 17) return "Good afternoon.";
  if (hour < 22) return "Good evening.";
  return "Good night.";
}

function runPath(projectId: string, adwId: string): string {
  return `/p/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(adwId)}`;
}

function runsPath(projectId: string): string {
  return `/p/${encodeURIComponent(projectId)}/runs`;
}

function secondsSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, (Date.now() - then) / 1000);
}

/** formatUptime degrades to minutes past a minute and to hours past an hour -
 * the same coarseness the sidebar's own uptime line already uses, so an
 * elapsed run and the factory's own uptime read the same way. */
function elapsedText(iso: string | null): string | null {
  const sec = secondsSince(iso);
  return sec === null ? null : `${formatUptime(sec)} elapsed`;
}

function agoText(iso: string | null): string | null {
  const sec = secondsSince(iso);
  return sec === null ? null : `${formatUptime(sec)} ago`;
}

interface Row {
  key: string;
  tone: Tone;
  pulse?: boolean;
  title: string;
  meta: string;
  to: string;
}

function cardRow(card: HomeCard, tone: Tone, projectId: string): Row {
  return {
    key: card.name,
    tone,
    title: card.title,
    // The server's own sentence for this state (cards.ts's `state_reason`) -
    // already the one honest line a row needs, so it is shown verbatim.
    meta: card.state_reason,
    to: card.adw_id ? runPath(projectId, card.adw_id) : runsPath(projectId),
  };
}

function runningRow(run: HomeLiveRun, projectId: string): Row {
  const parts = [run.phase?.name, elapsedText(run.started_at), run.model ?? run.coding_agent].filter(
    (part): part is string => Boolean(part),
  );
  return {
    key: run.adw_id,
    tone: "run",
    pulse: true,
    title: run.title ?? run.adw_name ?? run.adw_id,
    meta: parts.length > 0 ? parts.join(" · ") : "running",
    to: runPath(projectId, run.adw_id),
  };
}

function failedRow(session: HomeSession, projectId: string): Row {
  const parts = ["failed", session.adw_name, agoText(session.ended_at ?? session.started_at)].filter(
    (part): part is string => Boolean(part),
  );
  return {
    key: session.adw_id,
    tone: "fail",
    title: session.title ?? session.adw_name ?? session.adw_id,
    meta: parts.join(" · "),
    to: runPath(projectId, session.adw_id),
  };
}

const byName = (a: HomeCard, b: HomeCard) => a.name.localeCompare(b.name);

function sessionTime(s: HomeSession): number {
  const iso = s.ended_at ?? s.started_at;
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
}
const byRecency = (a: HomeSession, b: HomeSession) => sessionTime(b) - sessionTime(a);

function ShippingReport({ projectId, ship }: { projectId: string; ship: Resource<ShipReportPayload> }) {
  const data = ship.data;
  return (
    <div className="brief-prompt">
      <div className="label">Shipping report</div>
      <p className="question">Is this what we agreed?</p>
      {data?.available && !data.empty ? (
        <p className="summary plain">{data.markdown}</p>
      ) : data?.available && data.empty ? (
        <p className="summary">Nothing to ship yet — the factory hasn't integrated new work since the last chunk</p>
      ) : data && !data.available ? (
        <p className="summary">{data.reason ?? "the shipping report could not be produced"}</p>
      ) : null}
      {ship.error ? <ReadFailure error={ship.error} /> : null}
      <Link className="primary-cta" to={runsPath(projectId)}>
        <BookmarkIcon />
        Review merge queue
      </Link>
    </div>
  );
}

/**
 * A project with nothing to show. The mock fills this screen with sample runs;
 * a real one has to say which KIND of nothing this is, because the three have
 * different next moves and only one of them is the operator's:
 *
 *   · no factory in the folder  -> nothing can run here at all, yet
 *   · cards are ready           -> the factory picks them up by itself
 *   · no cards                  -> publishing a batch is what fills the Board
 *
 * Never "no data yet" on its own, and never a fabricated row.
 */
function NothingYet({ projectId, factoryAbsent, readyCount }: { projectId: string; factoryAbsent: boolean; readyCount: number }) {
  const boardPath = `/p/${encodeURIComponent(projectId)}/board`;
  if (factoryAbsent) {
    return (
      <div className="home-empty">
        <EmptyState
          heading="No factory here"
          sentence="This project has no adws/ in it yet, so there is nothing for the engine to run — the factory installer is what puts the roster, the queue seam and the config in place."
        />
      </div>
    );
  }
  if (readyCount > 0) {
    return (
      <div className="home-empty">
        <EmptyState
          heading="Nothing running"
          sentence={`${readyCount} ${readyCount === 1 ? "card is" : "cards are"} ready. The factory picks them up by itself when a lane frees up — there is no dispatch button anywhere.`}
        >
          <Link className="es-action" to={boardPath}>
            Open the Board
          </Link>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="home-empty">
      <EmptyState
        heading="Nothing queued yet"
        sentence="Publish a batch from your planning session — the cards land on the Board and the factory starts on its own."
      >
        <Link className="es-action" to={boardPath}>
          Open the Board
        </Link>
      </EmptyState>
    </div>
  );
}

function RunGroup({ header, tone, pulse, rows }: { header: string; tone: Tone; pulse?: boolean; rows: Row[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="run-group">
      <div className="run-group-header">
        <Dot tone={tone} pulse={pulse} />
        <h2>{header}</h2>
        <span className="count">{rows.length}</span>
      </div>
      {rows.map((row) => (
        <Link key={row.key} className="run-summary" to={row.to}>
          <Dot tone={row.tone} pulse={row.pulse} />
          <div className="run-summary-body">
            <div className="run-summary-title">{row.title}</div>
            <div className="run-summary-meta">{row.meta}</div>
          </div>
        </Link>
      ))}
    </section>
  );
}

export default function Home() {
  const { projectId, live } = useShell();
  const [greeting] = useState(greetingText);

  const ship = useResource<ShipReportPayload>(`${projectId}|ship-report`, `/api/app/p/${encodeURIComponent(projectId)}/ship/report`);
  const cardsRes = useResource<CardsPayload>(`${projectId}|cards`, `/api/app/p/${encodeURIComponent(projectId)}/cards`);
  const runsRes = useResource<RunsPayload>(`${projectId}|runs`, `/api/app/p/${encodeURIComponent(projectId)}/runs`);

  const items = cardsRes.data?.items ?? [];
  const doneCards = items.filter((c) => c.state === "done").sort(byName);
  const integratedCards = items.filter((c) => c.state === "integrated").sort(byName);
  const shippedCards = items.filter((c) => c.state === "shipped").sort(byName);
  const blockedCards = items.filter((c) => c.state === "blocked").sort(byName);

  // `/live` and `/runs` both 200 `{factory:"absent"}` (scoped.ts) when this
  // project has no factory installed - neither key exists on that shape, so
  // the Array.isArray guard reads as "no runs to show" rather than crashing.
  const rawRunning = live.data?.running;
  const runningRuns = Array.isArray(rawRunning) ? (rawRunning as unknown as HomeLiveRun[]) : [];
  const rawRuns = runsRes.data?.runs;
  const sessions = Array.isArray(rawRuns) ? rawRuns : [];
  const failedSessions = sessions.filter((s) => s.status === "fail").sort(byRecency);

  // Every group is empty and no read failed: this project genuinely has
  // nothing to show, and Home says which kind of nothing it is rather than
  // rendering a page of headings with no rows under them.
  const nothingToShow =
    runningRuns.length === 0 &&
    doneCards.length === 0 &&
    integratedCards.length === 0 &&
    shippedCards.length === 0 &&
    blockedCards.length === 0 &&
    failedSessions.length === 0;
  const settled = !cardsRes.loading && !runsRes.loading && !cardsRes.error && !runsRes.error;
  const factoryAbsent = runsRes.data?.factory === "absent";
  const readyCount = items.filter((card) => card.state === "ready").length;

  return (
    <div className="home-scroll">
      <div className="home-content fade-in">
        <div className="home-hero">
          <h1>{greeting}</h1>
        </div>

        <ShippingReport projectId={projectId} ship={ship} />

        {cardsRes.error ? <ReadFailure error={cardsRes.error} /> : null}
        {runsRes.error ? <ReadFailure error={runsRes.error} /> : null}

        <RunGroup header="Running" tone="run" pulse rows={runningRuns.map((r) => runningRow(r, projectId))} />

        {/* Lane cooldown: no backend signal exists yet for a rate-limited lane
            pause (docs/user-journeys.md change-list #9 - auto-resume is v1,
            the balancer round that would report cooldown is not built). This
            group is wired and in the right place; it stays empty rather than
            invent a state the engine has not reported. */}
        <RunGroup header="Lane cooldown" tone="warn" rows={[]} />

        {/* The lifecycle is the server's (app/cards.ts): `done` = the run
            pushed its own branch and the engine has not integrated it yet, so
            it is NOT parked in queue/done/ and ship_report.py cannot see it -
            it is not in the merge queue. `integrated` = parked on the working
            line, waiting for the next ship - that IS what the Runs rail lists
            (J5.2). Naming them the other way round made this screen disagree
            with the rail's count and with each row's own state sentence. */}
        <RunGroup header="Waiting to integrate" tone="ok" rows={doneCards.map((c) => cardRow(c, "ok", projectId))} />
        <RunGroup header="In merge queue" tone="ok" rows={integratedCards.map((c) => cardRow(c, "ok", projectId))} />
        <RunGroup header="Shipped" tone="ok" rows={shippedCards.map((c) => cardRow(c, "ok", projectId))} />
        <RunGroup header="Failed" tone="fail" rows={failedSessions.map((s) => failedRow(s, projectId))} />
        <RunGroup header="Blocked" tone="warn" rows={blockedCards.map((c) => cardRow(c, "warn", projectId))} />

        {nothingToShow && settled ? (
          <NothingYet projectId={projectId} factoryAbsent={factoryAbsent} readyCount={readyCount} />
        ) : null}
      </div>
    </div>
  );
}
