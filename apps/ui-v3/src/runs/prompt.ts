/**
 * The export bar's one output: the `/ship-check` handoff.
 *
 * `/ship-check` is the operator's deep-dive before a chunk ships - it runs
 * `adws/ship_report.py` itself and re-derives everything, so this text is a
 * handoff, not a report: it names the checkout, the range, the cards and their
 * adw-ids, and then gets out of the way. (It is NOT the morning brief; that
 * skill is retired from this flow - docs/user-journeys.md change #15.)
 *
 * Nothing here is padded. A card with no `Adw-Id:` says so, a report that
 * resolved no range says so in the script's own words, and an empty merge
 * queue produces a handoff that says the queue is empty rather than a chunk
 * that does not exist.
 */

export interface PromptCard {
  /** `003-slug.md` */
  name: string;
  title: string;
  /** the card's `Adw-Id:`, when it carries one */
  adwId: string | null;
  /** the park commit - the cut point, when the report named one */
  sha: string | null;
}

export interface PromptRun {
  adwId: string;
  title: string;
  /** the plain sentence from runStatus() - never a bare enum */
  sentence: string;
}

export interface PromptInput {
  projectName: string;
  projectRoot: string;
  /** `BASE..TIP` as the report resolved it */
  range: string | null;
  /** the script's own words when it could not produce a report */
  reportReason: string | null;
  /** the chunk being handed off, in integration order */
  cards: PromptCard[];
  /** the card the cut sits at, when the rail has a cut */
  cutName: string | null;
  /** the run the detail pane is showing, when one is selected */
  run?: PromptRun | null;
}

function cardLine(card: PromptCard, index: number): string {
  const parts = [`${index + 1}. ${card.name} - ${card.title}`];
  parts.push(card.adwId ? `adw-id ${card.adwId}` : "no Adw-Id on the card");
  if (card.sha) parts.push(`park ${card.sha}`);
  return `  ${parts.join(" - ")}`;
}

/**
 * The text both export buttons produce - Copy prompt puts it on the clipboard,
 * Open in Claude Code hands the same string to the OS when a launcher is wired
 * and copies it when one is not.
 */
export function buildShipCheckPrompt(input: PromptInput): string {
  const lines: string[] = ["/ship-check", ""];

  lines.push(`Project: ${input.projectName}`);
  lines.push(`Repo: ${input.projectRoot}`);
  lines.push(input.range ? `Range: ${input.range}` : `Range: not resolved${input.reportReason ? ` - ${input.reportReason}` : ""}`);

  if (input.cards.length === 0) {
    lines.push("");
    lines.push(
      input.reportReason
        ? `Nothing is in the merge queue: ${input.reportReason}`
        : "Nothing is in the merge queue right now - integration holds no card that main does not already have.",
    );
  } else {
    const cut = input.cutName ?? input.cards[input.cards.length - 1]!.name;
    lines.push(`Chunk: ${input.cards.length} card(s), cut at ${cut}`);
    lines.push("");
    lines.push("Cards, in integration order (oldest first):");
    for (const [index, card] of input.cards.entries()) lines.push(cardLine(card, index));
  }

  if (input.run) {
    lines.push("");
    lines.push(`Run in view: ${input.run.adwId} - ${input.run.title} (${input.run.sentence})`);
  }

  lines.push("");
  lines.push(
    input.cards.length === 0
      ? "Assemble the shipping report in this checkout and tell me what it says."
      : "Walk this chunk against the record before anything moves to main. Ship only on my explicit word.",
  );

  return `${lines.join("\n")}\n`;
}
