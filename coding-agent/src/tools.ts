export type ToolName =
  | "list_workers"
  | "get_worker_code"
  | "update_worker"
  | "call_worker"
  | "run_code"
  | "get_logs";

export interface Tool {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    env: Env,
    agent: { sql: { exec: (query: string) => unknown }; state: unknown }
  ) => Promise<string>;
}

interface Env {
  AI: Ai;
  VOICE_AGENT: Fetcher;
  LOADER: WorkerLoader;
  CF_API_KEY: string;
}

interface WorkerLoader {
  load(code: unknown): { getEntrypoint(): { fetch(request: Request): Promise<Response> } };
}

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export const tools: Tool[] = [
  // ─── 1. LIST WORKERS ──────────────────────────────────────────
  {
    name: "list_workers",
    description:
      "List all Workers on the Cloudflare account. Returns their names and deployment info.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (_args, env) => {
      const res = await fetch(`${CF_API_BASE}/accounts/${getAccountId(env)}/workers/scripts`, {
        headers: { Authorization: `Bearer ${env.CF_API_KEY}` },
      });
      const data = await res.json() as { result?: Array<{ id: string; modified_on?: string }> };
      const workers = data.result?.map((w) => `- ${w.id} (modified: ${w.modified_on || "unknown"})`).join("\n") || "No workers found";
      return workers;
    },
  },

  // ─── 2. GET WORKER CODE ───────────────────────────────────────
  {
    name: "get_worker_code",
    description:
      "Read the source code of a specific Worker by name. Returns the Worker's main script content.",
    parameters: {
      type: "object",
      properties: {
        worker_name: { type: "string", description: "The name of the Worker to read" },
      },
      required: ["worker_name"],
    },
    execute: async (args, env) => {
      const workerName = args.worker_name as string;
      const res = await fetch(
        `${CF_API_BASE}/accounts/${getAccountId(env)}/workers/scripts/${workerName}`,
        { headers: { Authorization: `Bearer ${env.CF_API_KEY}` } }
      );
      const text = await res.text();
      // The API returns multipart/form-data — extract the script
      const scriptMatch = text.match(/Content-Type:\s*application\/javascript[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/);
      return scriptMatch ? scriptMatch[1] : text.substring(0, 5000);
    },
  },

  // ─── 3. UPDATE WORKER ─────────────────────────────────────────
  {
    name: "update_worker",
    description:
      "Deploy updated source code to a Worker. Use with caution — this overwrites the existing code.",
    parameters: {
      type: "object",
      properties: {
        worker_name: { type: "string", description: "The name of the Worker to update" },
        code: { type: "string", description: "The new JavaScript/TypeScript source code" },
      },
      required: ["worker_name", "code"],
    },
    execute: async (args, env) => {
      const workerName = args.worker_name as string;
      const code = args.code as string;

      const boundary = `----FormBoundary${Date.now()}`;
      const metadata = JSON.stringify({ main_module: "worker.js" });
      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="metadata"',
        "Content-Type: application/json",
        "",
        metadata,
        `--${boundary}`,
        'Content-Disposition: form-data; name="worker.js"; filename="worker.js"',
        "Content-Type: application/javascript+module",
        "",
        code,
        `--${boundary}--`,
      ].join("\r\n");

      const res = await fetch(
        `${CF_API_BASE}/accounts/${getAccountId(env)}/workers/scripts/${workerName}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${env.CF_API_KEY}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          body,
        }
      );

      const data = await res.json() as { success: boolean; errors?: Array<{ message: string }> };
      if (data.success) {
        return `Successfully updated Worker "${workerName}"`;
      }
      return `Failed to update: ${JSON.stringify(data.errors)}`;
    },
  },

  // ─── 4. CALL WORKER (via service binding) ─────────────────────
  {
    name: "call_worker",
    description:
      "Call another Worker on the account via service binding (zero latency, no network hop). Currently bound to the voice agent.",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", description: "HTTP method (GET, POST, etc.)" },
        path: { type: "string", description: "Path to call on the Worker" },
        body: { type: "string", description: "Optional request body (JSON string)" },
      },
      required: ["method", "path"],
    },
    execute: async (args, env) => {
      const method = (args.method as string) || "GET";
      const path = (args.path as string) || "/";
      const body = args.body as string | undefined;

      const request = new Request(`https://internal${path}`, {
        method,
        body: body || undefined,
        headers: body ? { "Content-Type": "application/json" } : {},
      });

      const response = await env.VOICE_AGENT.fetch(request);
      const text = await response.text();
      return `Status: ${response.status}\n${text.substring(0, 3000)}`;
    },
  },

  // ─── 5. RUN CODE (Dynamic Worker sandbox) ─────────────────────
  {
    name: "run_code",
    description:
      "Execute JavaScript code in an isolated Dynamic Worker sandbox. Network access is blocked. Use for testing generated code, data processing, or quick calculations.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript code to execute. Must export a default fetch handler.",
        },
      },
      required: ["code"],
    },
    execute: async (args, env) => {
      const code = args.code as string;

      const worker = env.LOADER.load({
        compatibilityDate: "2026-10-15",
        mainModule: "worker.js",
        modules: {
          "worker.js": code,
        },
        // Block all outbound network access for security
        globalOutbound: null,
      });

      const request = new Request("https://sandbox/run");
      const response = await worker.getEntrypoint().fetch(request);
      const text = await response.text();
      return `Output (${response.status}):\n${text.substring(0, 5000)}`;
    },
  },

  // ─── 6. GET LOGS ──────────────────────────────────────────────
  {
    name: "get_logs",
    description:
      "Fetch recent observability logs for a specific Worker. Returns error logs and exceptions.",
    parameters: {
      type: "object",
      properties: {
        worker_name: { type: "string", description: "The name of the Worker to get logs for" },
      },
      required: ["worker_name"],
    },
    execute: async (args, env) => {
      const workerName = args.worker_name as string;
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;

      const query = {
        queryId: "agent-log-query",
        datasets: ["cloudflare-workers"],
        filters: [
          { key: "$metadata.service", operation: "eq", type: "string", value: workerName },
          { key: "$metadata.level", operation: "eq", type: "string", value: "error" },
        ],
        calculations: [],
        groupBys: [],
        havings: [],
        orderBys: [{ key: "$metadata.startTime", type: "number", order: "DESC" }],
        limit: 10,
        timeframe: { from: oneHourAgo, to: now },
      };

      const res = await fetch(
        `${CF_API_BASE}/accounts/${getAccountId(env)}/workers/observability/telemetry/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.CF_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(query),
        }
      );

      const data = await res.json() as { result?: { rows?: Array<Record<string, unknown>> } };
      const rows = data.result?.rows || [];
      if (rows.length === 0) return "No error logs in the last hour.";
      return rows
        .map((r) => JSON.stringify(r).substring(0, 500))
        .join("\n---\n");
    },
  },
];

// Helper to extract account ID from the token context
function getAccountId(_env: Env): string {
  // The account ID is available in the Worker environment
  // In production, store this as a binding or derive from the token
  return "1070f42f50aba614a00c682d2957befe";
}
