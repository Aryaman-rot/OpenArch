# OpenArch

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-%23f9f1e1?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-%233178C6?logo=typescript)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/sandbox-Docker-%232496ED?logo=docker)](https://docker.com)

CLI agent that wraps arbitrary GitHub repos in Docker sandboxes and lets an LLM
generate their tool schema by reading `--help` output — so it can call
`cowsay`, run `markdownlint`, start an Express server, or query a weather API
without you writing any integration glue.

## Why

An agent's usefulness is bottlenecked by the number of tools it has. Wiring up
each CLI tool or repo by hand — writing a Zod schema, wrapping it in a Docker
call, handling errors — doesn't scale.

The idea here is: skip the integration step. Point the agent at a GitHub repo.
It clones it, detects the runtime (Node / Python / existing Dockerfile),
generates a Dockerfile if needed, builds the image, runs `--help` (or `-h`),
sends the raw help text to an LLM with a structural prompt, and gets back a
`ToolSchema` — `name`, `description`, `arguments[]` — ready to be fed into the
agent's tool loop. The whole pipeline runs inside a resource-limited,
network-isolated container.

This means a new tool is one URL away, not one coding session away.

## Architecture

The entry point is `index.ts` which registers a single Commander command
(`wakeup`). From there:

<img src="images/Screenshot%202026-07-12%20232916.png" alt="OpenArch architecture diagram" width="100%"/>

*High-level request flow from user input through modes, tools, and sandbox isolation.*

<details>
<summary>Text-based architecture diagram (for quick reference)</summary>

```
User ──→ Wakeup Menu ──→ CLI / Telegram
                            │
                    ┌───────┴────────┐
                    │                │
              Read-Only          Mutation
              Modes             Modes
           (Ask / Plan)     (Agent / Plan steps)
                    │                │
                    │        ┌───────┴────────┐
                    │        │                │
                    │   Staged File        Repo Sandbox
                    │   Overlay +         (Docker, 512m,
                    │   Diff Approval     --network none)
                    │        │                │
                    │        ├── apply ──→ Disk
                    │        │
                    │        └── skip ──→ Clear
                    │
               Web Tools
           (Firecrawl search,
            fetch_url)
```

</details>

```
bun index.ts
    └─ runWakeup()               [tui/wakeup.ts]
         ├─ CLI                  [modes/cli.ts]
         │    ├─ Agent mode      [modes/agent/orchestrator.ts]
         │    │    └─ ToolLoopAgent (max 67 steps)
         │    │         ├─ File tools (read/create/modify/delete/list/search/analyze)
         │    │         ├─ Shell execution (staged)
         │    │         ├─ Repo sandbox tools (6 tools, see below)
         │    │         └─ Approval flow → apply to disk
         │    ├─ Plan mode       [modes/plan/orchestrator.ts]
         │    │    ├─ LLM generates multi-step plan
         │    │    ├─ User selects steps
         │    │    └─ Each step → ToolLoopAgent (max 30 steps)
         │    ├─ Ask mode        [modes/ask/orchestrator.ts]
         │    │    └─ Read-only tools + web tools (max 20 steps)
         │    └─ Pragmatist mode [modes/pragmatist/orchestrator.ts]
         │         └─ Clone repo → detect env vars → prompt → run sandboxed
         └─ Telegram             [modes/telegram/index.ts]
              ├─ /ask  — read-only agent
              ├─ /agent — full mutation agent
              └─ /plan — multi-step plan with inline keyboard
```

**Sandbox layer** (`services/sandbox.ts`):
- `runContainer(imageName, args)` → `docker run --rm --memory=512m --cpus=1 --network none <image> <args>`
- `startService(imageName, port)` → `docker run -d ...` + port allocation
- `callService(handle, path)` → HTTP to the running container

**Repo runner** (`services/repo-runner.ts`):
- Clone → detect runtime (`node` | `python` | `dockerfile` | `unknown`) → generate Dockerfile → build → run/start

**Tool generator** (`services/tool-generator.ts`):
- `wrapRepoAsTool(url)` → clone → detect → Dockerfile → build → read `--help` → LLM → `ToolSchema`

**Repo agent tools** (`services/repo-agent-tools.ts`):
- `run_repo_once` — one-shot CLI execution in sandbox
- `start_repo_service` — long-running REST service
- `call_repo_service` — HTTP to running service
- `stop_repo_service` — stop + cleanup
- `wrap_repo_as_tool` — auto-generate schema from `--help`
- `run_repo_with_env` — detect env vars + interactive prompt + run

## Features

### Multi-mode CLI + Telegram

Four interaction modes in the terminal, plus a Telegram bot for remote use.

| Mode | What it does | Tools | Step limit |
|---|---|---|---|
| **Agent** | Open-ended task: read, create, modify files, run shell commands, execute repos | Full file mutation + repo sandbox | 67 |
| **Plan** | Generate a multi-step plan, select steps to execute | File mutation + web search | 30 per step |
| **Ask** | Read-only Q&A about the codebase | Read-only file tools + web search | 20 |
| **Pragmatist** | Clone a repo, detect env vars, prompt for values, run it | Repo lifecycle UI | N/A (direct) |

Telegram supports `/ask`, `/agent`, and `/plan` with interactive inline
keyboards for step selection and diff approval.

### Staged file mutation with diff approval

All file mutations (`create_file`, `modify_file`, `delete_file`, `create_folder`,
`execute_shell`) are written to an in-memory overlay map and logged as
`ActionLog` entries with status `"pending"`. Nothing touches disk until the user
approves.

The approval flow (`modes/agent/approval.ts`) offers:
- **Approve all** — apply everything at once
- **Review one by one** — grouped by file path, each showing a unified diff
  (`diff.createTwoFilesPatch`) with accept/reject per group
- **Cancel** — clear the staging area

On approval, `ToolExecutor.applyApprovedFromTracker()` walks approved actions,
creates directories, writes files, deletes files, and runs approved shell
commands via `spawnSync`. Path traversal is blocked by `resolveSafe()`, and
`.env*` files are excluded from reads.

### Sandboxed repo execution

Any GitHub repo can be cloned and run inside a Docker container with:

- `--memory=512m` RAM cap
- `--cpus=1` CPU limit
- `--network none` by default (no egress)
- `--rm` auto-cleanup on exit
- Hard timeout on clone (30s) and process execution

<img src="images/Screenshot%202026-07-12%20232840.png" alt="Sandbox execution pipeline" width="100%"/>

*Step-by-step flow: repo URL to isolated container to output, with safety boundaries and runtime-detection details.*

Two modes:
- **One-shot** — `docker run --rm <image> <args>`, returns stdout/stderr/exit
  code. Image is removed after run.
- **Service** — `docker run -d`, port mapped to a random free port in
  [30000, 40000]. The agent gets a handle and can `call_repo_service()`
  (HTTP) or `stop_repo_service()`. Image is kept for the session.

Runtime detection checks for: existing `Dockerfile`, `package.json` (Node),
`requirements.txt` / `pyproject.toml` (Python). Node images are based on
`node:20-slim`, Python on `python:3.11-slim`. If `yarn.lock` exists, yarn is
used; otherwise npm.

The test files in `services/` exercise this against real repos:

| Test file | Repo | What it does |
|---|---|---|
| `test-runner.ts` | `piuccio/cowsay` | One-shot execution with `["Hello", "from", "OpenArch"]` |
| `test-tool-generator.ts` | `piuccio/cowsay` | Full `wrapRepoAsTool` pipeline — clone → build → `--help` → LLM → schema |
| `test-service-runner.ts` | `auchenberg/node-express-hello-world` | Start as service → `GET /` → stop |
| — | `igorshubovych/markdownlint-cli` | `run_repo_once` — full sandbox pipeline, `--help` schema generation verified |
| — | `jakubzitny/openweathermap-cli` | Pragmatist mode end-to-end: README env-var detection (no `.env.example`), masked `OPENWEATHERMAP_API_KEY` prompting, devDependency-aware Dockerfile (yarn install + build), opt-in network → live London weather |

Run any of the numbered tests with `bun run services/test-<name>.ts`.

### Auto tool-schema generation from `--help`

The core loop in `services/tool-generator.ts`:

1. Build the Docker image
2. Run it with `["--help"]`
3. Capture stdout (or stderr if stdout is empty)
4. Send the raw help text to `openrouter/free` with a system prompt that
   demands a specific JSON shape:
   ```json
   { "name": "...", "description": "...", "arguments": [
     { "name": "...", "description": "...", "required": true/false }
   ]}
   ```
5. Parse and validate with Zod
6. Clean up (remove image, delete clone directory)

The result is pure metadata — no generated code, no persisted registry. The
schema is returned inline to the agent and used immediately.

### Environment variable detection (Pragmatist)

`detectEnvRequirements()` in `services/pragmatist.ts` scans the cloned repo
for env vars in order:

1. `.env.example` / `.env.sample` — parsed for `KEY=VALUE` patterns
2. README sections matching "environment", "config", or "env vars" — regex for
   `UPPER_CASE` identifiers
3. Whole README fallback — same regex, minimum 4 characters

`promptForEnvValues()` then prompts the user interactively. Values matching
`KEY|SECRET|TOKEN|PASSWORD` are masked with `*`. Once collected, they're passed
to the container via `-e KEY=VALUE`.

The Pragmatist mode (`modes/pragmatist/orchestrator.ts`) is the direct user
facing path: enter a repo URL, get prompted for detected env vars, watch it
run.

### Opt-in network access

By default, sandboxed containers get `--network none`. The agent tool
`run_repo_once` has a `allowNetwork` boolean (default `false`). The Pragmatist
mode asks "Does this repo need internet access? (y/N)". This makes accidental
egress — sending your API keys to a third-party service — impossible without an
explicit affirmative.

This was verified with a real external API call: the `openweathermap-cli` repo
returned live weather data for London when run with network access enabled, and
failed with a clear connection error under the default isolated configuration —
confirming both the isolation boundary and the opt-in override work as intended.

## Quickstart

### Prerequisites

- **Bun** (runtime)
- **Docker** (for sandboxed repo execution)
- **Git** (for cloning repos)
- **OpenRouter API key** (for the AI model)

### Setup

```bash
# Clone and install
git clone https://github.com/Aryaman-rot/OpenArch.git
cd OpenArch
bun install

# Required: AI provider
export OPENROUTER_API_KEY="sk-or-..."
export OPENROUTER_DEFAULT_MODEL="openrouter/free"

# Optional: web search (used by Plan and Ask modes)
export FIRECRAWL_API_KEY="fc-..."

# Optional: Telegram bot
export TELEGRAM_BOT_TOKEN="..."
export TELEGRAM_OWNER_ID="..."
```

### Run

```bash
bun index.ts
```

This shows the banner and a picker: **CLI** or **Telegram** or **Exit**.

Select **CLI** to get the mode menu:

```bash
? Choose mode
  ❯ Agent mode     — Full codebase editing agent
    Plan mode       — Multi-step plan execution
    Ask mode        — Read-only Q&A
    Pragmatist mode — Run a repo safely
```

Or for one-off use of the sandbox runner:

```bash
bun run services/test-runner.ts                                    # cowsay
bun run services/test-tool-generator.ts                            # cowsay → schema
bun run services/test-service-runner.ts                            # Express hello world
```

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Bun |
| AI SDK | Vercel AI SDK (`ai`) + `@openrouter/ai-sdk-provider` |
| CLI framework | Commander |
| Terminal UI | Clack prompts, Chalk, Figlet |
| Markdown rendering | marked + marked-terminal |
| Schema validation | Zod |
| Diff engine | diff (`createTwoFilesPatch`) |
| Sandbox | Docker CLI (spawn) |
| Web search | Firecrawl |
| Telegram | Telegraf |

## Known Limitations

**What works reliably today:**
- Node.js repos with CLI interfaces (tested: `cowsay`, `markdownlint-cli`, Express hello world)
- Pragmatist-mode end-to-end flow for repos with env requirements (tested: `openweathermap-cli` — README-only env detection, masked prompting, devDependency-aware Dockerfile, opt-in network access with live API call)
- File read/create/modify/delete with staged approval
- Multi-step plan generation and selective execution
- Telegram bot with `/ask`, `/agent`, `/plan`, and diff approval
- Environment variable detection from `.env.example` and README

**Known gaps:**
- **Python repos** — runtime detection and Dockerfile generation exist but
  haven't been validated end-to-end with a real Python CLI tool.
- **No persistent tool registry** — every `wrap_repo_as_tool` call rebuilds
  the image and re-generates the schema. There's no cache or database.
- **Single AI provider** — only OpenRouter is wired. No support for direct
  OpenAI, Anthropic, Ollama, or local models.
- **No web UI** — terminal and Telegram only.
- **No CI / test runner** — the three test files are standalone scripts, not
  hooks in a framework.
- **Go / Rust / other runtimes** — `detectRuntime` only handles Node, Python,
  and existing Dockerfiles. No automatic containerization for other ecosystems.
- **No multi-turn conversation state** — the agent doesn't remember past
  sessions; each invocation is fresh.
- **Telegram only supports slash commands** — no freeform chat, no natural
  language parsing of arbitrary messages.

## Safety Design

Three explicit safety boundaries:

1. **Network isolation:** `--network none` by default. Containers cannot make
   outbound connections unless the user (or agent with user approval) sets
   `allowNetwork: true`. This prevents a compromised or malicious repo from
   exfiltrating data or phoning home.

2. **Resource limits:** Every container gets `--memory=512m --cpus=1`. A 30s
   timeout on `git clone` and configurable timeouts on process execution
   prevent runaway resource consumption.

3. **Staged mutations + human approval:** No file write or shell command
   reaches disk until the user runs the approval flow. Diffs are shown per-path
   with accept/reject granularity. The staging area is purely in-memory and can
   be cleared without side effects.

4. **Path confinement:** `ToolExecutor.resolveSafe()` rejects any path that
   escapes the workspace root via `..` traversal.

These are not disclaimers — they're the actual implementation in
`services/sandbox.ts:239-241` and `modes/agent/tool-executor.ts`.
