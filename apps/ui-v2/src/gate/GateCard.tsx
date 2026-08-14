/**
 * One shippable run (spec 2.6): `title - branch - +84 -0 across 6 files -
 * reviewer's one-sentence summary - the compare link`. Five things, and the
 * card carries nothing else: no status sentence, no cost block, no checks
 * table, no "waiting 1h 46m" (that is the prototype's mock-data density, and
 * the operator's note on it is binding).
 *
 * `title`: every run in the boot project's db has a null title, so the honest
 * fallback order is the one spec 3.7 fixes - title, branch, lane - which here
 * means `request` clipped, then the branch. `adw_id` never leads a label; it
 * is a hover affordance on the heading and nothing more (spec 2.0, F8/F14).
 *
 * `Compare on GitHub` is a link, not an action. When the remote is not GitHub
 * there is no button at all - `push_command` renders as copyable text
 * (`select-all`, so a click-drag or triple-click takes the whole line), which
 * is what spec 2.6 asks for and is not an action the app performs.
 *
 * Beside it, since the KISS correction, there is one action: **Merge**. It is
 * a word-button (no keybinding, here or anywhere) that opens an inline confirm
 * on the card itself - the T3 shape, ported not copied: T3 answers a git action
 * with a small confirm carrying the branch name in its own sentence
 * (`resolveDefaultBranchActionDialogCopy`: title, description, continue label)
 * and, when the action fails, shows the server's own message verbatim
 * (`failVcsActionState`: `error.message`, never a friendlier sentence). Here
 * that is one line, two word-links, and the server's reason printed as it
 * arrived - the app never invents a sentence about git that git did not say.
 */
import { useState, type ReactNode } from "react";
import { apiPost } from "../lib/api.ts";
import { clip } from "../lib/format.ts";
import { AcceptanceList } from "./AcceptanceList.tsx";

export interface GateDiffFile {
  path: string;
  added: number;
  deleted: number;
}

export interface GateItem {
  adw_id: string;
  adw_name: string | null;
  request: string | null;
  branch: string;
  ended_at: string | null;
  diff: {
    /** `resolveDiff`'s own words for what it compared, or why it could not. */
    base: string;
    files: GateDiffFile[];
    added: number;
    deleted: number;
    empty: boolean;
  };
  reviewer_summary: string | null;
  compare_url: string | null;
  push_command: string | null;
  remote_kind: "github" | "other" | "none";
}

/** What the merge endpoint answers with on success (`app/merge.ts`). */
interface MergeResult {
  merged: true;
  branch: string;
  main_sha: string;
  card_from: string;
  card_to: string;
}

export function GateCard({ projectId, item }: { projectId: string; item: GateItem }) {
  const heading = item.request ? clip(item.request, 120) : item.branch;

  return (
    <article className="overflow-hidden rounded-control border border-hairline bg-raised">
      <header className="border-b border-hairline px-5 py-4">
        <h2 className="truncate text-head font-semibold text-t1" title={item.adw_id}>
          {heading}
        </h2>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-mono text-t2">{item.branch}</span>
          <DiffStat diff={item.diff} />
        </div>
      </header>

      {/* Absent when null, never an em-dash placeholder (spec's binding rule). */}
      {item.reviewer_summary ? (
        <p className="max-w-[92ch] px-5 py-4 text-body text-t2">{item.reviewer_summary}</p>
      ) : null}

      <AcceptanceList projectId={projectId} adwId={item.adw_id} />

      <footer className="border-t border-hairline px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          {item.compare_url ? (
            <a
              href={item.compare_url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-7 items-center rounded-control border border-accent bg-accent-surface px-3 text-body font-semibold text-accent hover:bg-accent hover:text-on-accent"
            >
              Compare on GitHub
            </a>
          ) : item.push_command ? (
            <code className="select-all font-mono text-mono text-t2">{item.push_command}</code>
          ) : null}

          <MergeAction projectId={projectId} branch={item.branch} adwId={item.adw_id} />
        </div>
      </footer>
    </article>
  );
}

/** A word-button. Not an icon, not a keybinding, not a dialog - the whole
 * affordance vocabulary this app has left after the KISS correction. */
function WordButton({
  children,
  onClick,
  disabled,
  tone = "plain",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "plain" | "accent";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`text-body underline-offset-2 hover:underline disabled:no-underline disabled:text-t3 ${
        tone === "accent" ? "font-semibold text-accent" : "text-t2 hover:text-accent"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Merge, confirm, done - three states in one small strip on the card.
 *
 *   idle       `Merge`
 *   confirm    `Merge <branch> into main - this moves the card to done`
 *              followed by `Merge` / `Cancel`
 *   merged     the server's own facts: the new `main` sha and where the card went
 *
 * A failure never leaves the confirm: the reason is printed under it, verbatim
 * as the server sent it, and the two word-links stay where they were so the
 * operator can read, fix, and click again (or cancel). Nothing here retries by
 * itself, and nothing here forces - the server refuses anything that is not a
 * fast-forward and says so in its own words.
 */
function MergeAction({ projectId, branch, adwId }: { projectId: string; branch: string; adwId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);

  if (result) {
    return (
      <p className="flex flex-wrap items-baseline gap-x-2 text-body text-t2">
        <span className="text-ok">Merged</span>
        <span className="font-mono text-mono text-t2">
          {result.branch} &rarr; main @ {result.main_sha}
        </span>
        <span className="font-mono text-mono text-t3">{result.card_to}</span>
      </p>
    );
  }

  if (!confirming) {
    return <WordButton onClick={() => setConfirming(true)}>Merge</WordButton>;
  }

  const run = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const merged = await apiPost<MergeResult>(
        `/api/app/p/${encodeURIComponent(projectId)}/gate/${encodeURIComponent(adwId)}/merge`,
      );
      setResult(merged);
      setConfirming(false);
    } catch (error) {
      // The server's sentence, unedited. It is the only thing in the app that
      // knows why git said no.
      setFailure((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-body text-t2">
          Merge <span className="font-mono text-mono text-t1">{branch}</span> into main &mdash; this moves the card
          to done
        </span>
        <WordButton tone="accent" disabled={busy} onClick={() => void run()}>
          {busy ? "Merging..." : "Merge"}
        </WordButton>
        <WordButton
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            setFailure(null);
          }}
        >
          Cancel
        </WordButton>
      </div>
      {failure ? <p className="font-mono text-mono text-fail">{failure}</p> : null}
    </div>
  );
}

/**
 * `+84 −0 across 6 files`. When the run captured no diff, the honest thing is
 * `resolveDiff`'s own `base` string (`no diff available`) and nothing added to
 * it - spec 2.5's diff rule, which the Gate card obeys for the same reason.
 */
function DiffStat({ diff }: { diff: GateItem["diff"] }) {
  const count = diff.files.length;
  if (diff.empty || count === 0) {
    return <span className="font-mono text-mono text-t3">{diff.base}</span>;
  }
  return (
    <span className="font-mono text-mono tabular-nums">
      <span className="text-ok">+{diff.added}</span>{" "}
      <span className="text-fail">&minus;{diff.deleted}</span>{" "}
      <span className="text-t3">
        across {count} {count === 1 ? "file" : "files"}
      </span>
    </span>
  );
}
