#!/usr/bin/env bun

import { Command } from "commander";
import { runWakeup } from "./tui/wakeup";
import { promptAndSaveModel } from "./tui/model-select";

const program = new Command();

program
  .name("openarch-build")
  .description("A fancy CLI tool")
  .version("0.0.1");

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

