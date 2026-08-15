/**
 * Help: what this app is, in plain words — the two gates, what each surface
 * does, the daily flow between them, where the real things underneath it
 * live, and the standing no-keybindings rule.
 *
 * The screens' index states the thesis - "Factory is autonomous end-to-end;
 * the only human touchpoint is merge to main" - and the journeys file is
 * explicit that dropping Gate 1 from the app must not read as dropping the
 * rule: Gate 1 lives upstream, in the planning session. So both gates are
 * named here, first, before the surface-by-surface tour.
 */
const SURFACES: { name: string; sentence: string }[] = [
  { name: "Home", sentence: "The shipping report: what the factory finished, and \"is this what we agreed?\" before you ship." },
  { name: "Board", sentence: "Ready / Running / Done. The factory picks its own work here — there is no dispatch button." },
  { name: "Runs", sentence: "Every run's detail — phases, work log, diff — plus the merge queue rail for the ship gate." },
  { name: "Docs", sentence: "The project's own docs, specs and queue cards, rendered read-only." },
  { name: "Settings", sentence: "Roster and Lanes per project; Providers, Machines and Appearance for the whole app." },
];

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
              <div className="mh-label">The five surfaces</div>
              <p style={{ marginBottom: 6 }}>What each one is for, plainly:</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {SURFACES.map((surface) => (
                  <p key={surface.name} style={{ margin: 0 }}>
                    <strong>{surface.name}</strong> — {surface.sentence}
                  </p>
                ))}
              </div>
            </div>

            <div>
              <div className="mh-label">The daily flow</div>
              <p>
                <strong>Plan</strong> in a CLI session (documentation-factory → <code>/to-kanban</code>) →{" "}
                <strong>publish</strong>, which commits cards and docs and pushes — that push is Gate 1 and the only sync
                your planning needs → <strong>the factory</strong> picks up ready cards on its own, runs them, and
                integrates the green ones → <strong>ship</strong>, reviewing the assembled report on Home and squashing
                the chunk you agree with onto <strong>main</strong>.
              </p>
            </div>

            <div>
              <div className="mh-label">Where things live</div>
              <p>
                Cards and docs live in the project&apos;s own repository (<code>queue/</code>, <code>docs/</code>) — this
                app reads and writes nothing that is not already tracked there or in{" "}
                <code>~/.sdl-factory/</code> on this machine. Credentials never touch git: provider and machine secrets
                are written straight to the target machine over SSH, never committed.
              </p>
            </div>

            <div>
              <div className="mh-label">Driving it</div>
              <p>
                No keyboard shortcuts. Every action in this app is a button or a word-link — the standing rule this app
                follows everywhere, without exception.
              </p>
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
