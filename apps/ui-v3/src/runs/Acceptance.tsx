/**
 * The acceptance walk, straight out of `adws/ship_report.py`'s record.
 *
 * The script has exactly two verdicts and this file has exactly two sentences
 * for them: `confirmed-by-record` reads as confirmed, and
 * `cannot-confirm-from-record` reads as "the record does not show it" - a
 * warning about the evidence, never a claim that the card failed. The evidence
 * line under each row is the script's own string, unedited.
 *
 * Nothing here says anything about the CARD's own checkbox, deliberately.
 * `render_pr` prints the verdict as the box (`- [x]` = confirmed), so
 * `criterion.checked` restates the verdict rather than reporting the card - and
 * the card's real checkbox is already named, in the script's own words, inside
 * the evidence line ("card's own checkbox: checked"). Rendering `checked` as
 * the card's box produced rows that contradicted the evidence printed directly
 * beneath them; the fix is to let the one true source say it.
 */
import { Dot } from "../shared/Dot.tsx";
import { verdictSentence, verdictTone } from "./model.ts";
import type { ShipCard } from "./types.ts";

const VERDICT_SENTENCE: Record<string, string> = {
  "confirmed-by-record": "confirmed by the record",
  "cannot-confirm-from-record": "the record cannot confirm this",
};

export function Acceptance({ card }: { card: ShipCard }) {
  return (
    <div className="acceptance-section">
      <div className="log-section-title">Acceptance criteria</div>
      <p className="acc-summary">{verdictSentence(card)}</p>

      {card.criteria.length === 0 ? (
        <p className="record-note">
          This card's AGENT-BRIEF holds no acceptance checkboxes, so there is nothing for the report to walk.
        </p>
      ) : (
        card.criteria.map((criterion, index) => (
          <div className="acceptance-row" key={`${index}-${criterion.text}`}>
            <Dot tone={verdictTone(criterion.verdict)} />
            <div className="acc-body">
              <div className="acc-title">{criterion.text}</div>
              <div className={`acc-detail${criterion.verdict === "confirmed-by-record" ? "" : " warn"}`}>
                {VERDICT_SENTENCE[criterion.verdict] ?? criterion.verdict}
              </div>
              {criterion.evidence ? <div className="acc-evidence">{criterion.evidence}</div> : null}
            </div>
          </div>
        ))
      )}

      {card.gap ? <p className="record-note gap">{card.gap}</p> : null}
    </div>
  );
}
