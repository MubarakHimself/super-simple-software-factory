/**
 * Tests for the providers plane (`app/providers-v3.ts`), run with
 * `bun test server/app/providers-v3.test.ts` from `apps/ui`.
 *
 * ── What is real here ───────────────────────────────────────────────────────
 * The SSH is REAL, on the pattern `machines.test.ts` proved: a genuine
 * `ssh2.Server` on loopback, real publickey auth, real `exec` channels, real
 * SFTP writes. The sync path is exercised end to end against it — including the
 * one thing that matters most, that a credential crosses by SFTP and never on a
 * command line.
 *
 * ── What is a stand-in ──────────────────────────────────────────────────────
 * The far end's shell is emulated: `mkdir -p`, `printf "$HOME"` and the
 * `if [ -f x ]; then cat x; else printf ABSENT; fi` read this module sends. A
 * real Ubuntu box is not a unit test.
 *
 * ── Isolation ───────────────────────────────────────────────────────────────
 * Two redirections before the module ever loads: `SDL_FACTORY_HOME` (the
 * registry and secrets.env) and `SDL_FACTORY_LOCAL_HOME` (the fake `~` holding
 * `.pi/agent`, `.codex` and `.claude`). Nothing outside two temp directories is
 * read or written, so the operator's own credentials are never in play.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server, utils, type Connection } from "ssh2";
// Type-only so it is erased: the runtime imports below must not happen until
// both home overrides are in place.
import type { MachineRecord } from "./machines.ts";
import type { StoredProvider } from "./providers-v3.ts";

const appHomeDir = await mkdtemp(join(tmpdir(), "sdl-providers-app-"));
const userHomeDir = await mkdtemp(join(tmpdir(), "sdl-providers-home-"));
process.env["SDL_FACTORY_HOME"] = appHomeDir;
process.env["SDL_FACTORY_LOCAL_HOME"] = userHomeDir;
// A real token in the operator's own environment must not leak into a test's
// expectations (or into a fake box).
delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];

/** The machines plane's own reader of the record this module writes — imported
 * so the two halves of the journey are proved joined, not assumed to be. */
const { providerSyncSummary, readProviderSyncLog } = await import("./machines.ts");

const {
  PRESETS,
  applyLocally,
  buildResponse,
  claudeCredentialsPath,
  codexAuthPath,
  fingerprint,
  isValidProviderId,
  localStateFor,
  mergeAuthJson,
  mergeEnvText,
  mergeModelsJson,
  piAuthPath,
  piModelsPath,
  providerBlock,
  providersRegistryPath,
  readEnvValue,
  readProvidersRegistry,
  scrub,
  secretsEnvPath,
  syncToMachine,
  writeProvidersRegistry,
} = await import("./providers-v3.ts");

/* ── the fake VPS ──────────────────────────────────────────────────────────
   A real SSH server with a scripted shell. `files` is its filesystem: `cat`
   reads from it and SFTP writes into it, so a merge really round-trips. */

interface FakeBox {
  server: Server;
  port: number;
  publicKey: string;
  files: Map<string, string>;
  fileModes: Map<string, number>;
  commands: string[];
  close: () => Promise<void>;
}

/** The single-quoted arguments of a POSIX command line, unquoted. */
function quotedArgs(command: string): string[] {
  return [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map((match) => match[1]!.replace(/'\\''/g, "'"));
}

async function startFakeBox(publicKey: string): Promise<FakeBox> {
  const hostKey = utils.generateKeyPairSync("ed25519", {}).private;
  const files = new Map<string, string>();
  const fileModes = new Map<string, number>();
  const commands: string[] = [];

  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "publickey") {
        const presented = ctx.key.data.toString("base64");
        return publicKey.split(" ")[1] === presented ? ctx.accept() : ctx.reject(["publickey"]);
      }
      return ctx.reject(["publickey"]);
    });

    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const command = info.command;
          commands.push(command);

          if (command.includes('printf \'%s\\n\' "$HOME"')) {
            stream.write("/root\n");
            stream.exit(0);
            return stream.end();
          }
          if (command.startsWith("mkdir -p ")) {
            stream.exit(0);
            return stream.end();
          }
          if (command.startsWith("if [ -f ")) {
            const args = quotedArgs(command);
            const path = args[0]!;
            const absent = args[args.length - 1]!;
            stream.write(files.has(path) ? files.get(path)! : absent);
            stream.exit(0);
            return stream.end();
          }
          stream.stderr.write(`sh: not emulated: ${command}\n`);
          stream.exit(127);
          return stream.end();
        });

        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          const open = new Map<string, { path: string; chunks: string[] }>();
          let counter = 0;
          sftp.on("OPEN", (reqid, filename, _flags, attrs) => {
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(++counter, 0);
            open.set(handle.toString("hex"), { path: filename, chunks: [] });
            if (attrs && typeof attrs.mode === "number") fileModes.set(filename, attrs.mode & 0o777);
            sftp.handle(reqid, handle);
          });
          sftp.on("WRITE", (reqid, handle, _offset, data) => {
            open.get(handle.toString("hex"))?.chunks.push(data.toString("utf-8"));
            sftp.status(reqid, 0);
          });
          sftp.on("CLOSE", (reqid, handle) => {
            const entry = open.get(handle.toString("hex"));
            if (entry) files.set(entry.path, entry.chunks.join(""));
            sftp.status(reqid, 0);
          });
          sftp.on("REALPATH", (reqid, path) => sftp.name(reqid, [{ filename: path, longname: path, attrs: {} as never }]));
          sftp.on("FSTAT", (reqid) => sftp.status(reqid, 0));
          sftp.on("STAT", (reqid) => sftp.status(reqid, 2));
        });
      });
    });

    client.on("error", () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    publicKey,
    files,
    fileModes,
    commands,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const boxes: FakeBox[] = [];

/** A fake box plus the machine record that reaches it, with this app's own
 * generated key written where the registry says it lives. */
async function boxWithMachine(): Promise<{ box: FakeBox; record: MachineRecord }> {
  const pair = utils.generateKeyPairSync("ed25519", { comment: "sdl-factory-app-test" });
  const created = await startFakeBox(pair.public);
  boxes.push(created);
  const keyPath = join(appHomeDir, `key-${created.port}`);
  await writeFile(keyPath, pair.private, { encoding: "utf-8", mode: 0o600 });
  const record: MachineRecord = {
    id: `m-test-${created.port}`,
    name: "test-box",
    host: "127.0.0.1",
    port: created.port,
    user: "root",
    key_path: keyPath,
    key_generated: true,
    added_at: new Date().toISOString(),
    last_connected_at: null,
    repo_dir: null,
    // Nothing pinned: this record stands in for a machine added before host-key
    // pinning existed, so the sync connects and pins on first sight.
    host_fingerprint: null,
  };
  return { box: created, record };
}

function storedProvider(overrides: Partial<StoredProvider> = {}): StoredProvider {
  const now = new Date().toISOString();
  return {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    api: "openai-completions",
    base_url: "https://ollama.com/v1",
    auth_header: true,
    compat: { maxTokensField: "max_tokens" },
    models: [{ id: "kimi-k2.7-code", name: null }],
    key: "sk-ollama-SECRETVALUE-0001",
    added_at: now,
    updated_at: now,
    source: "ollama-cloud",
    ...overrides,
  };
}

beforeEach(async () => {
  await writeProvidersRegistry({ version: 1, providers: [], sync: {} });
  await rm(join(userHomeDir, ".pi"), { recursive: true, force: true });
  await rm(join(userHomeDir, ".codex"), { recursive: true, force: true });
  await rm(join(userHomeDir, ".claude"), { recursive: true, force: true });
  await rm(secretsEnvPath(), { force: true });
});

afterAll(async () => {
  for (const created of boxes) await created.close().catch(() => {});
  await rm(appHomeDir, { recursive: true, force: true }).catch(() => {});
  await rm(userHomeDir, { recursive: true, force: true }).catch(() => {});
});

/* ── pure helpers ──────────────────────────────────────────────────────────*/

describe("provider ids", () => {
  test("accepts the lane shapes pi resolves, including a second account", () => {
    expect(isValidProviderId("ollama-cloud")).toBe(true);
    expect(isValidProviderId("ollama-cloud-2")).toBe(true);
    expect(isValidProviderId("opencode-go")).toBe(true);
    expect(isValidProviderId("z.ai")).toBe(true);
  });

  test("rejects anything that would need quoting or break a JSON key", () => {
    expect(isValidProviderId("Ollama Cloud")).toBe(false);
    expect(isValidProviderId("-leading")).toBe(false);
    expect(isValidProviderId("a/b")).toBe(false);
    expect(isValidProviderId("it's")).toBe(false);
    expect(isValidProviderId("")).toBe(false);
  });
});

describe("the key never travels in the clear", () => {
  test("a fingerprint is stable, short, and not the key", () => {
    const key = "sk-test-abcdef";
    expect(fingerprint(key)).toBe(fingerprint(key));
    expect(fingerprint(key)).toHaveLength(12);
    expect(fingerprint(key)).not.toContain("sk-test");
    expect(fingerprint("sk-other")).not.toBe(fingerprint(key));
  });

  test("scrub replaces every occurrence of a known secret", () => {
    expect(scrub("wrote sk-secret-value to disk (sk-secret-value)", ["sk-secret-value"])).toBe(
      "wrote [redacted] to disk ([redacted])",
    );
  });

  test("scrub ignores short strings, so it can never redact a whole message", () => {
    expect(scrub("exit 1", ["1"])).toBe("exit 1");
  });
});

describe("auth.json merge", () => {
  test("writes pi's documented entry shape and leaves siblings byte-identical", () => {
    const existing = { anthropic: { type: "oauth", refresh: "keep-me" } };
    const merged = mergeAuthJson(existing, "ollama-cloud", "sk-1");
    expect(merged["ollama-cloud"]).toEqual({ type: "api_key", key: "sk-1" });
    expect(merged["anthropic"]).toEqual({ type: "oauth", refresh: "keep-me" });
  });

  test("rotating a key keeps any other field pi put on that entry", () => {
    const merged = mergeAuthJson({ "ollama-cloud": { type: "api_key", key: "old", env: { X: "1" } } }, "ollama-cloud", "new");
    expect(merged["ollama-cloud"]).toEqual({ type: "api_key", key: "new", env: { X: "1" } });
  });

  test("a non-object file is not carried forward as one", () => {
    expect(mergeAuthJson(null, "a", "k")).toEqual({ a: { type: "api_key", key: "k" } });
    expect(mergeAuthJson([1, 2], "a", "k")).toEqual({ a: { type: "api_key", key: "k" } });
  });
});

describe("models.json merge (ported from installer/steps.py:merge_ollama_provider)", () => {
  test("touches only its own provider key", () => {
    const existing = { providers: { xai: { api: "openai-completions", baseUrl: "https://x" } }, other: 1 };
    const merged = mergeModelsJson(existing, "ollama-cloud", { api: "openai-completions", baseUrl: "https://ollama.com/v1" });
    expect((merged["providers"] as Record<string, unknown>)["xai"]).toEqual({ api: "openai-completions", baseUrl: "https://x" });
    expect(merged["other"]).toBe(1);
  });

  test("carries a hand-added modelOverrides block across the replacement", () => {
    const existing = { providers: { "ollama-cloud": { api: "old", modelOverrides: { "kimi-k2.7-code": { maxTokens: 999 } } } } };
    const merged = mergeModelsJson(existing, "ollama-cloud", { api: "openai-completions" });
    const block = (merged["providers"] as Record<string, Record<string, unknown>>)["ollama-cloud"]!;
    expect(block["api"]).toBe("openai-completions");
    expect(block["modelOverrides"]).toEqual({ "kimi-k2.7-code": { maxTokens: 999 } });
  });

  test("does not mutate the object it was handed", () => {
    const existing = { providers: { xai: { api: "keep" } } };
    mergeModelsJson(existing, "new", { api: "x" });
    expect(Object.keys(existing.providers)).toEqual(["xai"]);
  });
});

describe("the provider block written into models.json", () => {
  test("carries no apiKey at all - the credential lives in auth.json", () => {
    const block = providerBlock(storedProvider());
    expect(block["apiKey"]).toBeUndefined();
    expect(JSON.stringify(block)).not.toContain("SECRETVALUE");
    expect(block["baseUrl"]).toBe("https://ollama.com/v1");
    expect(block["authHeader"]).toBe(true);
    expect(block["compat"]).toEqual({ maxTokensField: "max_tokens" });
  });

  test("a model with no name is given its own id, and models are omitted when there are none", () => {
    expect(providerBlock(storedProvider())["models"]).toEqual([{ id: "kimi-k2.7-code", name: "kimi-k2.7-code", input: ["text"] }]);
    expect(providerBlock(storedProvider({ models: [] }))["models"]).toBeUndefined();
  });
});

describe("env text merge (ported from installer/steps.py:merge_env_text)", () => {
  test("replaces in place and preserves comments, blanks and unrelated keys", () => {
    const text = "# a comment\n\nOTHER=1\nCLAUDE_CODE_OAUTH_TOKEN=old\nLAST=2\n";
    expect(mergeEnvText(text, "CLAUDE_CODE_OAUTH_TOKEN", "new")).toBe(
      "# a comment\n\nOTHER=1\nCLAUDE_CODE_OAUTH_TOKEN=new\nLAST=2\n",
    );
  });

  test("appends a key that was not there, without growing blank lines", () => {
    expect(mergeEnvText("OTHER=1\n", "CLAUDE_CODE_OAUTH_TOKEN", "t")).toBe("OTHER=1\nCLAUDE_CODE_OAUTH_TOKEN=t\n");
    expect(mergeEnvText("", "K", "v")).toBe("K=v\n");
  });

  test("readEnvValue finds a value, strips quotes, and ignores comments", () => {
    expect(readEnvValue("# CLAUDE_CODE_OAUTH_TOKEN=commented\nCLAUDE_CODE_OAUTH_TOKEN=\"real\"\n", "CLAUDE_CODE_OAUTH_TOKEN")).toBe("real");
    expect(readEnvValue("OTHER=1\n", "CLAUDE_CODE_OAUTH_TOKEN")).toBeNull();
  });
});

/* ── the preset catalog ────────────────────────────────────────────────────
   The catalog is DATA copied out of docs/research/opencode-providers-2026-08-17.md
   §5, which itself copied each field from a primary source. So the test that
   matters is not "does it parse" but "is it still the same string the research
   doc verified" - a base URL that drifts by one character is a lane that 404s
   with no error anywhere in this app. Hence the verbatim table below: it is the
   research doc's own row, restated, and it fails the moment either moves. */

/** Exactly the §5 table (plus the three lanes this pane already carried),
   base URL and env var, copied character for character. */
const RESEARCH_TABLE: Record<string, { base_url: string; key_env: string | null }> = {
  "ollama-cloud": { base_url: "https://ollama.com/v1", key_env: null },
  "opencode-go": { base_url: "https://opencode.ai/zen/go/v1/", key_env: null },
  openrouter: { base_url: "https://openrouter.ai/api/v1", key_env: "OPENROUTER_API_KEY" },
  deepseek: { base_url: "https://api.deepseek.com", key_env: "DEEPSEEK_API_KEY" },
  "fireworks-ai": { base_url: "https://api.fireworks.ai/inference/v1/", key_env: "FIREWORKS_API_KEY" },
  groq: { base_url: "https://api.groq.com/openai/v1", key_env: "GROQ_API_KEY" },
  mistral: { base_url: "https://api.mistral.ai/v1", key_env: "MISTRAL_API_KEY" },
  togetherai: { base_url: "https://api.together.ai/v1", key_env: "TOGETHER_API_KEY" },
  zai: { base_url: "https://api.z.ai/api/paas/v4", key_env: "ZHIPU_API_KEY" },
};

describe("the preset catalog", () => {
  test("every provider the research doc verified is in it, and nothing else is", () => {
    expect(PRESETS.map((preset) => preset.id).sort()).toEqual(Object.keys(RESEARCH_TABLE).sort());
  });

  test("each base URL and env var is the research doc's own string, character for character", () => {
    for (const preset of PRESETS) {
      const row = RESEARCH_TABLE[preset.id]!;
      expect({ id: preset.id, base_url: preset.base_url, key_env: preset.key_env }).toEqual({
        id: preset.id,
        base_url: row.base_url,
        key_env: row.key_env,
      });
    }
  });

  test("every entry is shaped for pi and says where its endpoint came from", () => {
    for (const preset of PRESETS) {
      // The research doc's mapping table: openai-completions for every one of
      // them, because every REST surface here is OpenAI-shaped.
      expect(preset.api).toBe("openai-completions");
      expect(preset.auth_header).toBe(true);
      expect(preset.base_url).toMatch(/^https:\/\//);
      expect(isValidProviderId(preset.id)).toBe(true);
      expect(preset.label.trim()).not.toBe("");
      expect(preset.source_note.length).toBeGreaterThan(20);
      // A model list with no "these age" line is a model list somebody will
      // trust in six months.
      expect(preset.models_note.length).toBeGreaterThan(20);
      expect(preset.key_placeholder.trim()).not.toBe("");
    }
  });

  test("an env var name is documentation, never something this app reads out of the environment", () => {
    for (const preset of PRESETS) {
      if (preset.key_env === null) continue;
      expect(preset.key_env).toMatch(/^[A-Z][A-Z0-9_]*$/);
      // The placeholder is a prompt, not a leaked key or an invented prefix.
      expect(preset.key_placeholder).not.toContain("sk-");
    }
  });

  test("the ollama-cloud preset still matches this repo's own running seed", () => {
    const preset = PRESETS.find((entry) => entry.id === "ollama-cloud")!;
    expect(preset.compat).toMatchObject({ maxTokensField: "max_tokens", supportsDeveloperRole: false });
    expect(preset.models).toContain("kimi-k2.7-code");
  });

  test("the two endpoints the research doc left unresolved say NOT VERIFIED on their own row", () => {
    // Together AI: api.together.ai vs. the older api.together.xyz, unreconciled.
    expect(PRESETS.find((entry) => entry.id === "togetherai")!.source_note).toContain("NOT VERIFIED");
    // Z.AI: pay-as-you-go path confirmed, Coding Plan path never was.
    expect(PRESETS.find((entry) => entry.id === "zai")!.source_note).toContain("NOT VERIFIED");
  });

  test("a preset carries starter model ids, verbatim, including the long Fireworks paths", () => {
    expect(PRESETS.find((entry) => entry.id === "deepseek")!.models).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(PRESETS.find((entry) => entry.id === "fireworks-ai")!.models).toContain(
      "accounts/fireworks/routers/kimi-k2p7-code-fast",
    );
    // OpenRouter ids are namespaced vendor/model - the whole string is the id.
    expect(PRESETS.find((entry) => entry.id === "openrouter")!.models[0]).toContain("/");
  });

  test("no preset carries a cost, context window or token ceiling", () => {
    // The research doc's own instruction (section 5): pull pricing live, never
    // freeze a fast-moving vendor's numbers into a file. pi's documented
    // defaults are honest; an unchecked number is not.
    const text = JSON.stringify(PRESETS);
    expect(text).not.toContain("contextWindow");
    expect(text).not.toContain("maxTokens\"");
    expect(text).not.toContain("\"cost\"");
  });
});

describe("a preset produces a valid pi provider block", () => {
  test("every catalog entry maps field-for-field onto the research doc's table", () => {
    for (const preset of PRESETS) {
      // Exactly what the Add form posts when a preset is picked and a key typed.
      const entry = storedProvider({
        id: preset.id,
        label: preset.label,
        api: preset.api,
        base_url: preset.base_url,
        auth_header: preset.auth_header,
        compat: preset.compat,
        models: preset.models.map((model) => ({ id: model, name: null })),
        source: preset.id,
      });
      const block = providerBlock(entry) as Record<string, unknown>;

      // opencode-providers-2026-08-17.md section 3, row by row:
      expect(block["baseUrl"]).toBe(preset.base_url); //          baseUrl <- api
      expect(block["api"]).toBe("openai-completions"); //         api     <- npm
      expect(block["authHeader"]).toBe(true); //                  authHeader
      if (preset.models.length === 0) {
        expect(block["models"]).toBeUndefined();
      } else {
        expect(block["models"]).toEqual(
          // models[].id verbatim; models[].name falls back to the id.
          preset.models.map((model) => ({ id: model, name: model, input: ["text"] })),
        );
      }
      // The credential never rides in this block - auth.json wins in pi's own
      // resolution order, so the file that could be read by anything is inert.
      expect(block["apiKey"]).toBeUndefined();
      expect(JSON.stringify(block)).not.toContain("SECRETVALUE");
      // pi's documented defaults, not invented numbers.
      expect(block["contextWindow"]).toBeUndefined();
      expect(block["maxTokens"]).toBeUndefined();
      expect(block["cost"]).toBeUndefined();
    }
  });

  test("a preset block merges into models.json under its own id and touches nothing else", () => {
    const existing = { providers: { xai: { api: "keep" } } };
    let models: Record<string, unknown> = existing;
    for (const preset of PRESETS) {
      models = mergeModelsJson(
        models,
        preset.id,
        providerBlock({
          api: preset.api,
          base_url: preset.base_url,
          auth_header: preset.auth_header,
          compat: preset.compat,
          models: preset.models.map((model) => ({ id: model, name: null })),
        }),
      );
    }
    const providers = models["providers"] as Record<string, Record<string, unknown>>;
    expect(providers["xai"]).toEqual({ api: "keep" });
    for (const preset of PRESETS) expect(providers[preset.id]!["baseUrl"]).toBe(preset.base_url);
    // pi resolves `provider/model` by its leading segment, so every catalog id
    // has to survive as a plain JSON key that never needs quoting.
    for (const preset of PRESETS) expect(isValidProviderId(preset.id)).toBe(true);
  });

  test("the custom path is unchanged: no preset, no prefill, the same block", () => {
    // What the form posts with Custom picked and every box typed by hand.
    const entry = storedProvider({
      id: "my-own-lane",
      label: "My Own Lane",
      base_url: "https://api.example.internal/v1",
      compat: null,
      models: [{ id: "some-model", name: null }],
      source: "operator",
    });
    expect(providerBlock(entry)).toEqual({
      api: "openai-completions",
      baseUrl: "https://api.example.internal/v1",
      authHeader: true,
      models: [{ id: "some-model", name: "some-model", input: ["text"] }],
    });
    // A hand-typed id is not in the catalog and does not need to be.
    expect(PRESETS.some((preset) => preset.id === "my-own-lane")).toBe(false);
    expect(isValidProviderId("my-own-lane")).toBe(true);
  });

  test("the catalog reaches the pane, and carries no key of any kind", async () => {
    const response = await buildResponse();
    expect(response.presets.map((preset) => preset.id).sort()).toEqual(Object.keys(RESEARCH_TABLE).sort());
    // A preset is a prefill. Nothing in it is a credential, and nothing in it
    // puts a provider on the pane - the rows come from the registry alone.
    expect(response.api_key).toHaveLength(0);
    for (const preset of response.presets) {
      expect(Object.prototype.hasOwnProperty.call(preset, "key")).toBe(false);
    }
  });
});

/* ── local apply ───────────────────────────────────────────────────────────*/

describe("applying to this machine's pi", () => {
  test("with no ~/.pi/agent it stores honestly rather than creating one", async () => {
    const state = await applyLocally(storedProvider());
    expect(state.state).toBe("stored");
    expect(state.reason).toContain("pi has no");
    expect(state.pi_auth_entry).toBe(false);
  });

  test("with ~/.pi/agent it writes both files and reports applied", async () => {
    await mkdir(join(userHomeDir, ".pi", "agent"), { recursive: true });
    const entry = storedProvider();
    const state = await applyLocally(entry);
    expect(state.state).toBe("applied");

    const auth = JSON.parse(await readFile(piAuthPath(), "utf-8")) as Record<string, { type: string; key: string }>;
    expect(auth["ollama-cloud"]).toEqual({ type: "api_key", key: entry.key });

    const models = JSON.parse(await readFile(piModelsPath(), "utf-8")) as { providers: Record<string, unknown> };
    expect(models.providers["ollama-cloud"]).toMatchObject({ baseUrl: "https://ollama.com/v1" });
    // The whole point of the auth.json-first design: the file that could be
    // read by anything carries no key.
    expect(await readFile(piModelsPath(), "utf-8")).not.toContain("SECRETVALUE");
  });

  test("an existing provider in either file survives the write", async () => {
    await mkdir(join(userHomeDir, ".pi", "agent"), { recursive: true });
    await writeFile(piAuthPath(), JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } }), "utf-8");
    await writeFile(piModelsPath(), JSON.stringify({ providers: { xai: { api: "keep" } } }), "utf-8");
    await applyLocally(storedProvider());

    const auth = JSON.parse(await readFile(piAuthPath(), "utf-8")) as Record<string, unknown>;
    expect(auth["anthropic"]).toEqual({ type: "oauth", refresh: "keep" });
    const models = JSON.parse(await readFile(piModelsPath(), "utf-8")) as { providers: Record<string, unknown> };
    expect(models.providers["xai"]).toEqual({ api: "keep" });
  });

  test("a corrupt auth.json is refused, never silently replaced", async () => {
    await mkdir(join(userHomeDir, ".pi", "agent"), { recursive: true });
    await writeFile(piAuthPath(), "{ not json", "utf-8");
    const state = await applyLocally(storedProvider());
    expect(state.state).toBe("missing");
    expect(state.reason).toContain("refusing to overwrite");
    expect(await readFile(piAuthPath(), "utf-8")).toBe("{ not json");
  });

  test("half-applied is its own state, not a false 'applied'", async () => {
    await mkdir(join(userHomeDir, ".pi", "agent"), { recursive: true });
    await writeFile(piModelsPath(), JSON.stringify({ providers: { "ollama-cloud": { api: "x" } } }), "utf-8");
    const state = await localStateFor("ollama-cloud");
    expect(state.state).toBe("stored");
    expect(state.pi_models_entry).toBe(true);
    expect(state.pi_auth_entry).toBe(false);
    expect(state.reason).toContain("half applied");
  });
});

/* ── the response ──────────────────────────────────────────────────────────*/

describe("GET /api/app/providers-v3", () => {
  test("no key ever appears in the response body", async () => {
    const entry = storedProvider();
    await writeProvidersRegistry({ version: 1, providers: [entry], sync: {} });
    const response = await buildResponse();
    expect(JSON.stringify(response)).not.toContain("SECRETVALUE");
    expect(response.api_key[0]!.key_fingerprint).toBe(fingerprint(entry.key));
  });

  test("both signed-in rows exist, carry no key field, and say how to sign in", async () => {
    const response = await buildResponse();
    expect(response.signed_in.map((row) => row.id)).toEqual(["claude", "codex"]);
    for (const row of response.signed_in) {
      expect(row.bucket).toBe("signed-in");
      expect(row.how_to_sign_in.length).toBeGreaterThan(20);
      expect(Object.prototype.hasOwnProperty.call(row, "key_fingerprint")).toBe(false);
    }
  });

  test("signed-in detection is the artifact on disk, not a guess", async () => {
    expect((await buildResponse()).signed_in.find((row) => row.id === "codex")!.detected).toBe(false);
    await mkdir(join(userHomeDir, ".codex"), { recursive: true });
    await writeFile(codexAuthPath(), JSON.stringify({ tokens: { access: "x" } }), "utf-8");
    const row = (await buildResponse()).signed_in.find((entry) => entry.id === "codex")!;
    expect(row.detected).toBe(true);
    expect(row.artifact_present).toBe(true);
    expect(row.artifact_mtime).not.toBeNull();
  });

  test("a claude credentials file counts as signed in, and its content is never read out", async () => {
    await mkdir(join(userHomeDir, ".claude"), { recursive: true });
    await writeFile(claudeCredentialsPath(), JSON.stringify({ claudeAiOauth: { accessToken: "TOPSECRETTOKEN" } }), "utf-8");
    const response = await buildResponse();
    expect(response.signed_in.find((row) => row.id === "claude")!.detected).toBe(true);
    expect(JSON.stringify(response)).not.toContain("TOPSECRETTOKEN");
  });

  test("an empty registry explains itself and names the file", async () => {
    const response = await buildResponse();
    expect(response.api_key).toHaveLength(0);
    expect(response.reason).toContain(providersRegistryPath());
    expect(response.catalog_note).toContain("/api/app/models");
  });
});

/* ── sync over real SSH ────────────────────────────────────────────────────*/

describe("sync to a machine", () => {
  test("writes the key into the machine's auth store and the block into models.json", async () => {
    const { box, record } = await boxWithMachine();
    const entry = storedProvider();
    await writeProvidersRegistry({ version: 1, providers: [entry], sync: {} });

    const run = await syncToMachine(record, { providerIds: ["ollama-cloud"] });
    expect(run.ok).toBe(true);
    expect(run.results[0]).toMatchObject({ provider_id: "ollama-cloud", state: "applied" });

    const auth = JSON.parse(box.files.get("/root/.pi/agent/auth.json")!) as Record<string, { key: string }>;
    expect(auth["ollama-cloud"]!.key).toBe(entry.key);
    const models = JSON.parse(box.files.get("/root/.pi/agent/models.json")!) as { providers: Record<string, unknown> };
    expect(models.providers["ollama-cloud"]).toMatchObject({ baseUrl: "https://ollama.com/v1" });
  });

  test("the key crosses by SFTP and never on a command line", async () => {
    const { box, record } = await boxWithMachine();
    const entry = storedProvider();
    await writeProvidersRegistry({ version: 1, providers: [entry], sync: {} });
    await syncToMachine(record, { providerIds: ["ollama-cloud"] });
    for (const command of box.commands) expect(command).not.toContain(entry.key);
    expect(box.fileModes.get("/root/.pi/agent/auth.json")).toBe(0o600);
  });

  test("an existing remote provider is preserved, not replaced wholesale", async () => {
    const { box, record } = await boxWithMachine();
    box.files.set("/root/.pi/agent/auth.json", JSON.stringify({ xai: { type: "oauth", refresh: "keep-me" } }));
    box.files.set("/root/.pi/agent/models.json", JSON.stringify({ providers: { xai: { api: "keep" } } }));
    await writeProvidersRegistry({ version: 1, providers: [storedProvider()], sync: {} });

    await syncToMachine(record, { providerIds: ["ollama-cloud"] });
    const auth = JSON.parse(box.files.get("/root/.pi/agent/auth.json")!) as Record<string, unknown>;
    expect(auth["xai"]).toEqual({ type: "oauth", refresh: "keep-me" });
    const models = JSON.parse(box.files.get("/root/.pi/agent/models.json")!) as { providers: Record<string, unknown> };
    expect(models.providers["xai"]).toEqual({ api: "keep" });
  });

  test("a corrupt remote auth.json fails the provider and leaves the file alone", async () => {
    const { box, record } = await boxWithMachine();
    box.files.set("/root/.pi/agent/auth.json", "{ not json");
    await writeProvidersRegistry({ version: 1, providers: [storedProvider()], sync: {} });

    const run = await syncToMachine(record, { providerIds: ["ollama-cloud"] });
    expect(run.ok).toBe(false);
    expect(run.results[0]!.state).toBe("failed");
    expect(run.results[0]!.reason).toContain("refusing to overwrite");
    expect(box.files.get("/root/.pi/agent/auth.json")).toBe("{ not json");
  });

  test("Claude with no token anywhere is needs-you, carrying the exact command", async () => {
    const { record } = await boxWithMachine();
    const run = await syncToMachine(record, { providerIds: ["claude"] });
    expect(run.results[0]).toMatchObject({ provider_id: "claude", state: "needs-you" });
    expect(run.results[0]!.reason).toContain("claude setup-token");
  });

  test("a pasted Claude token lands in the machine's secrets.env and nowhere on this laptop", async () => {
    const { box, record } = await boxWithMachine();
    box.files.set("/root/.sdl-factory/secrets.env", "OTHER=1\n");
    const run = await syncToMachine(record, { providerIds: ["claude"], claudeToken: "sk-ant-oat-PASTED" });
    expect(run.results[0]!.state).toBe("applied");
    expect(box.files.get("/root/.sdl-factory/secrets.env")).toBe("OTHER=1\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-PASTED\n");
    expect(box.fileModes.get("/root/.sdl-factory/secrets.env")).toBe(0o600);
    // The pasted token is for one sync: nothing on this laptop keeps it.
    const registryText = await readFile(providersRegistryPath(), "utf-8");
    expect(registryText).not.toContain("PASTED");
  });

  test("a local secrets.env token is carried without the operator typing anything", async () => {
    const { box, record } = await boxWithMachine();
    await writeFile(secretsEnvPath(), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-ONFILE\n", "utf-8");
    const run = await syncToMachine(record, { providerIds: ["claude"] });
    expect(run.results[0]!.state).toBe("applied");
    expect(box.files.get("/root/.sdl-factory/secrets.env")).toContain("sk-ant-oat-ONFILE");
  });

  test("Codex copies the local auth file when it exists, and says so plainly when it does not", async () => {
    const { box, record } = await boxWithMachine();
    const absent = await syncToMachine(record, { providerIds: ["codex"] });
    expect(absent.results[0]).toMatchObject({ state: "needs-you" });
    expect(absent.results[0]!.reason).toContain("codex login");

    await mkdir(join(userHomeDir, ".codex"), { recursive: true });
    await writeFile(codexAuthPath(), '{"tokens":{"access":"CODEXTOKEN"}}', "utf-8");
    const copied = await syncToMachine(record, { providerIds: ["codex"] });
    expect(copied.results[0]!.state).toBe("applied");
    expect(box.files.get("/root/.codex/auth.json")).toBe('{"tokens":{"access":"CODEXTOKEN"}}');
    expect(box.fileModes.get("/root/.codex/auth.json")).toBe(0o600);
  });

  test("an unreachable machine fails every provider with one honest reason", async () => {
    const { box, record } = await boxWithMachine();
    await box.close();
    await writeProvidersRegistry({ version: 1, providers: [storedProvider()], sync: {} });
    const run = await syncToMachine(record, { providerIds: ["ollama-cloud", "claude", "codex"] });
    expect(run.ok).toBe(false);
    expect(run.results).toHaveLength(3);
    for (const result of run.results) {
      expect(result.state).toBe("failed");
      expect(result.reason).toContain("could not reach");
    }
  });

  test("a missing private key never opens a connection, and names the file", async () => {
    const { record } = await boxWithMachine();
    const run = await syncToMachine({ ...record, key_path: join(appHomeDir, "no-such-key") }, { providerIds: ["claude"] });
    expect(run.results[0]!.state).toBe("failed");
    expect(run.results[0]!.reason).toContain("no-such-key");
  });

  test("the run is remembered so a reload still knows what happened", async () => {
    const { record } = await boxWithMachine();
    await writeProvidersRegistry({ version: 1, providers: [storedProvider()], sync: {} });
    await syncToMachine(record, { providerIds: ["ollama-cloud"] });
    const stored = await readProvidersRegistry();
    expect(stored.sync[record.id]!.results[0]!.state).toBe("applied");
    expect((await buildResponse()).sync[record.id]!.machine_name).toBe("test-box");
  });

  test("the remembered run carries the machine and the time the pane prints, and no credential", async () => {
    const { record } = await boxWithMachine();
    await writeProvidersRegistry({ version: 1, providers: [storedProvider()], sync: {} });
    await mkdir(join(userHomeDir, ".codex"), { recursive: true });
    await writeFile(codexAuthPath(), '{"tokens":{"access":"CODEXTOKEN"}}', "utf-8");

    // No provider_ids: everything, the way the pane's one button syncs.
    await syncToMachine(record, { claudeToken: "sk-ant-oat-PASTEDONCE" });

    const remembered = (await buildResponse()).sync[record.id]!;
    // Exactly what "synced to <machine> at <time>" is built from.
    expect(remembered.machine_name).toBe("test-box");
    expect(Number.isNaN(Date.parse(remembered.at))).toBe(false);
    expect(remembered.results.map((result) => result.provider_id).sort()).toEqual(["claude", "codex", "ollama-cloud"]);
    for (const result of remembered.results) {
      expect(result.state).toBe("applied");
      // "applied" with an empty reason is a row that says nothing on hover.
      expect(result.reason.length).toBeGreaterThan(20);
    }
    // The run is written to disk and read back by the machines pane as well, so
    // it is the one record a credential must never be able to reach.
    expect(JSON.stringify(remembered)).not.toContain("SECRETVALUE");
    const onDisk = await readFile(providersRegistryPath(), "utf-8");
    expect(onDisk).not.toContain("PASTEDONCE");
    expect(onDisk).not.toContain("CODEXTOKEN");
  });

  test("after a real sync the machines pane can say the box has providers", async () => {
    // The other half of the journey, end to end: this module writes the run,
    // `machines.ts` reads it back through its own reader, and the machine row
    // stops warning. Nothing between them is mocked.
    const { record } = await boxWithMachine();
    await writeProvidersRegistry({ version: 1, providers: [storedProvider()], sync: {} });

    // Before any sync the row's answer is null - the state the pane warns on.
    expect(providerSyncSummary((await readProviderSyncLog())[record.id])).toBeNull();

    await syncToMachine(record, { providerIds: ["ollama-cloud"] });

    const summary = providerSyncSummary((await readProviderSyncLog())[record.id])!;
    expect(summary.applied).toBe(1);
    expect(summary.applied_ids).toEqual(["ollama-cloud"]);
    expect(summary.at).toBe((await readProvidersRegistry()).sync[record.id]!.at);
    expect(JSON.stringify(summary)).not.toContain("SECRETVALUE");
  });

  test("a sync where nothing lands leaves the machine row still warning", async () => {
    const { record } = await boxWithMachine();
    // No api-key provider registered, no codex login, no claude token: three
    // needs-you/failed lines and not one applied.
    await writeProvidersRegistry({ version: 1, providers: [], sync: {} });
    await syncToMachine(record, { providerIds: ["claude", "codex"] });

    const summary = providerSyncSummary((await readProviderSyncLog())[record.id])!;
    expect(summary.applied).toBe(0);
    expect(summary.needs_you).toBe(2);
    expect(summary.ok).toBe(false);
  });
});

/* ── MANUAL PROOF (nothing in CI can do this) ───────────────────────────────
 *
 * Against a real box already added in Settings > Machines:
 *
 *   1. Settings > Providers > Add provider, pick Ollama Cloud, paste the key.
 *      Expect: the row says "applied on this machine" if pi is installed here,
 *      or "stored - applied on sync" if it is not. Then:
 *        type C:\Users\<you>\.pi\agent\auth.json    -> an "ollama-cloud" entry
 *        type C:\Users\<you>\.pi\agent\models.json  -> providers."ollama-cloud",
 *                                                      and NO apiKey inside it
 *   2. Sync providers to <machine>. On the box:
 *        cat ~/.pi/agent/auth.json | python3 -c 'import json,sys; print(list(json.load(sys.stdin)))'
 *        stat -c '%a' ~/.pi/agent/auth.json      -> 600
 *   3. pi -ne --list-models on the box            -> the new lane's models
 *   4. grep -r 'sk-' ~/.sdl-factory/install/*.log -> nothing (rule: no key in a log)
 */
