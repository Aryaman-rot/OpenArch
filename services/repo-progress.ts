import chalk from "chalk";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline";

import { setRepoToolContext } from "./tool-context";

export type RepoProgressWork<T> = (ctx: {
  signal: AbortSignal;
  onStatus: (message: string) => void;
}) => Promise<T>;

const barWidth = 14;
const pulseWidth = 6;
const renderIntervalMs = 120;
const pausedStatusPattern =
  /collecting environment variables|prompting for environment values|enter environment/i;

function isInteractiveTerminal(): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

function buildLoadingBar(frameIndex: number): string {
  const start = frameIndex % barWidth;
  const cells: string[] = [];
  const shades = ["█", "▓", "▒", "░", "░", "░"];

  for (let index = 0; index < barWidth; index += 1) {
    const distance = (index - start + barWidth) % barWidth;
    if (distance < pulseWidth) {
      cells.push(shades[distance] ?? "░");
    } else {
      cells.push("░");
    }
  }

  return `[${cells.join("")}]`;
}

function isErrorResult(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

export async function runWithRepoProgress<T>(
  toolLabel: string,
  work: RepoProgressWork<T>,
): Promise<T | { error: string }> {
  const controller = new AbortController();
  const interactive = isInteractiveTerminal();
  const initialStatus = `Starting ${toolLabel}...`;
  let currentStatus = initialStatus;
  let frameIndex = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let rawModeWasEnabled = false;
  let interrupted = false;
  let animationPaused = false;

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const render = () => {
    if (!interactive) {
      return;
    }

    readline.clearLine(output, 0);
    readline.cursorTo(output, 0);
    output.write(
      `${chalk.cyan(currentStatus)} ${chalk.cyan(buildLoadingBar(frameIndex))} ${chalk.yellow("esc interrupt")}`,
    );
  };

  const finishLine = (message: string) => {
    if (!interactive) {
      console.log(message);
      return;
    }

    readline.clearLine(output, 0);
    readline.cursorTo(output, 0);
    output.write(`${message}\n`);
  };

  const startTimer = () => {
    if (!interactive || animationPaused || timer) {
      return;
    }

    timer = setInterval(() => {
      frameIndex += 1;
      render();
    }, renderIntervalMs);
  };

  const onStatus = (message: string) => {
    currentStatus = message;

    if (!interactive) {
      console.log(chalk.cyan(message));
      return;
    }

    if (pausedStatusPattern.test(message)) {
      animationPaused = true;
      stopTimer();
      finishLine(
        `${chalk.cyan(message)} ${chalk.cyan(buildLoadingBar(frameIndex))} ${chalk.yellow("esc interrupt")}`,
      );
      return;
    }

    if (animationPaused) {
      animationPaused = false;
      startTimer();
    }

    render();
  };

  const onKeypress = (_chunk: string, key: readline.Key) => {
    if (key.name === "escape" || key.sequence === "\u001b") {
      if (!controller.signal.aborted) {
        interrupted = true;
        controller.abort();
        finishLine(chalk.yellow("Interrupted"));
      }
    }
  };

  if (interactive) {
    readline.emitKeypressEvents(input);
    rawModeWasEnabled = Boolean((input as NodeJS.ReadStream & { isRaw?: boolean }).isRaw);
    if (!rawModeWasEnabled && "setRawMode" in input) {
      input.setRawMode(true);
    }
    input.resume();
    input.on("keypress", onKeypress);
    render();
    startTimer();
  } else {
    console.log(chalk.cyan(initialStatus));
  }

  setRepoToolContext({ signal: controller.signal, onStatus });

  const cleanup = () => {
    stopTimer();
    input.off("keypress", onKeypress);
    if (interactive && "setRawMode" in input) {
      input.setRawMode(rawModeWasEnabled);
    }
    setRepoToolContext(undefined);
  };

  try {
    const result = await work({
      signal: controller.signal,
      onStatus,
    });

    if (interrupted || controller.signal.aborted) {
      cleanup();
      return { error: "Interrupted" };
    }

    if (isErrorResult(result)) {
      cleanup();
      finishLine(chalk.red(`✗ ${result.error}`));
      return result;
    }

    cleanup();
    finishLine(chalk.green(`✓ ${toolLabel} complete`));
    return result;
  } catch (error) {
    cleanup();

    if (interrupted || controller.signal.aborted) {
      return { error: "Interrupted" };
    }

    const message =
      error instanceof Error ? error.message : String(error || "Unknown error");
    finishLine(chalk.red(`✗ ${message}`));
    return { error: message };
  }
}
