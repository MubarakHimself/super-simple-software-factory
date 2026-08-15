/**
 * Providers (global — "Factory defaults") — J6.1, and change-list #12: the mock
 * titles this panel with a project name while its own scope logic correctly
 * makes it global. The title says Factory defaults here.
 *
 * Reads `GET /api/app/p/:id/factory/providers`: every git-tracked
 * `installer/assets/pi/<id>.provider.json` in the repo, plus a row for any lane
 * of the roster that has no definition file — a provider the factory draws on
 * that this repo cannot describe is a fact to show, not a row to omit. The
 * project id in the path is the repo the definitions were read from; the pane
 * says which one.
 *
 * `auth_status` is `"unknown"` on every path and always will be from here.
 * Credentials live in `~/.pi/agent/auth.json` (0600) on the machine that runs
 * the factory, written over SSH and never in git
 * (docs/research/pi-provider-mechanism-2026-08-15.md). Nothing in this app
 * reads one, so no row ever claims "connected".
 *
 * "Add a new provider…" opens a form that WRITES NOTHING this wave. It is built
 * as the explanation of what connecting will do, with the fields drawn beside
 * it, and its button is disabled and labelled. A form that pretended to succeed
 * would be worse than no form at all.
 */
import { useState } from "react";
import type { Resource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { PlusIcon } from "./icons.tsx";
import type { ProviderDefinition, ProviderDefinitionsResponse } from "./types.ts";

function authWords(definition: ProviderDefinition): string {
  switch (definition.auth_mechanism) {
    case "api-key-command":
      return "Auth: API key from a command · resolved on the machine that runs the factory";
    case "api-key":
      return "Auth: API key · read from pi's own config on the factory machine";
    case "none":
      return "Auth: none in this definition · pi supplies it, or the endpoint needs none";
    default:
      return "Auth: unknown · this definition could not be read";
  }
}

function modelWords(definition: ProviderDefinition): string {
  if (!definition.defined) return "no definition file in this repo";
  if (definition.models.length === 0) return "no models listed in the definition";
  const names = definition.models.map((model) => model.id).join(", ");
  return `${definition.models.length} ${definition.models.length === 1 ? "model" : "models"} · ${names}`;
}

function AddProviderForm({ onClose }: { onClose: () => void }) {
  const [id, setId] = useState("");
  const [api, setApi] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");

  return (
    <div className="provider-form fade-in">
      <div className="pf-title">Add a new provider</div>
      <div className="pf-grid">
        <div className="pf-field">
          <label htmlFor="pf-id">Provider id</label>
          <input id="pf-id" value={id} spellCheck={false} placeholder="opencode-go-2" onChange={(event) => setId(event.target.value)} />
        </div>
        <div className="pf-field">
          <label htmlFor="pf-api">API</label>
          <input id="pf-api" value={api} spellCheck={false} placeholder="openai-completions" onChange={(event) => setApi(event.target.value)} />
        </div>
        <div className="pf-field">
          <label htmlFor="pf-base">Base URL</label>
          <input id="pf-base" value={baseUrl} spellCheck={false} placeholder="https://…/v1" onChange={(event) => setBaseUrl(event.target.value)} />
        </div>
        <div className="pf-field">
          <label htmlFor="pf-model">First model id</label>
          <input id="pf-model" value={model} spellCheck={false} placeholder="glm-5.2" onChange={(event) => setModel(event.target.value)} />
        </div>
      </div>

      <div className="pf-plan">
        <div className="pf-plan-title">What Connect will do</div>
        <ol>
          <li>
            Write the definition to <code>installer/assets/pi/&lt;id&gt;.provider.json</code> in the repo. Definitions are
            git-tracked, so every machine that pulls gets the same provider.
          </li>
          <li>
            Register it in <code>~/.pi/agent/models.json</code> on the machine that runs the factory, which is what makes
            its models resolvable by <code>provider/model</code>.
          </li>
          <li>
            Write the credential into <code>~/.pi/agent/auth.json</code> (0600) on that machine, over SSH.{" "}
            <strong>Never in git, never in this repo, never through this browser.</strong>
          </li>
          <li>
            A second account of a provider you already have is a second id (<code>opencode-go-2</code>) — which is a second
            lane, and a second rate-limit bucket.
          </li>
        </ol>
      </div>

      <div className="pf-actions">
        <span className="pf-note">Nothing on this form is written yet — it lands with Connect, alongside the server connection.</span>
        <button type="button" className="pr-btn" onClick={onClose}>
          Close
        </button>
        <button type="button" className="pr-btn" disabled title="writing a provider needs the SSH connection to the factory machine — it lands with Connect">
          Add provider
        </button>
      </div>
    </div>
  );
}

export function Providers({
  projectName,
  definitions,
}: {
  projectName: string;
  /** Fired once by the Settings surface (the tab count and Roster's
   * Authentication column read the same response), handed down so no two panes
   * fetch the same definitions twice. */
  definitions: Resource<ProviderDefinitionsResponse>;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const providers = definitions.data?.providers ?? [];

  return (
    <div className="form-body-content fade-in">
      <div className="form-panel-title">
        Providers &amp; auth · <span className="scope-name-inline">Factory defaults</span>
      </div>
      <div className="form-panel-sub">
        Connect a provider to bring its models into the factory. The definition is git-tracked in the repo; the
        credential is written on the machine that runs the factory, never in git.
      </div>

      {definitions.error ? <ReadFailure error={definitions.error} /> : null}

      <div className="form-section">
        <div className="form-section-title">
          <span>Connected providers</span>
          <button type="button" className="section-action" onClick={() => setFormOpen(true)}>
            + Add provider
          </button>
        </div>

        {providers.length === 0 ? (
          <p className="section-empty">
            {definitions.loading
              ? "Reading the repo's provider definitions…"
              : definitions.error && !definitions.data
                ? "The provider read failed, so there is nothing to list — the line above carries the server's own words."
                : (definitions.data?.reason ?? "No provider definitions and no roster lanes to describe.")}
            {definitions.data ? <span className="se-note">{definitions.data.dir}</span> : null}
          </p>
        ) : (
          providers.map((definition) => (
            <div className="provider-row" key={definition.id}>
              <div className="pr-icon">{definition.id.slice(0, 1).toUpperCase()}</div>
              <div className="pr-body">
                <div className="pr-name">
                  {definition.id}
                  {definition.in_roster ? <span className="pr-tag"> in roster</span> : null}
                </div>
                <div className="pr-auth">{authWords(definition)}</div>
              </div>
              <div className="pr-models" title={modelWords(definition)}>
                {modelWords(definition)}
              </div>
              <div className="pr-status" title={definition.auth_reason}>
                <span className="dot" style={{ background: "var(--t3)" }} />
                {definition.defined ? "auth not checked here" : "no definition file"}
              </div>
              <div className="pr-actions">
                <button type="button" className="pr-btn" disabled title="reconnecting means writing a credential on the factory machine over SSH — it lands with Connect">
                  Reconnect
                </button>
                <button type="button" className="pr-btn danger" disabled title="removing a provider deletes a git-tracked file and a lane the roster may still name — it is not a click this app makes yet">
                  Remove
                </button>
              </div>
            </div>
          ))
        )}

        {formOpen ? (
          <AddProviderForm onClose={() => setFormOpen(false)} />
        ) : (
          <button type="button" className="provider-add" onClick={() => setFormOpen(true)}>
            <PlusIcon />
            <span>Add a new provider…</span>
          </button>
        )}

        <p className="section-note">
          Read from <strong>{projectName}</strong>&apos;s repo{definitions.data ? ` (${definitions.data.dir})` : ""}. Provider
          definitions travel with the repo, which is why they are a factory-wide fact rather than a per-project one.
          Reconnect, Rotate key and Remove all write on the factory machine over SSH — they arrive with the server
          connection, so they are drawn and disabled here.
        </p>
        <p className="section-note">
          Authentication status is <strong>unknown from this machine</strong>, and honestly so: pi reads credentials from{" "}
          <strong>~/.pi/agent/auth.json</strong> (0600) on the machine that runs the factory. Nothing in this app opens
          that file.
        </p>
      </div>
    </div>
  );
}
