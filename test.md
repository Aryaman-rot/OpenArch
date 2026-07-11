# Ask Mode

## Question

read the \modes\agent folder and all the ts files inside it and give me a summay of each of the ts files inside the folder indivitually for each of the files

## Answer

**modes/agent/action-tracker.ts**  
- Provides a simple in‑memory log for all staged actions (`ActionLog[]`).  
- Methods: `log()` to record an action, `getActions()` to read the log, `getPendingMutations()` to fetch pending file/folder/tool‑execute actions, and `updateStatus()` to change an action’s status (approved/rejected) and optional user approval flag.  
- Works with types from `./types.ts` (`ActionLog`, `ActionStatus`, `isMutationType`).  

**modes/agent/agent-tools.ts**  
- Factory that builds the set of AI‑assistant tools exposed to the agent (read, create, modify, delete files/folders, list/search files, analyze codebase, run shell commands, list/read skills).  
- Each tool wraps a corresponding method on `ToolExecutor` and validates input via Zod schemas.  
- Returns an object whose properties are the individual tool functions (e.g., `read_file`, `create_file`, …).  

**modes/agent/approval.ts**  
- Implements the interactive approval workflow for staged changes.  
- `groupPending()` clusters pending actions by file path (or shell) into review groups, creating diffs for file changes.  
- `runApprovalFlow()` presents a CLI menu (via `@clack/prompts` and `chalk`) letting the user approve all changes, review them one‑by‑one (with optional diff view), or cancel.  
- Returns `true` if any action was approved, otherwise `false`.  

**modes/agent/diff-view.ts**  
- Small utility for generating unified diffs.  
- `formatPatch()` delegates to `diff.createTwoFilesPatch` to produce a patch string.  
- `composeBeforeAfter()` extracts the “before” and “after” contents from a sorted list of related `ActionLog` entries (handles create/modify/delete).  

**modes/agent/orchestrator.ts**  
- Entry point for running the agent mode.  
- Prompts the user for a goal, creates an `ActionTracker`, `ToolExecutor`, and the toolset via `createAgentTools`.  
- Instantiates a `ToolLoopAgent` (from the `ai` package) with the model, step limit, instructions, and tools.  
- After the agent generates a response, it runs the approval flow; if approved, applies the staged changes via `ToolExecutor.applyApprovedFromTracker()` and reports success or any errors.  
- Finally clears staging.  

**modes/agent/tool-executor.ts**  
- Core implementation that actually stages (or executes) file/system actions while respecting workspace safety rules.  
- Maintains an overlay map for staged file contents and a set for staged deletions.  
- Provides methods matching the agent tools: `readFile`, `createFile`, `modifyFile`, `deleteFile`, `createFolder`, `listFiles`, `searchFiles`, `analyzeCodebase`, `queueShell`, plus skill‑related helpers (`listSkills`, `readSkill`).  
- Each method logs an `ActionLog` (pending for mutations, executed for read‑only ops) via the injected `ActionTracker`.  
- `applyApprovedFromTracker()` walks the approved log, creates folders, writes/deletes files, and runs queued shell commands, collecting any errors.  
- `clearStaging()` resets the overlay and deleted set.  

**modes/agent/types.ts**  
- Defines the shared TypeScript types used across the agent module:  
  - `ActionType` (file_create, file_modify, file_delete, folder_create, code_analysis, tool_execute).  
  - `ActionStatus` (pending, executed, approved, rejected).  
  - `ActionLog` interface (id, timestamp, type, path, details, status, userApproved?).  
  - `AgentConfig` (workspace path, limits, exclusion patterns, tool permission flags).  
  - `defaultAgentConfig()` supplies a sensible default configuration.  
  - `isMutationType()` helper to identify actions that require user approval.
