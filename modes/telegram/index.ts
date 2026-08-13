import { Telegraf } from "telegraf";
import chalk from "chalk";
import { WELCOME } from "./constants";
import { registerHandlers } from "./handlers";

export async function runTelegramMode() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ownerId = process.env.TELEGRAM_OWNER_ID;

  if (!token) {
    console.log(
      chalk.yellow(
        "\n⚠ Telegram mode requires a TELEGRAM_BOT_TOKEN environment variable.\n" +
          "See the README for setup instructions using @BotFather.\n"
      )
    );
    return;
  }

  const bot = new Telegraf(token);
  registerHandlers(bot);

  if (ownerId) {
    try {
      await bot.telegram.sendMessage(ownerId, WELCOME, { parse_mode: "Markdown" });
      console.log(chalk.green("Sent welcome message to Telegram owner.\n"));
    } catch {
      console.log(chalk.yellow("Note: Could not send initial welcome message to TELEGRAM_OWNER_ID.\n"));
    }
  }

  bot.launch();
  console.log(chalk.green("Telegram bot is running. Press Ctrl+C to stop.\n"));

  await new Promise<void>((resolve) => {
    const stop = () => {
      bot.stop("SIGINT");
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}