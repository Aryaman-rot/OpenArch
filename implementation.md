# Implementation Plan

This is a practical plan for turning the current archive into a cleaner AI workspace tool.
It is written from the repo shape, the Graphify metadata, and the Telegram/CLI entry flow.

## First Answer: Telegram Always-On

Yes, this can be implemented, but there are two different meanings:

1. **Always running as a background bot**  
   This means the process starts with Telegram enabled by default, instead of asking you to choose Telegram mode first.

2. **Responding to every message, not only commands**  
   This means adding a general text-message handler, because the current bot only reacts to `/start`, `/ask`, `/agent`, `/plan`, and button actions.

So the right answer is:

- the project can do this now
- but it needs small code changes
- and the runtime should be adjusted so Telegram becomes a default startup mode or a dedicated command

## What Needs To Change For Telegram

### Minimum change

If you only want the bot to stay online and respond after launch:

- make Telegram the default startup path
- skip the mode picker when a Telegram env flag is set
- keep the bot process alive continuously

### Slightly bigger change

If you want the bot to reply when someone sends ordinary text:

- add a generic `message` handler
- decide whether plain text should trigger `ask`, `agent`, or a lightweight fallback response
- keep command-based flows for advanced actions

### Required runtime support

For real always-on use, the bot should also be run as a persistent process:

- local dev process
- system service
- Docker container
- process manager like PM2, systemd, or Bun runner

Without that, it will still stop when the terminal closes.

## Recommended Product Direction

The best direction is not a larger monolith.
It is a modular AI engineering platform with one core engine and multiple clients.

Core layers:

- orchestration
- planning
- tool execution
- approvals
- workspace graph
- memory
- logging and traces
- clients

## Stepwise Plan

### Phase 0: Lock the target behavior

Goal: define the exact experience before editing architecture.

Decide:

- should Telegram start automatically every time, or only when an env flag is set?
- should plain text trigger an automatic action, or only commands?
- should Telegram be the default mode, or just a supported mode?

Output of this phase:

- one clear Telegram behavior spec
- one clear startup spec

### Phase 1: Make Telegram a first-class startup mode

Goal: remove the manual "choose Telegram mode" step when desired.

Tasks:

- add a startup flag or env variable for Telegram auto-start
- bypass the current wakeup mode selector when that flag is set
- let the app boot directly into Telegram mode
- keep the process alive until stopped

Output of this phase:

- Telegram can start without user selection
- the bot stays online as long as the process runs

### Phase 2: Add plain-message handling

Goal: let the bot respond to normal chat messages, not just slash commands.

Tasks:

- add a generic `message` handler
- detect whether incoming text is a question, task request, or unsupported message
- route basic free-text to `/ask` or another safe default
- keep command handlers for explicit actions

Output of this phase:

- the bot can answer when you send a normal message
- commands still work for precise control

### Phase 3: Separate core engine from UI

Goal: make Telegram, CLI, and future web UI use the same execution engine.

Tasks:

- extract shared runtime types
- isolate orchestration from presentation
- centralize tool execution
- standardize run results and errors

Output of this phase:

- Telegram is only a client
- CLI is only a client
- the engine lives in one place

### Phase 4: Introduce a tool registry

Goal: make tools explicit, safer, and easier to extend.

Tasks:

- define a registry for tools
- add schemas for input and output
- mark approval-sensitive tools
- add execution metadata

Output of this phase:

- new tools can be added without random branching
- tool permissions become visible and consistent

### Phase 5: Add workspace understanding

Goal: make the system understand repositories as graphs, not just files.

Tasks:

- index files, symbols, imports, exports, and dependencies
- store references in a graph-friendly format
- answer impact questions from that graph
- surface project summaries before edits

Output of this phase:

- the system can explain what a change touches
- planning becomes smarter

### Phase 6: Add persistence and memory

Goal: remember useful history across sessions.

Tasks:

- store sessions and runs
- store project preferences
- store approval history
- store recurring decisions and mistakes

Output of this phase:

- repeated work gets faster
- the system stops forgetting everything after one run

### Phase 7: Add observability

Goal: make runs auditable.

Tasks:

- log every tool call
- log approvals and rejections
- log diffs and outcomes
- record token usage and failures

Output of this phase:

- you can understand what the agent did and why
- debugging becomes much easier

### Phase 8: Expand interfaces

Goal: keep growing without duplicating logic.

Tasks:

- keep CLI working
- keep Telegram working
- improve TUI where useful
- add web/dashboard only after the engine is stable

Output of this phase:

- one engine supports many clients

## Implementation Order I Recommend

If we want the fastest useful progress, do it in this order:

1. Make Telegram auto-start available.
2. Add a plain-message handler.
3. Separate shared core logic from Telegram and CLI code.
4. Introduce a tool registry.
5. Add workspace indexing / graph support.
6. Add persistence for sessions and memory.
7. Add observability and tracing.
8. Expand to more interfaces.

## What Not To Do Yet

Avoid these early mistakes:

- rewriting the whole project before the startup behavior is fixed
- adding a web dashboard before the engine is stable
- adding many agent roles before the core orchestration is clean
- building complex memory before you know what should be remembered

## Success Criteria

We are moving in the right direction when:

- Telegram can run without manual mode selection
- the bot can respond to normal chat input
- all clients share one engine
- tool execution is explicit and tracked
- project understanding comes from indexing and graph data
- runs are persistent and explainable

## Short Version

The immediate work is:

- make Telegram start automatically when requested
- make it respond to normal messages
- then refactor the engine so Telegram, CLI, and future UI all share the same core
