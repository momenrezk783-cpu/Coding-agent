import { Agent } from "agents";
import { tools, type ToolName } from "./tools";

export interface AgentState {
  messages: Array<{
    role: "user" | "assistant" | "tool";
    content: string;
    timestamp: number;
  }>;
  workers: string[];
  currentFile: string | null;
}

const SYSTEM_PROMPT = `You are a helpful coding agent running on Cloudflare Workers.

You can:
1. LIST WORKERS — List all Workers on the account
2. READ WORKER — Read any Worker's source code
3. UPDATE WORKER — Deploy updated code to any Worker
4. CALL WORKER — Call methods on other Workers via service bindings
5. RUN CODE — Execute generated code in an isolated Dynamic Worker sandbox
6. GET LOGS — Check observability logs for any Worker

When the user asks you to modify a Worker:
1. First, read the current source code
2. Propose changes and explain them
3. Apply the changes using the update_worker tool
4. Verify by reading the updated code back

Always explain what you're doing and show code diffs when making changes.
Be concise but thorough. Use markdown for formatting.`;

const PRIMARY_MODEL = "@cf/zai-org/glm-4.7-flash";
const FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const PRIMARY_TIMEOUT_MS = 5_000;  // 5s — fail fast on the primary model
const FALLBACK_TIMEOUT_MS = 3_000; // 3s — even shorter for the fallback

export class CodingAgent extends Agent<Env, AgentState> {
  initialState: AgentState = {
    messages: [],
    workers: [],
    currentFile: null,
  };

  // ─── Central LLM call with automatic fallback ──────────────────
  // Same pattern as mizan-voice-agent:
  // 1. Try the primary dialogue model with a 5s timeout
  // 2. If it times out or throws, fall back to the fast model with 3s timeout
  // 3. Uses the AI binding directly (no AI Gateway hop)
  async callLLM(
    messages: Array<{ role: string; content: string }>,
    options?: { tools?: unknown[] }
  ): Promise<{ response: string; tool_calls?: unknown[]; usedFallback: boolean }> {
    // Try primary model
    try {
      const result = await this.runWithTimeout(
        this.env.AI.run(PRIMARY_MODEL, { messages, ...(options?.tools ? { tools: options.tools } : {}) }),
        PRIMARY_TIMEOUT_MS
      );
      return {
        response: (result as { response?: string }).response || "",
        tool_calls: (result as { tool_calls?: unknown[] }).tool_calls,
        usedFallback: false,
      };
    } catch (primaryError) {
      console.log(`Primary model (${PRIMARY_MODEL}) failed:`, (primaryError as Error).message);
      console.log(`Falling back to ${FALLBACK_MODEL}...`);

      // Fallback to fast model (no tools — fallback model may not support tool calling)
      try {
        const result = await this.runWithTimeout(
          this.env.AI.run(FALLBACK_MODEL, { messages }),
          FALLBACK_TIMEOUT_MS
        );
        return {
          response: (result as { response?: string }).response || `Error: primary model failed and fallback returned no response.`,
          usedFallback: true,
        };
      } catch (fallbackError) {
        console.log(`Fallback model (${FALLBACK_MODEL}) also failed:`, (fallbackError as Error).message);
        return {
          response: `Both models failed. Primary: ${(primaryError as Error).message}. Fallback: ${(fallbackError as Error).message}`,
          usedFallback: true,
        };
      }
    }
  }

  // ─── Timeout helper using AbortController ──────────────────────
  async runWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    try {
      // Race the promise against the timeout
      const result = await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(new Error(`Timed out after ${ms}ms`));
          });
        }),
      ]);
      clearTimeout(timeout);
      return result;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  async onConnect(connection: WebSocket) {
    connection.send(JSON.stringify({ type: "state", state: this.state }));
  }

  async onMessage(connection: WebSocket, message: ArrayBuffer) {
    const text = new TextDecoder().decode(message);
    let parsed: { type: string; content?: string };

    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { type: "message", content: text };
    }

    if (parsed.type === "message" && parsed.content) {
      await this.handleUserMessage(connection, parsed.content);
    }
  }

  async handleUserMessage(connection: WebSocket, userMessage: string) {
    // Add user message to state
    const messages = [
      ...this.state.messages,
      { role: "user" as const, content: userMessage, timestamp: Date.now() },
    ];
    this.setState({ ...this.state, messages });

    // Build conversation for the LLM
    const conversation = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      ...messages.map((m) => ({
        role: m.role as "user" | "assistant" | "tool",
        content: m.content,
      })),
    ];

    connection.send(JSON.stringify({ type: "thinking" }));

    // Call LLM with tools
    const toolDefs = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const response = await this.callLLM(conversation, { tools: toolDefs });

    // Check if the model wants to call a tool
    if (response.tool_calls && (response.tool_calls as unknown[]).length > 0) {
      for (const toolCall of response.tool_calls as Array<{
        function: { name: string; arguments?: string };
      }>) {
        const toolName = toolCall.function.name as ToolName;
        const args = JSON.parse(toolCall.function.arguments || "{}");

        connection.send(
          JSON.stringify({ type: "tool_call", tool: toolName, args })
        );

        // Execute the tool
        const result = await this.executeTool(toolName, args);

        connection.send(
          JSON.stringify({ type: "tool_result", tool: toolName, result })
        );

        // Add tool result to conversation and get final response (with fallback)
        conversation.push({
          role: "assistant" as const,
          content: `I called ${toolName} with ${JSON.stringify(args)} and got: ${result}`,
        });

        const finalResponse = await this.callLLM(conversation);
        const finalText = finalResponse.response || "Done.";

        connection.send(JSON.stringify({ type: "message", content: finalText }));

        messages.push({
          role: "assistant" as const,
          content: finalText,
          timestamp: Date.now(),
        });
      }
    } else {
      const text = response.response || "I'm not sure how to help with that.";

      if (response.usedFallback) {
        connection.send(
          JSON.stringify({
            type: "message",
            content: text,
            fallback: true,
          })
        );
      } else {
        connection.send(JSON.stringify({ type: "message", content: text }));
      }

      messages.push({
        role: "assistant" as const,
        content: text,
        timestamp: Date.now(),
      });
    }

    this.setState({ ...this.state, messages });
  }

  async executeTool(name: ToolName, args: Record<string, unknown>): Promise<string> {
    const tool = tools.find((t) => t.name === name);
    if (!tool) return `Unknown tool: ${name}`;

    try {
      return await tool.execute(args, this.env, this);
    } catch (error) {
      return `Tool error: ${(error as Error).message}`;
    }
  }

  // HTTP API for REST access (optional, in addition to WebSocket)
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/workers") {
      const result = await tools
        .find((t) => t.name === "list_workers")!
        .execute({}, this.env, this);
      return Response.json({ workers: result });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      const { message } = (await request.json()) as { message: string };

      const messages = [
        ...this.state.messages,
        { role: "user" as const, content: message, timestamp: Date.now() },
      ];
      this.setState({ ...this.state, messages });

      // Use the same callLLM with fallback
      const conversation = [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ];

      const response = await this.callLLM(conversation);
      const text = response.response || "Done.";

      messages.push({
        role: "assistant" as const,
        content: text,
        timestamp: Date.now(),
      });
      this.setState({ ...this.state, messages });

      return Response.json({ response: text, fallback: response.usedFallback });
    }

    return new Response("Not found", { status: 404 });
  }
}

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
  get(id: string, cb: () => Promise<unknown>): { getEntrypoint(): { fetch(request: Request): Promise<Response> } };
}
