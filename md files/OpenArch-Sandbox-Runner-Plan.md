# OpenArch — Sandboxed Repo Runner & Auto-Tool Generator

**Project goal:** Extend OpenArch (existing agent CLI) so it can take an arbitrary
GitHub repo, run it safely in an isolated sandbox, and automatically generate a
callable tool interface for it — without hand-written integration code per repo.

**Scope discipline:** This is built to work reliably on 5–8 hand-picked repos,
not "any repo on GitHub." Depth over breadth.

---

## 1. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Agent runtime | Bun + TypeScript (existing OpenArch code) | Already built |
| LLM provider | OpenRouter via `ai` SDK (existing `ai.config.ts`) | Already built |
| Sandbox | Docker (via `dockerode` npm package, or shelling out to `docker` CLI) | Mature, well-documented, good enough for v1 — skip Firecracker/gVisor for now |
| Repo fetching | `simple-git` or plain `git clone` via `spawnSync` | Simple, no need for GitHub API auth for public repos |
| Runtime detection | File-marker checks (`package.json`, `requirements.txt`, `go.mod`, `Dockerfile`) | Cheap heuristic, no ML needed |
| CLI help parsing → tool schema | LLM call (existing `getAgentModel()`) + `zod` schema validation | Reuses your existing AI SDK tool pattern |
| REST API discovery | Look for `/openapi.json`, `/swagger.json`; fallback to README + LLM | OpenAPI parsing is close to free when present |
| Tool registration | Existing `tool()` pattern from `ai` SDK, same as `agent-tools.ts` | No new abstraction needed |
| Action logging | Extend existing `ActionTracker` / `ActionLog` types | Plumbing already exists |
| Networking (sandbox → host) | Docker port mapping (`-p`) for REST services | Standard Docker feature |

No new frameworks needed beyond Docker tooling — everything else builds on what
you already have in the repo.

---

## 2. Architecture Overview

```
User task
   │
   ▼
OpenArch Agent (existing ToolLoopAgent)
   │
   ├── existing tools: read_file, modify_file, execute_shell, etc.
   │
   └── NEW: dynamically-generated service tools
          │
          ▼
   ServiceRegistry
          │
   ┌──────┴───────┐
   │              │
RepoRunner    ToolSchemaGenerator
(sandbox +     (help-text / OpenAPI
 lifecycle)     → JSON schema)
   │
   ▼
Docker container (isolated, no network by default,
memory/CPU capped, timeout-killed)
```

---

## Phase 0 — Prep (2–4 days)

**Goal:** Environment ready, targets picked, no code yet.

- [ ] Install Docker locally, confirm `docker run hello-world` works
- [ ] Learn/refresh: `docker build`, `docker run -p`, `docker run --network none`, `--memory`, `--cpus`, `--rm`
- [ ] Pick 5–8 target repos in advance:
  - 2–3 simple CLI tools (single binary/script, clear `--help` output)
  - 2–3 small REST/HTTP services (bonus if they ship an OpenAPI spec)
  - Prefer well-maintained, well-documented repos — don't fight bad repos yet
- [ ] Write down the list in a `TARGETS.md` file with repo URL + what you expect it to do

**Done when:** You have a fixed list of target repos and Docker works on your machine.

---

## Phase 1 — The Sandbox (build this first, it's the spine)

**Goal:** Given a repo URL, clone it, detect its runtime, and run it inside an
isolated container.

### Steps
1. `cloneRepo(url): string` — clone into a scratch dir (e.g. `/tmp/openarch-runs/<id>/`)
2. `detectRuntime(path): RuntimeInfo` — check in order:
   - `Dockerfile` present → use as-is
   - `package.json` → Node runtime, infer start command from `scripts.start` or `main`
   - `requirements.txt` / `pyproject.toml` → Python runtime
   - `go.mod` → Go runtime
   - none matched → fail gracefully with a clear error, don't guess wildly
3. `generateDockerfile(runtimeInfo): string` — if no `Dockerfile` exists, template one out (`FROM node:20-slim`, `RUN npm install`, `CMD [...]`, etc.)
4. `buildImage(path): imageId` — `docker build`
5. `runContainer(imageId, opts): ContainerHandle` — always with:
   - `--network none` by default (opt-in network only if the service genuinely needs outbound access)
   - `--memory=512m --cpus=1` (tune per repo)
   - `--rm` so nothing lingers
   - a hard timeout that kills the container if exceeded
6. `stopContainer(handle)` — cleanup

**Milestone / demo:** Point this at all 5–8 target repos. Each one starts inside
an isolated container. Prove isolation: confirm no outbound network access, and
that the container is destroyed after use.

**Type sketch (extend your existing `modes/agent/types.ts` patterns):**
```ts
interface RuntimeInfo {
  kind: "node" | "python" | "go" | "dockerfile";
  startCommand: string;
  exposedPort?: number;
}

interface ContainerHandle {
  id: string;
  kind: "cli" | "http";
  hostPort?: number; // only for http
}
```

---

## Phase 2 — Talking to What's Running

**Goal:** Actually send input and get output back from the sandboxed service.

### For CLI-style repos
- `execInContainer(handle, args: string[]): { stdout, stderr, exitCode }` via `docker exec`

### For HTTP-style repos
- Map container's internal port to a host port at `docker run -p` time
- `callHttp(handle, path, method, body): response` — plain `fetch()` to `localhost:<hostPort>`

**Milestone / demo:** Manually (via a test script, not yet through the agent)
run a command against a sandboxed CLI repo and get real stdout back. Separately,
`curl` a sandboxed REST repo and get a real response back.

---

## Phase 3 — Auto Tool Generation (the actual twist)

**Goal:** Turn a running service into a tool definition the agent can call,
without you writing that tool by hand.

### For CLIs
1. Run the binary with `--help` (or `-h`) inside the container, capture output
2. Send that raw text to the LLM with a system prompt like:
   > "Given this CLI help text, output a JSON schema describing each command,
   > its arguments, and their types, matching this format: `{...}`"
3. Validate the response against a `zod` schema (fail closed — if it doesn't
   validate, don't register the tool)
4. Convert into an `ai` SDK `tool({ description, inputSchema, execute })`
   definition, where `execute` calls `execInContainer` under the hood

### For REST APIs
1. Check for `/openapi.json` or `/swagger.json` at the mapped port first — if
   present, parse it directly into tool defs (no LLM needed, more reliable)
2. If absent, fall back to: feed the README + a sample of endpoint responses
   to the LLM, ask it to infer available endpoints and generate the same
   schema format as above
3. Same `zod` validation + fail-closed behavior

**Milestone / demo:** For at least 2 repos (one CLI, one REST), the pipeline
generates a working tool definition with zero hand-written schema, and you can
call it directly and get correct results.

---

## Phase 4 — Wire Into OpenArch

**Goal:** Make these generated tools available inside the existing agent loop.

- [ ] Build a `ServiceRegistry` that holds active `ContainerHandle`s + their
      generated tool defs
- [ ] Merge registry tools into `createAgentTools(executor)` the same way
      `createWebTools` is merged in today (see `modes/plan/orchestrator.ts`
      for the existing pattern)
- [ ] Extend `ActionTracker`/`ActionLog` (in `modes/agent/types.ts`) with a
      new `ActionType`: `"service_call"`, logging which service, what input,
      what output — reuse the existing approval flow so service calls can be
      reviewed/approved like file edits
- [ ] Add lifecycle commands: `start_service <repo>`, `stop_service <id>`,
      `list_services` as new tools in `agent-tools.ts`

**Milestone / demo:** Give the agent a task that requires using one of your
wrapped repos as a tool (e.g. "convert this markdown file using the wrapped
CLI tool"), and watch it call the service and use the result — through the
normal Agent Mode flow, diff/approval and all.

---

## Phase 5 — Polish for Demo

- [ ] Get all 5–8 target repos working reliably end-to-end
- [ ] Record a short screen-capture GIF/video of the full flow: point at a
      repo URL → agent runs it in sandbox → tool auto-generated → agent uses
      it to complete a task
- [ ] Write the README: problem statement, architecture diagram, the 5–8
      supported repos, known limitations (be explicit and honest about what
      breaks it — this matters for interviews)
- [ ] Note the failure cases you hit and how you handled them (great
      interview material)

---

## 3. Explicit Non-Goals (v1)

To keep this finishable, deliberately **do not** attempt:
- Supporting arbitrary/unknown repos with no runtime markers
- Multi-service orchestration (services calling other services)
- Production-grade sandboxing (Firecracker/gVisor) — Docker is enough for v1
- Authentication/secrets management for wrapped services
- Persisting service state across restarts

These are all legitimate "future work" bullet points for your README, but
building them now risks never finishing v1.

---

## 4. Suggested Repo Structure Additions

```
OpenArch-build/
├── services/
│   ├── repo-runner.ts        # Phase 1: clone, detect, build, run
│   ├── sandbox.ts            # Docker wrapper (build/run/exec/stop)
│   ├── tool-generator.ts     # Phase 3: help-text/OpenAPI → tool schema
│   ├── service-registry.ts   # Phase 4: active services + generated tools
│   └── types.ts              # RuntimeInfo, ContainerHandle, etc.
├── TARGETS.md                # Phase 0: your fixed list of target repos
```

This slots in alongside your existing `modes/agent/`, `modes/plan/`, etc.
without needing to touch their internals — `service-registry.ts` tools just
get merged into the existing tool sets the same way `createWebTools` already is.
