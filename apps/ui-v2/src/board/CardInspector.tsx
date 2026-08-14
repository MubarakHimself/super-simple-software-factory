/**
 * The card inspector (spec 2.4, W2-A2): title, status pill, `Adw:`, the Agent
 * Brief rendered as markdown by the SAME renderer Docs uses (W3-B5 - kills the
 * `<pre>` dump), acceptance criteria as real disabled checkboxes with their
 * texts, and the raw path as one copyable monospace line at the bottom.
 *
 * The checkboxes come out of the one markdown renderer rather than out of a
 * second list built from `criteria[]`: the brief already contains the
 * `- [ ]` lines, `shared/Markdown.tsx` renders GFM task lists as REAL inputs
 * and forces every one of them `disabled`, and printing the same four
 * sentences twice is exactly the text density the operator's note forbids.
 * `criteria[]` from the API is what the Gate's acceptance walk consumes; here
 * the file's own list is the list.
 *
 * The UI never writes a card (`queue/TEMPLATE.md`'s contract, Open Decision
 * 20: never). There is no edit affordance in this panel, by construction.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Dot, type Tone } from "../shared/Dot.tsx";
import { Markdown } from "../shared/Markdown.tsx";
import type { BoardCard, CardStatus } from "./Card.tsx";

/** One spelling per noun, in every position (spec 2.0) - the same word the
 * column head uses, so the pill never introduces a second name for a status. */
export const STATUS_NOUN: Record<CardStatus, string> = {
  "ready-for-agent": "Ready",
  running: "Running",
  blocked: "Blocked",
  done: "Done",
};

/** Amber is the "needs you" family, so Blocked is amber; Done is graphite
 * rather than green - a done card is filed, not celebrated. */
export const STATUS_TONE: Record<CardStatus, Tone> = {
  "ready-for-agent": "idle",
  running: "run",
  blocked: "accent",
  done: "neutral",
};

const AGENT_BRIEF = /^##\s+Agent Brief[ \t]*$/m;
const H1 = /^#\s+.+$/m;

/**
 * The Agent Brief, which is everything under `## Agent Brief` - the
 * AGENT-BRIEF.md contract the triage skill writes (`queue/TEMPLATE.md`). The
 * heading itself is dropped: the panel is already the brief, and an h2 that
 * repeats the panel is one more line of text for zero information.
 *
 * A card without that heading falls back to its body minus the H1 and the
 * contiguous `Key: value` block `queue.ts` parses - never to nothing, and
 * never to a `<pre>` dump of the whole file.
 */
export function agentBrief(body: string): string {
  const marked = AGENT_BRIEF.exec(body);
  if (marked) return body.slice(marked.index + marked[0].length).replace(/^\r?\n/, "");

  const h1 = H1.exec(body);
  if (!h1) return body.trim();
  const lines = body.slice(h1.index + h1[0].length).split(/\r\n|\n/);
  let i = 0;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  while (i < lines.length && /^[A-Za-z][A-Za-z0-9-]*:/.test(lines[i] ?? "")) i++;
  return lines.slice(i).join("\n").trim();
}

export function CardInspector({
  card,
  projectId,
  onClose,
}: {
  card: BoardCard;
  projectId: string;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-raised">
      <header className="flex h-topbar shrink-0 items-center gap-2 border-b border-hairline px-3">
        <span className="flex items-center gap-1.5 text-body text-t2">
          <Dot tone={STATUS_TONE[card.status]} />
          {STATUS_NOUN[card.status]}
        </span>
        {card.adw_id ? (
          <Link
            to={`/p/${projectId}/runs/${card.adw_id}`}
            className="ml-auto text-body text-t3 hover:text-accent"
          >
            Open the run
          </Link>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={`${card.adw_id ? "" : "ml-auto "}flex size-row items-center justify-center rounded-chip text-t3 hover:bg-row-hover hover:text-t1`}
        >
          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <h2 className="text-head font-semibold text-t1">{card.title}</h2>
        {card.adw ? (
          <p className="mt-1 flex items-baseline gap-1.5 text-meta text-t3">
            <span>Adw:</span>
            <span className="font-mono text-mono text-t2">{card.adw}</span>
          </p>
        ) : null}
        <div className="mt-3">
          <Markdown text={agentBrief(card.body)} />
        </div>
      </div>

      <PathLine path={card.path} />
    </div>
  );
}

/** The raw path, one copyable monospace line. Copying is the whole
 * interaction: the operator's next move is `code queue/019-….md` in his own
 * terminal, and this panel's job is to make that one click. */
function PathLine({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = () => {
    void navigator.clipboard?.writeText(path).then(
      () => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
      },
      () => {
        /* clipboard denied - the path is still selectable text on screen */
      },
    );
  };

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy"
      className={`flex h-row shrink-0 items-center border-t border-hairline px-4 text-left font-mono text-mono ${
        copied ? "text-accent" : "text-t3 hover:text-t2"
      }`}
    >
      <span className="truncate">{path}</span>
    </button>
  );
}
