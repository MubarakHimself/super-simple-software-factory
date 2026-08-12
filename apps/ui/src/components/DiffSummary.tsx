import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { DiffFile, DiffResponse } from "@shared/types";
import { cn } from "@/lib/utils";

const INITIAL_SHOWN = 8;

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "(root)" : path.slice(0, i);
}

function groupByDir(files: DiffFile[]): [string, DiffFile[]][] {
  const map = new Map<string, DiffFile[]>();
  for (const f of files) {
    const d = dirOf(f.path);
    const list = map.get(d);
    if (list) list.push(f);
    else map.set(d, [f]);
  }
  return Array.from(map.entries());
}

/**
 * `3 changed files +47 -12 Show files`, grouped by directory, per-file
 * +N/-N, an explicit `Show all N files` so it never floods (spec 5.2.1, 7).
 */
export function DiffSummary({ diff }: { diff: DiffResponse }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  if (diff.empty) {
    return (
      <div className="rounded-md border border-border bg-elevated px-2.5 py-2 text-[11px] text-muted-foreground">
        This run made no commits and captured no diff. Diffs appear for chains that reach a git phase (plan-build and
        up).
      </div>
    );
  }

  const groups = groupByDir(diff.files);
  const totalFiles = diff.files.length;

  return (
    <div className="rounded-md border border-border bg-elevated">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px]"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className="font-medium text-foreground">
          {totalFiles} changed file{totalFiles === 1 ? "" : "s"}
        </span>
        <span className="mono">
          <span className="text-[var(--color-success)]">+{diff.added}</span>{" "}
          <span className="text-[var(--color-fail)]">-{diff.deleted}</span>
        </span>
        <span className="ml-auto text-[10.5px] text-muted-foreground">{open ? "Hide files" : "Show files"}</span>
      </button>
      {open && (
        <div className="border-t border-border px-2.5 py-1.5">
          {groups.map(([dir, files]) => (
            <div key={dir} className="mb-1.5 last:mb-0">
              <div className="mono mb-0.5 text-[10px] text-[var(--color-text-meta)]">
                {dir} - {files.length} file{files.length === 1 ? "" : "s"}
              </div>
              {(showAll ? files : files.slice(0, INITIAL_SHOWN)).map((f) => (
                <div key={f.path} className="mono flex items-center justify-between gap-2 py-0.5 text-[11px]">
                  <span className="min-w-0 truncate text-foreground">{f.path.slice(dir.length === 0 ? 0 : dir.length + 1)}</span>
                  <span className="shrink-0">
                    <span className="text-[var(--color-success)]">+{f.added}</span>{" "}
                    <span className="text-[var(--color-fail)]">-{f.deleted}</span>
                  </span>
                </div>
              ))}
            </div>
          ))}
          {!showAll && totalFiles > INITIAL_SHOWN && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className={cn("mt-0.5 text-[10.5px] text-primary hover:underline")}
            >
              Show all {totalFiles} files
            </button>
          )}
        </div>
      )}
    </div>
  );
}
