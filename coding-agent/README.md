# Coding Agent — Cloudflare Workers + Durable Objects + Vite

A coding agent built on Cloudflare's Agents SDK that can read, edit, and deploy your other Workers.

## Features

- **AI-powered** — Uses `@cf/zai-org/glm-4.7-flash` (fast dialogue model) with `@cf/meta/llama-3.1-8b-instruct-fast` fallback
- **Service Bindings** — Zero-latency calls to `mizan-voice-agent` and other Workers
- **Cloudflare API** — Read source code, update bindings, deploy new versions of any Worker
- **Dynamic Workers** — Execute generated code in isolated sandboxes (network blocked)
- **Durable Object** — Persistent conversation history and agent state via SQLite
- **Vite + React** — Real-time WebSocket chat interface with tool call visualization

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Create the CF_API_KEY secret

You need a Cloudflare API token with Workers edit permissions so the agent can read and deploy Workers:

1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Create a token with these permissions:
   - **Account → Workers Scripts → Edit**
   - **Account → Workers Observability → Read**
3. Set it as a secret:

```sh
npx wrangler secret put CF_API_KEY
# Paste your token when prompted
```

### 3. Run locally

```sh
npm run dev          # Start Vite frontend (port 5173)
npm run dev:worker    # Start Worker dev server (port 8787)
```

Or build and preview:

```sh
npm run build
npm run deploy
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Vite + React                      │
│               (WebSocket chat UI)                     │
└──────────────────┬──────────────────────────────────┘
                   │ WebSocket
┌──────────────────▼──────────────────────────────────┐
│              Worker (worker.ts)                       │
│         routeAgentRequest → DO stub                  │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│           CodingAgent (Durable Object)                │
│                                                      │
│  ┌─────────┐  ┌──────────┐  ┌─────────────────────┐  │
│  │ AI Bind │  │ SQLite   │  │ Tools               │  │
│  │ (LLM)  │  │ (state)  │  │                     │  │
│  └─────────┘  └──────────┘  │ list_workers        │  │
│                              │ get_worker_code     │  │
│  ┌─────────────┐            │ update_worker       │  │
│  │ Fallback    │            │ call_worker (svc)   │  │
│  │ LLM (fast)  │            │ run_code (sandbox)  │  │
│  └─────────────┘            │ get_logs            │  │
│                              └─────────────────────┘  │
│                                                      │
│  ┌──────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ VOICE_AGENT  │  │ LOADER   │  │ CF_API_KEY  │  │
│  │ (svc binding)│  │ (dyn wk) │  │ (secret)      │  │
│  └──────────────┘  └──────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────┘
         │                    │               │
         ▼                    ▼               ▼
  mizan-voice-agent    Dynamic Worker     Cloudflare API
  (zero latency)      (sandboxed code)   (edit Workers)
```

## Bindings (wrangler.jsonc)

| Binding | Type | Purpose |
|---|---|---|
| `AI` | Workers AI | LLM inference (glm-4.7-flash + fallback) |
| `CODING_AGENT` | Durable Object | Agent state, SQLite, WebSocket |
| `VOICE_AGENT` | Service Binding | Call mizan-voice-agent at zero latency |
| `LOADER` | Worker Loader | Spin up Dynamic Workers for code execution |
| `CF_API_KEY` | Secret | Cloudflare API access for editing Workers |
| `ASSETS` | Static Assets | Serves Vite-built frontend |

## Tools Available to the Agent

| Tool | What It Does |
|---|---|
| `list_workers` | List all Workers on your account |
| `get_worker_code` | Read any Worker's source code |
| `update_worker` | Deploy updated code to any Worker |
| `call_worker` | Call another Worker via service binding |
| `run_code` | Execute code in an isolated Dynamic Worker sandbox |
| `get_logs` | Fetch error logs for any Worker |

## Security Notes

- Dynamic Workers have `globalOutbound: null` — all network access blocked
- `CF_API_KEY` should be scoped to only Workers permissions
- Service bindings only reach Workers you explicitly declare
- Agent conversation history is stored in the Durable Object's SQLite

## Customization

To add more service bindings (reach more Workers), edit `wrangler.jsonc`:

```jsonc
"services": [
  { "binding": "VOICE_AGENT", "service": "mizan-voice-agent" },
  { "binding": "API_GATEWAY", "service": "my-api-worker" },
  { "binding": "AUTH", "service": "my-auth-worker" }
]
```

Then update `tools.ts` to add tools that call the new bindings.
