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
 * ── The catalog ────────────────────────────────────────────────────────────
 * Roster's model dropdown reads `/api/app/models`, which shells
 * `pi -ne --list-models` — pi's MERGED catalog, so a provider written into
 * ~/.pi/agent/models.json shows up there with no extra plumbing. That endpoint
 * caches for the life of the server process, so every successful apply here
 * fires `?refresh=1` at it; without that the operator would add a provider and
 * find Roster still blind to it until a restart.
 */
import { useCallback, useMemo, useState } from "react";
import { apiGet, apiPost } from "../lib/api.ts";
import { useResource, type Resource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { PlusIcon } from "./icons.tsx";
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

/** Only what this pane needs off the machine registry: a name to sync to. */
interface MachineRow {
  id: string;
  name: string;
  kind: "local" | "server";
  host: string | null;
  user: string | null;
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

/** The status triple: dot, bold state, plain sentence. Used for every state on
 * this pane so a row never reads two different ways. */
function Triple({ color, word, sentence }: { color: string; word: string; sentence: string }) {
  return (
    <div className="pr-status" title={sentence} style={{ flexDirection: "column", alignItems: "flex-end", gap: 2, whiteSpace: "normal" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="dot" style={{ background: color }} />
        <strong style={{ color: "var(--t1)", fontWeight: 600 }}>{word}</strong>
      </span>
      <span style={{ color: "var(--t3)", textAlign: "right", maxWidth: 320, lineHeight: 1.5 }}>{sentence}</span>
    </div>
  );
}

function modelWords(row: ProviderApiKeyRow): string {
  if (row.models.length === 0) return "no models named — pi will list none for this lane";
  return `${row.models.length} ${row.models.length === 1 ? "model" : "models"} · ${row.models.map((model) => model.id).join(", ")}`;
}

/* ── add provider (bucket A) ────────────────────────────────────────────────*/

function AddProviderModal({
  presets,
  onClose,
  onAdded,
}: {
  presets: ProviderPreset[];
  onClose: () => void;
  onAdded: (id: string, applied: ProviderLocalState) => void;
}) {
  const [presetId, setPresetId] = useState<string>(presets[0]?.id ?? "custom");
  const preset = presets.find((entry) => entry.id === presetId) ?? null;

  const [id, setId] = useState(presets[0]?.id ?? "");
  const [label, setLabel] = useState(presets[0]?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(presets[0]?.base_url ?? "");
  const [api, setApi] = useState(presets[0]?.api ?? "openai-completions");
  const [models, setModels] = useState((presets[0]?.models ?? []).join(", "));
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = (chosen: string) => {
    setPresetId(chosen);
    const next = presets.find((entry) => entry.id === chosen);
    if (!next) {
      setId("");
      setLabel("");
      setBaseUrl("");
      setApi("openai-completions");
      setModels("");
      return;
    }
    setId(next.id);
    setLabel(next.label);
    setBaseUrl(next.base_url);
    setApi(next.api);
    setModels(next.models.join(", "));
  };

  const submit = async () => {
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
      setError(errorText(caught));
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
          <div className="modal-sub">An account with an API key. A second account of one you already have is a second row here — and a second lane.</div>
        </div>

        <div className="modal-body" style={{ overflowY: "auto" }}>
          <div className="modal-field">
            <label htmlFor="ap-preset">Start from</label>
            <select id="ap-preset" value={presetId} onChange={(event) => choose(event.target.value)} disabled={busy}>
              {presets.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
              <option value="custom">Something else (type it all)</option>
            </select>
            <span className="field-hint">{preset ? preset.source_note : "Every field is yours. pi takes any OpenAI-compatible endpoint."}</span>
          </div>

          <div className="modal-field">
            <label htmlFor="ap-id">Provider id</label>
            <input id="ap-id" value={id} spellCheck={false} disabled={busy} placeholder="ollama-cloud-2" onChange={(event) => setId(event.target.value)} />
            <span className="field-hint">
              This is the lane name — the part before the slash in <code>ollama-cloud/kimi-k2.7-code</code>. Lowercase, digits, dot,
              dash and underscore.
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
            <span className="field-hint">
              One of <code>openai-completions</code>, <code>openai-responses</code>, <code>anthropic-messages</code>,{" "}
              <code>google-generative-ai</code> — pi&apos;s own four words.
            </span>
          </div>

          <div className="modal-field">
            <label htmlFor="ap-models">Model ids</label>
            <input id="ap-models" value={models} spellCheck={false} disabled={busy} placeholder="kimi-k2.7-code, glm-5.2" onChange={(event) => setModels(event.target.value)} />
            <span className="field-hint">
              Comma separated. A provider with no models named resolves nothing — pi lists exactly what is written here.
            </span>
          </div>

          <div className="modal-field">
            <label htmlFor="ap-key">API key</label>
            <input id="ap-key" type="password" value={apiKey} spellCheck={false} disabled={busy} autoComplete="off" onChange={(event) => setApiKey(event.target.value)} />
            <span className="field-hint">
              Stored on this laptop at <code>~/.sdl-factory/providers.json</code> with mode 0600, and written into pi&apos;s own
              <code> ~/.pi/agent/auth.json</code> here. <strong>It never enters git and never comes back out of this app</strong> —
              the row below will show a fingerprint, not the key.
            </span>
          </div>

          {error ? <span className="modal-error">{error}</span> : null}
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

  /** Per-provider result from the last sync to the chosen machine — the row's
   * "synced / needs you / unknown". */
  const lastFor = (id: string): ProviderSyncResult | null => {
    const stored = chosen ? (run?.machine_id === chosen.id ? run : (data?.sync[chosen.id] ?? null)) : null;
    return stored?.results.find((result) => result.provider_id === id) ?? null;
  };

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
      <div className="form-panel-sub">
        A provider is an account — one account is one lane and one rate-limit bucket. A second account of the same service is a
        second row here, with its own id.
      </div>

      {providers.error ? <ReadFailure error={providers.error} /> : null}
      {writeError ? <p className="modal-error">{writeError}</p> : null}
      {notice ? <p className="section-note">{notice}</p> : null}

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
            {providers.loading
              ? "Reading this machine's provider registry…"
              : (data?.reason ?? "No API-key provider is registered on this machine.")}
            {data ? <span className="se-note">{data.registry_path}</span> : null}
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
                    {last ? (
                      <span className="pr-tag" style={{ color: SYNC_COLOR[last.state], background: "transparent" }} title={last.reason}>
                        {SYNC_WORD[last.state]} · {chosen?.name}
                      </span>
                    ) : null}
                  </div>
                  <div className="pr-auth">
                    {row.auth_mechanism} · key {row.key_fingerprint}
                  </div>
                  <div className="pr-auth" title={row.base_url}>
                    {row.api} · {row.base_url}
                  </div>
                </div>
                <div className="pr-models" title={modelWords(row)}>
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
          <p className="section-note">
            <strong>{projectName}</strong>&apos;s roster draws on {unkeyedLanes.join(", ")}, which {unkeyedLanes.length === 1 ? "has" : "have"} no
            key registered here. That is fine if the credential already lives on the factory machine — this pane only knows what it
            was told.
          </p>
        ) : null}

        <p className="section-note">
          Keys live at <strong>{data?.registry_path ?? "~/.sdl-factory/providers.json"}</strong> (0600) and, once applied, in{" "}
          <strong>{data?.pi_auth_path ?? "~/.pi/agent/auth.json"}</strong> (0600). The provider block written into{" "}
          <strong>{data?.pi_models_path ?? "~/.pi/agent/models.json"}</strong> carries no key at all — pi reads auth.json first, so
          the file that describes the provider stays inert.
        </p>
        <p className="section-note">{data?.catalog_note}</p>
      </div>

      {/* ── bucket B ────────────────────────────────────────────────────── */}
      <div className="form-section">
        <div className="form-section-title">
          <span>Signed in</span>
        </div>
        <div className="lane-callout">
          <div className="lc-title">These two have no key to type</div>
          <div className="lc-body">
            Claude and Codex are subscription logins. This pane reads whether you are signed in on this machine — the file&apos;s
            existence, never its contents — and carries what a server needs when you sync. Signing in itself opens a browser, so it
            stays yours.
          </div>
        </div>

        {(data?.signed_in ?? []).map((row) => {
          const last = lastFor(row.id);
          return (
            <div className="provider-row" key={row.id}>
              <div className="pr-icon">{row.label.slice(0, 1).toUpperCase()}</div>
              <div className="pr-body">
                <div className="pr-name">
                  {row.label} <span className="pr-tag">{row.cli}</span>
                  {last ? (
                    <span className="pr-tag" style={{ color: SYNC_COLOR[last.state], background: "transparent" }} title={last.reason}>
                      {SYNC_WORD[last.state]} · {chosen?.name}
                    </span>
                  ) : null}
                </div>
                <div className="pr-auth">{row.auth_mechanism}</div>
                <div className="pr-auth" title={row.artifact_path}>
                  {row.artifact_path}
                  {row.artifact_mtime ? ` · last changed ${new Date(row.artifact_mtime).toLocaleString()}` : ""}
                </div>
                {row.detected ? null : <div className="form-hint">How to sign in: {row.how_to_sign_in}</div>}
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
                    <span className="field-hint">
                      Sent with the next sync and written on the machine only, into its own ~/.sdl-factory/secrets.env (0600). This
                      laptop never stores it, and the box clears itself once the sync has run.
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
      </div>

      {/* ── sync ────────────────────────────────────────────────────────── */}
      <div className="form-section">
        <div className="form-section-title">
          <span>Sync to a machine</span>
        </div>
        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Write these credentials onto a server</div>
            <div className="form-hint">
              Over the same SSH connection Machines made: API keys into the machine&apos;s ~/.pi/agent/auth.json, a Claude token into
              its ~/.sdl-factory/secrets.env, this machine&apos;s Codex login copied across. Every provider reports for itself.
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
                </option>
              ))
            )}
          </select>
          <button type="button" className="pr-btn" disabled={!chosen || syncing} onClick={() => void sync()}>
            {syncing ? "Syncing…" : chosen ? `Sync providers to ${chosen.name}` : "Sync providers"}
          </button>
        </div>

        {servers.length === 0 ? (
          <p className="section-empty">
            No server is registered on this machine, so there is nothing to sync to. Settings → Machines takes an IP and a password
            once.
            {machines.error ? <span className="se-note">{machines.error}</span> : null}
          </p>
        ) : null}

        {run ? (
          <div className="modal-steps" style={{ marginTop: 12, maxHeight: "none" }}>
            {run.results.map((result) => (
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
              <span className="step-dot" style={{ background: run.ok ? "var(--ok)" : "var(--warn)" }} />
              <span className="step-text">
                {run.ok
                  ? `Every provider landed on ${run.machine_name}.`
                  : `Some providers need you, or failed, on ${run.machine_name}. Each line above says which and why.`}
                <span className="step-detail">{new Date(run.at).toLocaleString()}</span>
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
