/**
 * Quality (spec 2.5.5): three states rendered from `status` -
 * `pass | fail | incomplete` - and the rule that makes the third one exist:
 *
 *   "`passed` is the trap field (false for incomplete too); never collapse a
 *    missing answer into a failure."
 *
 * So this file reads `status` and nothing else for its verdict, and
 * `incomplete` gets its own neutral color and the tool's own evidence
 * (the command and the exit code the record holds), never a red dot.
 *
 * A run with no `quality:%` events renders NOTHING - not an empty Quality
 * heading. A section that says "no quality checks" on 12 runs that never ran
 * one is chrome the record did not earn.
 */
import { useState } from "react";
import { useShell } from "../App.tsx";
import { apiGet } from "../lib/api.ts";
import { Dot, type Tone } from "../shared/Dot.tsx";
import type { QualityCheck, QualityStatus } from "./types.ts";

const TONE: Record<QualityStatus, Tone> = {
  pass: "ok",
  fail: "fail",
  incomplete: "neutral",
  unknown: "neutral",
};

/** An artifact path is only openable when it sits inside the project - the
 * file reader is path-confined and this app never reaches outside a root. */
function relativeTo(root: string | null, artifact: string): string | null {
  if (!root) return null;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const a = norm(artifact);
  if (a.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return a.slice(r.length + 1);
  return a.startsWith("/") || /^[A-Za-z]:/.test(a) ? null : a;
}

function OutputExpander({ artifact }: { artifact: string }) {
  const { project } = useShell();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const relative = relativeTo(project?.root ?? null, artifact);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || text !== null || !relative || !project) return;
    try {
      const file = await apiGet<{ text: string }>(
        `/api/app/p/${encodeURIComponent(project.id)}/docs/file?path=${encodeURIComponent(relative)}`,
      );
      setText(file.text);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <button type="button" onClick={() => void toggle()} className="font-mono text-meta text-t3 hover:text-t2">
        {open ? "hide output" : "open output"}
      </button>
      {open ? (
        <pre className="mt-1 max-h-64 overflow-auto rounded-control border border-hairline bg-raised px-3 py-2 font-mono text-mono text-t2">
          {text ?? error ?? artifact}
        </pre>
      ) : null}
    </>
  );
}

function evidenceOf(check: QualityCheck): string | null {
  const parts: string[] = [];
  if (check.command) parts.push(check.command);
  if (check.returncode !== null) parts.push(`exit ${check.returncode}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function QualityBlock({ checks }: { checks: QualityCheck[] }) {
  if (checks.length === 0) return null;

  return (
    <section className="border-t border-hairline px-5 py-3">
      <h2 className="mb-2 text-head font-semibold text-t1">Quality</h2>
      {checks.map((check, index) => (
        <div key={`${check.area}-${check.operation}-${index}`} className="py-1">
          <p className="flex min-w-0 items-baseline gap-2 text-body">
            <span className="translate-y-[-2px]">
              <Dot tone={TONE[check.status]} />
            </span>
            <span className="shrink-0 font-semibold text-t1">
              {[check.area, check.operation].filter(Boolean).join(" ") || "check"}
            </span>
            <span className="shrink-0 font-mono text-meta text-t2">{check.status}</span>
            <span className="min-w-0 truncate font-mono text-meta text-t3">{evidenceOf(check)}</span>
          </p>
          {check.output_artifact ? (
            <div className="pl-4">
              <OutputExpander artifact={check.output_artifact} />
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}
