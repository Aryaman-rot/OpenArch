import { spawn } from "node:child_process";
import { createServer } from "node:net";

import type { RunResult, ServiceHandle } from "./types";

type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function runCommand(
  command: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts?.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

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
      aborted = true;
      console.log(`[sandbox] Abort signal fired — killing ${command} (pid ${child.pid})`);
      if (process.platform === "win32") {
        try {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            shell: false,
            stdio: "ignore",
          });
        } catch {
          // Best effort.
        }
      } else {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort.
        }
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      rejectIfOpen(new Error(`Interrupted while running ${command}.`));
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
          `Failed to start ${command}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });

    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }

      if (aborted || opts?.signal?.aborted) {
        reject(new Error(`Interrupted while running ${command}.`));
        return;
      }

      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: timedOut ? 124 : exitCode ?? -1,
      });
    });

    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        stderrChunks.push(Buffer.from(`\nProcess timed out after ${opts.timeoutMs}ms.\n`, "utf8"));
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }
  });
}

function formatCommandError(
  command: string,
  args: string[],
  result: SpawnResult,
): Error {
  const details = [
    `Command failed: ${command} ${args.join(" ")}`,
    `Exit code: ${result.exitCode}`,
  ];

  if (result.stdout.trim()) {
    details.push(`stdout:\n${result.stdout.trimEnd()}`);
  }

  if (result.stderr.trim()) {
    details.push(`stderr:\n${result.stderr.trimEnd()}`);
  }

  return new Error(details.join("\n"));
}

function sanitizeNameSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function findFreePort(): Promise<number> {
  const startPort = 30000 + Math.floor(Math.random() * 10000);
  const endPort = 40000;

  for (let port = startPort; port <= endPort; port += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.unref();
      server.once("error", () => {
        server.close();
        resolve(false);
      });
      server.listen({ host: "127.0.0.1", port: port }, () => {
        server.close(() => resolve(true));
      });
    });

    if (free) {
      return port;
    }
  }

  for (let port = 30000; port < startPort; port += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.unref();
      server.once("error", () => {
        server.close();
        resolve(false);
      });
      server.listen({ host: "127.0.0.1", port: port }, () => {
        server.close(() => resolve(true));
      });
    });

    if (free) {
      return port;
    }
  }

  throw new Error("No free port found in range 30000-40000");
}

async function inspectContainerStatus(containerName: string): Promise<string | null> {
  const result = await runCommand("docker", [
    "inspect",
    "-f",
    "{{.State.Status}}",
    containerName,
  ]);

  if (result.exitCode !== 0) {
    return null;
  }

  return result.stdout.trim() || null;
}

async function getContainerLogs(containerName: string): Promise<string> {
  try {
    const result = await runCommand("docker", ["logs", containerName]);
    const output = [result.stdout.trimEnd(), result.stderr.trimEnd()]
      .filter((part) => part.trim().length > 0)
      .join("\n");
    return output;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function buildImage(
  repoPath: string,
  imageName: string,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  const result = await runCommand("docker", ["build", "-t", imageName, repoPath], {
    signal: opts?.signal,
  });

  if (result.exitCode !== 0) {
    throw formatCommandError("docker", ["build", "-t", imageName, repoPath], result);
  }
}

export async function runContainer(
  imageName: string,
  args: string[],
  opts?: { timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string>; allowNetwork?: boolean },
): Promise<RunResult> {
  const dockerArgs = [
    "run",
    "--rm",
    "--memory=512m",
    "--cpus=1",
  ];

  if (!opts?.allowNetwork) {
    dockerArgs.push("--network", "none");
  }

  if (opts?.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      dockerArgs.push("-e", `${key}=${value}`);
    }
  }

  dockerArgs.push(imageName, ...args);

  const result = await runCommand("docker", dockerArgs, {
    timeoutMs: opts?.timeoutMs,
    signal: opts?.signal,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

export async function removeImage(imageName: string): Promise<void> {
  try {
    const result = await runCommand("docker", ["rmi", imageName]);

    if (result.exitCode !== 0) {
      console.warn(
        `Warning: failed to remove image ${imageName}.\n${result.stderr.trim()}`,
      );
    }
  } catch (error) {
    console.warn(
      `Warning: failed to remove image ${imageName}.\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function listOpenArchImages(): Promise<
  Array<{ imageName: string; imageId: string; size: string; createdAt: string }>
> {
  const result = await runCommand("docker", [
    "images",
    "--filter", "reference=openarch-*",
    "--format", "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedAt}}",
  ]);

  if (result.exitCode !== 0) {
    return [];
  }

  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    return [];
  }

  return lines.map((line) => {
    const parts = line.split("\t");
    return {
      imageName: parts[0] ?? "",
      imageId: parts[1] ?? "",
      size: parts[2] ?? "",
      createdAt: parts.slice(3).join("\t"),
    };
  });
}

export async function removeImages(
  imageNames: string[],
): Promise<{ removed: string[]; failed: Array<{ name: string; error: string }> }> {
  const removed: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const name of imageNames) {
    try {
      const result = await runCommand("docker", ["rmi", name]);
      if (result.exitCode === 0) {
        removed.push(name);
      } else {
        failed.push({ name, error: result.stderr.trim() || `exit code ${result.exitCode}` });
      }
    } catch (error) {
      failed.push({
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { removed, failed };
}

export async function startService(
  imageName: string,
  containerPort: number,
  opts?: { signal?: AbortSignal; env?: Record<string, string>; allowNetwork?: boolean },
): Promise<ServiceHandle> {
  const hostPort = await findFreePort();
  const containerName = `openarch-service-${sanitizeNameSegment(imageName)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const stopContainer = async () => {
    await stopService({
      id: "",
      imageName,
      containerName,
      hostPort,
      containerPort,
    });
  };

  try {
    const runResult = await runCommand(
      "docker",
      [
        "run",
        "-d",
        "--name",
        containerName,
        "--memory=512m",
        "--cpus=1",
        ...(!opts?.allowNetwork ? ["--network", "none"] : []),
        "-p",
        `${hostPort}:${containerPort}`,
        ...(opts?.env ? Object.entries(opts.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]) : []),
        imageName,
      ],
      { signal: opts?.signal },
    );

    if (runResult.exitCode !== 0) {
      throw formatCommandError(
        "docker",
        [
          "run",
          "-d",
          "--name",
          containerName,
          "--memory=512m",
          "--cpus=1",
          ...(!opts?.allowNetwork ? ["--network", "none"] : []),
          "-p",
          `${hostPort}:${containerPort}`,
          imageName,
        ],
        runResult,
      );
    }

    const id = runResult.stdout.trim();
    if (!id) {
      throw new Error(`Docker did not return a container id for ${containerName}`);
    }

    const timeoutAt = Date.now() + 5000;
    while (Date.now() < timeoutAt) {
      if (opts?.signal?.aborted) {
        throw new Error(`Interrupted while starting service ${containerName}.`);
      }

      const status = await inspectContainerStatus(containerName);
      if (status === "running") {
        return {
          id,
          imageName,
          containerName,
          hostPort,
          containerPort,
        };
      }

      if (status === "exited" || status === "dead") {
        const logs = await getContainerLogs(containerName);
        throw new Error(
          [
            `Service container crashed immediately: ${containerName}`,
            logs ? `logs:\n${logs}` : "logs: <empty>",
          ].join("\n"),
        );
      }

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, 250);
        if (opts?.signal) {
          const abortHandler = () => {
            clearTimeout(timeout);
            reject(new Error(`Interrupted while starting service ${containerName}.`));
          };
          opts.signal.addEventListener("abort", abortHandler, { once: true });
        }
      });
    }

    const logs = await getContainerLogs(containerName);
    throw new Error(
      [
        `Service container did not stay running: ${containerName}`,
        logs ? `logs:\n${logs}` : "logs: <empty>",
      ].join("\n"),
    );
  } catch (error) {
    await stopContainer().catch(() => undefined);
    throw error;
  }
}

export async function callService(
  handle: ServiceHandle,
  path: string,
  options?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<Response> {
  const url = new URL(path, `http://localhost:${handle.hostPort}`);
  const hasBody = options?.body !== undefined;
  const init: RequestInit = {
    method: options?.method ?? (hasBody ? "POST" : undefined),
    signal: options?.signal,
  };

  if (hasBody) {
    init.body = JSON.stringify(options.body);
    init.headers = {
      "Content-Type": "application/json",
    };
  }

  return fetch(url, init);
}

export async function stopService(
  handle: ServiceHandle,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  return stopServiceInternal(handle, opts);
}

async function stopServiceInternal(
  handle: ServiceHandle,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  try {
    const stopResult = await runCommand("docker", ["stop", handle.containerName], {
      signal: opts?.signal,
    });
    if (stopResult.exitCode !== 0) {
      console.warn(
        `Warning: failed to stop service ${handle.containerName}.\n${stopResult.stderr.trim()}`,
      );
    }
  } catch (error) {
    console.warn(
      `Warning: failed to stop service ${handle.containerName}.\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const rmResult = await runCommand("docker", ["rm", handle.containerName], {
      signal: opts?.signal,
    });
    if (rmResult.exitCode !== 0) {
      console.warn(
        `Warning: failed to remove service ${handle.containerName}.\n${rmResult.stderr.trim()}`,
      );
    }
  } catch (error) {
    console.warn(
      `Warning: failed to remove service ${handle.containerName}.\n${
        error instanceof Error ? error.message : String(error)
      }`,
      );
  }
}
