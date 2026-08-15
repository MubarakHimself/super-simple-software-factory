/**
 * The export bar, on every detail view.
 *
 * Both buttons produce the SAME text - the `/ship-check` handoff (prompt.ts).
 * "Copy prompt" puts it on the clipboard; "Open in Claude Code" hands it to a
 * launcher when this build has one wired and copies it when it does not, and
 * says which of those two things just happened. There is no third behaviour: a
 * button that appears to launch something and silently does nothing is exactly
 * the failure J7 forbids.
 *
 * The launcher seam: an Electron build may expose
 * `window.factory.openInClaudeCode(text)`. Today's preload does not, so the
 * button copies and says so. Nothing here invents a URL scheme to fire into
 * the dark.
 */
import { useState } from "react";
import { CopyIcon, StarIcon } from "./icons.tsx";

interface HandoffBridge {
  openInClaudeCode?: (text: string) => Promise<{ ok: boolean; error?: string }>;
}

function launcher(): HandoffBridge["openInClaudeCode"] | null {
  const bridge = (globalThis as unknown as { factory?: HandoffBridge }).factory;
  return typeof bridge?.openInClaudeCode === "function" ? bridge.openInClaudeCode.bind(bridge) : null;
}

async function copyText(text: string): Promise<string | null> {
  try {
    await navigator.clipboard.writeText(text);
    return null;
  } catch (error) {
    return (error as Error).message || "the browser refused the clipboard";
  }
}

const TOOLTIP =
  "Copies the /ship-check handoff — the card names, adw-ids and range for this chunk — as plain text to paste into Claude Code.";

export function ExportBar({ prompt }: { prompt: string }) {
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);
  const [tipOpen, setTipOpen] = useState(false);

  const onCopy = async () => {
    const failure = await copyText(prompt);
    setNote(
      failure
        ? { text: `copy failed — ${failure}`, failed: true }
        : { text: "copied — paste it into Claude Code or Codex", failed: false },
    );
  };

  const onOpen = async () => {
    const open = launcher();
    if (!open) {
      const failure = await copyText(prompt);
      setNote(
        failure
          ? { text: `no launcher is wired on this machine, and the copy failed — ${failure}`, failed: true }
          : { text: "no launcher is wired on this machine — the handoff was copied; paste it into Claude Code", failed: false },
      );
      return;
    }
    try {
      const result = await open(prompt);
      if (result?.ok) {
        setNote({ text: "handed to Claude Code", failed: false });
        return;
      }
      const failure = await copyText(prompt);
      setNote({
        text: `the launcher refused — ${result?.error ?? "no reason given"}${failure ? `, and the copy failed — ${failure}` : "; the handoff was copied instead"}`,
        failed: true,
      });
    } catch (error) {
      const failure = await copyText(prompt);
      setNote({
        text: `the launcher failed — ${(error as Error).message}${failure ? `, and the copy failed — ${failure}` : "; the handoff was copied instead"}`,
        failed: true,
      });
    }
  };

  return (
    <div className="export-bar">
      <span className="eb-label">Export</span>
      <button
        type="button"
        className="export-btn"
        onClick={() => void onCopy()}
        onMouseEnter={() => setTipOpen(true)}
        onMouseLeave={() => setTipOpen(false)}
        onFocus={() => setTipOpen(true)}
        onBlur={() => setTipOpen(false)}
      >
        <CopyIcon />
        Copy prompt
        <span className={`copy-tooltip${tipOpen ? " visible" : ""}`} role="tooltip">
          {TOOLTIP}
        </span>
      </button>
      <button type="button" className="export-btn" onClick={() => void onOpen()}>
        <StarIcon />
        Open in Claude Code
      </button>
      {note ? <p className={`export-note${note.failed ? " failed" : ""}`}>{note.text}</p> : null}
    </div>
  );
}
