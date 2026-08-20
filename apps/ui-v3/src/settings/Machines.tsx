/**
 * Machines (global — "Factory defaults") — the servers the factory runs on,
 * and the one-click deploy.
 *
 * The operator's sentence this pane exists to satisfy: *"hypothetically the
 * server has NO CLI tool, nothing... I put in the IP together with the password
 * and I click connect, which means the factory is set up."*
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
 * ── The layout, after the operator's ruling ─────────────────────────────────
 * An earlier build put a paragraph under every control and a second copy of
 * each machine's status underneath its own row. The verdict was *"you ruined
 * it."* So: one row per machine (name · host · factory · status dot · actions),
 * every long truth on the row's own `title=`, the deploy log visible only while
 * something is running or has just run, and the standing explanations behind
 * one "How this works" link at the foot of the section.
 *
 * The Failover select went out entirely rather than being drawn disabled with
 * an apology beside it: nothing in this app or the engine moves a run to a
 * second machine, so there was no control to draw. Nothing that could be
 * written was removed.
 *
 * The password is used ONCE, on the connect that installs this app's own
 * generated ed25519 key into the server's `~/.ssh/authorized_keys`. It is never
 * written to disk and never sent back in a response (`server/app/machines.ts`).
 *
 * ── The half a deploy does not finish ───────────────────────────────────────
 * `engine active` reads as done, and it is not: a box with no provider
 * credential on it cannot answer one prompt. So every server row carries what
 * the last provider sync landed there — a tag when something did, a warn Alert
 * with a word-link into Providers when nothing has. The same link is the last
 * line of a finished deploy. The counts come from
 * `GET /api/app/machines`'s own `providers` field; this pane reads no key and
 * is shown none.
 *
 * Types are declared here, on this directory's convention ("a surface owns its
 * own types in its own directory"), mirrored from `apps/ui/shared/types.ts`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useShell } from "../App.tsx";
import { apiGet, apiPost, type Project } from "../lib/api.ts";
import { useResource, type Resource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { appToken } from "../lib/token.ts";
import { PlusIcon } from "./icons.tsx";
import { Alert, HowThisWorks } from "./notices.tsx";

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

/** Counts from the last provider sync onto this machine. No key, no reason
 * string — enough to answer "does the factory here have any models?" */
interface MachineProviderSync {
  at: string;
  ok: boolean;
  applied: number;
  needs_you: number;
  failed: number;
  applied_ids: string[];
}

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
  /** null = no provider has ever been synced onto this box (see `providersOf`) */
  providers: MachineProviderSync | null;
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

/**
 * What this machine can actually run, in one word and one warning.
 *
 * `engine active` used to be the last thing this pane said, and it reads as
 * finished — but a box with no provider credential on it cannot answer one
 * prompt. So the missing half is a state of its own here: `null` (nothing was
 * ever synced) and `applied: 0` (a sync ran and landed nothing) both raise the
 * warning, and only a landed provider earns the tag.
 */
function providersOf(row: MachineRegistryRow): { tag: string | null; title: string; warn: string | null } {
  if (row.kind === "local") return { tag: null, title: "", warn: null };
  const sync = row.providers;
  if (sync === null) {
    return {
      tag: null,
      title: "No provider has been synced to this machine from this app.",
      warn: "no providers synced — the factory has no models here",
    };
  }
  const when = new Date(sync.at).toLocaleString();
  if (sync.applied === 0) {
    return {
      tag: null,
      title: `The sync at ${when} landed nothing: ${sync.needs_you} need you, ${sync.failed} failed.`,
      warn: "the last sync landed no provider — the factory has no models here",
    };
  }
  const pending = sync.needs_you + sync.failed;
  return {
    tag: `${sync.applied} provider${sync.applied === 1 ? "" : "s"}`,
    title: `${sync.applied_ids.join(", ")} synced to ${row.name} at ${when}.${pending > 0 ? ` ${sync.needs_you} still need you, ${sync.failed} failed - Providers says which.` : ""}`,
    // Deliberately no warning here. One provider is enough for the factory to
    // run, and most operators will always have a signed-in lane they never
    // carried over - a permanent alert for that would teach the eye to skip
    // the one alert that means the box is dead.
    warn: null,
  };
}

/** The one word that chains this pane to Providers. Settings panes are routes,
 * so this really navigates — the operator can come back to it. */
function GoProviders({ onGo, children }: { onGo: () => void; children: string }) {
  return (
    <button type="button" className="pa-link" onClick={onGo}>
      {children}
    </button>
  );
}

/** The pinned host key, as a tooltip line rather than a printed paragraph. */
function fingerprintText(row: MachineRegistryRow): string {
  if (row.kind === "local") return "";
  return row.host_fingerprint
    ? `Host key ${row.host_fingerprint}, pinned when this machine was added. Any connection answered by a different key is refused before anything is sent.`
    : "No host key pinned yet — the next connection pins the key it sees.";
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

  /** The app correcting the operator before the SSH attempt does it slowly. */
  const complaint = useCallback((): string | null => {
    const address = host.trim();
    if (address === "" || /\s/.test(address)) {
      return "Type the server's address — an IP like 203.0.113.10, or a hostname. No spaces.";
    }
    if (/^[a-z]+:\/\//i.test(address)) {
      return `Drop the scheme: this wants ${address.replace(/^[a-z]+:\/\//i, "")}, not a URL.`;
    }
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      return `Port ${port || "(empty)"} is not a port. SSH is on 22 unless you moved sshd.`;
    }
    return null;
  }, [host, port]);

  const connect = useCallback(async () => {
    const wrong = complaint();
    if (wrong) {
      setError(wrong);
      return;
    }
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
  }, [complaint, host, keyPath, mode, name, onAdded, password, port, user]);

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
          <div className="modal-sub" title="A bare Ubuntu box with nothing installed on it is enough.">
            An IP and a password is the whole starting condition.
          </div>
        </div>

        <div className="modal-body">
          {error ? <Alert onDismiss={() => setError(null)}>{error}</Alert> : null}

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
            <span className="field-hint" title="Nothing needs to be installed on the box first — a bare Ubuntu image is enough.">
              The address your provider gave you.
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="modal-field">
              <label htmlFor="ms-user">User</label>
              <input id="ms-user" value={user} onChange={(event) => setUser(event.target.value)} autoComplete="off" disabled={busy} />
              <span className="field-hint">root, or passwordless sudo.</span>
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
            <span className="field-hint" title="Nothing on the server reads this name.">
              What this box is called in this app.
            </span>
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
              <span
                className="field-hint"
                title="Connect signs in with it once, generates an ed25519 key for this app alone, installs the public half in the server's ~/.ssh/authorized_keys, then reconnects with only that key to prove it works. The password is not written to any file, not put in the registry, and not sent back in any response."
              >
                <strong>Used once, never stored.</strong>
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
              <span
                className="field-hint"
                title="Used as it is: this app generates no key, does not touch the server's authorized_keys, and copies your key nowhere."
              >
                Your own key, used as it is.
              </span>
            </div>
          )}

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
  onGoProviders,
}: {
  row: MachineRegistryRow;
  projects: Project[];
  defaultProjectId: string;
  onFinished: () => void;
  onGoProviders: () => void;
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

  /**
   * Stop a deploy that is not going to finish.
   *
   * Without this a wedged run held the machine for the life of the app server:
   * the server returns the RUNNING job for a machine that already has one, so
   * "Deploy again" silently did nothing and this panel polled a state that
   * would never change. Nothing on the far end is rolled back — every bootstrap
   * step is idempotent, so the next deploy converges from wherever this stopped.
   */
  const cancel = useCallback(async () => {
    setError(null);
    try {
      const stopped = await apiPost<DeployJobView>(`/api/app/machines/${encodeURIComponent(row.id)}/deploy/cancel`, {});
      if (alive.current) setJob(stopped);
    } catch (caught) {
      if (alive.current) setError(errorText(caught));
    }
  }, [row.id]);

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
        <button
          type="button"
          className="pr-btn"
          onClick={() => void start()}
          disabled={running || starting || projects.length === 0}
          // HONEST STATES: "the installer's server target" was true only of the
          // sdl-factory repo itself, which is the only checkout that carries
          // installer/. A stamped project takes bootstrap.sh's inline path,
          // whose step 14b says out loud that it cannot converge the pi
          // providers or skylos. Both paths are named here rather than the one
          // the operator will almost never take.
          title="Pushes one POSIX script over SFTP and runs it: apt essentials, uv, Node, just, clone this project's own origin, check out integration, uv sync, then either the installer's server target (only the sdl-factory repo has an installer/) or the same steps inline (any stamped project — that path cannot converge the pi providers or skylos, and says so), then confirm sdl-engine is active. Every step is idempotent."
        >
          {running ? "Deploying…" : starting ? "Starting…" : view ? "Deploy again" : "Deploy"}
        </button>
        {running ? (
          <button
            type="button"
            className="pr-btn danger"
            onClick={() => void cancel()}
            title="Drops the SSH connection, which stops the script on the machine. Nothing is rolled back - every step is idempotent, so the next deploy carries on from where this one stopped."
          >
            Cancel
          </button>
        ) : null}
        <span className="form-hint" style={{ flex: 1, minWidth: 160 }} title="No repository URL is ever typed twice.">
          Clones this project&apos;s own <code>origin</code>
        </span>
      </div>

      <div className="status-triple">
        <span className="st-dot dot" style={{ background: headColor, width: 7, height: 7, borderRadius: "50%" }} />
        <span className="st-id">
          {job === null || job.state === "none" ? "not deployed" : job.state === "running" ? "running" : job.state}
        </span>
        <span className="st-sentence" title={headline}>
          {headline}
        </span>
      </div>

      {error ? <Alert onDismiss={() => setError(null)}>{error}</Alert> : null}

      {/* The journey's next link. A finished deploy is an installed factory
          with nothing to think with, and this is the only place the operator
          is looking when that becomes true. */}
      {view?.state === "done" && (row.providers === null || row.providers.applied === 0) ? (
        <Alert kind="warn">
          Factory installed — now <GoProviders onGo={onGoProviders}>sync providers</GoProviders>, or this box runs no model.
        </Alert>
      ) : null}

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
  onGoProviders,
}: {
  row: MachineRegistryRow;
  projects: Project[];
  defaultProjectId: string;
  isDefault: boolean;
  onChanged: () => void;
  onRemoved: (note: string) => void;
  onGoProviders: () => void;
}) {
  const isLocal = row.kind === "local";
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = statusOf(row);
  const factory = factoryOf(row);
  const credentials = providersOf(row);

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
                {credentials.tag ? (
                  <span className="mc-tag dim" title={credentials.title}>
                    {credentials.tag}
                  </span>
                ) : null}
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

        <div className="mc-status" title={`${status.sentence}\n\n${fingerprintText(row)}`}>
          <span className="dot" style={{ background: status.color }} />
          <span className="mc-state">
            <span className="mc-state-id">{status.id}</span>
            <span className="mc-state-why">{status.sentence}</span>
          </span>
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
              <button type="button" className="pr-btn" onClick={() => setOpen((value) => !value)} title="Install or update the factory on this server">
                {open ? "Hide deploy" : "Deploy"}
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

      {/* The state that is invisible everywhere else: a box the factory is
          installed on, with no credential to think with. */}
      {credentials.warn ? (
        <Alert kind="warn">
          <strong>{row.name}</strong>: {credentials.warn}.{" "}
          <GoProviders onGo={onGoProviders}>Sync providers</GoProviders>
        </Alert>
      ) : null}

      {confirming ? (
        <Alert kind="warn" onDismiss={() => setConfirming(false)}>
          Remove takes {row.name} out of this laptop&apos;s list only — nothing on {row.host} is stopped or deleted.
        </Alert>
      ) : null}
      {error ? <Alert onDismiss={() => setError(null)}>{error}</Alert> : null}

      {open && !isLocal ? (
        <DeployPanel
          row={row}
          projects={projects}
          defaultProjectId={defaultProjectId}
          onFinished={onChanged}
          onGoProviders={onGoProviders}
        />
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
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  /** The other half of the journey. Providers is a global pane, so any
   * project's path reaches the same one. */
  const goProviders = useCallback(
    () => navigate(`/p/${encodeURIComponent(projectId)}/settings/providers`),
    [navigate, projectId],
  );

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
      <div className="form-panel-sub">You plan here; the factory runs on a server you add with its IP and password.</div>

      {list.error ? <ReadFailure error={list.error} /> : null}
      {writeError ? <Alert onDismiss={() => setWriteError(null)}>{writeError}</Alert> : null}
      {notice ? (
        <Alert kind="ok" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      ) : null}

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
            {list.loading ? "Reading this machine's server registry…" : "No machine could be read."}
            <span className="se-note">{list.loading ? "" : "The message above carries the server's own words."}</span>
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
                onGoProviders={goProviders}
              />
            ))}
          </div>
        )}

        <HowThisWorks label="What Add server and Deploy actually do">
          <p>
            <strong>Connect</strong> signs in once with the password you type, generates an ed25519 key for this app
            alone, installs its public half on the server, then reconnects with only that key to prove it works before
            anything is saved. The password is never written anywhere. That first connect also pins the box&apos;s host
            key: a later connection answered by a different key is refused before a password, an API key or an OAuth
            token can be sent to it.
          </p>
          <p>
            <strong>Deploy</strong> pushes one POSIX script over SFTP and runs it — apt essentials, uv, Node, just, clone
            your project&apos;s origin, check out <code>integration</code>, <code>uv sync</code>, the installer&apos;s
            server target, strip planning skills, confirm <code>sdl-engine</code> is active. Each step reports itself; a
            failure names the step and stops there. Running it twice reports <strong>already present</strong> rather
            than installing anything twice.
          </p>
          <p>
            A deploy installs the factory, not the accounts it thinks with: a box with no provider synced onto it runs
            no model. Its row says so until one lands, and{" "}
            <GoProviders onGo={goProviders}>Providers</GoProviders> is where that is done.
          </p>
          <p>
            A row says <strong>reachable</strong> only when this app just spoke to the box over SSH — anything unproven
            reads unreachable with the connection&apos;s own error. The registry is{" "}
            <code>{list.data?.registry_path ?? "~/.sdl-factory/machines.json"}</code> and the keys are in{" "}
            <code>{list.data?.key_dir ?? "~/.sdl-factory/keys"}</code>, both outside every repository. All of it runs in
            this app&apos;s own local server, so the browser and the desktop app can do exactly the same things.
            {list.data?.reason ? ` ${list.data.reason}` : ""}
          </p>
        </HowThisWorks>
      </div>

      <div className="form-section">
        <div className="form-section-title">
          <span>
            {/* HONEST STATES: still no dispatch routing — every deployed box's
                engine works whatever its own checkout holds, and nothing here
                sends it work. What the binding DOES do now is decide which
                machine this app reads a project's engine health and run history
                from (server/app/remote.ts), so the caption names that and
                nothing more. */}
            Runs on{" "}
            <span className="section-plain">
              — the machine this app reads that project&apos;s engine and runs from; it still routes no work
            </span>
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

        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Everything else</div>
            {/* Same honesty as the section title above: this value is stored and
                shown (it is what puts the "default" badge on a row) and nothing
                dispatches by it. */}
            <div className="form-hint" title="The binding is a field on this machine's own project list, beside the repository path — it never enters the project's repository.">
              The machine marked default when nothing above names one
            </div>
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
