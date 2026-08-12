/**
 * queue/*.md header parser -> items[] + unparsed[] (spec 5.3).
 *
 * The UI only ever reads this directory. It parses exactly the contiguous
 * run of `Key: value` lines directly under the H1 - never the prose body -
 * and never writes a queue file back.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { QueueItem, QueueResponse, QueueStatus, UnparsedQueueItem } from "../shared/types.ts";

const VALID_STATUSES: QueueStatus[] = ["ready-for-agent", "running", "blocked", "done"];
const HEADER_LINE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/;
const H1 = /^#\s+(.+?)\s*$/;

function parseHeaderBlock(text: string): { title: string | null; fields: Record<string, string> } | null {
  const lines = text.split(/\r\n|\n/);
  let h1Index = -1;
  let title: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = H1.exec(lines[i] ?? "");
    if (m) {
      h1Index = i;
      title = m[1] ?? null;
      break;
    }
  }
  if (h1Index === -1) return null;

  let i = h1Index + 1;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++; // one blank-line run

  const fields: Record<string, string> = {};
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") break; // contiguous run ends at the first blank line
    const m = HEADER_LINE.exec(line);
    if (!m) break; // ...or the first line that isn't Key: value
    const key = (m[1] ?? "").toLowerCase();
    fields[key] = (m[2] ?? "").trim();
    i++;
  }
  return { title, fields };
}

function countCriteria(body: string): { done: number; total: number } {
  const boxes = body.match(/^[ \t]*-\s*\[( |x|X)\]/gm) ?? [];
  const done = boxes.filter((b) => /\[[xX]\]/.test(b)).length;
  return { done, total: boxes.length };
}

function extractField(body: string, label: string): string | null {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, "i");
  const m = re.exec(body);
  return m ? (m[1] ?? "").trim() : null;
}

export async function readQueue(queueDir: string): Promise<QueueResponse> {
  const items: QueueItem[] = [];
  const unparsed: UnparsedQueueItem[] = [];

  let entries: string[] = [];
  try {
    entries = (await readdir(queueDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md") && e.name !== "TEMPLATE.md")
      .map((e) => e.name)
      .sort();
  } catch {
    return { dir: queueDir, items: [], unparsed: [] };
  }

  for (const name of entries) {
    const path = join(queueDir, name);
    let text: string;
    try {
      text = await readFile(path, "utf-8");
    } catch (error) {
      unparsed.push({ path: `queue/${name}`, reason: `could not read file: ${(error as Error).message}` });
      continue;
    }

    const parsed = parseHeaderBlock(text);
    if (!parsed) {
      unparsed.push({ path: `queue/${name}`, reason: "no H1 title found (expected \"# Title\" on its own line)" });
      continue;
    }
    const { title, fields } = parsed;
    const statusRaw = fields["status"];
    if (statusRaw === undefined) {
      unparsed.push({ path: `queue/${name}`, reason: "missing Status: line under the H1" });
      continue;
    }
    if (!VALID_STATUSES.includes(statusRaw as QueueStatus)) {
      unparsed.push({
        path: `queue/${name}`,
        reason: `unknown Status: "${statusRaw}" (expected one of ${VALID_STATUSES.join(", ")})`,
      });
      continue;
    }

    const { done, total } = countCriteria(text);
    items.push({
      path: `queue/${name}`,
      slug: name.replace(/\.md$/i, ""),
      title: title ?? name,
      status: statusRaw as QueueStatus,
      adw: fields["adw"] || null,
      adw_id: fields["adw-id"] || null,
      created: fields["created"] || null,
      context: fields["context"] || null,
      category: extractField(text, "Category"),
      criteria_done: done,
      criteria_total: total,
      body: text,
    });
  }

  return { dir: queueDir, items, unparsed };
}
