/**
 * Machines (global — "Factory defaults") — the servers the factory actually
 * runs on, and the one-click deploy.
 *
 * The operator's sentence this pane exists to satisfy: *"hypothetically the
 * server has NO CLI tool, nothing... I put in the IP together with the password
 * and I click connect, which means the factory is set up."* So every control
 * here is wired to something that really happens on a real box. The previous
 * version of this file drew six controls and disabled all six; the honest state
 * for a thing that is not wired is to say so, but the honest state for a thing
 * that IS wired is to work.
 *
 * ── What is wired, and to what ──────────────────────────────────────────────
 *   Add server        POST   /api/app/machines            (connect, install key, save)
 *   live status       GET    /api/app/machines?probe=1    (a real SSH probe per row)
 *   Re-check          GET    /api/app/machines?refresh=1  (skips the 15s probe cache)
 *   Deploy factory    POST   /api/app/machines/:id/deploy (bootstrap.sh over SFTP)
 *   deploy log        GET    /api/app/machines/:id/deploy/status
 *   Remove            DELETE /api/app/machines/:id        (this registry only)
 *   Default machine   POST   /api/app/default-machine
 *   Runs on           POST   /api/app/p/:id/machine       (the project manifest)
 *
 * Exactly one control is still disabled, and it says why in its own words:
 * Failover has no mechanism behind it — nothing on this machine reads a second
 * machine when the first is unreachable, so a select that stored a choice would
 * be storing a decision nobody acts on.
 *
 * ── The credential sentence, printed where the credential is typed ──────────
 * The password is used ONCE, on the connect that installs this app's own
 * generated ed25519 key into the server's `~/.ssh/authorized_keys`. It is never
 * written to disk and never sent back in a response. That is a fact about
 * `server/app/machines.ts`, and this pane prints it beside the password field
 * rather than in a help page nobody opens.
 *
 * ── Plain browser vs the desktop shell ──────────────────────────────────────
 * Nothing here needs Electron. The SSH runs in the Bun server at :4700, so the
 * plain browser has every capability the packaged app has — no degraded mode to
 * declare, which is itself worth stating rather than leaving the operator to
 * wonder.
 *
 * ── Types ───────────────────────────────────────────────────────────────────
 * Declared here, on this directory's stated convention ("a surface owns its own
 * types in its own directory"), mirrored from `apps/ui/shared/types.ts`. ui-v3
 * is its own package and does not compile against the server's tsconfig, so
 * they cannot be imported across that boundary.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useShell } from "../App.tsx";
import { apiGet, apiPost, type Project } from "../lib/api.ts";
import { useResource, type Resource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { appToken } from "../lib/token.ts";
import { PlusIcon } from "./icons.tsx";

/* ── the shapes the registry routes answer with ─────────────────────────────*/

interface MachineProbe {
  reachable: boolean;
  checked_at: string;
  latency_ms: number | null;
  error: string | null;
  os: string | null;
  engine: string | null;
  factory_head: string | null;
  factory_branch: string | null;
}

interface DeployStep {
  name: string;
  state: "ok" | "fail";
  detail: string;
  at: string;
}

interface DeployJobView {
  job_id: string;
  machine_id: string;
  state: "running" | "done" | "failed";
  steps: DeployStep[];
  lines: string[];
  dropped: number;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  error: string | null;
  repo_url: string;
  branch: string;
  dir: string;
}

interface DeployNone {
  machine_id: string;
  state: "none";
  reason: string;
}

type DeployRead = DeployJobView | DeployNone;

interface MachineRegistryRow {
  id: string;
  name: string;
  kind: "local" | "server";
  role: string;
  host: string | null;
  port: number | null;
  user: string | null;
  key_path: string | null;
  key_generated: boolean;
  added_at: string | null;
  last_connected_at: string | null;
  repo_dir: string | null;
  /** `SHA256:...` of the host key pinned when this machine was added */
  host_fingerprint: string | null;
  probe: MachineProbe | null;
  probe_reason: string | null;
  deploy: DeployJobView | null;
}

interface MachinesRegistryResponse {
  machines: MachineRegistryRow[];
  default_machine: string | null;
  bindings: Record<string, string>;
  registry_path: string;
  key_dir: string;
  reason: string | null;
}

/** What `POST /api/app/machines` hands back — `steps` are the server's own
 * plain-words sentences about what it just did, printed verbatim. */
interface AddMachineResult {
  machine: { id: string; name: string; host: string };
  steps: string[];
}

interface RemoveResult {
  removed: string;
  note: string;
}

/* ── helpers ────────────────────────────────────────────────────────────────*/

/** `lib/api.ts` carries GET and POST only, and it belongs to the shell rather
 * than to this pane. The one DELETE in the app lives with the one surface that
 * makes it, and it sends the same `X-App-Token` every other write does. */
async function apiDelete<T>(path: string): Promise<T> {
  const token = appToken();
  const res = await fetch(path, {
    method: "DELETE",
    headers: { accept: "application/json", ...(token ? { "X-App-Token": token } : {}) },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`.trim();
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body?.error === "string" && body.error.trim()) message = body.error;
    } catch {
      /* not JSON — the status line is the honest answer */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A live probe is only worth as much as its age. Anything older than a minute
 * says how old it is rather than implying it is now. */
function agoText(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

const OK = "var(--ok)";
const FAIL = "var(--fail)";
const RUN = "var(--run)";
const DIM = "var(--t3)";

/** The status triple, everywhere: dot + bold id + one plain sentence. */
function statusOf(row: MachineRegistryRow): { color: string; id: string; sentence: string } {
  if (row.kind === "local") {
    return { color: DIM, id: "planning only", sentence: row.role };
  }
  if (row.probe === null) {
    return { color: DIM, id: "not checked", sentence: row.probe_reason ?? "this read did not probe the machine" };
  }
  if (!row.probe.reachable) {
    return { color: FAIL, id: "unreachable", sentence: row.probe.error ?? "the connection failed and said nothing" };
  }
  const parts: string[] = [];
  if (row.probe.os) parts.push(row.probe.os);
  if (row.probe.latency_ms !== null) parts.push(`${row.probe.latency_ms} ms`);
  parts.push(`checked ${agoText(row.probe.checked_at)}`);
  return { color: OK, id: "reachable", sentence: parts.join(" · ") };
}

/** What the row prints in the "factory" column — never a version this app did
 * not read. The engine's own `systemctl is-active` answer is the truth. */
function factoryOf(row: MachineRegistryRow): { color: string; text: string; title: string } {
  if (row.kind === "local") {
    return { color: DIM, text: "no factory", title: "the app runs here; the engine does not" };
  }
  if (row.probe === null || !row.probe.reachable) {
    return { color: DIM, text: "unknown here", title: "nothing was read from this machine on this pass" };
  }
  const engine = row.probe.engine ?? "unknown";
  const head = row.probe.factory_head;
  const branch = row.probe.factory_branch;
  const checkout = head ? `${branch ?? "?"} ${head}` : "no checkout";
  if (engine === "active") return { color: OK, text: `engine active · ${checkout}`, title: "systemctl is-active sdl-engine = active" };
  if (engine === "unknown") {
    return { color: DIM, text: `engine unknown · ${checkout}`, title: "systemd could not answer — this box may have no sdl-engine unit yet" };
  }
  return { color: FAIL, text: `engine ${engine} · ${checkout}`, title: `systemctl is-active sdl-engine = ${engine}` };
}

/* ── the add-server modal ───────────────────────────────────────────────────*/

type AuthMode = "password" | "key";

function AddServer({ onClose, onAdded }: { onClose: () => void; onAdded: (result: AddMachineResult) => void }) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("root");
  const [mode, setMode] = useState<AuthMode>("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const secretGiven = mode === "password" ? password.length > 0 : keyPath.trim().length > 0;
  const ready = host.trim().length > 0 && user.trim().length > 0 && secretGiven && !busy;

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSteps([]);
    try {
      const body: Record<string, unknown> = {
        name: name.trim() || undefined,
        host: host.trim(),
        port: Number(port) || 22,
        user: user.trim(),
      };
      if (mode === "password") body["password"] = password;
      else body["key_path"] = keyPath.trim();

      const result = await apiPost<AddMachineResult>("/api/app/machines", body);
      // The password leaves this component the moment the request is answered;
      // it was only ever in this field and in the request body.
      setPassword("");
      if (!alive.current) return;
      setSteps(result.steps ?? []);
      onAdded(result);
    } catch (caught) {
      if (!alive.current) return;
      setError(errorText(caught));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [host, keyPath, mode, name, onAdded, password, port, user]);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal add-project fade-in" role="dialog" aria-modal="true" aria-label="Add server">
        <div className="modal-header">
          <h3>Add server</h3>
          <div className="modal-sub">A bare Ubuntu box with an IP and a password is the whole starting condition.</div>
        </div>

        <div className="modal-body">
          <div className="modal-field">
            <label htmlFor="ms-host">Host or IP</label>
            <input
              id="ms-host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="203.0.113.10"
              autoComplete="off"
              disabled={busy}
            />
            <span className="field-hint">The address your provider gave you. Nothing needs to be installed on it.</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="modal-field">
              <label htmlFor="ms-user">User</label>
              <input id="ms-user" value={user} onChange={(event) => setUser(event.target.value)} autoComplete="off" disabled={busy} />
              <span className="field-hint">root, or a user with passwordless sudo.</span>
            </div>
            <div className="modal-field">
              <label htmlFor="ms-port">Port</label>
              <input id="ms-port" value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" disabled={busy} />
              <span className="field-hint">22 unless you moved sshd.</span>
            </div>
          </div>

          <div className="modal-field">
            <label htmlFor="ms-name">Name</label>
            <input
              id="ms-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={host.trim() || "the address, if you leave this empty"}
              autoComplete="off"
              disabled={busy}
            />
            <span className="field-hint">What this box is called in this app. Nothing on the server reads it.</span>
          </div>

          <div className="modal-field">
            <label htmlFor="ms-mode">How to sign in this once</label>
            <select id="ms-mode" value={mode} onChange={(event) => setMode(event.target.value as AuthMode)} disabled={busy}>
              <option value="password">Password — used once, then never again</option>
              <option value="key">A private key already on this laptop</option>
            </select>
          </div>

          {mode === "password" ? (
            <div className="modal-field">
              <label htmlFor="ms-password">Password</label>
              <input
                id="ms-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="off"
                disabled={busy}
              />
              <span className="field-hint">
                <strong>This password is used once and is never stored.</strong> Connect signs in with it, generates an
                ed25519 key for this app alone, installs the public half in the server&apos;s{" "}
                <code>~/.ssh/authorized_keys</code>, then reconnects using only that key to prove it works. The password
                is not written to any file, not put in the registry, and not sent back in any response. From then on this
                app authenticates with the key, which stays on this laptop and never enters git.
                <br />
                This first connect also <strong>pins the server&apos;s host key</strong>: there is nothing to compare it
                against yet, so it is trusted once and remembered, and every connection after this one — probe, deploy,
                and the credential sync — is refused unless that same key answers.
              </span>
            </div>
          ) : (
            <div className="modal-field">
              <label htmlFor="ms-key">Private key path</label>
              <input
                id="ms-key"
                value={keyPath}
                onChange={(event) => setKeyPath(event.target.value)}
                placeholder="C:\\Users\\you\\.ssh\\id_ed25519"
                autoComplete="off"
                disabled={busy}
              />
              <span className="field-hint">
                Your own key, used as it is. This app does not generate one, does not touch the server&apos;s
                authorized_keys, and does not copy the key anywhere. The server&apos;s host key is pinned on this first
                connect, and every connection afterwards must be answered by it.
              </span>
            </div>
          )}

          {error ? <span className="modal-error">{error}</span> : null}

          {steps.length > 0 ? (
            <div className="modal-field">
              <label>What happened</label>
              <div className="modal-steps">
                {steps.map((step, index) => (
                  <div className="step-row" key={`${index}-${step}`}>
                    <span className="step-dot" style={{ background: OK }} />
                    <span className="step-text">{step}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={onClose} disabled={busy}>
            {steps.length > 0 ? "Done" : "Cancel"}
          </button>
          <button type="button" className="modal-btn primary" onClick={() => void connect()} disabled={!ready}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── the per-machine deploy panel ───────────────────────────────────────────*/

const DEPLOY_POLL_MS = 900;

function DeployPanel({
  row,
  projects,
  defaultProjectId,
  onFinished,
}: {
  row: MachineRegistryRow;
  projects: Project[];
  defaultProjectId: string;
  onFinished: () => void;
}) {
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [job, setJob] = useState<DeployRead | null>(row.deploy);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const running = job !== null && job.state === "running";

  // Poll only while something is actually running. A finished deploy is a fact
  // that does not change, so re-reading it forever would be noise.
  useEffect(() => {
    if (!running) return;
    const read = async () => {
      try {
        const next = await apiGet<DeployRead>(`/api/app/machines/${encodeURIComponent(row.id)}/deploy/status`);
        if (!alive.current) return;
        setJob(next);
        if (next.state !== "running") onFinished();
      } catch (caught) {
        if (alive.current) setError(errorText(caught));
      }
    };
    const timer = window.setInterval(() => void read(), DEPLOY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, row.id, onFinished]);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const started = await apiPost<DeployJobView>(`/api/app/machines/${encodeURIComponent(row.id)}/deploy`, {
        project_id: projectId,
      });
      if (alive.current) setJob(started);
    } catch (caught) {
      if (alive.current) setError(errorText(caught));
    } finally {
      if (alive.current) setStarting(false);
    }
  }, [projectId, row.id]);

  const view = job !== null && job.state !== "none" ? (job as DeployJobView) : null;

  const headline = (() => {
    if (job === null) return "No deploy has been started for this machine from this app.";
    if (job.state === "none") return (job as DeployNone).reason;
    const done = view!;
    if (done.state === "running") return `Deploying ${done.branch} from ${done.repo_url} into ${done.dir}…`;
    if (done.state === "done") return `Deploy complete — ${done.branch} is checked out at ${done.dir} and sdl-engine is active.`;
    return done.error ?? `The deploy exited ${done.exit_code} without saying why.`;
  })();

  const headColor = job === null || job.state === "none" ? DIM : job.state === "running" ? RUN : job.state === "done" ? OK : FAIL;

  return (
    <div
      style={{
        margin: "0 0 18px 60px",
        padding: "14px 16px",
        border: "1px solid var(--hairline)",
        borderRadius: "var(--r-control)",
        background: "var(--canvas)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div className="form-label" style={{ fontWeight: 600 }}>
          Deploy factory
        </div>
        <select
          className="form-select compact"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          disabled={running || starting}
          aria-label="Which project's repository the server clones"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <button type="button" className="pr-btn" onClick={() => void start()} disabled={running || starting || projects.length === 0}>
          {running ? "Deploying…" : starting ? "Starting…" : view ? "Deploy again" : "Deploy"}
        </button>
        <span className="form-hint" style={{ flex: 1, minWidth: 180 }}>
          The server clones what this project&apos;s own <code>origin</code> points at — no URL is typed twice.
        </span>
      </div>

      <div className="status-triple">
        <span className="st-dot dot" style={{ background: headColor, width: 7, height: 7, borderRadius: "50%" }} />
        <span className="st-id">
          {job === null || job.state === "none" ? "not deployed" : job.state === "running" ? "running" : job.state}
        </span>
        <span className="st-sentence" style={{ whiteSpace: "normal" }} title={headline}>
          {headline}
        </span>
      </div>

      {error ? <span className="modal-error">{error}</span> : null}

      {view && view.steps.length > 0 ? (
        <div className="modal-steps" style={{ maxHeight: 260 }}>
          {view.steps.map((step, index) => (
            <div className="step-row" key={`${index}-${step.name}`}>
              <span className="step-dot" style={{ background: step.state === "ok" ? OK : FAIL }} />
              <span className="step-text">
                <strong style={{ fontFamily: "var(--font-mono)" }}>{step.name}</strong>
                {step.detail ? <span className="step-detail">{step.detail}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {view && view.lines.length > 0 ? (
        <details>
          <summary style={{ cursor: "pointer", fontSize: "var(--text-meta)", color: "var(--t3)" }}>
            Raw output from the server ({view.lines.length} lines
            {view.dropped > 0 ? `, ${view.dropped} older ones dropped` : ""})
          </summary>
          <pre
            style={{
              marginTop: 8,
              maxHeight: 240,
              overflow: "auto",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-mono)",
              color: "var(--t3)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {view.lines.join("\n")}
          </pre>
        </details>
      ) : null}

      <p className="section-note" style={{ marginTop: 0 }}>
        Every step is idempotent: deploying a second time reports <strong>already present</strong> down the list rather
        than installing anything twice. Planning skills under <code>~/.claude/skills</code> are stripped on the server
        (the factory&apos;s own <code>sssf</code> skill is kept) and what was removed is named in the log — the server
        executes, it does not plan.
      </p>
    </div>
  );
}

/* ── one machine row ────────────────────────────────────────────────────────*/

function Row({
  row,
  projects,
  defaultProjectId,
  isDefault,
  onChanged,
  onRemoved,
}: {
  row: MachineRegistryRow;
  projects: Project[];
  defaultProjectId: string;
  isDefault: boolean;
  onChanged: () => void;
  onRemoved: (note: string) => void;
}) {
  const isLocal = row.kind === "local";
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = statusOf(row);
  const factory = factoryOf(row);

  // A row whose deploy is mid-flight opens itself: a running job must never be
  // hidden behind a click the operator does not know to make.
  useEffect(() => {
    if (row.deploy?.state === "running") setOpen(true);
  }, [row.deploy?.state]);

  const remove = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiDelete<RemoveResult>(`/api/app/machines/${encodeURIComponent(row.id)}`);
      onRemoved(result.note);
      onChanged();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }, [onChanged, onRemoved, row.id]);

  return (
    <div>
      <div className="machine-row">
        <div
          className="mc-icon"
          style={
            isLocal
              ? { background: "var(--raised)", color: "var(--t2)" }
              : { background: "var(--accent-surface)", color: "var(--accent)" }
          }
        >
          {row.name.slice(0, 1).toUpperCase()}
        </div>

        <div className="mc-body">
          <div className="mc-name">
            {row.name}
            {isLocal ? (
              <span className="mc-tag dim">planning only</span>
            ) : (
              <>
                <span className="mc-tag">factory</span>
                {isDefault ? <span className="mc-tag dim">default</span> : null}
              </>
            )}
          </div>
          <div className="mc-meta">{isLocal ? row.role : `${row.user}@${row.host}:${row.port}`}</div>
        </div>

        <div className="mc-ip">{row.host ?? "—"}</div>

        <div className="mc-factory" title={factory.title}>
          <span className="dot" style={{ background: factory.color }} />
          {factory.text}
        </div>

        <div className="mc-status" title={status.sentence}>
          <span className="dot" style={{ background: status.color }} />
          {status.id}
        </div>

        <div className="mc-actions">
          {isLocal ? (
            <button
              type="button"
              className="pr-btn"
              disabled
              title="the app already runs here, and the engine deliberately does not — there is nothing to reach"
            >
              Local
            </button>
          ) : (
            <>
              <button type="button" className="pr-btn" onClick={() => setOpen((value) => !value)}>
                {open ? "Hide deploy" : "Deploy factory"}
              </button>
              {confirming ? (
                <>
                  <button type="button" className="pr-btn danger" onClick={() => void remove()} disabled={busy}>
                    {busy ? "Removing…" : "Confirm"}
                  </button>
                  <button type="button" className="pr-btn" onClick={() => setConfirming(false)} disabled={busy}>
                    Keep
                  </button>
                </>
              ) : (
                <button type="button" className="pr-btn danger" onClick={() => setConfirming(true)}>
                  Remove
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {!isLocal ? (
        <div style={{ margin: "-8px 0 10px 60px" }}>
          <div className="status-triple">
            <span className="st-dot dot" style={{ background: status.color, width: 7, height: 7, borderRadius: "50%" }} />
            <span className="st-id">{status.id}</span>
            <span className="st-sentence" style={{ whiteSpace: "normal" }}>
              {status.sentence}
            </span>
          </div>
          <p className="section-note mono" style={{ marginTop: 6 }} title="the server must answer with this exact host key or the connection is refused before anything is sent">
            {row.host_fingerprint
              ? `host key ${row.host_fingerprint} · pinned when this machine was added`
              : "host key not pinned yet — the next connection pins the key it sees"}
          </p>
          {confirming ? (
            <p className="section-note" style={{ marginTop: 6 }}>
              Remove takes this machine out of <strong>this laptop&apos;s registry only</strong>. Nothing on{" "}
              {row.host} is stopped, uninstalled or deleted — not the checkout, not the engine, not this app&apos;s key in
              its authorized_keys.
            </p>
          ) : null}
          {error ? <p className="section-note" style={{ color: "var(--fail)", marginTop: 6 }}>{error}</p> : null}
        </div>
      ) : null}

      {open && !isLocal ? (
        <DeployPanel row={row} projects={projects} defaultProjectId={defaultProjectId} onFinished={onChanged} />
      ) : null}
    </div>
  );
}

/* ── the pane ───────────────────────────────────────────────────────────────*/

const LIST_POLL_MS = 30_000;

export function Machines(_legacy: {
  /** The old read-only `/api/app/factory/machines` resource Settings still
   * fires for the tab count. This pane reads the real registry itself, so the
   * prop is accepted and ignored; pointing that count at `/api/app/machines`
   * is a one-line change in `Settings.tsx`, which this pane does not own. */
  machines?: Resource<unknown>;
}) {
  const { projectId, projects } = useShell();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  const list = useResource<MachinesRegistryResponse>("machines-registry", "/api/app/machines?probe=1", LIST_POLL_MS);
  const { refresh } = list;

  const servers = (list.data?.machines ?? []).filter((row) => row.kind === "server");
  const rows = list.data?.machines ?? [];

  const recheck = useCallback(async () => {
    setRechecking(true);
    setWriteError(null);
    try {
      // `refresh=1` makes the server skip its 15s probe cache and really open a
      // connection; the poll then re-reads the fresh answer.
      await apiGet<MachinesRegistryResponse>("/api/app/machines?probe=1&refresh=1");
      refresh();
    } catch (caught) {
      setWriteError(errorText(caught));
    } finally {
      setRechecking(false);
    }
  }, [refresh]);

  const setDefault = useCallback(
    async (machineId: string) => {
      setWriteError(null);
      try {
        await apiPost("/api/app/default-machine", { machine_id: machineId || null });
        setNotice(machineId ? "Default machine saved." : "Default machine cleared.");
        refresh();
      } catch (caught) {
        setWriteError(errorText(caught));
      }
    },
    [refresh],
  );

  const bind = useCallback(
    async (project: Project, machineId: string) => {
      setWriteError(null);
      try {
        await apiPost(`/api/app/p/${encodeURIComponent(project.id)}/machine`, { machine_id: machineId || null });
        setNotice(
          machineId
            ? `${project.name} runs on ${servers.find((row) => row.id === machineId)?.name ?? machineId}.`
            : `${project.name} has no machine bound — it will use the default.`,
        );
        refresh();
      } catch (caught) {
        setWriteError(errorText(caught));
      }
    },
    [refresh, servers],
  );

  return (
    <div className="form-body-content fade-in">
      <div className="form-panel-title">
        Machines · <span className="scope-name-inline">Factory defaults</span>
      </div>
      <div className="form-panel-sub">
        Planning happens on this laptop. Factory execution happens on a server. Add one with its IP and its password, and
        the rest is this app&apos;s job.
      </div>

      {list.error ? <ReadFailure error={list.error} /> : null}

      <div className="form-section">
        <div className="form-section-title">
          <span>
            Servers <span className="section-plain">— where factory instances run</span>
          </span>
          <span style={{ display: "inline-flex", gap: 14, alignItems: "center" }}>
            <button type="button" className="section-action" onClick={() => void recheck()} disabled={rechecking || servers.length === 0}>
              {rechecking ? "Checking…" : "Re-check now"}
            </button>
            <button type="button" className="section-action" onClick={() => setAdding(true)}>
              <PlusIcon /> Add server
            </button>
          </span>
        </div>

        {rows.length === 0 ? (
          <p className="section-empty">
            {list.loading
              ? "Reading this machine's server registry…"
              : "The registry read failed, so not even this machine's own row could be drawn — the line above carries the server's own words."}
          </p>
        ) : (
          <div className="machine-list">
            {rows.map((row) => (
              <Row
                key={row.id}
                row={row}
                projects={projects}
                defaultProjectId={projectId}
                isDefault={list.data?.default_machine === row.id}
                onChanged={refresh}
                onRemoved={setNotice}
              />
            ))}
          </div>
        )}

        {list.data?.reason ? <p className="section-note">{list.data.reason}</p> : null}

        {notice ? (
          <p className="section-note" style={{ color: "var(--t2)" }}>
            {notice}
          </p>
        ) : null}
        {writeError ? (
          <p className="section-note" style={{ color: "var(--fail)" }}>
            {writeError}
          </p>
        ) : null}

        <p className="section-note">
          A server row says <strong>reachable</strong> only when this app just spoke to it over SSH; anything it has not
          proven reads <strong>unreachable</strong> with the connection&apos;s own error, never a guess. The registry is{" "}
          <span className="section-note mono">{list.data?.registry_path ?? "~/.sdl-factory/machines.json"}</span> and the
          keys are in <span className="section-note mono">{list.data?.key_dir ?? "~/.sdl-factory/keys"}</span> — both
          outside every repository, so nothing about a machine can reach git.
        </p>
      </div>

      <div className="form-section">
        <div className="form-section-title">
          <span>
            Runs on <span className="section-plain">— which machine each project dispatches to</span>
          </span>
        </div>

        {projects.length === 0 ? (
          <p className="section-empty">No project is registered on this machine yet.</p>
        ) : (
          projects.map((project) => (
            <div className="form-row" key={project.id}>
              <div className="form-label-group">
                <div className="form-label">{project.name}</div>
                <div className="form-hint">{project.root}</div>
              </div>
              <select
                className="form-select compact"
                value={list.data?.bindings[project.id] ?? ""}
                onChange={(event) => void bind(project, event.target.value)}
                disabled={servers.length === 0}
              >
                <option value="">
                  {servers.length === 0 ? "no server registered" : "use the default machine"}
                </option>
                {servers.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </div>
          ))
        )}

        <p className="section-note">
          The binding is a field on this machine&apos;s own project list, beside the repository path — it never enters the
          project&apos;s repository. A project with no binding uses the default machine below.
        </p>
      </div>

      <div className="form-section">
        <div className="form-section-title">
          <span>Default dispatch</span>
        </div>

        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Default machine</div>
            <div className="form-hint">Where a project runs when nothing above binds it</div>
          </div>
          <select
            className="form-select compact"
            value={list.data?.default_machine ?? ""}
            onChange={(event) => void setDefault(event.target.value)}
            disabled={servers.length === 0}
          >
            <option value="">{servers.length === 0 ? "no server registered" : "none"}</option>
            {servers.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </div>

        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Failover</div>
            <div className="form-hint">If the default machine is unreachable, fall back to…</div>
          </div>
          <select className="form-select compact" disabled value="later">
            <option value="later">not wired — later</option>
          </select>
        </div>

        <p className="section-note">
          Failover is drawn and disabled on purpose: nothing in this app or in the engine moves a run to a second machine
          when the first goes quiet, so a choice stored here would be a decision nobody acts on. The default machine
          select above is real and writes to the registry as you pick it.
        </p>
      </div>

      <div className="lane-callout">
        <div className="lc-title">What Add server actually does</div>
        <div className="lc-body">
          Connect signs in once with the password you type, generates an ed25519 key for this app alone, installs its
          public half on the server, then reconnects with only that key to prove it works before anything is saved. The
          password is never written anywhere. That first connect also pins the box&apos;s <strong>host key</strong>: any
          later connection answered by a different key is refused by name, before a password, a provider API key or an
          OAuth token can be sent to it. <strong>Deploy factory</strong> then pushes one POSIX script over SFTP and
          runs it: apt essentials, uv, Node, just, clone your project&apos;s origin, check out <code>integration</code>,{" "}
          <code>uv sync</code>, the factory installer&apos;s server target, strip planning skills, and confirm{" "}
          <code>sdl-engine</code> is active. Each step reports itself as it happens, and a failure names the step and
          stops there. All of it runs in this app&apos;s own local server, so the browser at :4700 and the desktop app can
          do exactly the same things.
        </div>
      </div>

      {adding ? (
        <AddServer
          onClose={() => {
            setAdding(false);
            refresh();
          }}
          onAdded={(result) => {
            setNotice(`${result.machine.name} added — ${result.machine.host} answers to this app's own key now.`);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}
