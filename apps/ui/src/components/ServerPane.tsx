import { useEffect, useState } from "react";
import { navigate, terminalPath } from "@/routes";
import { announceExternalSession } from "@/lib/terminalBus";
import { usePoll } from "@/lib/poll";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ServerConfig, TunnelStatus } from "@/types/factory";

const EMPTY_CONFIG: ServerConfig = { host: "", keyPath: "", remotePort: 4700, localPort: 4701 };

const STATE_LABEL: Record<TunnelStatus["state"], string> = {
  idle: "not connected",
  connecting: "connecting...",
  connected: "connected",
  closed: "tunnel closed",
  error: "error",
};

const STATE_DOT: Record<TunnelStatus["state"], string> = {
  idle: "bg-[var(--color-text-meta)]",
  connecting: "bg-[var(--color-warning)]",
  connected: "bg-[var(--color-success)]",
  closed: "bg-[var(--color-text-meta)]",
  error: "bg-[var(--color-fail)]",
};

/** Action IPC is origin-gated (spec 5.4): setConfig/deploy/connect are
 * denied when this pane happens to be rendered from the tunnel's own
 * origin (viewing a remote server's dashboard). A rejected invoke is an
 * honest state, not a bug - render it plainly rather than swallow it. */
function actionUnavailableMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("untrusted origin")) {
    return "This action is only available from the local app, not while viewing a remote server through the tunnel.";
  }
  return message;
}

/**
 * Settings > Server (spec 5). Config is read/written by main via
 * window.factory.server.* - never through the read-only GET api, which
 * never learns this exists. In a plain browser (no bridge) this renders the
 * same desktop-only empty state as the Terminal surface (spec 3.6).
 */
export function ServerPane() {
  if (typeof window === "undefined" || window.factory?.isDesktop !== true) {
    return (
      <div className="rounded-md border border-border bg-elevated px-3 py-3 text-[11.5px] text-muted-foreground">
        The Server lens is desktop-only. Open the SDL Factory desktop app to configure or connect to a remote
        factory.
      </div>
    );
  }
  return <DesktopServerPane />;
}

function DesktopServerPane() {
  const [config, setConfig] = useState<ServerConfig>(EMPTY_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const tunnel = usePoll<TunnelStatus>(() => window.factory!.server.status(), 3000);

  useEffect(() => {
    let cancelled = false;
    void window.factory!.server.getConfig().then((c) => {
      if (!cancelled) {
        setConfig(c);
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function field<K extends keyof ServerConfig>(key: K) {
    return {
      value: String(config[key]),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value;
        setConfig((prev) => ({
          ...prev,
          [key]: key === "remotePort" || key === "localPort" ? Number(raw) || 0 : raw,
        }));
      },
    };
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await window.factory!.server.setConfig(config);
      if (!result.ok) setSaveError(result.error ?? "could not save");
    } catch (error) {
      setSaveError(actionUnavailableMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeploy() {
    setDeploying(true);
    setDeployError(null);
    try {
      const result = await window.factory!.server.deploy();
      if ("error" in result) {
        setDeployError(result.error);
        return;
      }
      announceExternalSession(result.sessionId, "deploy");
      navigate(terminalPath);
    } catch (error) {
      setDeployError(actionUnavailableMessage(error));
    } finally {
      setDeploying(false);
    }
  }

  async function handleConnect() {
    setConnecting(true);
    setConnectError(null);
    try {
      const result = await window.factory!.server.connect();
      if (!result.ok) setConnectError(result.error ?? "could not connect");
      // on success the window navigates to the tunnel origin - this
      // component's own instance on the old origin unmounts on its own.
    } catch (error) {
      setConnectError(actionUnavailableMessage(error));
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setConnectError(null);
    try {
      await window.factory!.server.disconnect();
    } catch (error) {
      setConnectError(actionUnavailableMessage(error));
    }
  }

  const state = tunnel.data?.state ?? "idle";
  const isConnectedOrConnecting = state === "connected" || state === "connecting";

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px]">
          <span className={`inline-block size-1.5 rounded-full ${STATE_DOT[state]}`} />
          <span className="font-semibold text-foreground">{STATE_LABEL[state]}</span>
          {tunnel.data?.origin && <span className="mono text-[10.5px] text-muted-foreground">{tunnel.data.origin}</span>}
        </div>
        {tunnel.data?.message && (
          <div className="mb-2 text-[11px] text-muted-foreground">{tunnel.data.message}</div>
        )}
        {connectError && <div className="mb-2 text-[11px] text-[var(--color-fail)]">{connectError}</div>}
        <div className="flex gap-2">
          {state === "connected" || state === "connecting" ? (
            <Button size="sm" variant="secondary" onClick={() => void handleDisconnect()}>
              Disconnect
            </Button>
          ) : (
            <Button size="sm" onClick={() => void handleConnect()} disabled={connecting}>
              {state === "closed" || state === "error" ? "Reconnect" : "Connect"}
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border border-border bg-elevated p-2.5">
        <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
          Connection
        </div>
        <div className="space-y-1.5">
          <Row label="host">
            <Input placeholder="root@203.0.113.10" disabled={!loaded || isConnectedOrConnecting} {...field("host")} />
          </Row>
          <Row label="keyPath">
            <Input
              placeholder="C:/Users/.../.ssh/id_ed25519"
              disabled={!loaded || isConnectedOrConnecting}
              {...field("keyPath")}
            />
          </Row>
          <Row label="remotePort">
            <Input disabled={!loaded || isConnectedOrConnecting} {...field("remotePort")} />
          </Row>
          <Row label="localPort">
            <Input disabled={!loaded || isConnectedOrConnecting} {...field("localPort")} />
          </Row>
        </div>
        {saveError && <div className="mt-2 text-[11px] text-[var(--color-fail)]">{saveError}</div>}
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="secondary" disabled={!loaded || saving || isConnectedOrConnecting} onClick={() => void handleSave()}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
        <p className="mt-2 text-[10.5px] leading-snug text-muted-foreground">
          No password or passphrase field - if the key needs one, ssh prompts for it in the deploy tab, where it
          belongs.
        </p>
      </div>

      <div>
        <div className="mb-1.5 text-[11.5px] font-semibold text-foreground">Deploy</div>
        <p className="mb-1.5 text-[11px] text-muted-foreground">
          Runs the same installer wizard over ssh, target=server, in a visible terminal tab. The repo must already
          exist on the server - this does not clone it.
        </p>
        {deployError && <div className="mb-1.5 text-[11px] text-[var(--color-fail)]">{deployError}</div>}
        <Button size="sm" variant="secondary" disabled={deploying} onClick={() => void handleDeploy()}>
          {deploying ? "Opening..." : "Deploy to server"}
        </Button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
