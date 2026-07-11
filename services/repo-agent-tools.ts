import { tool } from "ai";
import { z } from "zod";

import { callService, stopService } from "./sandbox";
import { runRepo, runRepoAsService, runRepoWithEnvCheck } from "./repo-runner";
import { runWithRepoProgress } from "./repo-progress";
import { wrapRepoAsTool } from "./tool-generator";
import type { ServiceHandle } from "./types";

const activeServices = new Map<string, ServiceHandle>();

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
        runWithRepoProgress("run_repo_once", async ({ signal, onStatus }) => {
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
        runWithRepoProgress("start_repo_service", async ({ signal, onStatus }) => {
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
        runWithRepoProgress("call_repo_service", async ({ signal, onStatus }) => {
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
        runWithRepoProgress("stop_repo_service", async ({ signal }) => {
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
        runWithRepoProgress("wrap_repo_as_tool", async ({ signal, onStatus }) => {
          return wrapRepoAsTool(repoUrl, { signal, onStatus });
        }),
    }),

    run_repo_with_env: tool({
      description:
        "Clone and run a GitHub repo that may require environment variables (API keys, config, etc.). Detects required variables from .env.example or README, and will prompt the user interactively in the terminal to provide them before running.",
      inputSchema: z.object({
        repoUrl: z.string(),
        args: z.array(z.string()),
      }),
      execute: async ({ repoUrl, args }) =>
        runWithRepoProgress("run_repo_with_env", async () => {
          const result = await runRepoWithEnvCheck(repoUrl, args);
          if (isErrorResult(result)) {
            return result;
          }

          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          };
        }),
    }),
  };
}
