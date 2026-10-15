import { routeAgentRequest } from "agents";
import { CodingAgent } from "./agent";

export { CodingAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route WebSocket and API requests to the Coding Agent Durable Object
    const agentResponse = await routeAgentRequest(
      request,
      env.CODING_AGENT,
      "coding-agent"
    );

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
  CF_API_TOKEN: string;
}

interface WorkerLoader {
  load(code: unknown): { getEntrypoint(): { fetch(request: Request): Promise<Response> } };
}
