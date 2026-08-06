#!/usr/bin/env node

import { Command } from "commander";
import { runWakeup } from "./tui/wakeup";
import { promptAndSaveModel } from "./tui/model-select";
import { loadEnvConfig } from "./services/env-config";

// Load configuration from ~/.openarch/.env and/or local .env
loadEnvConfig();

const program = new Command();

program
  .name("openarch")
  .description("CLI agent that containerizes GitHub repos on the fly, runs them in isolated Docker sandboxes, and exposes their CLIs as dynamic LLM tools.")
  .version("1.0.3");

program
  .command("wakeup")
  .description("Show the banner and pick cli or telegram mode")
  .action(async () => {
        await runWakeup(); 
    });

program
  .command("config")
  .description("Configure OpenArch settings (e.g. AI model)")
  .action(async () => {
    await promptAndSaveModel();
  });

await program.parseAsync(process.argv);

