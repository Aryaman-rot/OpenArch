import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Returns the path to the global user environment file (~/.openarch/.env).
 * Ensures the ~/.openarch directory exists before returning.
 */
export function getGlobalEnvPath(): string {
  const dir = path.join(os.homedir(), ".openarch");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, ".env");
}

/**
 * Returns the path to the local environment file (./.env) relative to cwd.
 */
export function getLocalEnvPath(): string {
  return path.resolve(process.cwd(), ".env");
}

/**
 * Returns the environment file path to read from.
 * Checks for a local .env in process.cwd() first (git-clone / dev mode).
 * If no local .env exists, falls back to global ~/.openarch/.env.
 */
export function getEnvReadPath(): string {
  const local = getLocalEnvPath();
  if (fs.existsSync(local)) {
    return local;
  }
  return getGlobalEnvPath();
}

/**
 * Returns the environment file path to write settings to.
 * If a local .env exists in process.cwd(), updates that local .env (dev mode).
 * Otherwise, writes to the global ~/.openarch/.env.
 */
export function getEnvWritePath(): string {
  const local = getLocalEnvPath();
  if (fs.existsSync(local)) {
    return local;
  }
  return getGlobalEnvPath();
}

/**
 * Simple .env parser that loads key=value pairs into process.env.
 * Will not overwrite existing process.env variables.
 */
function parseEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Remove enclosing quotes if present
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

/**
 * Loads environment configuration into process.env at application startup.
 * 1. Reads local ./.env first (if exists in cwd) so project-specific settings take precedence.
 * 2. Reads ~/.openarch/.env second to fill in any missing global fallback defaults.
 */
export function loadEnvConfig(): void {
  // Load local .env first (if exists in cwd)
  const localPath = getLocalEnvPath();
  if (fs.existsSync(localPath)) {
    parseEnvFile(localPath);
  }

  // Load global .env second (fills in missing defaults without overwriting local)
  const globalPath = path.join(os.homedir(), ".openarch", ".env");
  if (fs.existsSync(globalPath)) {
    parseEnvFile(globalPath);
  }
}
