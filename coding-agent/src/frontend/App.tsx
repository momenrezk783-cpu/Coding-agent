import { useState, useEffect, useRef } from "react";

interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  fallback?: boolean;
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

interface ToolResult {
  tool: string;
  result: string;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [toolCalls, setToolCalls] = useState<(ToolCall | ToolResult)[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token =
      localStorage.getItem("coding_agent_token") ||
      window.prompt("Coding agent auth token") ||
      "";
    if (token) localStorage.setItem("coding_agent_token", token);
    const wsUrl = `${protocol}//${window.location.host}/agent/coding-agent?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case "state":
          setMessages(data.state.messages || []);
          break;
        case "thinking":
          setThinking(true);
          break;
        case "tool_call":
          setThinking(false);
          setToolCalls((prev) => [...prev, { tool: data.tool, args: data.args }]);
          break;
        case "tool_result":
          setToolCalls((prev) => [...prev, { tool: data.tool, result: data.result }]);
          break;
        case "message":
          setThinking(false);
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: data.content, timestamp: Date.now(), fallback: data.fallback || false },
          ]);
          break;
      }
    };

    return () => ws.close();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages, thinking, toolCalls]);

  const send = () => {
    if (!input.trim() || !wsRef.current) return;
    const userMsg: Message = {
      role: "user",
      content: input,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    wsRef.current.send(JSON.stringify({ type: "message", content: input }));
    setInput("");
    setThinking(true);
    setToolCalls([]);
  };

  const quickActions = [
    { label: "List Workers", msg: "List all Workers on my account" },
    { label: "Read Voice Agent", msg: "Read the source code of mizan-voice-agent" },
    { label: "Check Logs", msg: "Check the error logs for mizan-voice-agent" },
    { label: "Run Code", msg: 'Run this code: export default { fetch() { return new Response("Hello from sandbox!"); } }' },
  ];

  return (
    <div className="app">
      <header>
        <h1>🔧 Coding Agent</h1>
        <div className="status">
          <span className={`dot ${connected ? "online" : "offline"}`} />
          {connected ? "Connected" : "Disconnected"}
        </div>
      </header>

      <div className="chat" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty">
            <p>Ask me to read, edit, or deploy your Cloudflare Workers.</p>
            <div className="quick-actions">
              {quickActions.map((action) => (
                <button
                  key={action.label}
                  onClick={() => {
                    setInput(action.msg);
                  }}
                  className="quick-btn"
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            <div className="role-badge">
              {msg.role === "user" ? "You" : msg.role === "assistant" ? "Agent" : "Tool"}
              {msg.fallback && <span className="fallback-badge">⚡ fallback</span>}
            </div>
            <div className="content">
              {msg.role === "assistant" ? (
                <MarkdownRenderer text={msg.content} />
              ) : (
                <pre>{msg.content}</pre>
              )}
            </div>
          </div>
        ))}

        {toolCalls.map((tc, i) => (
          <div key={`tc-${i}`} className="tool-entry">
            {"result" in tc ? (
              <div className="tool-result">
                <span className="tool-label">✅ {tc.tool}</span>
                <pre>{tc.result}</pre>
              </div>
            ) : (
              <div className="tool-call">
                <span className="tool-label">🔧 {tc.tool}</span>
                <pre>{JSON.stringify(tc.args, null, 2)}</pre>
              </div>
            )}
          </div>
        ))}

        {thinking && (
          <div className="message assistant">
            <div className="role-badge">Agent</div>
            <div className="content thinking">
              <span className="dots">Thinking</span>
            </div>
          </div>
        )}
      </div>

      <div className="input-bar">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask the agent to read, edit, or deploy Workers..."
          rows={1}
        />
        <button onClick={send} disabled={!input.trim() || !connected}>
          Send
        </button>
      </div>
    </div>
  );
}

function MarkdownRenderer({ text }: { text: string }) {
  // Simple markdown rendering for code blocks and inline code
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  return (
    <div>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const code = part.slice(3, -3).replace(/^\w*\n/, "");
          return (
            <pre key={i} className="code-block">
              {code}
            </pre>
          );
        }
        if (part.startsWith("`")) {
          return (
            <code key={i} className="inline-code">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </div>
  );
}
