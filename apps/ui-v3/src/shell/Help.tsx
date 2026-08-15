/**
 * Help: the two gates, in the operator's own words, plus the one sentence
 * about how this app is driven.
 *
 * The screens' index states the thesis - "Factory is autonomous end-to-end;
 * the only human touchpoint is merge to main" - and the journeys file is
 * explicit that dropping Gate 1 from the app must not read as dropping the
 * rule: Gate 1 lives upstream, in the planning session. So both gates are
 * named here.
 */
export function Help({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="modal-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal fade-in" role="dialog" aria-modal="true" aria-label="Help">
        <div className="modal-header">
          <h3>How this works</h3>
          <div className="modal-sub">Two gates. Everything between them is the factory's.</div>
        </div>
        <div className="modal-body">
          <div className="modal-help">
            <div>
              <div className="mh-label">Gate 1 · the plan</div>
              <p>
                Ratified in your planning session, before a batch is published. The app never asks it again — publishing
                is the sync.
              </p>
            </div>
            <div>
              <div className="mh-label">Gate 2 · the ship</div>
              <p>
                One squash commit onto <strong>main</strong>, on your click, carrying the shipping report as its
                message. This is the only human touchpoint.
              </p>
            </div>
            <div>
              <div className="mh-label">In between</div>
              <p>
                The factory picks ready cards, runs them on lanes, re-verifies and integrates each green run on{" "}
                <strong>integration</strong> by itself. There is no dispatch button, and there is nothing to approve.
              </p>
            </div>
            <div>
              <div className="mh-label">Driving it</div>
              <p>No keyboard shortcuts. Every action in this app is a button or a word-link.</p>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
