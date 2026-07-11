import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";

import type { EnvRequirement } from "./types";
import { getRepoToolContext } from "./tool-context";

function dedupe(keys: string[]): EnvRequirement[] {
  const seen = new Set<string>();
  const result: EnvRequirement[] = [];

  for (const key of keys) {
    const normalized = key.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push({ key: normalized, description: "", required: true });
  }

  return result;
}

function parseEnvLikeContent(content: string): string[] {
  const keys: string[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const stripped = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;

    const match = stripped.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match?.[1]) {
      keys.push(match[1]);
      continue;
    }

    const keyOnly = stripped.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    if (keyOnly?.[1]) {
      keys.push(keyOnly[1]);
    }
  }

  return keys;
}

function findFile(repoPath: string, pattern: RegExp): string | undefined {
  const entries = readdirSync(repoPath, { withFileTypes: true });
  return entries.find((entry) => entry.isFile() && pattern.test(entry.name))?.name;
}

function extractRelevantReadmeSection(readmeText: string): string {
  const lines = readmeText.split(/\r?\n/);
  const section: string[] = [];
  let collecting = false;
  let currentHeadingLevel = 0;

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const headingText = heading[2]?.toLowerCase() ?? "";
      const isRelevant =
        headingText.includes("environment") ||
        headingText.includes("config") ||
        headingText.includes("env vars");

      if (collecting && heading[1]!.length <= currentHeadingLevel) {
        break;
      }

      collecting = isRelevant;
      currentHeadingLevel = heading[1]!.length;
      continue;
    }

    if (collecting) {
      section.push(line);
    }
  }

  return section.join("\n");
}

function isSecretKey(key: string): boolean {
  return /KEY|SECRET|TOKEN|PASSWORD/i.test(key);
}

function askQuestion(prompt: string, mask: boolean, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input,
      output,
      terminal: Boolean(input.isTTY && output.isTTY),
    });

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      rl.close();
    };

    const onAbort = () => {
      cleanup();
      reject(new Error("Interrupted"));
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new Error("Interrupted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    if (mask) {
      const interfaceRef = rl as readline.Interface & {
        stdoutMuted?: boolean;
        _writeToOutput?: (stringToWrite: string) => void;
      };
      const outputRef = rl as readline.Interface & { output: typeof output };
      const originalWrite = interfaceRef._writeToOutput?.bind(rl);
      interfaceRef.stdoutMuted = true;

      if (originalWrite) {
        interfaceRef._writeToOutput = function writeMasked(stringToWrite: string) {
          if (interfaceRef.stdoutMuted) {
            if (stringToWrite === "\n") {
              outputRef.output.write("\n");
            } else {
              outputRef.output.write("*".repeat(stringToWrite.length));
            }
            return;
          }

          originalWrite(stringToWrite);
        };
      }
    }

    rl.question(prompt, (answer) => {
      cleanup();
      resolve(answer);
    });
  });
}

export function detectEnvRequirements(repoPath: string): EnvRequirement[] {
  const envFile = findFile(repoPath, /^\.env\.(example|sample)$/i);
  if (envFile) {
    const keys = parseEnvLikeContent(readFileSync(path.join(repoPath, envFile), "utf8"));
    const result = dedupe(keys);
    console.log(`[pragmatist] .env file found, requirements: ${JSON.stringify(result)}`);
    return result;
  }

  const readme = findFile(repoPath, /^readme(\..+)?$/i);
  if (readme) {
    const readmeText = readFileSync(path.join(repoPath, readme), "utf8");
    const section = extractRelevantReadmeSection(readmeText);
    const sectionMatches = section.match(/\b[A-Z][A-Z0-9_]+\b/g) ?? [];
    if (sectionMatches.length > 0) {
      const result = dedupe(sectionMatches);
      console.log(`[pragmatist] README section scan found: ${JSON.stringify(result)}`);
      return result;
    }

    const allMatches = readmeText.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? [];
    const result = dedupe(allMatches);
    console.log(`[pragmatist] README full scan found: ${JSON.stringify(result)}`);
    return result;
  }

  return [];
}

export async function promptForEnvValues(
  requirements: EnvRequirement[],
): Promise<Record<string, string>> {
  if (requirements.length === 0) {
    return {};
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error("Cannot prompt for environment values in a non-interactive terminal.");
  }

  const signal = getRepoToolContext()?.signal;
  const values: Record<string, string> = {};

  output.write("\n");

  for (const requirement of requirements) {
    while (true) {
      output.write(`${requirement.key}`);
      if (requirement.description.trim()) {
        output.write(` - ${requirement.description.trim()}`);
      }
      output.write(requirement.required ? " (required)\n" : " (optional)\n");

      const answer = await askQuestion(
        "> ",
        isSecretKey(requirement.key),
        signal,
      );

      if (answer.trim()) {
        values[requirement.key] = answer;
        break;
      }

      if (!requirement.required) {
        break;
      }

      output.write(`${requirement.key} is required.\n\n`);
    }
  }

  output.write("\n");
  return values;
}
