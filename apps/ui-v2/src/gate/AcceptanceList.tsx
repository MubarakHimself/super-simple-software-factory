/**
 * The acceptance walk (spec 2.6, W2-E2) - the card's criteria, one row each,
 * three verdicts and only three:
 *
 *   met          the record names the file or the passing check (evidence inline)
 *   not met      the record says otherwise
 *   unconfirmed  `cannot confirm from the record - check the compare page for
 *                this one` - the morning-brief skill's fixed phrase
 *
 * Two rules this file exists to keep:
 *
 * 1. **The phrase is the server's, byte for byte.** It is rendered from
 *    `criterion.note` and never retyped here, so there is exactly one copy of
 *    it in the app and it cannot drift from
 *    `~/.claude/skills/morning-brief/SKILL.md:96` (ASCII hyphen, no em-dash).
 *    Word for word means byte for byte, or the operator learns to recognise
 *    two phrases instead of one.
 * 2. **The card's own `- [x]` is displayed but is never evidence.** The
 *    checkbox shows what the file says; the verdict beside it shows what the
 *    run's record supports. When they disagree, that disagreement IS the
 *    reading - which is why the checkbox is disabled and sits on the far side
 *    of the row from the verdict. Nothing here ever writes a card (W3 Open 10).
 *
 * Matching is the server's, mechanical and conservative; a criterion with no
 * mechanical match is `unconfirmed`, never a fuzzy "probably". On a real card
 * this marks roughly half the rows unconfirmed - that is the honest floor
 * (Open Decision 12), not a defect in this list.
 */
import { useResource } from "../lib/poll.ts";
import { Dot, type Tone } from "../shared/Dot.tsx";
import { ReadFailure } from "../shell/EmptyState.tsx";

export type AcceptanceVerdict = "met" | "not-met" | "unconfirmed";

export interface AcceptanceEvidence {
  kind: "diff" | "envelope" | "quality";
  text: string;
  source: string;
}

export interface AcceptanceCriterion {
  text: string;
  done_in_file: boolean;
  verdict: AcceptanceVerdict;
  evidence: AcceptanceEvidence[];
  /** Present only on `unconfirmed`: the skill's fixed sentence, verbatim. */
  note: string | null;
}

/** Dot + word, never a bare colour (spec 3.2). The words are spec 2.6's own. */
const VERDICT: Record<AcceptanceVerdict, { tone: Tone; word: string }> = {
  met: { tone: "ok", word: "met" },
  "not-met": { tone: "fail", word: "not met" },
  unconfirmed: { tone: "neutral", word: "unconfirmed" },
};

export function AcceptanceList({ projectId, adwId }: { projectId: string; adwId: string }) {
  const { data, error } = useResource<{ criteria: AcceptanceCriterion[] }>(
    `${projectId}|gate|${adwId}|acceptance`,
    `/api/app/p/${encodeURIComponent(projectId)}/gate/${encodeURIComponent(adwId)}/acceptance`,
  );

  if (!data && error) {
    return (
      <div className="border-t border-hairline">
        <ReadFailure error={error} />
      </div>
    );
  }

  // No card joined to this run, or a card with no checkbox lines: the walk is
  // absent rather than empty-stated. Plenty of runs have no card at all, and
  // an element with nothing to say does not render (spec's "absent when null").
  const criteria = data?.criteria ?? [];
  if (criteria.length === 0) return null;

  return (
    <ul className="border-t border-hairline px-4 py-2">
      {criteria.map((criterion, index) => (
        <CriterionRow key={`${index}-${criterion.text}`} criterion={criterion} />
      ))}
    </ul>
  );
}

function CriterionRow({ criterion }: { criterion: AcceptanceCriterion }) {
  const verdict = VERDICT[criterion.verdict] ?? VERDICT.unconfirmed;

  // The verdict is a left column, not a right float: the card is full-width
  // (spec 3.4) and a right-aligned verdict on a 1360px window ends up a
  // thousand pixels from the sentence it judges. A fixed column reads at any
  // width, and dot + word is the same idiom the rest of the app uses.
  return (
    <li className="flex items-start gap-2 py-1">
      <input
        type="checkbox"
        checked={criterion.done_in_file}
        disabled
        readOnly
        title="as written in the card"
        className="mt-[4px] size-3 shrink-0 accent-[var(--accent)]"
      />
      <span className="flex w-24 shrink-0 items-center gap-1.5 pt-[2px] text-meta text-t2">
        <Dot tone={verdict.tone} />
        {verdict.word}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-body text-t1">{criterion.text}</p>

        {/* Evidence sits under the criterion it speaks to - the changed file,
            the envelope that reported it, or the quality check that answers
            it. One line each, and only what the record actually holds. */}
        {criterion.evidence.map((evidence, index) => (
          <p key={`${index}-${evidence.text}`} className="truncate font-mono text-mono text-t3">
            {evidence.text} <span className="opacity-70">{evidence.source}</span>
          </p>
        ))}

        {criterion.note ? <p className="text-meta text-neutral">{criterion.note}</p> : null}
      </div>
    </li>
  );
}
