import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildImage,
  removeImage,
  runContainer,
  startService,
} from "./sandbox";
import { detectEnvRequirements, promptForEnvValues } from "./pragmatist";
import { getRepoToolContext } from "./tool-context";
import type { RuntimeInfo, RunResult, ServiceHandle } from "./types";

const CLONE_TIMEOUT_MS = 30_000;

function killGitProcessTree(childPid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(childPid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
      });
    } catch {
      // Best effort.
    }
    return;
  }

  try {
    process.kill(childPid, "SIGKILL");
  } catch {
    // Best effort.
  }
}

function runGitClone(
  url: string,
  targetDir: string,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("git", ["clone", url, targetDir], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let settled = false;
    const rejectIfOpen = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    };

    const interrupt = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      killGitProcessTree(child.pid ?? 0);
      rejectIfOpen(new Error(`Interrupted while cloning repo: ${url}`));
    };

    if (opts?.signal) {
      if (opts.signal.aborted) {
        interrupt();
        return;
      }

      opts.signal.addEventListener("abort", interrupt, { once: true });
    }

    child.on("error", (error) => {
      rejectIfOpen(
        new Error(
          `Failed to clone repo: ${url}. ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (timeout) {
        clearTimeout(timeout);
      }

      if (timedOut) {
        settled = true;
        reject(
          new Error(
            "Clone timed out after 30s - check the URL is correct and reachable.",
          ),
        );
        return;
      }

      if (code !== 0) {
        settled = true;
        reject(
          new Error(
            [
              `Failed to clone repo: ${url}`,
              `Exit code: ${code ?? -1}`,
              stdout.trim() ? `stdout:\n${stdout.trimEnd()}` : "",
              stderr.trim() ? `stderr:\n${stderr.trimEnd()}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          ),
        );
        return;
      }

      settled = true;
      resolve();
    });

    timeout = setTimeout(() => {
      timedOut = true;
      const elapsedMs = Date.now() - startedAt;
      console.warn(
        `[repo-runner] git clone timeout fired after ${elapsedMs}ms for ${url}`,
      );
      killGitProcessTree(child.pid ?? 0);
      rejectIfOpen(
        new Error(
          "Clone timed out after 30s - check the URL is correct and reachable.",
        ),
      );
    }, CLONE_TIMEOUT_MS);
  });
}

function parseCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}

function detectNodeStartCommand(
  pkg: Record<string, unknown>,
  packageManager: NodePackageManager,
): string {
  const scripts = pkg.scripts as Record<string, unknown> | undefined;
  const startScript = scripts?.start;
  if (typeof startScript === "string" && startScript.trim()) {
    return getStartCommand(packageManager);
  }

  const bin = pkg.bin;
  if (typeof bin === "string" && bin.trim()) {
    return `node ${bin.trim()}`;
  }

  if (bin && typeof bin === "object") {
    const firstBin = Object.values(bin).find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );

    if (firstBin) {
      return `node ${firstBin.trim()}`;
    }
  }

  return "node index.js";
}

type NodePackageManager = "npm" | "yarn";

function detectNodePackageManager(repoPath: string): NodePackageManager {
  if (existsSync(path.join(repoPath, "yarn.lock"))) {
    return "yarn";
  }

  return "npm";
}

function getInstallCommand(packageManager: NodePackageManager): string {
  if (packageManager === "yarn") {
    return "RUN yarn install";
  }

  return "RUN npm install";
}

function getBuildCommand(packageManager: NodePackageManager): string {
  if (packageManager === "yarn") {
    return "RUN yarn build";
  }

  return "RUN npm run build";
}

function getStartCommand(packageManager: NodePackageManager): string {
  if (packageManager === "yarn") {
    return "yarn start";
  }

  return "npm start";
}

export async function cloneRepo(
  url: string,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const baseDir = path.join(os.tmpdir(), "openarch-runs");
  const runId = randomUUID();
  const targetDir = path.join(baseDir, runId);

  await mkdir(baseDir, { recursive: true });
  await runGitClone(url, targetDir, opts);

  return targetDir;
}

export function detectRuntime(repoPath: string): RuntimeInfo {
  if (existsSync(path.join(repoPath, "Dockerfile"))) {
    return {
      kind: "dockerfile",
      startCommand: "",
      hasDockerfile: true,
    };
  }

  const packageJsonPath = path.join(repoPath, "package.json");
  if (existsSync(packageJsonPath)) {
    let pkg: Record<string, unknown>;
    const packageManager = detectNodePackageManager(repoPath);

    try {
      pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Failed to parse package.json at ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      kind: "node",
      startCommand: detectNodeStartCommand(pkg, packageManager),
      hasDockerfile: false,
    };
  }

  if (
    existsSync(path.join(repoPath, "requirements.txt")) ||
    existsSync(path.join(repoPath, "pyproject.toml"))
  ) {
    return {
      kind: "python",
      startCommand: "python main.py",
      hasDockerfile: false,
    };
  }

  return {
    kind: "unknown",
    startCommand: "",
    hasDockerfile: false,
  };
}

function toDockerEntrypoint(startCommand: string): string {
  const parts = parseCommand(startCommand);
  if (parts.length === 0) {
    return `["node", "index.js"]`;
  }

  return `[${parts.map((part) => JSON.stringify(part)).join(", ")}]`;
}

export function generateDockerfile(repoPath: string, runtimeInfo: RuntimeInfo): void {
  if (runtimeInfo.hasDockerfile) {
    return;
  }

  const dockerfilePath = path.join(repoPath, "Dockerfile");
  let dockerfile = "";

  if (runtimeInfo.kind === "node") {
    const packageManager = detectNodePackageManager(repoPath);
    const packageJsonPath = path.join(repoPath, "package.json");
    let pkg: Record<string, unknown> = {};

    try {
      if (existsSync(packageJsonPath)) {
        pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
      }
    } catch (error) {
      throw new Error(
        `Failed to parse package.json at ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const scripts = pkg.scripts as Record<string, unknown> | undefined;
    const hasBuildScript =
      typeof scripts?.build === "string" && scripts.build.trim().length > 0;
    const hasStartScript =
      typeof scripts?.start === "string" && scripts.start.trim().length > 0;

    dockerfile = [
      "FROM node:20-slim",
      "WORKDIR /app",
      "COPY . .",
      getInstallCommand(packageManager),
      ...(hasBuildScript ? [getBuildCommand(packageManager)] : []),
      `ENTRYPOINT ${toDockerEntrypoint(
        hasStartScript ? getStartCommand(packageManager) : runtimeInfo.startCommand,
      )}`,
      "",
    ].join("\n");
  } else if (runtimeInfo.kind === "python") {
    const hasRequirements = existsSync(path.join(repoPath, "requirements.txt"));
    dockerfile = [
      "FROM python:3.11-slim",
      "WORKDIR /app",
      "COPY . .",
      ...(hasRequirements ? ["RUN pip install -r requirements.txt"] : []),
      `ENTRYPOINT ${toDockerEntrypoint(runtimeInfo.startCommand)}`,
      "",
    ].join("\n");
  } else {
    return;
  }

  writeFileSync(dockerfilePath, dockerfile, "utf8");
}

function imageNameFromUrl(url: string): string {
  const slug = url
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  const suffix = createHash("sha256").update(url).digest("hex").slice(0, 8);
  return `openarch-${slug.slice(0, 32)}-${suffix}`;
}

async function prepareRepoImage(
  url: string,
  opts?: { signal?: AbortSignal; onStatus?: (message: string) => void },
  beforeBuild?: (repoPath: string) => Promise<Record<string, string> | undefined>,
): Promise<{
  repoPath: string;
  imageName: string;
  runtimeInfo: RuntimeInfo;
  env?: Record<string, string>;
}> {
  const status = opts?.onStatus ?? console.log;

  status("Cloning repo...");
  const repoPath = await cloneRepo(url, { signal: opts?.signal });

  status("Detecting runtime...");
  const runtimeInfo = detectRuntime(repoPath);
  status(`Detected runtime: ${runtimeInfo.kind}`);

  if (runtimeInfo.kind === "unknown") {
    throw new Error(`Unable to detect a supported runtime for ${url}`);
  }

  const env = beforeBuild ? await beforeBuild(repoPath) : undefined;

  status("Generating Dockerfile...");
  generateDockerfile(repoPath, runtimeInfo);

  const imageName = imageNameFromUrl(url);
  status("Building image...");
  await buildImage(repoPath, imageName, { signal: opts?.signal });

  return { repoPath, imageName, runtimeInfo, env };
}

export async function runRepo(
  url: string,
  args: string[],
  opts?: { signal?: AbortSignal; onStatus?: (message: string) => void },
): Promise<RunResult> {
  const imageName = imageNameFromUrl(url);
  let repoPath = "";

  try {
    const prepared = await prepareRepoImage(url, opts);
    repoPath = prepared.repoPath;

    (opts?.onStatus ?? console.log)("Running in sandbox...");
    const result = await runContainer(imageName, args, { signal: opts?.signal });
    return result;
  } finally {
    if (repoPath) {
      await removeImage(imageName);
    }
  }
}

export async function runRepoWithEnvCheck(
  repoUrl: string,
  args: string[],
): Promise<RunResult> {
  const context = getRepoToolContext();
  const status = context?.onStatus ?? console.log;

  const prepared = await prepareRepoImage(
    repoUrl,
    context,
    async (repoPath) => {
      const requirements = detectEnvRequirements(repoPath);
      if (requirements.length === 0) {
        return undefined;
      }

      status("Collecting environment variables...");
      return promptForEnvValues(requirements);
    },
  );

  try {
    status("Running in sandbox...");
    const result = await runContainer(prepared.imageName, args, {
      signal: context?.signal,
      env: prepared.env,
    });
    return result;
  } finally {
    await removeImage(prepared.imageName);
  }
}

export async function runRepoAsService(
  url: string,
  containerPort: number,
  opts?: { signal?: AbortSignal; onStatus?: (message: string) => void },
): Promise<ServiceHandle> {
  const prepared = await prepareRepoImage(url, opts);
  try {
    (opts?.onStatus ?? console.log)("Starting service...");
    return await startService(prepared.imageName, containerPort, {
      signal: opts?.signal,
    });
  } catch (error) {
    await removeImage(prepared.imageName);
    throw error;
  }
}
