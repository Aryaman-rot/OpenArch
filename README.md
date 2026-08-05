# OpenArch

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-%23f9f1e1?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-%233178C6?logo=typescript)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/sandbox-Docker-%232496ED?logo=docker)](https://docker.com)
[![PostgreSQL](https://img.shields.io/badge/database-PostgreSQL-%234169E1?logo=postgresql)](https://www.postgresql.org)
OpenArch is a CLI agent that containerizes arbitrary GitHub repositories on the fly, executes their command-line interfaces inside isolated Docker sandboxes, and dynamically generates their tool schemas by reading their `--help` outputs using an LLM. By automatically translating CLI help documentation into structured tool schemas, OpenArch allows an agent to leverage third-party repositories—like running `cowsay`, performing static analysis with `markdownlint`, or executing network requests via custom APIs—without requiring any manual integration glue.

## Why

Traditional agent frameworks are bottlenecked by manual tool definitions. Integrating a new tool typically requires writing a custom interface wrapper (such as a Zod schema), setting up its execution environment, and handling runtime errors manually.

OpenArch replaces manual integration with automated containerization and documentation analysis:
1. Point the agent to any public GitHub repository URL.
2. The system clones the repository, detects its runtime environment, builds a Docker image, and runs it with the `--help` flag.
3. The raw console help output is structured by an LLM into an exact JSON tool schema (containing argument names, descriptions, types, and requirements).
4. The schema is loaded dynamically into the agent's tool loop, making the repository immediately executable inside a resource-constrained, isolated Docker container.

## Architecture

The system entry point is `index.ts`, which runs the Commander-based `wakeup` TUI menu. From there, execution flows through interaction modes, tool executors, and the sandboxed container runtime.

<img src="docs/images/architecture-diagram-updated.png" alt="OpenArch architecture diagram" width="800">

*High-level request flow from user input through modes, tools, database caching, and sandbox isolation.*

<details>
<summary>Text-based architecture diagram</summary>

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
                    │   Staged File        Repo Sandbox (Docker, 512m, --network none)
                    │   Overlay +                 ▲
                    │   Diff Approval             │ Check Cache / Save
                    │        │                    ▼
                    │        ├── apply ──→ Disk   PostgreSQL Registry (wrapped_repos)
                    │        │
                    │        └── skip ──→ Clear
                    │
               Web Tools
           (Firecrawl search,
            fetch_url)
```

```
bun index.ts
    └─ runWakeup()               [tui/wakeup.ts]
         ├─ CLI                  [modes/cli.ts]
         │    ├─ Agent mode      [modes/agent/orchestrator.ts]
         │    │    └─ ToolLoopAgent (max 67 steps)
         │    │         ├─ File tools (read/create/modify/delete/list/search/analyze)
         │    │         ├─ Shell execution (staged)
         │    │         ├─ Repo sandbox tools (list_sandboxes, cleanup_sandboxes, etc.)
         │    │         ├─ PostgreSQL registry cache check
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

</details>

- **Sandbox layer** (`services/sandbox.ts`): Orchestrates low-level Docker calls (spawning `docker run` with resource restrictions, network settings, and volume mounts) and manages service container lifecycles.
- **Repo runner** (`services/repo-runner.ts`): Detects runtimes, generates appropriate Dockerfiles dynamically, and handles the cloning/building process.
- **Tool generator** (`services/tool-generator.ts`): Invokes the container `--help` step and uses an LLM to build a validated Zod tool schema.
- **Registry layer** (`services/registry.ts`): Interacts with PostgreSQL to cache built tool schemas and local image statuses.

---

## Tech Stack

| Layer | Component | Choice |
|---|---|---|
| **Runtime** | Execution Environment | Bun |
| **Database** | Registry & Caching | PostgreSQL (`pg` / `node-postgres`) |
| **AI SDK** | Core AI & Integration | Vercel AI SDK (`ai`) + `@openrouter/ai-sdk-provider` |
| **CLI** | Framework | Commander |
| **Terminal UI** | Visual Prompts & Banner | `@clack/prompts`, `chalk`, `figlet` |
| **Markdown** | Terminal Text Rendering | `marked` + `marked-terminal` |
| **Validation** | Schema Validation | `zod` |
| **Diffing** | Patch Engine | `diff` |
| **Sandbox** | Containerization | Docker CLI |
| **Web Search** | Egress Data Retrieval | Firecrawl (`@mendable/firecrawl-js`) |
| **Telegram** | Bot Interface | Telegraf |

---

## Features

### Multi-Mode CLI & Telegram Bot

OpenArch provides four separate execution environments via CLI and a Telegram bot interface.

| Mode | Purpose | Tool Access | Limit |
|---|---|---|---|
| **Agent** | Codebase modifications and arbitrary execution | Full filesystem mutation, staged shell commands, repo sandbox tools | 67 steps |
| **Plan** | Multi-step task decomposition and step-by-step review | File mutation + web search (interactive execution per-step) | 30 steps/step |
| **Ask** | Read-only questions and codebase analysis | Read-only file tools + web search | 20 steps |
| **Pragmatist** | Sandbox-only execution for foreign CLI tools | Directly collects env requirements and executes sandboxed commands | N/A (direct TUI) |

The Telegram bot (`modes/telegram/`) implements `/ask`, `/agent`, and `/plan` using inline keyboards for interactive diff approvals and step selection.

### Multi-Turn Conversation with Persistent History

Agent Mode and Ask Mode stay active across follow-up questions within a single session instead of returning to the mode menu after each answer. Conversation history is carried forward across turns so the model retains context from earlier in the session. Type `exit`, `back`, or `quit` (or press Esc) to return to the mode selection menu.

### User-Configurable AI Model

The AI model used across all modes is selected at runtime from the `MODEL` environment variable, falling back to `OPENROUTER_DEFAULT_MODEL`, then `openrouter/free`. Users can pick or change models at any time via:
- The first-run setup prompt on initial launch (if no model is configured).
- The **Change AI Model** option in the wakeup menu.
- `bun index.ts config` from the command line.

The model picker fetches the current catalog live from OpenRouter's public `/api/v1/models` endpoint, displaying real model names with input/output pricing per million tokens. If the fetch fails, a small offline fallback list is shown. Custom model IDs (any OpenRouter-compatible string) can also be entered manually.

### Friendly AI API Error Handling

All AI API errors across Agent, Ask, Plan, and Telegram modes are caught and classified by `ai/ai-error.ts` into specific, actionable messages rather than raw stack traces:
- **404 / Model unavailable**: Names the selected model and links to `bun index.ts config`.
- **402 / Insufficient credits**: Directs to OpenRouter's credit top-up page or suggests switching to a free model.
- **401 / Invalid API key**: Points to `OPENROUTER_API_KEY` in `.env` and the OpenRouter key management page.
- **Other API errors**: Shows the status code and a suggestion to switch models.

### Generic Tool-Call Progress Indicators

All tool calls — including regular file and workspace tools (`read_file`, `search_files`, `list_files`, etc.) — display a lightweight `Running <tool_name>…` status line while executing, using the same animated progress bar already used for sandbox tools (`services/repo-progress.ts`). Fast tools produce a brief flash; the indicator is consistent regardless of tool duration.

### Staged File Mutation with Diff Approval

File writes and modifications do not touch the host disk immediately. 
- All filesystem-mutating tools (`create_file`, `modify_file`, `delete_file`, `create_folder`, and `execute_shell`) write their outputs to an in-memory overlay map.
- Changes are tracked as pending actions (`ActionLog`).
- The user is presented with a diff approval prompt (`modes/agent/approval.ts`), allowing them to **approve all**, **review changes line-by-line** (using unified diffs generated by `diff`), or **cancel** (clearing the staging area entirely).
- Path traversal outside the workspace is prevented by `resolveSafe()`.

### Sandboxed Repo Execution

Repositories can be cloned and run safely under isolated container conditions:

<img src="docs/images/sandbox-diagram-updated.png" alt="Sandbox execution pipeline diagram" width="800">

*The sandbox execution pipeline from repo URL ingestion to isolated container run.*

- **Resource Limits**: Every container is run with strict RAM caps (`--memory=512m`), CPU restrictions (`--cpus=1`), and a 30-second clone timeout.
- **One-Shot Execution**: Runs a single command in an ephemeral container (`docker run --rm <image> <args>`) and returns stdout, stderr, and the exit code.
- **Service Execution**: Starts long-running processes (e.g. backend web servers) by mapping container ports to host ports in the range `[30000, 40000]`. The agent interacts with the service using `call_repo_service` and terminates it via `stop_repo_service`.
- **Runtime Detection**: Identifies Node.js applications (via `package.json` with npm/yarn support), Python scripts (using `requirements.txt`, `pyproject.toml`, or fallbacks to single root `.py`/`main.py` files), and existing `Dockerfile` configurations.

### Auto Tool-Schema Generation from `--help`

By executing a repository image with standard `--help` arguments, OpenArch fetches documentation directly from the tool itself. The system sends this raw text to an LLM alongside a strict structural prompt. The parsed output is validated against a Zod schema to produce a clean tool definition containing argument parameters and flag configurations:

```json
{
  "name": "cowsay",
  "description": "cowsay generates an ASCII picture of a cow saying something.",
  "arguments": [
    { "name": "text", "description": "The message for the cow to say", "required": true }
  ]
}
```

### Environment Variable Detection & Secure Collection

When running under Pragmatist mode, the system scans the repository directory to detect configuration requirements:
1. Parses `.env.example` or `.env.sample`.
2. Inspects markdown sections inside the `README` for configuration keywords.
3. Falls back to scanning the entire `README` text for uppercase environment variable patterns.

Detected variables are requested from the user in the terminal. Sensitive keys (matching strings like `KEY`, `SECRET`, `TOKEN`, or `PASSWORD`) mask user input with `*` as they are typed.

### Opt-in Network Access

Containers run with isolated network stacks (`--network none`) by default. This makes it impossible for untrusted code to exfiltrate keys or make unauthorized external requests. 
- For sandboxed repos requiring API connections, the agent tool `run_repo_once` accepts an explicit `allowNetwork` parameter.
- Pragmatist mode prompts the user interactively before enabling external network access.

### Persistent Tool Registry

To prevent redundant build overhead, OpenArch implements a PostgreSQL-backed caching layer (`services/registry.ts`).

<img src="docs/images/tool-registry-cache-updated.png" alt="Registry caching flow diagram" width="800">

*The registry caching logic detailing fast-path execution and rebuild recovery flow.*

- **Caching**: The `wrapped_repos` table records the `repo_url`, `runtime_kind`, local `image_name`, and the generated `tool_schema`.
- **Fast-Path Check**: On repeat runs, OpenArch checks the registry. If a record is found and the Docker image still exists locally, the system skips cloning and rebuilding, launching the cached tool instantly.
- **Graceful Fallback**: If a database entry exists but the corresponding local Docker image was pruned, OpenArch catches the error, deletes the stale registry entry, and rebuilds the tool automatically.
- **Zero-Config Portability**: The database registry is optional. If `DATABASE_URL` is not set, OpenArch bypasses caching and runs in-memory without breaking.

### Sandbox Cleanup Tools

OpenArch exposes `list_sandboxes` and `cleanup_sandboxes` tools to help prune Docker disk usage.
- `list_sandboxes`: Queries the Docker CLI for all images referencing the `openarch-*` tag and returns their size and creation date.
- `cleanup_sandboxes`: Prunes built images either by age (`olderThanDays`) or altogether (`all: true`). The tool rejects empty parameters to prevent accidental bulk deletions.

### Self-Documenting Tool Discovery

Instead of dumping the entire toolset into the initial system prompt (which consumes token context), modes include a hint instructing the model to list tools as needed.
- The `list_available_tools` tool returns a JSON description of all registered tools.
- Output is mode-scoped (e.g. Ask Mode receives only read-only and web utilities, whereas Agent Mode receives full system tools).

---

## Quickstart

### Prerequisites
- **Bun**: Install the runtime via `curl -fsSL https://bun.sh/install | bash`.
- **Docker**: Must be installed and running locally.
- **Git**: Installed and configured on your path.
- **OpenRouter API Key**: A valid key for the model orchestrator.

### Setup

1. Clone the repository and install project dependencies:
   ```bash
   git clone https://github.com/Aryaman-rot/OpenArch.git
   cd OpenArch
   bun install
   ```

2. Configure environment variables in your terminal (or a `.env` file — `.env` is gitignored):
   ```bash
   # Required: OpenRouter API key
   OPENROUTER_API_KEY="sk-or-..."

   # Optional: preferred AI model (any OpenRouter model ID).
   # If unset, you'll be prompted to choose on first run.
   # Falls back to OPENROUTER_DEFAULT_MODEL, then "openrouter/free".
   MODEL="openai/gpt-4o"

   # Optional: Database caching (registry fallback will disable caching if unset)
   DATABASE_URL="postgres://username:password@localhost:5432/openarch"

   # Optional: Web search integration
   FIRECRAWL_API_KEY="fc-..."

   # Optional: Telegram bot credentials
   TELEGRAM_BOT_TOKEN="123456:ABC..."
   TELEGRAM_OWNER_ID="987654321"
   ```

   Run `bun index.ts config` at any time to interactively update the model from the live OpenRouter catalog.

### Run

Launch the interactive wakeup menu:
```bash
bun index.ts
```

Alternatively, you can run standalone test scripts directly:
```bash
bun run services/test-runner.ts           # Runs cowsay sandbox test
bun run services/test-tool-generator.ts   # Runs cowsay schema generation test
bun run services/test-service-runner.ts   # Runs Express service test
```

---

## Known Limitations & Roadmap

### What works reliably today:
- **Node.js CLI Tools**: Tested end-to-end against `piuccio/cowsay`, `igorshubovych/markdownlint-cli`, and `auchenberg/node-express-hello-world`.
- **Python CLI Tools**: Tested and verified on `alfredodeza/argparse-python-cli` (correctly falling back to single root-level py scripts without dependency files).
- **Environment Variable Detection**: Scans `.env.example` and reads README files to detect secret requirements (tested against `jakubzitny/openweathermap-cli` to retrieve weather data using opt-in network overrides).
- **Staged Approvals**: Unified diff previews and selective disk updates.
- **Registry Caching**: Postgres-backed image mapping with automatic rebuild recovery.
- **Multi-turn Agent & Ask sessions**: Both modes maintain conversation history across follow-up questions within a session.
- **Model switching**: Live model catalog fetched from OpenRouter; model switchable at any time via `bun index.ts config` or the wakeup menu.

### Known Gaps:
- **Plan Mode requires structured-output support**: Plan generation relies on the model producing valid structured JSON output. Free-tier models tested on OpenRouter (including `inclusionai/ling-3.0-flash:free`, `poolside/laguna-s-2.1:free`, and Cohere's free tier) failed to do so reliably — returning 400 errors or unparseable responses. Models from major providers (Anthropic, OpenAI, Google) are expected to work based on their documented structured-output capabilities, but this has not been confirmed end-to-end due to credit unavailability during testing. **If Plan Mode returns an error immediately after generating the plan, switching to a non-free model is the recommended fix.**
- **Single Provider Constraint**: Locked to OpenRouter. No direct configuration hooks for independent OpenAI, Anthropic, or local Ollama endpoints.
- **Limited Runtime Ecosystems**: Only Node.js, Python, and existing `Dockerfile` repositories are automatically detected. No build generation for Go, Rust, or C++ CLIs.
- **No persistent cross-session memory**: Agent history is maintained within a single session but does not persist across separate CLI invocations.
- **No web UI**: Interface is constrained to Terminal TUI and Telegram bot keyboards.

### Reliability & Error Handling:
- **Docker unavailability**: If Docker is not running or not installed, a non-blocking warning is shown at startup and any sandbox tool invocation surfaces a clear install/start message instead of a raw connection error — non-sandbox features (Ask Mode, Agent Mode for file work) remain fully usable without Docker.
- **Terminal input stability**: All CLI mode transitions now perform cleanup (raw mode restoration, keypress listener teardown) in `try/finally` blocks, so a crash in any mode returns cleanly to the menu with working input rather than freezing the terminal.
- **Git Clone Hangs**: Failed clones (invalid or unreachable URLs) reject with a clean error within 30 seconds instead of hanging indefinitely.
- **Windows Process Cleanup**: Aborted Docker builds and commands on Windows clean up their entire process tree using `taskkill /PID /T /F`.
- **Cached Output Decoding**: Raw byte chunks are buffered and decoded once at the end, preventing multi-byte UTF-8 character corruption in cached sandbox output.

---

## Safety Design

1. **Network Egress Boundaries**: Sandboxes use `--network none` by default. Egress must be explicitly enabled with `allowNetwork: true` per invocation (implemented in `services/sandbox.ts`).
2. **Resource Constraints**: Docker limits CPU cores (`--cpus=1`) and memory (`--memory=512m`) to prevent infinite loops or memory leaks from freezing the host machine.
3. **Staged Disk Mutations**: The orchestrator writes all updates to an in-memory overlay map. Real files are only modified after the user reviews unified diffs and confirms changes via the TUI approval flow (`modes/agent/approval.ts`).
4. **Path Traversal Guards**: The tool executor uses `resolveSafe()` to block any paths containing parent directory pointers (`..`) from escaping the workspace directory.

---

## License

This project is licensed under the **MIT License** — see the [LICENSE](./LICENSE) file for details.

Copyright (c) 2026 [Aryaman-rot](https://github.com/Aryaman-rot)
