import { select, isCancel, note } from "@clack/prompts";
import chalk from "chalk";
import figlet from "figlet";
// @ts-ignore - figlet importable fonts don't have built-in d.ts types
import ansiShadowFont from "figlet/importable-fonts/ANSI Shadow.js";
// @ts-ignore
import standardFont from "figlet/importable-fonts/Standard.js";

import { runCliMode } from "../modes/cli";
import { runTelegramMode } from "../modes/telegram";

import { promptAndSaveModel, promptAndSaveApiKey } from "./model-select";
import { checkDockerStatus } from "../services/sandbox";
import { restoreTerminalStdin, settleTerminalState } from "../services/terminal-state";

// Register fonts in memory so figlet doesn't require font files on disk at runtime
figlet.parseFont("ANSI Shadow", ansiShadowFont);
figlet.parseFont("Standard", standardFont);

const BANNER_FONT = "ANSI Shadow";
const SHADOW = chalk.hex("#b55fadd7");
const FACE = chalk.hex("#d559bafc").bold;

function printBannerWithShadow(ascii: string) {

  const bannerLines = ascii.replace(/\s+$/, '').split('\n');
  const maxLen = Math.max(...bannerLines.map((l) => l.length), 0);
  const rowWidth = maxLen + 2;

  for (const line of bannerLines) {
    console.log(SHADOW(('  ' + line).padEnd(rowWidth)));
  }
  process.stdout.write(`\x1b[${bannerLines.length}A`);
  for (const line of bannerLines) {
    console.log(FACE(line.padEnd(rowWidth)));
  }
  console.log();
}



export async function runWakeup() {
  let ascii: string;
  try {
    ascii = figlet.textSync("OpenArch", { font: BANNER_FONT });
  } catch (error) {
    ascii = figlet.textSync("OpenArch", { font: "Standard" });
  }

  printBannerWithShadow(ascii);

  const needsApiKey = !process.env.OPENROUTER_API_KEY;
  const needsModel = !process.env.MODEL && !process.env.OPENROUTER_DEFAULT_MODEL;

  if (needsApiKey || needsModel) {
    console.log(chalk.cyan("First-run setup: Please configure your OpenArch settings.\n"));

    if (needsApiKey) {
      const key = await promptAndSaveApiKey();
      if (!key) {
        await settleTerminalState(20);
        console.log(chalk.dim("\nSetup canceled. Returning...\n"));
        return;
      }
    }

    if (needsModel) {
      await promptAndSaveModel();
    }
  }

  const dockerStatus = await checkDockerStatus();
  if (!dockerStatus.available) {
    console.log(chalk.yellow("  Note: Docker is not currently running. Sandboxed repo features will require Docker Desktop.\n"));
  }

  while (true) {
    await settleTerminalState(80);
    const mode = await select({
      message: "Choose your mode",
      options: [
        { value: "cli", label: "CLI" },
        { value: "telegram", label: "Telegram" },
        { value: "model", label: "Change AI Model" },
        { value: "key", label: "Change OpenRouter API Key" },
        { value: "exit", label: "Exit" },
      ],
    });

    if (isCancel(mode) || mode === "exit") {
      await settleTerminalState(80);
      console.log(chalk.dim("\n Exiting... \n"));
      console.log(chalk.dim("Arrivederci!"));
      return;
    }

    if (mode === "cli") {
      console.log(chalk.dim("You chose CLI mode!"));
      console.log(chalk.dim("Starting CLI..."));
      await runCliMode();
      await settleTerminalState(80);
    } else if (mode === "telegram") {
      if (!process.env.TELEGRAM_BOT_TOKEN) {
        note(
          `Telegram mode requires additional setup:\n\n` +
            `1. Create a bot with @BotFather on Telegram to get a TELEGRAM_BOT_TOKEN.\n` +
            `2. Add TELEGRAM_BOT_TOKEN (and optionally TELEGRAM_OWNER_ID) to your ~/.openarch/.env (or local .env).\n\n` +
            `See the README for step-by-step setup instructions.`,
          "Telegram Setup Required"
        );
      } else {
        console.log(chalk.dim("You chose Telegram mode!"));
        console.log(chalk.dim("Starting Telegram Bot..."));
        await runTelegramMode();
      }
      await settleTerminalState(80);
    } else if (mode === "model") {
      await promptAndSaveModel();
      await settleTerminalState(80);
    } else if (mode === "key") {
      await promptAndSaveApiKey();
      await settleTerminalState(80);
    }
  }
}





