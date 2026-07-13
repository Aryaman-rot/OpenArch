import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { rm } from "node:fs/promises";
import { z } from "zod";

import { buildImage, removeImage, runContainer } from "./sandbox";
import { cloneRepo, detectRuntime, generateDockerfile } from "./repo-runner";
import { getRegistryEntry, saveRegistryEntry, touchLastUsed } from "./registry";
import type { RuntimeInfo, ToolSchema } from "./types";

function getToolGeneratorModel() {
  const provider = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
  });

  return provider("openrouter/free");
}

function imageNameFromRepoUrl(url: string): string {
  const slug = url
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  const hash = createHash("sha256").update(url).digest("hex").slice(0, 8);
  return `openarch-tools-${slug.slice(0, 32)}-${hash}`;
}

function toolNameFromRepoUrl(url: string): string {
  const parts = url.replace(/\.git$/i, "").split("/");
  const last = parts[parts.length - 1] ?? "tool";
  return last.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "tool";
}

function validateToolSchema(candidate: unknown): ToolSchema {
  const argumentSchema = z.object({
    name: z.string(),
    description: z.string(),
    required: z.boolean(),
  });

  const schema = z.object({
    name: z.string(),
    description: z.string(),
    arguments: z.array(argumentSchema),
  });

  return schema.parse(candidate) as ToolSchema;
}

export async function getHelpOutput(
  imageName: string,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const result = await runContainer(imageName, ["--help"], {
    signal: opts?.signal,
  });
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  if (stdout) {
    return stdout;
  }

  if (stderr) {
    return stderr;
  }

  throw new Error(
    `No help output was produced by image ${imageName} (exit code ${result.exitCode}).`,
  );
}

export async function generateToolSchema(
  helpText: string,
  toolName: string,
  opts?: { signal?: AbortSignal; onStatus?: (message: string) => void },
): Promise<ToolSchema> {
  const status = opts?.onStatus ?? (() => undefined);
  status("Generating tool schema...");

  const system = [
    "You read CLI help text and convert it into a single JSON object.",
    "Return ONLY valid JSON.",
    "Do not wrap the result in markdown or code fences.",
    "Do not add prose before or after the JSON.",
    "First inspect the Usage line or similar invocation line in the help text, usually near the top.",
    "If the Usage line shows positional or main arguments in angle brackets or square brackets, include each one in the arguments array even when it has no flag prefix.",
    "A positional argument is valid even without a flag like -x or --xyz; do not skip it just because it is unflagged.",
    "Mark a positional argument as required when it appears without brackets or in angle brackets, and optional when it appears in square brackets.",
    "For tools like cowsay, if the usage implies a free-form message/text operand, include that operand as its own argument entry, even when all flag options are already listed separately.",
    "If the command has one obvious main operand in addition to flags, do not omit it; model it as something like message, input_text, file_path, or similar based on the help text.",
    "The JSON must match this shape:",
    '{ "name": string, "description": string, "arguments": [{ "name": string, "description": string, "required": boolean }] }',
    `Tool name hint: ${toolName}`,
  ].join("\n");

  const result = await generateText({
    model: getToolGeneratorModel(),
    system,
    prompt: helpText,
    abortSignal: opts?.signal,
  });

  const raw = result.text.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      [
        "Failed to parse model output as JSON while generating tool schema.",
        `Tool name: ${toolName}`,
        `Raw model output:\n${raw}`,
        `Parse error: ${error instanceof Error ? error.message : String(error)}`,
      ].join("\n"),
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("name" in parsed) ||
    !("arguments" in parsed) ||
    !Array.isArray((parsed as { arguments?: unknown }).arguments)
  ) {
    throw new Error(
      [
        "Model output was missing required ToolSchema fields.",
        `Tool name: ${toolName}`,
        `Raw model output:\n${raw}`,
      ].join("\n"),
    );
  }

  return validateToolSchema(parsed);
}

export async function wrapRepoAsTool(
  repoUrl: string,
  opts?: { signal?: AbortSignal; onStatus?: (message: string) => void },
): Promise<ToolSchema> {
  const status = opts?.onStatus ?? (() => undefined);

  const entry = await getRegistryEntry(repoUrl);
  if (entry?.toolSchema) {
    const imageExists = await checkImageExistsLocal(entry.imageName);
    if (imageExists) {
      const dateStr = entry.lastUsedAt
        ? new Date(entry.lastUsedAt).toLocaleString()
        : "unknown date";
      console.log(`[registry] Using cached image for ${repoUrl} (last built ${dateStr})`);
      touchLastUsed(repoUrl).catch(() => {});
      return entry.toolSchema;
    }
    console.warn(
      `[registry] DB record found for ${repoUrl} but image ${entry.imageName} is missing locally. Rebuilding.`,
    );
  }

  const repoPath = await cloneRepo(repoUrl, { signal: opts?.signal });
  const imageName = imageNameFromRepoUrl(repoUrl);
  const toolName = toolNameFromRepoUrl(repoUrl);
  let runtimeInfo: RuntimeInfo | undefined;

  try {
    runtimeInfo = detectRuntime(repoPath);
    if (runtimeInfo.kind === "unknown") {
      throw new Error(`Unable to detect a supported runtime for ${repoUrl}`);
    }

    status("Generating Dockerfile...");
    generateDockerfile(repoPath, runtimeInfo);
    status("Building image...");
    await buildImage(repoPath, imageName, { signal: opts?.signal });

    status("Reading help output...");
    const helpText = await getHelpOutput(imageName, { signal: opts?.signal });
    const schema = await generateToolSchema(helpText, toolName, {
      signal: opts?.signal,
      onStatus: opts?.onStatus,
    });

    saveRegistryEntry({
      repoUrl,
      runtimeKind: runtimeInfo.kind,
      imageName,
      toolSchema: schema,
    }).catch(() => {});

    return schema;
  } finally {
    await rm(repoPath, { recursive: true, force: true });
    if (!process.env.DATABASE_URL) {
      await removeImage(imageName);
    }
  }
}

function checkImageExistsLocal(imageName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["image", "inspect", imageName], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}
