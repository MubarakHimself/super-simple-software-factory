import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PtyPane } from "@/components/PtyPane";
import { cn } from "@/lib/utils";
import type { SetupStatus, VerifyCheck } from "@/types/factory";

const TARGETS: { id: string; label: string; note: string }[] = [
  { id: "laptop", label: "Laptop", note: "this machine, planning box" },
  { id: "server", label: "Server", note: "headless Linux box, also installs the UI" },
  { id: "container", label: "Container", note: "inside docker/lxc" },
];

const OUTCOME_DOT: Record<string, string> = {
  ok: "bg-[var(--color-success)]",
  failed: "bg-[var(--color-fail)]",
  "needs-operator": "bg-[var(--color-warning)]",
  "expected-unavailable": "bg-[var(--color-text-meta)]",
};

const OUTCOME_LABEL: Record<string, string> = {
  ok: "ok",
  failed: "failed",
  "needs-operator": "needs you",
  "expected-unavailable": "n/a here",
};

function CheckRow({ check }: { check: VerifyCheck }) {
  return (
    <div className="flex items-start gap-2 rounded-sm border border-border bg-elevated px-2.5 py-1.5">
      <span className={cn("mt-1 inline-block size-1.5 shrink-0 rounded-full", OUTCOME_DOT[check.outcome] ?? "bg-[var(--color-text-meta)]")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="mono text-[11px] font-semibold text-foreground">{check.id}</span>
          <span className="text-[10.5px] text-muted-foreground">{OUTCOME_LABEL[check.outcome] ?? check.outcome}</span>
        </div>
        <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{check.message}</div>
      </div>
    </div>
  );
}

/**
 * First-run Setup (spec 4). Loaded from setup.html (a standalone bundle,
 * never a route inside the dashboard SPA - the dashboard's own server
 * cannot exist yet on a genuinely fresh machine, spec 4.3). Every check
 * shown here is install.py's own verify[] output, verbatim - this screen
 * invents no check, no wording, no ordering of its own (spec 4.1).
 */
export function SetupScreen() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [target, setTarget] = useState<string>("laptop");
  const [runSessionId, setRunSessionId] = useState<string | null>(null);
  const [proceeding, setProceeding] = useState(false);
  const [proceedError, setProceedError] = useState<string | null>(null);
  const targetChosenByOperator = useRef(false);

  const refresh = useCallback(async () => {
    if (!window.factory) return;
    setChecking(true);
    const next = await window.factory.setup.status();
    setStatus(next);
    setChecking(false);
    if (next.target && !targetChosenByOperator.current) setTarget(next.target);
    return next;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Exit 0 -> the app moves on (spec 4.2): once a re-check after a run
  // reports converged, proceed automatically - the operator already
  // clicked "Run setup" to get here, nothing installs without that click
  // having already happened (MAP rule 14).
  useEffect(() => {
    if (!status?.converged || proceeding) return;
    setProceeding(true);
    setProceedError(null);
    void window.factory!.setup
      .proceed()
      .then((result) => {
        if (!result.ok) {
          setProceeding(false);
          setProceedError(result.error ?? "could not open the dashboard");
        }
        // on success the window navigates away - nothing left to do here
      })
      .catch((error: unknown) => {
        setProceeding(false);
        setProceedError(error instanceof Error ? error.message : String(error));
      });
  }, [status?.converged, proceeding]);

  async function handlePtyExit() {
    await refresh();
  }

  async function handleRun() {
    if (!window.factory) return;
    const { sessionId } = await window.factory.setup.run(target);
    setRunSessionId(sessionId);
  }

  if (!window.factory) {
    // Setup only ever loads inside the desktop app (spec 4.3) - this is
    // unreachable in practice, but an honest empty state costs nothing
    // and matches the app's rule everywhere else (never a dead screen).
    return (
      <div className="flex h-screen items-center justify-center bg-canvas p-10 text-center text-[12px] text-muted-foreground">
        Setup is desktop-only. Open the SDL Factory desktop app.
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-canvas text-foreground">
      <div className="border-b border-border px-5 py-3">
        <div className="text-[14px] font-semibold">SDL Factory Setup</div>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          This machine has not converged yet. Nothing installs until you click "Run setup" below - the wizard runs
          interactively, in the terminal pane, exactly as it would from a shell.
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
        {proceeding && !proceedError && (
          <div className="rounded-sm border border-border bg-elevated px-3 py-2 text-[11.5px] text-foreground">
            Converged - opening the dashboard...
          </div>
        )}
        {proceedError && (
          <div className="rounded-sm border border-[var(--color-fail)]/40 bg-elevated px-3 py-2 text-[11.5px]">
            <div className="text-[var(--color-fail)]">{proceedError}</div>
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => void refresh()}>
              Re-check
            </Button>
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <div className="text-[11.5px] font-semibold text-foreground">Checklist</div>
            <Button size="sm" variant="ghost" disabled={checking} onClick={() => void refresh()}>
              {checking ? "Checking..." : "Re-check"}
            </Button>
          </div>
          {checking && !status && <div className="text-[11.5px] text-muted-foreground">Checking this machine...</div>}
          {status?.error && (
            <div className="mb-2 rounded-sm border border-[var(--color-fail)]/40 bg-elevated px-2.5 py-1.5 text-[11.5px] text-[var(--color-fail)]">
              {status.error}
            </div>
          )}
          {status && status.checks.length > 0 && (
            <div className="space-y-1.5">
              {status.checks.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </div>
          )}
          {status && status.checks.length === 0 && !status.error && (
            <div className="text-[11.5px] text-muted-foreground">
              No checklist yet - the wizard reports this once a run has happened.
            </div>
          )}
        </div>

        {!runSessionId && (
          <div>
            <div className="mb-1.5 text-[11.5px] font-semibold text-foreground">Target</div>
            <div className="flex gap-1.5">
              {TARGETS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    targetChosenByOperator.current = true;
                    setTarget(t.id);
                  }}
                  className={cn(
                    "rounded-md border px-2.5 py-1.5 text-left text-[11.5px]",
                    target === t.id ? "border-primary bg-elevated text-foreground" : "border-border text-muted-foreground hover:bg-elevated-hover",
                  )}
                >
                  <div className="font-semibold">{t.label}</div>
                  <div className="text-[10.5px] text-muted-foreground">{t.note}</div>
                </button>
              ))}
            </div>
            <Button className="mt-3" onClick={() => void handleRun()}>
              Run setup ({TARGETS.find((t) => t.id === target)?.label ?? target})
            </Button>
          </div>
        )}

        {runSessionId && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-1.5 text-[11.5px] font-semibold text-foreground">
              Running: uv run installer/install.py --target {target}
            </div>
            <div className="min-h-[320px] flex-1 rounded-md border border-border bg-canvas p-1.5">
              <PtyPane sessionId={runSessionId} onExit={() => void handlePtyExit()} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
