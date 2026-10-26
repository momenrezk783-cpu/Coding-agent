import { routeAgentRequest } from "agents";
import { CodingAgent } from "./agent";

export { CodingAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Auth gate: everything that reaches the agent (WebSocket or /api/*) must
    // carry the shared token. Static assets still load without it so the UI
    // can prompt for the token, but the agent itself is never open.
    if (
      url.pathname.startsWith("/agent/") ||
      url.pathname.startsWith("/agents/") ||
      url.pathname.startsWith("/api/")
    ) {
      const token =
        request.headers
          .get("Authorization")
          ?.replace(/^Bearer\s+/i, "")
          .trim() ||
        request.headers.get("X-Auth-Token")?.trim() ||
        url.searchParams.get("token")?.trim() ||
        "";
      const expected = String(env.CODING_AGENT_AUTH_TOKEN || "").trim();
      if (!expected || token !== expected) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    // Route WebSocket and API requests to the Coding Agent Durable Object.
    // routeAgentRequest needs the full env (it discovers DO bindings from it);
    // passing env.CODING_AGENT made every agent request return 400 "Invalid request".
    const agentResponse = await routeAgentRequest(request, env);

    if (agentResponse) {
      return agentResponse;
    }

    // Serve static assets (Vite-built frontend)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

interface Env {
  AI: Ai;
  VOICE_AGENT: Fetcher;
  LOADER: WorkerLoader;
  CODING_AGENT: DurableObjectNamespace;
  ASSETS: Fetcher;
  CF_API_KEY: string;
  CODING_AGENT_AUTH_TOKEN: string;
}

interface WorkerLoader {
  load(code: unknown): { getEntrypoint(): { fetch(request: Request): Promise<Response> } };
}
