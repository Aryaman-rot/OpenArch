# Docker Commands Reference — Learned via cowsay exercise

A running log of every Docker concept and command used so far, explained in
plain language, plus which ones matter most for the OpenArch sandbox project.

---

## The core mental model

| Term | Plain meaning |
|---|---|
| **Image** | A frozen, ready-to-use package (code + everything it needs to run). Like a sealed tiffin box. You don't run an image directly. |
| **Container** | A *running* instance of an image. Opening and using that tiffin box. |
| **Dockerfile** | The recipe card — text instructions for how to build an image. |
| **Docker Engine / Desktop** | The background service that actually does the building and running. Must be "on" (running) for any `docker` command to work. |
| **Registry (Docker Hub)** | The public shelf of ready-made images (like `node:20-slim`) you can download instead of building from scratch. |

---

## Terminal commands (PowerShell) — setup & checks

| Command | What it does |
|---|---|
| `docker --version` | Confirms the Docker CLI is installed and on PATH |
| `docker info` | Confirms the Docker **engine** is actually running (not just installed) |
| `docker run hello-world` | The standard "is everything working" sanity test — pulls a tiny image and runs it |

---

## Dockerfile instructions (go INSIDE the `Dockerfile` text file — never typed directly into PowerShell)

| Instruction | Plain meaning | Used in cowsay? |
|---|---|---|
| `FROM <image>` | Start from an existing base image instead of nothing. Always the first line. | ✅ `FROM node:20-slim` |
| `WORKDIR <path>` | Set the "current folder" inside the image for every instruction after it | ✅ `WORKDIR /app` |
| `COPY <src> <dest>` | Copy files from your computer into the image | ✅ `COPY . .` (copy everything) |
| `RUN <command>` | Execute a command *while building* the image (e.g. installing dependencies) | ✅ `RUN npm install` |
| `CMD [...]` | The **default** command run when the container starts — **gets fully replaced** if you pass extra arguments to `docker run` | ⚠️ Tried first, caused a bug |
| `ENTRYPOINT [...]` | The **fixed** command run when the container starts — extra `docker run` arguments get **appended**, not replaced | ✅ `ENTRYPOINT ["node", "cli.js"]` — this is what actually worked |
| `EXPOSE <port>` | Documents which port the container listens on (for web services, not needed for CLIs) | Not used yet — will matter for REST-API repos later |
| `ENV <key>=<value>` | Set an environment variable inside the image | Not used yet |

**Key lesson learned:** `CMD` vs `ENTRYPOINT` — use `ENTRYPOINT` when you always want the same base command (like `node cli.js`) and just want to feed it different arguments each time you run it. Use `CMD` only when you want a fully overridable default.

---

## `docker build` — creating an image

| Command | Plain meaning |
|---|---|
| `docker build -t <name> .` | "Prepare an image using the Dockerfile in this folder (`.`), and label it `<name>`" |
| `docker build -t <name> -f <path> .` | Same, but use a Dockerfile at a custom path/name (not needed yet, but useful later when generating Dockerfiles dynamically for different repos) |

**Why the build order matters (layer caching):** Docker builds top-to-bottom and caches each step. If an early step (like `COPY package.json`) hasn't changed, Docker skips redoing that step and everything before it on the next build — faster rebuilds. This is why splitting `COPY package.json` before `COPY . .` is often recommended — though in cowsay's case, we had to skip that trick because its install step needed all source files present upfront.

---

## `docker run` — actually running a container

| Command | Plain meaning |
|---|---|
| `docker run <image>` | Start a container from an image using its default command |
| `docker run --rm <image>` | Same, but auto-delete the container once it exits (no clutter left behind) |
| `docker run --rm <image> "arg"` | Pass extra arguments — appended to `ENTRYPOINT`, or replaces `CMD` entirely (the bug we hit) |
| `docker run --rm --network none <image>` | **Sandbox flag** — container has NO internet access at all |
| `docker run --rm --memory=512m --cpus=1 <image>` | **Sandbox flags** — cap how much RAM/CPU the container can use |
| `docker run -it <image> sh` | Start a container and drop into an interactive shell inside it (useful for poking around/debugging) |
| `docker run -p 8080:80 <image>` | Map container's internal port 80 to your machine's port 8080 (needed later for REST-API repos, not used yet) |

### ⭐ Most important flags for OpenArch specifically:
```powershell
docker run --rm --network none --memory=512m --cpus=1 <image> <args>
```
This is the exact "safe box" pattern the whole sandbox project is built around:
isolated, no network, resource-capped, self-cleaning.

---

## Inspecting / managing things

| Command | What it does |
|---|---|
| `docker ps` | List currently **running** containers |
| `docker ps -a` | List **all** containers, including stopped ones |
| `docker images` | List all images you've built or downloaded |
| `docker stop <container-id>` | Stop a running container |
| `docker rm <container-id>` | Delete a stopped container |
| `docker rmi <image-id>` | Delete an image |
| `docker exec -it <container-id> sh` | Open a shell inside an *already running* container (different from `docker run -it`, which starts a new one) |
| `type Dockerfile` (PowerShell) | Print file contents — used constantly to sanity-check the Dockerfile before building |

---

## Errors we actually hit, and the real cause

| Error | Real cause | Fix |
|---|---|---|
| `failed to connect to the docker API` | Docker Desktop (the engine) wasn't running | Open Docker Desktop, wait for "Engine running" |
| `docker : term not recognized` | Docker CLI not on PowerShell's PATH | Reinstall / manually add install folder to PATH, open fresh terminal |
| `failed to read dockerfile: no such file or directory` | The `Dockerfile` didn't actually exist (editor saved it wrong, or it was never created) | Created directly via PowerShell `Out-File` to avoid hidden `.txt` extensions |
| `WORKDIR/COPY not recognized as cmdlet` | Typed Dockerfile instructions directly into PowerShell instead of writing them into the Dockerfile | Dockerfile instructions only belong inside the Dockerfile text file |
| `Could not resolve entry module (rollup.config.js)` | Only copied `package.json` before `npm install`, but this project's install step needed full source present | Changed to `COPY . .` before `RUN npm install` |
| `Cannot find module '/app/Hello Docker'` | Used `CMD`, which gets fully replaced by `docker run` arguments — Node tried to load "Hello Docker" as a file | Switched to `ENTRYPOINT`, which appends arguments instead of replacing them |

---

## Next Docker concepts to learn (not covered yet)

- `docker-compose` — running multiple containers together (relevant once wrapping REST-API repos that need a database)
- `.dockerignore` — excluding files from being copied into the image (e.g. `node_modules`, `.git`)
- Multi-stage builds — building in one image, copying only the final result into a smaller final image (makes images smaller/faster)
- `docker network` — custom networking between containers (only relevant if services need to talk to each other)
- Named volumes — persisting data across container restarts

These will come up naturally as you move from "one CLI repo" to REST-API repos and eventually the OpenArch `services/sandbox.ts` implementation.
