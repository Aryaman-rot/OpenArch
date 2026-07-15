# OpenArch

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-%23f9f1e1?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-%233178C6?logo=typescript)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/sandbox-Docker-%232496ED?logo=docker)](https://docker.com)
[![PostgreSQL](https://img.shields.io/badge/database-PostgreSQL-%234169E1?logo=postgresql)](https://www.postgresql.org)

*Note: A LICENSE file was not found in the root of the repository; this project is assumed to be distributed under the MIT license.*

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

2. Configure environment variables in your terminal:
   ```bash
   # Required: AI config
   export OPENROUTER_API_KEY="sk-or-..."
   export OPENROUTER_DEFAULT_MODEL="openrouter/free"

   # Optional: Database caching (registry fallback will disable caching if unset)
   export DATABASE_URL="postgres://username:password@localhost:5432/openarch"

   # Optional: Web search integration
   export FIRECRAWL_API_KEY="fc-..."

   # Optional: Telegram bot credentials
   export TELEGRAM_BOT_TOKEN="123456:ABC..."
   export TELEGRAM_OWNER_ID="987654321"
   ```

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

### Known Gaps:
- **Single Provider Constraint**: Locked to OpenRouter. No direct configuration hooks for independent OpenAI, Anthropic, or local Ollama endpoints.
- **Limited Runtime Ecosystems**: Only Node.js, Python, and existing `Dockerfile` repositories are automatically detected. No build generation for Go, Rust, or C++ CLIs.
- **No Multi-Turn Agent Session State**: The agent has no memory of past runs; context restarts fresh with each CLI invocation.
- **No web UI**: Interface is constrained to Terminal TUI and Telegram bot keyboards.

### Hardening & Resolved Issues:
- **Git Clone Hangs**: Fixed a promise rejection failure where failed git clones (like invalid or unreachable URLs) would hang indefinitely; cloning now rejects with a clean error within 30 seconds.
- **Windows Process Cleanup**: Aborted Docker builds and commands on Windows now clean up their entire process tree using `taskkill /PID /T /F` rather than leaving orphaned containers or ignoring SIGTERM.
- **Terminal Input Freezes**: Resolved a stdin/readline stream conflict that caused terminal inputs to freeze when a mode was re-entered a second time in a single CLI session.
- **Cached Output Decoding**: Corrected output decoding issues on cached sandboxes by buffering raw chunks and decoding once at the end, preventing multi-byte UTF-8 character corruption.
- **Opt-in Network Isolation**: Sandboxed executions default strictly to network isolation, requiring explicit `allowNetwork` permissions to prevent unexpected data exfiltration.

---

## Safety Design

1. **Network Egress Boundaries**: Sandboxes use `--network none` by default. Egress must be explicitly enabled with `allowNetwork: true` per invocation (implemented in `services/sandbox.ts`).
2. **Resource Constraints**: Docker limits CPU cores (`--cpus=1`) and memory (`--memory=512m`) to prevent infinite loops or memory leaks from freezing the host machine.
3. **Staged Disk Mutations**: The orchestrator writes all updates to an in-memory overlay map. Real files are only modified after the user reviews unified diffs and confirms changes via the TUI approval flow (`modes/agent/approval.ts`).
4. **Path Traversal Guards**: The tool executor uses `resolveSafe()` to block any paths containing parent directory pointers (`..`) from escaping the workspace directory.
