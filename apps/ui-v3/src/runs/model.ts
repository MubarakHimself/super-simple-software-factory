/**
 * Runs' whole derivation layer: every rule that turns three server reads (runs,
 * cards, the shipping report) into what a row, a beat rail, a banner or the cut
 * point says. Pure functions, no React, no fetch - so the rules are testable
 * (model.test.ts) and so no component can quietly grow a second version of one.
 *
 * Two rules run through all of it:
 *
 *   1. Nothing is invented. A state this data cannot support is `unknown` with
 *      the reason the server itself gave; a field the record does not carry
 *      (a machine name today) comes back null and the chip simply does not
 *      render. There is no placeholder anywhere in this file.
 *   2. States come from whoever owns them. `running`/`failed` are the run's own
 *      (sssf.db); `blocked`/`integrated`/`shipped` are the CARD's (queue/ +
 *      git), and their sentence is the server's `state_reason`, quoted, not
 *      paraphrased.
 */
import type { Tone } from "../shared/Dot.tsx";
import type { CardItem, FactoryAbsent, RunPhase, RunsSource, RunSummary, ShipCard, ShipReport, WorkLogEntry } from "./types.ts";

/** What the left column, the detail pane and the badges all switch on.
 * `cooldown` is a run state the record has to earn (see cooldownSignal). */
export type RunState = "running" | "cooldown" | "blocked" | "failed" | "integrated" | "shipped" | "done" | "unknown";

export interface RunStatus {
  state: RunState;
  tone: Tone;
  /** one plain sentence - the third part of the status triple */
  sentence: string;
  /** the row's second line: short, mono, factual */
  step: string;
  /** for cooldown/blocked/failed: the record's own words, verbatim */
  evidence: string | null;
}

/* ── "there is no factory here" ─────────────────────────────────────────── */

/** True for the 200 `{"factory":"absent"}` a db-backed read gives a project
 * that has no `sssf.db` yet. Narrowing it here (rather than letting it fall
 * through as an object with no `runs` key) is what keeps "this project has no
 * factory record" from rendering as the very different "no runs yet". */
export function isFactoryAbsent(data: unknown): data is FactoryAbsent {
  return typeof data === "object" && data !== null && (data as FactoryAbsent).factory === "absent";
}

/** The payload of a db-backed read, or null when what came back was the
 * factory-absent answer - so a caller holds either real data or nothing. */
export function present<T>(data: T | FactoryAbsent | null): T | null {
  return data === null || isFactoryAbsent(data) ? null : data;
}

/* ── lanes, models, machines ────────────────────────────────────────────── */

/** One provider account = one lane = one quota pool: the lane is the provider
 * half of a roster `provider/model` string. A model string with no provider
 * half names no lane, and this returns null rather than guessing one. */
export function laneOf(model: string | null | undefined): string | null {
  if (!model) return null;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : null;
}

/** The model half of a `provider/model` string - the lane is the other half.
 * A model string with no provider prefix is already just a model name. */
export function modelName(model: string | null | undefined): string | null {
  if (!model) return null;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

/** The model a row should name: the agent owning the open phase, falling back
 * to the run's last agent - the same choice the server's own `/live` makes. */
export function modelOf(run: RunSummary): string | null {
  const open = openPhase(run.phases);
  const byOwner = open?.owner ? run.agents.find((agent) => agent.agent === open.owner) : undefined;
  const active = byOwner ?? run.agents[run.agents.length - 1];
  return active?.model ?? null;
}

/**
 * The machine chip, "when known". No table in `sssf.db` records which machine
 * ran a run, so a row read out of a LOCAL db still returns null here and the
 * chip does not render - guessing "it must be the machine holding the db"
 * would be a fabricated fact.
 *
 * What changed is that rows can now arrive from a machine: `/runs` falls back
 * to reading a registered server's own sssf.db over SSH, and stamps each row
 * it fetched with `machine: "on <host>"`. That is exactly the case this
 * function was written for ("the moment run records arrive over the server
 * connection carrying one the chip appears with no other change anywhere"),
 * and it needed no edit to serve it.
 */
export function machineOf(run: RunSummary): string | null {
  const record = run as unknown as { machine?: unknown; host?: unknown; hostname?: unknown };
  for (const value of [record.machine, record.host, record.hostname]) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/* ── phases and the beat rail ───────────────────────────────────────────── */

/** Phases in the record's own order: by `seq` when it has one, otherwise as
 * stored. Never a fixed five - the chains differ and the record is the truth
 * (docs/user-journeys.md, change #8). */
export function orderedPhases(phases: RunPhase[]): RunPhase[] {
  return [...phases].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/** Started, not ended - the phase happening right now. Later rows win, which
 * is how a retried phase reads as the live one. */
export function openPhase(phases: RunPhase[]): RunPhase | null {
  const ordered = orderedPhases(phases);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const phase = ordered[i]!;
    if (phase.started_at && !phase.ended_at) return phase;
  }
  return null;
}

export type BeatState = "done" | "active" | "failed" | "pending";

export interface BeatStep {
  key: string;
  label: string;
  state: BeatState;
}

/**
 * The beat rail, rendered from the run's ACTUAL phase list. A run whose record
 * holds no phases gets no rail at all (the caller renders nothing) rather than
 * five empty circles that would imply a chain nobody ran.
 */
export function beatSteps(phases: RunPhase[]): BeatStep[] {
  return orderedPhases(phases).map((phase) => {
    const label = phase.beat ?? phase.name ?? phase.owner ?? "phase";
    let state: BeatState = "pending";
    if (phase.status === "fail") state = "failed";
    else if (phase.ended_at) state = "done";
    else if (phase.started_at) state = "active";
    return { key: phase.phase_id, label, state };
  });
}

/** "phase 3 of 5 · review" - the position of the open phase, or of the last
 * one that ran when nothing is open. Empty string when there are no phases. */
export function phaseLabel(phases: RunPhase[]): string {
  const ordered = orderedPhases(phases);
  if (ordered.length === 0) return "";
  const open = openPhase(phases);
  const index = open ? ordered.findIndex((phase) => phase.phase_id === open.phase_id) : ordered.length - 1;
  const phase = ordered[index]!;
  const name = phase.name ?? phase.owner ?? "phase";
  return `phase ${index + 1} of ${ordered.length} · ${name}`;
}

/** The phase a failure happened in, for "failed in the test phase". */
export function failedPhase(phases: RunPhase[]): RunPhase | null {
  return orderedPhases(phases).find((phase) => phase.status === "fail") ?? null;
}

/* ── cooldown: a state the record has to earn ───────────────────────────── */

/** The vocabulary a rate-limited lane leaves behind. The engine does not write
 * a cooldown state today, so cooldown is only ever claimed when the run's own
 * record says one of these words - and the matched text is shown verbatim as
 * the banner's evidence. No match, no cooldown view, ever. */
const COOLDOWN_PATTERN =
  /(rate[-\s]?limit(?:ed|ing|s)?|too many requests|\b429\b|quota (?:exhausted|exceeded|reached)|cool[-\s]?down)/i;

/** The first recorded line that says the lane is rate-limited, verbatim; null
 * when nothing in the record says it. */
export function cooldownSignal(texts: (string | null | undefined)[]): string | null {
  for (const text of texts) {
    if (typeof text === "string" && text.trim() !== "" && COOLDOWN_PATTERN.test(text)) return text.trim();
  }
  return null;
}

/** Everything in a run's record that could carry the words: phase errors, then
 * the work log's own log/error rows (newest first - the pause is recent). */
export function cooldownTexts(phases: RunPhase[], entries: WorkLogEntry[]): (string | null)[] {
  const fromLog: (string | null)[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.kind === "error") fromLog.push(entry.detail ?? null);
    else if (entry.kind === "log") fromLog.push(entry.text ?? null);
  }
  return [...orderedPhases(phases).map((phase) => phase.error), ...fromLog];
}

/* ── the run's state ────────────────────────────────────────────────────── */

/**
 * The one place a run's state is decided.
 *
 * The run owns `running`, `cooldown` and `failed`; the card owns everything
 * after the run stops - `blocked` (the engine could not integrate it),
 * `integrated` (on the working line, in the merge queue) and `shipped` (inside
 * a chunk squash on main). Where the card has a sentence for it, that sentence
 * is the server's `state_reason` and is used unchanged.
 */
export function runStatus(run: RunSummary, card: CardItem | null, cooldown: string | null): RunStatus {
  if (run.status === "running") {
    if (cooldown) {
      return {
        state: "cooldown",
        tone: "warn",
        sentence: "paused — the lane hit its rate limit; the factory auto-resumes when it clears",
        step: "lane cooldown",
        evidence: cooldown,
      };
    }
    return {
      state: "running",
      tone: "run",
      sentence: "running — the factory is working this card",
      step: phaseLabel(run.phases) || "running",
      evidence: null,
    };
  }

  if (card?.state === "blocked") {
    return {
      state: "blocked",
      tone: "fail",
      sentence: card.state_reason,
      step: "blocked",
      evidence: card.blocked_reason,
    };
  }

  if (run.status === "fail") {
    const failed = failedPhase(run.phases);
    return {
      state: "failed",
      tone: "fail",
      sentence: failed?.name ? `the run failed in the ${failed.name} phase` : "the run failed",
      step: failed?.name ? `failed · ${failed.name}` : "failed",
      evidence: failed?.error ?? null,
    };
  }

  if (card?.state === "shipped") {
    return { state: "shipped", tone: "ok", sentence: card.state_reason, step: "shipped", evidence: null };
  }
  if (card?.state === "integrated") {
    return { state: "integrated", tone: "ok", sentence: card.state_reason, step: "in the merge queue", evidence: null };
  }
  if (run.status === "success") {
    return {
      state: "done",
      tone: "ok",
      sentence: card
        ? card.state_reason
        : "the run finished; no card in queue/ names this run, so this app cannot say where it landed",
      step: "finished",
      evidence: null,
    };
  }

  return {
    state: "unknown",
    tone: "neutral",
    sentence: "this run's record carries no status this app can read",
    step: "no status",
    evidence: null,
  };
}

/** The run's human name, in the order the record can honestly supply it. */
export function runTitle(run: RunSummary, card: CardItem | null): string {
  const candidates = [run.title, card?.title, run.request, run.adw_name];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return run.adw_id;
}

/* ── the left column's rows ─────────────────────────────────────────────── */

export interface RunRowModel {
  adwId: string;
  title: string;
  status: RunStatus;
  /** the provider account this run draws on, when its model names one */
  lane: string | null;
  model: string | null;
  machine: string | null;
  /** elapsed while running, "2h ago" once it stopped */
  clock: string;
  card: CardItem | null;
}

/**
 * The left column, assembled once so every row asks the same questions in the
 * same order. Runs in flight sort to the top (that is what the operator opened
 * the surface to see); everything else follows newest-first.
 *
 * Cooldown here is decided from the phases the list already carries - a run
 * whose open phase recorded the rate limit reads as cooldown in the list too,
 * and one whose evidence only exists deeper in its work log reads as running
 * until it is opened. Both are honest about what this list actually knows.
 */
export function buildRunRows(runs: RunSummary[], cards: CardItem[], now: number): RunRowModel[] {
  const rows = runs.map((run) => {
    const card = cardForRun(cards, run.adw_id);
    const cooldown = run.status === "running" ? cooldownSignal(orderedPhases(run.phases).map((phase) => phase.error)) : null;
    const model = modelOf(run);
    return {
      adwId: run.adw_id,
      title: runTitle(run, card),
      status: runStatus(run, card, cooldown),
      lane: laneOf(model),
      model,
      machine: machineOf(run),
      clock: runClock(run, now),
      card,
    } satisfies RunRowModel;
  });

  const inFlight = (row: RunRowModel): number => (row.status.state === "running" || row.status.state === "cooldown" ? 0 : 1);
  const startedAt = (adwId: string): number => parseTime(runs.find((run) => run.adw_id === adwId)?.started_at) ?? 0;
  return rows.sort((a, b) => inFlight(a) - inFlight(b) || startedAt(b.adwId) - startedAt(a.adwId));
}

/* ── the empty list, which is three different sentences ─────────────────── */

export interface RunsEmpty {
  heading: string;
  sentence: string;
}

/**
 * What "no rows" means, decided from the server's own `source` rather than
 * from the absence itself. There are four of them and they are not
 * interchangeable:
 *
 *   no factory record here      this checkout has no sssf.db at all
 *   nothing recorded yet        it has one and it is empty
 *   nothing on <host> yet       a machine was read and its record is empty
 *   <host> did not answer       a machine was read and could not be reached
 *
 * The last two are the ones this exists for. When the server read a machine it
 * also wrote the sentence for it - naming the host, the path, or the SSH error
 * verbatim - so the sentence below is the server's, never a friendlier one
 * invented here. Only the short heading is chosen locally.
 */
export function runsEmptyState(source: RunsSource | null | undefined, factoryAbsent: boolean): RunsEmpty {
  if (source?.origin === "machine" && source.reason) {
    const host = source.host ?? "that machine";
    return {
      heading: source.reachable === false ? `${host} could not be reached` : `No runs on ${host} yet`,
      sentence: source.reason,
    };
  }
  if (factoryAbsent) {
    return {
      heading: "No factory record",
      sentence:
        "This project has no sssf.db on this machine — the engine writes one the first time it runs a card here.",
    };
  }
  return {
    heading: "No runs yet",
    sentence: "The engine records a run when it picks up a ready card; nothing here needs dispatching.",
  };
}

/* ── the merge queue's rows ─────────────────────────────────────────────── */

export interface QueueRowModel {
  /** `003-slug.md` - the identity `POST /ship`'s `cut` takes */
  name: string;
  title: string;
  /** the card's `Adw-Id:`, when the card carries one */
  adwId: string | null;
  lane: string | null;
  model: string | null;
  /** `12 files · +340 −28`, only when the report counted them */
  stat: string | null;
  /** the script's own note when it could not count a diff */
  note: string | null;
  sha: string | null;
}

/**
 * The rail, in the report's own integration order (oldest first) - the order
 * IS the semantics, because the cut is a point on that line.
 *
 * The report names cards, not runs, so the adw id and the lane are joined in:
 * card name -> `queue/` card -> its `Adw-Id:` -> that run's model. A card whose
 * run this record never saw keeps a null lane and the row simply carries one
 * line less.
 */
export function buildQueueRows(cards: ShipCard[], items: CardItem[], runRows: RunRowModel[]): QueueRowModel[] {
  return cards.map((card) => {
    const item = items.find((candidate) => candidate.name === card.name) ?? null;
    const run = item?.adw_id ? (runRows.find((row) => row.adwId === item.adw_id) ?? null) : null;
    return {
      name: card.name,
      title: card.title,
      adwId: item?.adw_id ?? null,
      lane: run?.lane ?? null,
      model: run?.model ?? null,
      stat: queueStat(card),
      note: queueStat(card) === null ? card.diff_note : null,
      sha: card.sha,
    } satisfies QueueRowModel;
  });
}

function queueStat(card: ShipCard): string | null {
  const diff = diffStat(card.insertions, card.deletions);
  const files = card.files_changed === null ? null : `${card.files_changed} file${card.files_changed === 1 ? "" : "s"}`;
  if (files === null && diff === null) return null;
  return [files, diff].filter((part) => part !== null).join(" · ");
}

/* ── joins ──────────────────────────────────────────────────────────────── */

/** The card a run is working, by `Adw-Id:`. Cards carry the run's id, not the
 * other way round, so this is the only direction the join runs. */
export function cardForRun(cards: CardItem[], adwId: string): CardItem | null {
  return cards.find((card) => card.adw_id === adwId) ?? null;
}

export function shipCardFor(report: ShipReport | null, cardName: string | null | undefined): ShipCard | null {
  if (!report || !cardName) return null;
  return report.cards.find((card) => card.name === cardName) ?? null;
}

/* ── the cut point ──────────────────────────────────────────────────────── */

/** Where the cut sits in the current report; -1 when nothing is cut, or when
 * the card it named is gone (a shipped chunk, a re-read report). */
export function cutIndex(cards: ShipCard[], cutName: string | null): number {
  if (!cutName) return -1;
  return cards.findIndex((card) => card.name === cutName);
}

/** Selection is always a contiguous prefix: integration is one line, so
 * "ship this one" always means "ship it and everything under it". */
export function selectedCards(cards: ShipCard[], index: number): ShipCard[] {
  return index < 0 ? [] : cards.slice(0, index + 1);
}

/** What `POST /ship` is given. The last card is `"all"` - the whole line, and
 * the script's own default range with it. */
export function cutPayload(cards: ShipCard[], index: number): string | null {
  if (index < 0 || index >= cards.length) return null;
  return index === cards.length - 1 ? "all" : cards[index]!.name;
}

/** "Park for later" = lower the cut to the card below this one (change #3):
 * nothing is ever plucked out of the middle of the line. Returns the new cut
 * name, or null when parking the first card empties the selection. */
export function parkBelow(cards: ShipCard[], cardName: string): string | null {
  const index = cutIndex(cards, cardName);
  if (index <= 0) return null;
  return cards[index - 1]!.name;
}

/** The range the squash body will cover for a given cut - `BASE..SHA`, or the
 * report's own range for the whole line. Null when the report named no base. */
export function rangeForCut(report: ShipReport, index: number): string | null {
  if (!report.base) return null;
  if (index < 0) return null;
  if (index === report.cards.length - 1) return report.range;
  const sha = report.cards[index]?.sha;
  return sha ? `${report.base}..${sha}` : null;
}

/* ── verdicts ───────────────────────────────────────────────────────────── */

/** The script's two verdicts, and only those. `confirmed-by-record` is the
 * only one that reads as a pass; anything the record could not confirm is a
 * warning, never a failure - the record being quiet is not the card failing. */
export function verdictTone(verdict: string): Tone {
  return verdict === "confirmed-by-record" ? "ok" : "warn";
}

export function verdictSentence(card: ShipCard): string {
  const total = card.criteria.length;
  if (total === 0) return "this card records no acceptance boxes";
  const unconfirmed = card.criteria.filter((c) => c.verdict !== "confirmed-by-record").length;
  if (unconfirmed === 0) return `all ${total} acceptance boxes are confirmed by the record`;
  return `${unconfirmed} of ${total} acceptance boxes cannot be confirmed from the record`;
}

/* ── time ───────────────────────────────────────────────────────────────── */

export function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** "12s" / "4m 12s" / "1h 04m" - the mock's own shape. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "just now" / "6m ago" / "2h ago" / "3d ago". */
export function formatAgo(iso: string | null | undefined, now: number): string {
  const at = parseTime(iso);
  if (at === null) return "—";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The right-hand column of a run row: how long it has been going, or how long
 * ago it stopped. Em dash when the record timed neither. */
export function runClock(run: RunSummary, now: number): string {
  const started = parseTime(run.started_at);
  if (run.status === "running") return started === null ? "—" : formatElapsed(now - started);
  return formatAgo(run.ended_at ?? run.started_at, now);
}

/** The work log's left gutter: elapsed since the run started ("04:12"), the
 * wall clock when the run's own start is unknown, and the mock's own "--:--"
 * when the record timed neither. */
export function logTime(entryAt: string | null, runStart: string | null): string {
  const at = parseTime(entryAt);
  if (at === null) return "--:--";
  const start = parseTime(runStart);
  if (start === null || at < start) {
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  const seconds = Math.floor((at - start) / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** ISO date -> "2026-08-15" (the report's park dates). */
export function shortDate(iso: string | null): string | null {
  const ms = parseTime(iso);
  if (ms === null) return null;
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** `+340 −28`, with the mock's own minus sign. Null when the report counted
 * neither - the caller then shows the script's `diff_note` instead. */
export function diffStat(insertions: number | null, deletions: number | null): string | null {
  if (insertions === null && deletions === null) return null;
  return `+${insertions ?? 0} −${deletions ?? 0}`;
}
