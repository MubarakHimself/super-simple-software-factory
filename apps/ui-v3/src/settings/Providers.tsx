/**
 * Providers (global — "Factory defaults") — J6.1, change-list #12.
 *
 * The previous version of this file drew six controls and disabled all six.
 * The operator's verdict on that: *"none of these buttons actually work."*
 * Every control here is wired to something that really happens on a real file
 * on a real machine, and the one thing that genuinely cannot be automated
 * (`claude setup-token` opens a browser and waits for a human) says exactly
 * that, in those words, beside the one box that finishes the job.
 *
 * ── The two buckets, and why the split is real ─────────────────────────────
 * A PROVIDER here is an ACCOUNT / LANE — never a model family. Nothing on this
 * pane feeds the cross-family reviewer rule; that reads MODEL names, in Roster.
 *
 *   API KEY   Ollama Cloud, OpenCode Go, OpenRouter, and anything else
 *             OpenAI-compatible. You type a name and a key. The key is stored
 *             on this laptop at ~/.sdl-factory/providers.json (0600, never git)
 *             and written into pi's own auth store here if pi is installed.
 *   SIGNED IN Claude and Codex, and only those two. There is no key field
 *             because there is no key: they are subscription logins. This pane
 *             reads their local auth artifacts for existence and mtime and
 *             never opens their contents.
 *
 * ── What is wired, and to what ─────────────────────────────────────────────
 *   the rows        GET  /api/app/providers-v3
 *   Add provider    POST /api/app/providers-v3/add     (registry + local pi)
 *   Apply           POST /api/app/providers-v3/apply   (local pi only)
 *   Remove          POST /api/app/providers-v3/remove  (registry only)
 *   Sync to machine POST /api/app/providers-v3/sync    (over SSH, per provider)
 *   machine list    GET  /api/app/machines?probe=0
 *
 * ── Honest states, everywhere ──────────────────────────────────────────────
 * `applied` means two files on this machine really carry the provider.
 * `stored` means the key is on file and nothing here could apply it — because
 * pi is not installed on this laptop, which is the normal case for a planning
 * machine. It is never dressed up as success. Per machine, a row is `synced`,
 * `needs you` or `unknown`, and `unknown` is what it says before any sync has
 * ever run: this pane does not poll a server it was not asked to touch.
 *
 * ── What survives a reload ─────────────────────────────────────────────────
 * `syncToMachine` writes its run back into `~/.sdl-factory/providers.json`, so
 * `GET /api/app/providers-v3` returns the last run per machine and everything
 * a sync said — every per-provider line, the machine's name and the time —
 * renders again tomorrow. `live` is the one bit that does not survive, and the
 * summary line says so rather than implying the state was just re-checked.
 *
 * ── The journey chains both ways ───────────────────────────────────────────
 * A key with no machine is as stuck as a machine with no key, so the empty
 * state here links into Machines, and every machine row over there warns and
 * links back here until a provider has actually landed on it.
 *
 * ── The catalog ────────────────────────────────────────────────────────────
 * Roster's model dropdown reads `/api/app/models`, which shells
 * `pi -ne --list-models` — pi's MERGED catalog, so a provider written into
 * ~/.pi/agent/models.json shows up there with no extra plumbing. That endpoint
 * caches for the life of the server process, so every successful apply here
 * fires `?refresh=1` at it; without that the operator would add a provider and
 * find Roster still blind to it until a restart.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useShell } from "../App.tsx";
import { apiGet, apiPost } from "../lib/api.ts";
import { useResource, type Resource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { PlusIcon } from "./icons.tsx";
import { Alert, HowThisWorks } from "./notices.tsx";
import type { ProviderDefinitionsResponse } from "./types.ts";

/* ── the shapes the routes answer with ──────────────────────────────────────
   Declared here on this directory's stated convention ("a surface owns its own
   types in its own directory"), mirrored from apps/ui/shared/types.ts. ui-v3 is
   its own package and does not compile against the server's tsconfig. */

interface ProviderLocalState {
  state: "applied" | "stored" | "missing";
  reason: string;
  pi_auth_entry: boolean;
  pi_models_entry: boolean;
}

interface ProviderApiKeyRow {
  id: string;
  label: string;
  bucket: "api-key";
  auth_mechanism: string;
  api: string;
  base_url: string;
  models: { id: string; name: string | null }[];
  key_fingerprint: string;
  added_at: string;
  updated_at: string;
  source: string;
  local: ProviderLocalState;
}

interface ProviderSignedInRow {
  id: "claude" | "codex";
  label: string;
  bucket: "signed-in";
  auth_mechanism: string;
  cli: string;
  cli_path: string | null;
  detected: boolean;
  detail: string;
  artifact_path: string;
  artifact_present: boolean;
  artifact_mtime: string | null;
  token_available: boolean;
  token_source: string | null;
  how_to_sign_in: string;
  sync_note: string;
}

interface ProviderPreset {
  id: string;
  label: string;
  api: string;
  base_url: string;
  auth_header: boolean;
  compat: Record<string, unknown> | null;
  models: string[];
  key_env: string | null;
  key_placeholder: string;
  models_note: string;
  source_note: string;
}

interface ProviderSyncResult {
  provider_id: string;
  bucket: "api-key" | "signed-in";
  state: "applied" | "needs-you" | "failed";
  reason: string;
}

interface ProviderSyncRun {
  machine_id: string;
  machine_name: string;
  at: string;
  ok: boolean;
  results: ProviderSyncResult[];
}

interface ProvidersV3Response {
  api_key: ProviderApiKeyRow[];
  signed_in: ProviderSignedInRow[];
  presets: ProviderPreset[];
  sync: Record<string, ProviderSyncRun>;
  registry_path: string;
  pi_auth_path: string;
  pi_models_path: string;
  reason: string | null;
  catalog_note: string;
}

/** Only what this pane needs off the machine registry: a name to sync to, and
 * whether anything has ever landed there — a box with nothing on it is the one
 * most likely to be the box the operator meant to pick. */
interface MachineRow {
  id: string;
  name: string;
  kind: "local" | "server";
  host: string | null;
  user: string | null;
  providers: { applied: number } | null;
}

interface MachinesRegistryResponse {
  machines: MachineRow[];
  default_machine: string | null;
}

/* ── small helpers ──────────────────────────────────────────────────────────*/

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

const LOCAL_COLOR: Record<ProviderLocalState["state"], string> = {
  applied: "var(--ok)",
  stored: "var(--warn)",
  missing: "var(--fail)",
};

const LOCAL_WORD: Record<ProviderLocalState["state"], string> = {
  applied: "applied here",
  stored: "stored",
  missing: "not applied",
};

const SYNC_COLOR: Record<ProviderSyncResult["state"], string> = {
  applied: "var(--ok)",
  "needs-you": "var(--warn)",
  failed: "var(--fail)",
};

const SYNC_WORD: Record<ProviderSyncResult["state"], string> = {
  applied: "synced",
  "needs-you": "needs you",
  failed: "failed",
};

/** The row tag's whole sentence: what happened, to which machine, WHEN, and
 * the server's own reason. The `when` is the half a reload used to lose — the
 * run is persisted in the providers registry precisely so this reads the same
 * tomorrow as it does one second after the sync. */
function syncTitle(result: ProviderSyncResult, run: ProviderSyncRun): string {
  return `${SYNC_WORD[result.state]} to ${run.machine_name} at ${new Date(run.at).toLocaleString()} — ${result.reason}`;
}

/** The state of a row: a dot and one word. The server's own sentence about WHY
 * it is in that state rides on the tooltip — it is the answer to a question the
 * operator only sometimes asks, and it used to be three lines of prose in every
 * single row. */
function Triple({ color, word, sentence }: { color: string; word: string; sentence: string }) {
  return (
    <div className="pr-status" title={sentence}>
      <span className="dot" style={{ background: color }} />
      <strong style={{ color: "var(--t1)", fontWeight: 600 }}>{word}</strong>
    </div>
  );
}

/** What the row prints; the full list is the tooltip. */
function modelWords(row: ProviderApiKeyRow): string {
  if (row.models.length === 0) return "no models named";
  return `${row.models.length} ${row.models.length === 1 ? "model" : "models"}`;
}

function modelList(row: ProviderApiKeyRow): string {
  if (row.models.length === 0) return "No model id is registered for this provider, so pi will list none for this lane.";
  return row.models.map((model) => model.id).join(", ");
}

/** A provider id is a lane name and the part before the slash in a model
 * string, so pi's own grammar for it is the grammar this box enforces. */
const ID_RULE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * `source_note` carries provenance for all nine presets, and for two of them
 * (Together AI's `.ai` vs the older `.xyz` host; Z.AI's pay-as-you-go path vs a
 * Coding Plan's) it carries the words NOT VERIFIED and the reason. On a preset
 * whose endpoint might 404, that half is the whole point — and a `title=` the
 * operator has already clicked past is not where it can live. So it is cut out
 * of the note and shown, in words, the moment that preset is chosen.
 */
const NOT_VERIFIED = "NOT VERIFIED";

function caveat(note: string): string | null {
  const at = note.indexOf(NOT_VERIFIED);
  if (at === -1) return null;
  return note.slice(at + NOT_VERIFIED.length).replace(/^[:\s]+/, "").trim() || null;
}

/* ── add provider (bucket A) ────────────────────────────────────────────────*/

/**
 * The catalog is the first thing in the modal and the whole of the shortcut: a
 * grid of names, one click, and the boxes below fill in. What it is NOT is a
 * connection — a preset carries a base URL somebody verified and a starter
 * model list that ages, and nothing more. The row it produces goes down the
 * same add path as one typed by hand and shows the same honest state, so
 * "applied" still means two files on this machine really carry the provider.
 * Every field stays editable, and Custom starts blank.
 */
function AddProviderModal({
  presets,
  onClose,
  onAdded,
}: {
  presets: ProviderPreset[];
  onClose: () => void;
  onAdded: (id: string, applied: ProviderLocalState) => void;
}) {
  // Nothing is chosen until the operator chooses: nine presets and a silent
  // default would put one vendor's endpoint in the boxes unasked.
  const [presetId, setPresetId] = useState<string>("");
  const preset = presets.find((entry) => entry.id === presetId) ?? null;

  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState("openai-completions");
  const [models, setModels] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The one box no preset can ever fill, so it is the one that gets focus. */
  const keyRef = useRef<HTMLInputElement>(null);
  /** The alert sits at the TOP of `.modal-body`, which scrolls. Choosing a
   * preset scrolls the form down to the key box, so an alert raised after that
   * renders entirely above the scroll viewport: the operator clicks "Add
   * provider", the modal does not visibly move, and the reason it refused is
   * off-screen. The refusal has to be where the eye is, so raising one brings
   * it into view. */
  const alertRef = useRef<HTMLDivElement>(null);

  /** Set the refusal AND scroll it into view - never one without the other. */
  const raise = useCallback((message: string) => {
    setError(message);
    requestAnimationFrame(() => alertRef.current?.scrollIntoView({ block: "nearest" }));
  }, []);

  const choose = (chosen: string) => {
    setPresetId(chosen);
    setError(null);
    const next = presets.find((entry) => entry.id === chosen);
    if (!next) {
      setId("");
      setLabel("");
      setBaseUrl("");
      setApi("openai-completions");
      setModels("");
    } else {
      setId(next.id);
      setLabel(next.label);
      setBaseUrl(next.base_url);
      setApi(next.api);
      setModels(next.models.join(", "));
    }
    keyRef.current?.focus();
  };

  /** The app correcting the operator before the server has to. Each sentence
   * says what is wrong and what to type instead. */
  const complaint = (): string | null => {
    const wanted = id.trim().toLowerCase();
    if (!ID_RULE.test(wanted)) {
      return `"${id.trim()}" cannot be a provider id. Use lowercase letters, digits, dot, dash and underscore, starting with a letter or digit — for example ollama-cloud-2.`;
    }
    if (!/^https?:\/\//i.test(baseUrl.trim())) {
      return "The base URL has to start with http:// or https:// — paste the endpoint your provider gave you, ending in /v1.";
    }
    if (models.trim() === "") {
      return "Name at least one model id, one per line or comma separated. A provider with no models resolves nothing and will not appear in the Roster dropdown.";
    }
    return null;
  };

  const submit = async () => {
    const wrong = complaint();
    if (wrong) {
      raise(wrong);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await apiPost<{ provider: ProviderApiKeyRow }>("/api/app/providers-v3/add", {
        id: id.trim().toLowerCase(),
        label: label.trim(),
        api: api.trim(),
        base_url: baseUrl.trim(),
        auth_header: preset ? preset.auth_header : true,
        compat: preset?.compat ?? null,
        models: models
          .split(/[,\n]/)
          .map((word) => word.trim())
          .filter(Boolean),
        key: apiKey,
        source: preset ? preset.id : "operator",
      });
      onAdded(response.provider.id, response.provider.local);
    } catch (caught) {
      raise(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const ready = id.trim() !== "" && baseUrl.trim() !== "" && apiKey.trim() !== "";

  return (
    <div
      className="modal-overlay"
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal fade-in" role="dialog" aria-modal="true" aria-label="Add provider" style={{ width: 520, maxHeight: "88vh" }}>
        <div className="modal-header">
          <h3>Add a provider</h3>
          <div className="modal-sub">One account, one lane.</div>
        </div>

        <div className="modal-body" style={{ overflowY: "auto" }}>
          <div ref={alertRef}>{error ? <Alert onDismiss={() => setError(null)}>{error}</Alert> : null}</div>

          <div className="modal-field">
            <label>Start from</label>
            <div className="preset-grid">
              {presets.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`preset-chip${presetId === entry.id ? " on" : ""}`}
                  disabled={busy}
                  title={entry.source_note}
                  onClick={() => choose(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
              <button
                type="button"
                className={`preset-chip${presetId === "custom" ? " on" : ""}`}
                disabled={busy}
                title="pi takes any OpenAI-compatible endpoint. Every box below is yours to fill."
                onClick={() => choose("custom")}
              >
                Custom
              </button>
            </div>
            <span
              className="field-hint"
              title={
                preset
                  ? `${preset.source_note} Picking it fills the boxes below and nothing else - the row's state still comes from what is actually written.`
                  : "A preset fills the boxes below. It does not test the endpoint, does not check the key, and never makes a row say applied on its own."
              }
            >
              {preset ? `Prefilled from ${preset.label}. Edit anything.` : "Fills the boxes. Connects nothing."}
            </span>
            {preset && caveat(preset.source_note) ? (
              <Alert kind="warn">
                <strong>{preset.label}&apos;s endpoint is not verified.</strong> {caveat(preset.source_note)}
              </Alert>
            ) : null}
          </div>

          <div className="modal-field">
            <label htmlFor="ap-id">Provider id</label>
            <input id="ap-id" value={id} spellCheck={false} disabled={busy} placeholder="ollama-cloud-2" onChange={(event) => setId(event.target.value)} />
            <span
              className="field-hint"
              title="The part before the slash in ollama-cloud/kimi-k2.7-code. Lowercase letters, digits, dot, dash and underscore."
            >
              The lane name.
            </span>
          </div>

          <div className="modal-field">
            <label htmlFor="ap-label">Name to show</label>
            <input id="ap-label" value={label} disabled={busy} placeholder="Ollama Cloud" onChange={(event) => setLabel(event.target.value)} />
          </div>

          <div className="modal-field">
            <label htmlFor="ap-base">Base URL</label>
            <input id="ap-base" value={baseUrl} spellCheck={false} disabled={busy} placeholder="https://…/v1" onChange={(event) => setBaseUrl(event.target.value)} />
          </div>

          <div className="modal-field">
            <label htmlFor="ap-api">API</label>
            <input id="ap-api" value={api} spellCheck={false} disabled={busy} onChange={(event) => setApi(event.target.value)} />
            <span
              className="field-hint"
              title="pi's own four words: openai-completions, openai-responses, anthropic-messages, google-generative-ai"
            >
              pi&apos;s word for the wire format.
            </span>
          </div>

          <div className="modal-field">
            <label htmlFor="ap-models">Model ids</label>
            <textarea
              id="ap-models"
              rows={2}
              value={models}
              spellCheck={false}
              disabled={busy}
              placeholder="kimi-k2.7-code, glm-4.7"
              onChange={(event) => setModels(event.target.value)}
            />
            <span
              className="field-hint"
              title={`pi lists exactly what is written here, and nothing else. ${preset ? preset.models_note : "One id per line, or comma separated."}`}
            >
              One per line or comma separated. Edit freely — model names age.
            </span>
          </div>

          <div className="modal-field">
            <label htmlFor="ap-key">API key</label>
            <input
              id="ap-key"
              ref={keyRef}
              type="password"
              value={apiKey}
              spellCheck={false}
              disabled={busy}
              autoComplete="off"
              placeholder={preset ? preset.key_placeholder : "paste the key your provider gave you"}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <span
              className="field-hint"
              title={`Stored on this laptop at ~/.sdl-factory/providers.json (0600) and written into pi's own ~/.pi/agent/auth.json here. It never enters git and never comes back out of this app.${preset?.key_env ? ` ${preset.label} documents this key as ${preset.key_env}; this app does not read that variable, it stores what you paste.` : ""}`}
            >
              Kept on this laptop only; the row will show a fingerprint, never the key.
            </span>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="modal-btn primary" onClick={() => void submit()} disabled={busy || !ready}>
            {busy ? "Adding…" : "Add provider"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── the pane ───────────────────────────────────────────────────────────────*/

export function Providers({
  projectName,
  definitions,
}: {
  projectName: string;
  /** The git-tracked `installer/assets/pi/*.provider.json` read Settings fires
   * for the tab count. This pane reads its own registry; the definitions are
   * used for one honest cross-check: a lane the roster names that has no key
   * here. */
  definitions: Resource<ProviderDefinitionsResponse>;
}) {
  const providers = useResource<ProvidersV3Response>("providers-v3", "/api/app/providers-v3");
  const machines = useResource<MachinesRegistryResponse>("providers-machines", "/api/app/machines?probe=0");
  const { refresh } = providers;
  const { projectId } = useShell();
  const navigate = useNavigate();

  /** The other half of the journey: a key with no machine to put it on is as
   * stuck as a machine with no key. Machines is a global pane, so any
   * project's path reaches the same one. */
  const goMachines = useCallback(
    () => navigate(`/p/${encodeURIComponent(projectId)}/settings/machines`),
    [navigate, projectId],
  );

  const [addOpen, setAddOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [claudeToken, setClaudeToken] = useState("");
  const [machineId, setMachineId] = useState<string>("");
  const [syncing, setSyncing] = useState(false);
  const [run, setRun] = useState<ProviderSyncRun | null>(null);

  const data = providers.data;
  const servers = useMemo(() => (machines.data?.machines ?? []).filter((row) => row.kind === "server"), [machines.data]);
  const chosen = servers.find((row) => row.id === machineId) ?? servers[0] ?? null;

  /** The catalog is what Roster reads. An apply that does not refresh it leaves
   * the operator staring at a dropdown that has not noticed. */
  const refreshCatalog = useCallback(async () => {
    try {
      await apiGet("/api/app/models?refresh=1");
    } catch {
      /* the catalog probe is pi's business, not this pane's - a failure here
         does not make the apply less true, and Roster reports its own. */
    }
  }, []);

  const apply = useCallback(
    async (id: string) => {
      setBusyId(id);
      setWriteError(null);
      setNotice(null);
      try {
        const response = await apiPost<{ provider: ProviderApiKeyRow }>("/api/app/providers-v3/apply", { id });
        setNotice(`${id}: ${response.provider.local.reason}`);
        await refreshCatalog();
        refresh();
      } catch (caught) {
        setWriteError(errorText(caught));
      } finally {
        setBusyId(null);
      }
    },
    [refresh, refreshCatalog],
  );

  const remove = useCallback(
    async (id: string) => {
      setBusyId(id);
      setWriteError(null);
      setNotice(null);
      try {
        const response = await apiPost<{ note: string }>("/api/app/providers-v3/remove", { id });
        setNotice(response.note);
        refresh();
      } catch (caught) {
        setWriteError(errorText(caught));
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const sync = useCallback(async () => {
    if (!chosen) return;
    setSyncing(true);
    setWriteError(null);
    setNotice(null);
    try {
      const body: { machine_id: string; claude_token?: string } = { machine_id: chosen.id };
      if (claudeToken.trim()) body.claude_token = claudeToken.trim();
      const response = await apiPost<ProviderSyncRun>("/api/app/providers-v3/sync", body);
      setRun(response);
      // The pasted token was for this one sync; it lives on the machine now and
      // nowhere here. Clearing the box is part of that promise.
      setClaudeToken("");
      refresh();
    } catch (caught) {
      setWriteError(errorText(caught));
    } finally {
      setSyncing(false);
    }
  }, [chosen, claudeToken, refresh]);

  /**
   * The sync this pane is describing: the one that just ran when it was for the
   * chosen machine, otherwise the one the registry remembers for it. A reload
   * loses the first and keeps the second — which is the whole reason
   * `syncToMachine` writes its run back into `providers.json`, and why every
   * result below still renders after the operator closes the app.
   */
  const shown: ProviderSyncRun | null = chosen ? (run?.machine_id === chosen.id ? run : (data?.sync[chosen.id] ?? null)) : null;
  /** true when `shown` is this session's own run rather than a remembered one */
  const live = shown !== null && shown === run;

  /** Per-provider result from that run — the row's "synced / needs you". */
  const lastFor = (id: string): ProviderSyncResult | null =>
    shown?.results.find((result) => result.provider_id === id) ?? null;

  /** Lanes the roster names that have no key on this laptop. A lane the factory
   * draws on with no credential registered is a fact worth one line. */
  const unkeyedLanes = (definitions.data?.providers ?? [])
    .filter((definition) => definition.in_roster && !(data?.api_key ?? []).some((row) => row.id === definition.id))
    .map((definition) => definition.id);

  return (
    <div className="form-body-content fade-in">
      <div className="form-panel-title">
        Providers &amp; auth · <span className="scope-name-inline">Factory defaults</span>
      </div>
      <div className="form-panel-sub">A provider is an account, and one account is one lane.</div>

      {providers.error ? <ReadFailure error={providers.error} /> : null}
      {writeError ? <Alert onDismiss={() => setWriteError(null)}>{writeError}</Alert> : null}
      {notice ? (
        <Alert kind="ok" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      ) : null}

      {/* ── bucket A ────────────────────────────────────────────────────── */}
      <div className="form-section">
        <div className="form-section-title">
          <span>API key</span>
          <button type="button" className="section-action" onClick={() => setAddOpen(true)} disabled={!data}>
            <PlusIcon />
            Add provider
          </button>
        </div>

        {(data?.api_key.length ?? 0) === 0 ? (
          <p className="section-empty">
            {providers.loading ? "Reading this machine's provider registry…" : "No API-key provider yet."}
            <span className="se-note">{providers.loading ? "" : "Add provider takes a name, an endpoint and a key."}</span>
          </p>
        ) : (
          data!.api_key.map((row) => {
            const last = lastFor(row.id);
            return (
              <div className="provider-row" key={row.id}>
                <div className="pr-icon">{row.label.slice(0, 1).toUpperCase()}</div>
                <div className="pr-body">
                  <div className="pr-name">
                    {row.label} <span className="pr-tag">{row.id}</span>
                    {last && shown ? (
                      <span className="pr-tag" style={{ color: SYNC_COLOR[last.state], background: "transparent" }} title={syncTitle(last, shown)}>
                        {SYNC_WORD[last.state]} · {shown.machine_name}
                      </span>
                    ) : null}
                  </div>
                  <div className="pr-auth" title={`${row.auth_mechanism} · ${row.api} · ${row.base_url}`}>
                    key {row.key_fingerprint} · {row.base_url}
                  </div>
                </div>
                <div className="pr-models" title={modelList(row)}>
                  {modelWords(row)}
                </div>
                <Triple color={LOCAL_COLOR[row.local.state]} word={LOCAL_WORD[row.local.state]} sentence={row.local.reason} />
                <div className="pr-actions">
                  <button
                    type="button"
                    className="pr-btn"
                    disabled={busyId !== null}
                    onClick={() => void apply(row.id)}
                    title="write this provider into pi's own auth.json and models.json on this machine"
                  >
                    {busyId === row.id ? "…" : "Apply here"}
                  </button>
                  <button
                    type="button"
                    className="pr-btn danger"
                    disabled={busyId !== null}
                    onClick={() => void remove(row.id)}
                    title="removes the row and its key from this laptop's registry only - pi's own files and any machine you synced are left exactly as they are"
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })
        )}

        <button type="button" className="provider-add" onClick={() => setAddOpen(true)} disabled={!data}>
          <PlusIcon />
          <span>Add a new provider…</span>
        </button>

        {unkeyedLanes.length > 0 ? (
          <Alert kind="warn">
            <strong>{projectName}</strong>&apos;s roster draws on {unkeyedLanes.join(", ")}, which {unkeyedLanes.length === 1 ? "has" : "have"} no
            key here. Add the key, or check it already lives on the factory machine.
          </Alert>
        ) : null}

        <HowThisWorks label="Where these keys live">
          <p>
            Keys are on this laptop at <code>{data?.registry_path ?? "~/.sdl-factory/providers.json"}</code> (0600) and,
            once applied, in <code>{data?.pi_auth_path ?? "~/.pi/agent/auth.json"}</code> (0600). The block written into{" "}
            <code>{data?.pi_models_path ?? "~/.pi/agent/models.json"}</code> carries no key at all. Neither file is in any
            repository.
          </p>
          {data?.catalog_note ? <p>{data.catalog_note}</p> : null}
          {data?.reason ? <p>{data.reason}</p> : null}
        </HowThisWorks>
      </div>

      {/* ── bucket B ────────────────────────────────────────────────────── */}
      <div className="form-section">
        <div className="form-section-title">
          <span>
            Signed in <span className="section-plain">— subscription logins, no key to type</span>
          </span>
        </div>

        {(data?.signed_in ?? []).map((row) => {
          const last = lastFor(row.id);
          return (
            <div className="provider-row" key={row.id}>
              <div className="pr-icon">{row.label.slice(0, 1).toUpperCase()}</div>
              <div className="pr-body">
                <div className="pr-name">
                  {row.label} <span className="pr-tag">{row.cli}</span>
                  {last && shown ? (
                    <span className="pr-tag" style={{ color: SYNC_COLOR[last.state], background: "transparent" }} title={syncTitle(last, shown)}>
                      {SYNC_WORD[last.state]} · {shown.machine_name}
                    </span>
                  ) : null}
                </div>
                <div
                  className="pr-auth"
                  title={`${row.auth_mechanism} · ${row.artifact_path}${row.artifact_mtime ? ` · last changed ${new Date(row.artifact_mtime).toLocaleString()}` : ""}`}
                >
                  {row.auth_mechanism}
                  {row.artifact_mtime ? ` · last changed ${new Date(row.artifact_mtime).toLocaleDateString()}` : ""}
                </div>
                {row.detected ? null : (
                  <div className="form-hint" title={row.how_to_sign_in}>
                    Sign in with <code>{row.how_to_sign_in}</code>
                  </div>
                )}
                {row.id === "claude" && !row.token_available ? (
                  <div className="modal-field" style={{ marginTop: 8, maxWidth: 420 }}>
                    <label htmlFor="claude-token">Token from `claude setup-token`</label>
                    <input
                      id="claude-token"
                      type="password"
                      value={claudeToken}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="paste it here, then sync"
                      onChange={(event) => setClaudeToken(event.target.value)}
                    />
                    {/* One command mints it, and this app cannot run that
                        command for you: `claude setup-token` opens a browser
                        and waits for a human. The box is write-only — the
                        token is sent with the next sync, never read back by
                        any route, and the field clears itself afterwards. */}
                    <span
                      className="field-hint"
                      title="Mint it with one command on a machine that has a browser: `claude setup-token` (run `claude` once first if you have never logged in). Paste what it prints here. It is sent with the next sync and written on THAT machine only, into its own ~/.sdl-factory/secrets.env (0600) - one paste per machine. This laptop never stores it, no route ever reads it back, and the box clears itself once the sync has run."
                    >
                      Mint it with <code>claude setup-token</code>; it goes to the server on the next sync, never stored here.
                    </span>
                  </div>
                ) : null}
              </div>
              <div className="pr-models" title={row.sync_note}>
                {row.sync_note}
              </div>
              <Triple
                color={row.detected ? "var(--ok)" : "var(--warn)"}
                word={row.detected ? "signed in" : "not signed in"}
                sentence={row.detail}
              />
              <div className="pr-actions">
                <button
                  type="button"
                  className="pr-btn"
                  onClick={() => refresh()}
                  title="re-read this machine's auth artifacts - signing in happens in a terminal, so this is how the row catches up"
                >
                  Re-check
                </button>
              </div>
            </div>
          );
        })}

        <HowThisWorks label="What signed in means here">
          <p>
            Claude and Codex are subscription logins, not keys. This pane reads whether their auth file exists on this
            machine and when it last changed — never its contents — and carries what a server needs when you sync.
            Signing in itself opens a browser, so it stays yours; <strong>Re-check</strong> is how a row catches up after
            you have done it in a terminal.
          </p>
        </HowThisWorks>
      </div>

      {/* ── sync ────────────────────────────────────────────────────────── */}
      <div className="form-section">
        <div className="form-section-title">
          <span>Sync to a machine</span>
        </div>
        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Write these credentials onto a server</div>
            <div
              className="form-hint"
              title="Over the same SSH connection Machines made: API keys into the machine's ~/.pi/agent/auth.json, a Claude token into its ~/.sdl-factory/secrets.env, this machine's Codex login copied across."
            >
              Over the SSH connection Machines already made
            </div>
          </div>
          <select
            className="form-select"
            value={chosen?.id ?? ""}
            onChange={(event) => setMachineId(event.target.value)}
            disabled={servers.length === 0 || syncing}
          >
            {servers.length === 0 ? (
              <option value="">no server registered</option>
            ) : (
              servers.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} ({row.user}@{row.host})
                  {(row.providers?.applied ?? 0) === 0 ? " · nothing synced yet" : ` · ${row.providers!.applied} synced`}
                </option>
              ))
            )}
          </select>
          <button type="button" className="pr-btn" disabled={!chosen || syncing} onClick={() => void sync()}>
            {syncing ? "Syncing…" : chosen ? `Sync providers to ${chosen.name}` : "Sync providers"}
          </button>
        </div>

        {servers.length === 0 ? (
          <Alert kind="warn">
            No server registered, so there is nothing to sync to —{" "}
            <button type="button" className="pa-link" onClick={goMachines}>
              add one in Machines
            </button>
            . {machines.error ?? "It takes an IP and a password, once."}
          </Alert>
        ) : null}

        {/* Rendered from `shown`, not from this session's `run`: the registry
            remembers the last sync per machine, so re-opening the app still
            says what landed on that box and when. */}
        {shown ? (
          <div className="modal-steps" style={{ marginTop: 12, maxHeight: "none" }}>
            {shown.results.map((result) => (
              <div className="step-row" key={`${result.provider_id}-${result.state}`}>
                <span className="step-dot" style={{ background: SYNC_COLOR[result.state] }} />
                <span className="step-text">
                  <strong>
                    {result.provider_id} · {SYNC_WORD[result.state]}
                  </strong>
                  <span className="step-detail">{result.reason}</span>
                </span>
              </div>
            ))}
            <div className="step-row">
              <span className="step-dot" style={{ background: shown.ok ? "var(--ok)" : "var(--warn)" }} />
              <span className="step-text">
                {shown.ok
                  ? `Every provider landed on ${shown.machine_name}.`
                  : `Some providers need you, or failed, on ${shown.machine_name}. Each line above says which and why.`}
                <span className="step-detail">
                  synced to {shown.machine_name} at {new Date(shown.at).toLocaleString()}
                  {live ? "" : " · remembered from the last sync, not re-checked"}
                </span>
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {addOpen && data ? (
        <AddProviderModal
          presets={data.presets}
          onClose={() => setAddOpen(false)}
          onAdded={(id, local) => {
            setAddOpen(false);
            setNotice(`${id}: ${local.reason}`);
            void refreshCatalog();
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}
