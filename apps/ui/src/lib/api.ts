import type {
  AgentPrompts,
  ApiError,
  ConfigResponse,
  DiffResponse,
  Envelope,
  EventsPage,
  GateResponse,
  GateResult,
  HealthResponse,
  QueueResponse,
  SessionDetail,
  SessionSummary,
} from "@shared/types";

class ApiRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as ApiError;
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body - keep the status line */
    }
    throw new ApiRequestError(res.status, message);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => get<HealthResponse>("/api/health"),
  sessions: (limit = 200) => get<SessionSummary[]>(`/api/sessions?limit=${limit}`),
  session: (adwId: string) => get<SessionDetail>(`/api/sessions/${encodeURIComponent(adwId)}`),
  events: (adwId: string, after = 0, limit = 500) =>
    get<EventsPage>(`/api/sessions/${encodeURIComponent(adwId)}/events?after=${after}&limit=${limit}`),
  envelopes: (adwId: string) => get<Envelope[]>(`/api/sessions/${encodeURIComponent(adwId)}/envelopes`),
  gates: (adwId: string) => get<GateResult[]>(`/api/sessions/${encodeURIComponent(adwId)}/gates`),
  prompts: (adwId: string, agent: string) =>
    get<AgentPrompts>(`/api/sessions/${encodeURIComponent(adwId)}/prompts/${encodeURIComponent(agent)}`),
  diff: (adwId: string, scope: string) =>
    get<DiffResponse>(`/api/sessions/${encodeURIComponent(adwId)}/diff?scope=${encodeURIComponent(scope)}`),
  queue: () => get<QueueResponse>("/api/queue"),
  gate: () => get<GateResponse>("/api/gate"),
  config: () => get<ConfigResponse>("/api/config"),
};

export { ApiRequestError };
