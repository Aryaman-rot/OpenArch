#!/usr/bin/env node

import { Command } from "commander";
import { runWakeup } from "./tui/wakeup";
import { promptAndSaveModel } from "./tui/model-select";
import { loadEnvConfig } from "./services/env-config";
import { checkForUpdatesAsync } from "./services/update-check";
import pkg from "./package.json" assert { type: "json" };

// Load configuration from ~/.openarch/.env and/or local .env
loadEnvConfig();

// Non-blocking update check (only in main interactive session, not submode workers)
if (!process.argv.includes("submode")) {
  checkForUpdatesAsync(pkg.version);
}

const program = new Command();

program
  .name("openarch")
  .description("CLI agent that containerizes GitHub repos on the fly, runs them in isolated Docker sandboxes, and exposes their CLIs as dynamic LLM tools.")
  .version(pkg.version);

program
  .command("wakeup")
  .description("Show the banner and pick cli or telegram mode")
  .action(async () => {
    await runWakeup(); 
  });

program
  .command("submode <mode>")
  .description("Internal child process runner for isolated mode execution")
  .action(async (mode: string) => {
    // Safe exit: unref stdin so it doesn't keep the event loop alive,
    // then let all pending timers/handles drain naturally before exiting.
    // This prevents the libuv UV_HANDLE_CLOSING assertion crash that occurs
    // when process.exit(0) tears down handles while timers are still pending.
    function safeExit(): void {
      try {
        if (process.stdin && typeof process.stdin.unref === "function") {
          process.stdin.unref();
        }
        if (process.stdout && typeof process.stdout.unref === "function") {
          process.stdout.unref();
        }
        if (process.stderr && typeof process.stderr.unref === "function") {
          process.stderr.unref();
        }
      } catch {}
      // Allow any pending timers/IO callbacks to drain, then exit cleanly
      setTimeout(() => process.exit(0), 100);
    }

    if (mode === "agent") {
      const { runAgentMode } = await import("./modes/agent/orchestrator");
      await runAgentMode();
      safeExit();
    }
    if (mode === "plan") {
      const { runPlanMode } = await import("./modes/plan/orchestrator");
      await runPlanMode();
      safeExit();
    }
    if (mode === "ask") {
      const { runAskMode } = await import("./modes/ask/orchestrator");
      await runAskMode();
      safeExit();
    }
    if (mode === "pragmatist") {
      const { runPragmatistMode } = await import("./modes/pragmatist/orchestrator");
      await runPragmatistMode();
      safeExit();
    }
    if (mode === "cli") {
      const { runCliMode } = await import("./modes/cli");
      await runCliMode();
      safeExit();
    }
    if (mode === "telegram") {
      const { runTelegramMode } = await import("./modes/telegram");
      await runTelegramMode();
      safeExit();
    }
    if (mode === "model") {
      const { promptAndSaveModel } = await import("./tui/model-select");
      await promptAndSaveModel();
      safeExit();
    }
    if (mode === "key") {
      const { promptAndSaveApiKey } = await import("./tui/model-select");
      await promptAndSaveApiKey();
      safeExit();
    }
  });

program
  .command("config")
  .description("Configure OpenArch settings (e.g. AI model)")
  .action(async () => {
    await promptAndSaveModel();
  });

await program.parseAsync(process.argv);
