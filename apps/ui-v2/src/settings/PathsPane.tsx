/**
 * Server, data and machine facts - the sections that used to be a **Paths and
 * data** pane of their own.
 *
 * The 2026-08-14 layout pass folded that pane into **Project** (the operator's
 * note: "settings pages are inert words"; two panes of read-only facts about
 * one project are one pane). So this file exports sections rather than a pane,
 * and `Settings.tsx` composes them beside the project's own four facts. The
 * content, the honesty rules and the one departure below are unchanged.
 *
 * Its original brief (spec 2.8, W3-D4):
 *
 *   "server facts (bind 127.0.0.1:4700, build time, read-only) + the
 *    **Machine** block (not per-project): free probes `uv` / `just` / `pi`,
 *    dot + id + one sentence, and a **Full check** button whose label names
 *    its token cost ... `expected-unavailable` is never counted as an issue
 *    (the count is `failed + needs-operator` only). Nothing runs at app
 *    start."
 *
 * All three probes render, passing ones included: a green `uv` row and a
 * missing `just` row are both facts, and showing only the failures made
 * "probed and passing" look identical to "never probed" (DEF-7). The `uv`
 * probe now comes from `/api/app/providers` like the other two, so no row is
 * invented here.
 *
 * One honest departure, stated rather than papered over:
 *
 * **Full check hands back a command instead of running one.** Spec 1.3 is
 *    categorical that "exactly two commands may ever create a job" (init git,
 *    init factory), so there is no endpoint that could spawn
 *    `installer/install.py --verify-only` and no way to add one inside this
 *    chunk. The control therefore does what §2.3 does when the bridge is
 *    absent: it produces the real command as copyable text and never a fake
 *    result. The label still names the cost, which is the point of the rule.
 */
import { useState } from "react";
import { useShell } from "../App.tsx";
import { useResource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { StatusTriple } from "../shared/StatusTriple.tsx";
import { factoryAbsent, type ConfigBody } from "./config.ts";
import { CopyLine, Field, Section } from "./parts.tsx";
import { providerTone, type ProviderRow } from "./ProvidersPane.tsx";

/** Spec's machine set, in spec's order. Every one of them renders once a
 * response lands - a probe the server omitted says so, it does not vanish. */
const MACHINE_PROBES = ["uv", "just", "pi"] as const;

/** `--verify-only`'s V2 pass is a paid round trip - 39,501 tokens on this
 * box, measured, which is why the number is in the label rather than in a
 * warning sentence under it. */
const FULL_CHECK_TOKENS = "39,501";
const FULL_CHECK_COMMAND = "uv run installer/install.py --verify-only";

export function PathsSections({ config }: { config: ConfigBody | null }) {
  const { projectId } = useShell();
  const providers = useResource<ProviderRow[]>(`${projectId}|providers`, "/api/app/providers");
  const [showCommand, setShowCommand] = useState(false);

  // Every probe in the spec's set keeps its slot, in the spec's order, with
  // whatever the response carried for it - `null` meaning the server did not
  // report it, which is a different thing from the probe failing.
  const machine = MACHINE_PROBES.map((id) => ({
    id,
    row: (providers.data ?? []).find((row) => row.id === id) ?? null,
  }));
  // The count is failures only. There is no `expected-unavailable` state in
  // this app's probes, and `ready` is not an issue - so the arithmetic that
  // audit F6 got wrong cannot be written here. An unreported probe is not
  // counted either: nothing is known about it to count.
  const needsYou = machine.filter(({ row }) => row !== null && row.state !== "ready").length;

  const server = config && !factoryAbsent(config) ? config.paths : null;
  const data = config && !factoryAbsent(config) ? config.observability : null;

  return (
    <>
      {/* A section whose every field is absent does not render its label
          either - an empty heading is the layout form of an em-dash. */}
      {server ? (
        <Section label="Server">
          <Field label="Bind" value={`${server.bind}:${server.port}`} />
          <Field label="Access" value={server.read_only ? "read-only" : null} />
          <Field label="Build time" value={server.build_time} />
        </Section>
      ) : null}

      {data ? (
        <Section label="Data">
          {/* No `Db` row here. It is spec 2.8's own second Project fact ("root,
              db path, branch, remote") and `Settings.tsx` prints it there; when
              this section moved into that pane, the two groups met and the same
              absolute path was drawn twice, four rows apart, both ellipsised.
              The spec-named group keeps the fact; the absorbed one drops it. */}
          <Field label="Journal mode" value={data.journal_mode} />
          <Field label="Poll" value={`${data.poll_ms}ms`} />
          <Field label="Data dir" value={data.data_dir} />
          <Field label="Sessions dir" value={data.sessions_dir} />
          <Field label="Runs" value={data.session_count} />
        </Section>
      ) : null}

      <Section label="Machine">
        <div className="flex flex-col gap-1">
          {providers.data
            ? machine.map(({ id, row }) =>
                row ? (
                  <StatusTriple
                    key={id}
                    tone={providerTone(row.state)}
                    identifier={row.version ? `${row.id} ${row.version}` : row.id}
                    sentence={row.detail}
                  />
                ) : (
                  <StatusTriple key={id} tone="neutral" identifier={id} sentence="Not reported by the server." />
                ),
              )
            : null}
        </div>
        {providers.error ? <ReadFailure error={providers.error} /> : null}
        {needsYou > 0 ? <p className="mt-2 text-meta text-t3">{needsYou} need you</p> : null}

        <div className="mt-3 flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={showCommand}
            onClick={() => setShowCommand((open) => !open)}
            className="self-start rounded-control border border-hairline bg-raised px-2 py-1 text-body text-t2 hover:border-accent hover:text-accent"
          >
            Full check · {FULL_CHECK_TOKENS} tokens
          </button>
          {showCommand ? (
            <>
              <CopyLine text={FULL_CHECK_COMMAND} />
              <p className="text-meta text-t3">Runs in your terminal.</p>
            </>
          ) : null}
        </div>
      </Section>
    </>
  );
}
