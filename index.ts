#!/usr/bin/env node

import { Command } from "commander";
import { runWakeup } from "./tui/wakeup";
import { promptAndSaveModel } from "./tui/model-select";
import { loadEnvConfig } from "./services/env-config";
import { checkForUpdatesAsync } from "./services/update-check";
import pkg from "./package.json" assert { type: "json" };

// Load configuration from ~/.openarch/.env and/or local .env
loadEnvConfig();

// Non-blocking update check
checkForUpdatesAsync(pkg.version);

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
    if (mode === "agent") {
      const { runAgentMode } = await import("./modes/agent/orchestrator");
      await runAgentMode();
      process.exit(0);
    }
    if (mode === "plan") {
      const { runPlanMode } = await import("./modes/plan/orchestrator");
      await runPlanMode();
      process.exit(0);
    }
    if (mode === "ask") {
      const { runAskMode } = await import("./modes/ask/orchestrator");
      await runAskMode();
      process.exit(0);
    }
    if (mode === "pragmatist") {
      const { runPragmatistMode } = await import("./modes/pragmatist/orchestrator");
      await runPragmatistMode();
      process.exit(0);
    }
    if (mode === "cli") {
      const { runCliMode } = await import("./modes/cli");
      await runCliMode();
      process.exit(0);
    }
    if (mode === "telegram") {
      const { runTelegramMode } = await import("./modes/telegram");
      await runTelegramMode();
      process.exit(0);
    }
    if (mode === "model") {
      const { promptAndSaveModel } = await import("./tui/model-select");
      await promptAndSaveModel();
      process.exit(0);
    }
    if (mode === "key") {
      const { promptAndSaveApiKey } = await import("./tui/model-select");
      await promptAndSaveApiKey();
      process.exit(0);
    }
  });

program
  .command("config")
  .description("Configure OpenArch settings (e.g. AI model)")
  .action(async () => {
    await promptAndSaveModel();
  });

await program.parseAsync(process.argv);
