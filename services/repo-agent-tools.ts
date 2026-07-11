import { tool } from "ai";
import chalk from "chalk";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline";
import { z } from "zod";

import { callService, stopService } from "./sandbox";
import { runRepo, runRepoAsService } from "./repo-runner";
import { wrapRepoAsTool } from "./tool-generator";
import type { ServiceHandle } from "./types";

const activeServices = new Map<string, ServiceHandle>();

const spinnerFrames = ["◐", "◓", "◑", "◒"];

function errorResult(message: string) {
  return { error: message };
}

function serviceNotFound(serviceId: string) {
  return `Service '${serviceId}' was not found. Start it first with start_repo_service.`;
}

function isErrorResult(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

function isInteractiveTerminal(): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

function createProgressRunner<T>(
  toolLabel: string,
  work: (ctx: {
    signal: AbortSignal;
    onStatus: (message: string) => void;
  }) => Promise<T>,
): Promise<T | { error: string }> {
  const controller = new AbortController();
  const interactive = isInteractiveTerminal();
  const initialStatus = `Starting ${toolLabel}...`;
  let currentStatus = initialStatus;
  let spinnerIndex = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let rawModeWasEnabled = false;
  let settled = false;
  let interrupted = false;

  const render = () => {
    if (!interactive) {
      return;
    }

    readline.clearLine(output, 0);
    readline.cursorTo(output, 0);
    output.write(
      `${chalk.cyan(spinnerFrames[spinnerIndex % spinnerFrames.length])} ${currentStatus} ${chalk.yellow("[Esc to interrupt]")}`,
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

  const onStatus = (message: string) => {
    currentStatus = message;
    if (!interactive) {
      console.log(chalk.cyan(message));
      return;
    }

    render();
  };

  const onKeypress = (_chunk: string, key: readline.Key) => {
    if (key.name === "escape" || key.sequence === "\u001b") {
      if (!controller.signal.aborted) {
        interrupted = true;
        controller.abort(new Error("Interrupted"));
        currentStatus = "Interrupted";
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
    timer = setInterval(() => {
      spinnerIndex += 1;
      render();
    }, 90);
  } else {
    console.log(chalk.cyan(initialStatus));
  }

  const cleanup = () => {
    if (timer) {
      clearInterval(timer);
    }
    input.off("keypress", onKeypress);
    if (interactive && !rawModeWasEnabled && "setRawMode" in input) {
      input.setRawMode(false);
    }
    settled = true;
  };

  return work({
    signal: controller.signal,
    onStatus,
  })
    .then((result) => {
      cleanup();
      if (interrupted || controller.signal.aborted) {
        if (!interactive) {
          console.log(chalk.yellow("Interrupted"));
        }
        return errorResult("Interrupted");
      }

      if (isErrorResult(result)) {
        if (interactive) {
          finishLine(chalk.red(`✗ ${result.error}`));
        } else {
          console.log(chalk.red(`✗ ${result.error}`));
        }
        return result;
      }

      if (interactive) {
        finishLine(chalk.green(`✓ ${toolLabel} complete`));
      } else {
        console.log(chalk.green(`✓ ${toolLabel} complete`));
      }

      return result;
    })
    .catch((error) => {
      cleanup();
      const message =
        error instanceof Error ? error.message : String(error || "Unknown error");

      if (interrupted || controller.signal.aborted) {
        if (!interactive) {
          console.log(chalk.yellow("Interrupted"));
        }
        return errorResult("Interrupted");
      }

      if (interactive) {
        finishLine(chalk.red(`✗ ${message}`));
      } else {
        console.log(chalk.red(`✗ ${message}`));
      }

      return errorResult(message);
    });
}

export function createRepoAgentTools() {
  return {
    run_repo_once: tool({
      description:
        "Clone a GitHub repo, run it once inside an isolated Docker sandbox (no network access, resource-limited), and return its output. Best for CLI-style tools that run a single command and exit.",
      inputSchema: z.object({
        repoUrl: z.string(),
        args: z.array(z.string()),
      }),
      execute: async ({ repoUrl, args }) =>
        createProgressRunner("run_repo_once", async ({ signal, onStatus }) => {
          const result = await runRepo(repoUrl, args, { signal, onStatus });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          };
        }),
    }),

    start_repo_service: tool({
      description:
        "Clone a GitHub repo, build it, and start it as a long-running sandboxed service (e.g. a small REST API), returning a handle and the local port it's reachable on. Use for repos that run a persistent server rather than a one-shot command.",
      inputSchema: z.object({
        repoUrl: z.string(),
        containerPort: z.number().int(),
      }),
      execute: async ({ repoUrl, containerPort }) =>
        createProgressRunner("start_repo_service", async ({ signal, onStatus }) => {
          const handle = await runRepoAsService(repoUrl, containerPort, {
            signal,
            onStatus,
          });
          activeServices.set(handle.containerName, handle);
          return {
            id: handle.containerName,
            hostPort: handle.hostPort,
            containerName: handle.containerName,
          };
        }),
    }),

    call_repo_service: tool({
      description:
        "Send an HTTP request to a repo service previously started with start_repo_service, using the id/handle returned from it.",
      inputSchema: z.object({
        serviceId: z.string(),
        path: z.string(),
        method: z.string().optional(),
        body: z.unknown().optional(),
      }),
      execute: async ({ serviceId, path, method, body }) =>
        createProgressRunner("call_repo_service", async ({ signal, onStatus }) => {
          const handle = activeServices.get(serviceId);
          if (!handle) {
            return errorResult(serviceNotFound(serviceId));
          }

          onStatus("Calling repo service...");
          const response = await callService(handle, path, {
            method,
            body,
            signal,
          });
          const text = await response.text();
          return {
            status: response.status,
            body: text,
          };
        }),
    }),

    stop_repo_service: tool({
      description:
        "Stop and clean up a repo service previously started with start_repo_service.",
      inputSchema: z.object({
        serviceId: z.string(),
      }),
      execute: async ({ serviceId }) =>
        createProgressRunner("stop_repo_service", async ({ signal }) => {
          const handle = activeServices.get(serviceId);
          if (!handle) {
            return errorResult(serviceNotFound(serviceId));
          }

          await stopService(handle, { signal });
          activeServices.delete(serviceId);
          return {
            ok: true,
            serviceId,
          };
        }),
    }),

    wrap_repo_as_tool: tool({
      description:
        "Clone a GitHub repo and automatically generate a tool schema for it by reading its --help output and using an LLM to structure it. Use this to understand what a CLI repo can do before calling run_repo_once on it with the right arguments.",
      inputSchema: z.object({
        repoUrl: z.string(),
      }),
      execute: async ({ repoUrl }) =>
        createProgressRunner("wrap_repo_as_tool", async ({ signal, onStatus }) => {
          return wrapRepoAsTool(repoUrl, { signal, onStatus });
        }),
    }),
  };
}
