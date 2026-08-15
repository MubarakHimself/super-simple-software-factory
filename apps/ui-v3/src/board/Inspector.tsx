/**
 * The inspector rail (board-v3.html): card detail, status rows, Blocks /
 * Blocked by straight from `needs`/`blocks` (J3.2), the card's own source
 * path. No "Est. runs" row - `CardItem` carries no such field, and a row
 * with nothing behind it is worse than no row (change-list #7 leaves this
 * to be decided at build; there is nothing to show).
 */
import type { ReactNode } from "react";
import { Dot, type Tone } from "../shared/Dot.tsx";
import type { BoardColumn, CardItem, LiveRun } from "./types.ts";
import { columnLabel, extractSummary, laneOf, priorityTone, stateTone, toneVar } from "./types.ts";

function CloseX() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M4 4l6 6M10 4l-6 6" strokeLinecap="round" />
    </svg>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="inspector-meta-row">
      <span className="imr-label">{label}</span>
      <span className="imr-val">{children}</span>
    </div>
  );
}

function DotRow({ label, tone, text }: { label: string; tone: Tone; text: string }) {
  return (
    <MetaRow label={label}>
      <Dot tone={tone} />
      {text}
    </MetaRow>
  );
}

const COLUMN_TONE: Record<BoardColumn, Tone> = { ready: "idle", running: "run", done: "ok" };

export function Inspector({
  card,
  column,
  live,
  onClose,
}: {
  card: CardItem | null;
  column: BoardColumn | null;
  live: LiveRun | null;
  onClose: () => void;
}) {
  return (
    <div className="inspector-rail">
      <div className="inspector-header">
        <h3>Details</h3>
        {card ? (
          <button type="button" className="inspector-close" onClick={onClose} title="Close">
            <CloseX />
          </button>
        ) : null}
      </div>
      <div className="inspector-body">
        {!card || !column ? (
          <div className="inspector-empty fade-in">
            <div className="ie-icon" />
            <p>Select a card to see its details.</p>
          </div>
        ) : (
          <div className="fade-in">
            <div className="inspector-section">
              <div className="inspector-label">Card</div>
              <div className="inspector-id">{card.adw_id ? `${card.slug} · ${card.adw_id}` : card.slug}</div>
              <div className="inspector-title">{card.title}</div>
              {(() => {
                const desc = extractSummary(card.body) ?? card.context;
                return desc ? <div className="inspector-desc">{desc}</div> : null;
              })()}
            </div>

            <div className="inspector-section">
              <div className="inspector-label">Status</div>
              <DotRow label="Column" tone={COLUMN_TONE[column]} text={columnLabel(column)} />
              <DotRow label="State" tone={stateTone(card.state)} text={card.state} />
              {(() => {
                const lane = column === "running" ? laneOf(live?.model ?? null) : null;
                return <DotRow label="Lane" tone={lane ? "run" : "idle"} text={lane ?? "unassigned"} />;
              })()}
              {card.priority ? (
                <MetaRow label="Priority">
                  <span style={{ color: toneVar(priorityTone(card.priority)) }}>{card.priority}</span>
                </MetaRow>
              ) : null}
              <MetaRow label="Source">{card.path}</MetaRow>
            </div>

            <div className="inspector-section">
              <div className="inspector-label">Linked</div>
              <MetaRow label="Blocks">{card.blocks.length > 0 ? card.blocks.join(", ") : "—"}</MetaRow>
              <MetaRow label="Blocked by">{card.needs.length > 0 ? card.needs.join(", ") : "—"}</MetaRow>
            </div>

            <div className="inspector-section">
              <div className="inspector-label">Notes</div>
              <div className="inspector-desc" style={{ fontStyle: "italic" }}>
                {card.state_reason}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
