import {select , isCancel} from "@clack/prompts";
import chalk from "chalk";
import { error } from "console";
import figlet from "figlet";
import { runCliMode } from "../modes/cli";
import { runTelegramMode } from "../modes/telegram";

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

  while (true) {
    const mode = await select({
      message: "Choose your mode",
      options: [
        { value: "cli", label: "CLI" },
        { value: "telegram", label: "Telegram" },
        { value: "exit", label: "Exit" },
      ],
    });

    if (isCancel(mode) || mode === "exit") {
      console.log(chalk.dim("\n Exiting... \n"));
      console.log(chalk.dim("Arrivederci!"));
      return;
    }

    if (mode === "cli") {
      console.log(chalk.dim("You chose CLI mode!"));
      console.log(chalk.dim("Starting CLI..."));
      await runCliMode();
    } else if (mode === "telegram") {
      console.log(chalk.dim("You chose Telegram mode!"));
      console.log(chalk.dim("Starting Telegram Bot..."));
      await runTelegramMode();
    }
  }
}





