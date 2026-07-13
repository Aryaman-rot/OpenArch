import { spawn } from "node:child_process";
import { Pool } from "pg";

import type { RegistryEntry, ToolSchema } from "./types";

let pool: Pool | null = null;
let poolInitialized = false;

function getPool(): Pool | null {
  if (poolInitialized) return pool;
  poolInitialized = true;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn(
      "[registry] DATABASE_URL is not set. Registry features (caching, listing wrapped repos) will be unavailable.\n" +
      "To enable, set DATABASE_URL to a PostgreSQL connection string. Example:\n" +
      "  postgres://user:password@localhost:5432/openarch",
    );
    return null;
  }

  try {
    pool = new Pool({ connectionString, max: 5 });
    return pool;
  } catch (error) {
    console.warn(
      `[registry] Failed to create connection pool: ${error instanceof Error ? error.message : String(error)}. Registry will be unavailable.`,
    );
    return null;
  }
}

export async function getRegistryEntry(repoUrl: string): Promise<RegistryEntry | null> {
  const p = getPool();
  if (!p) return null;

  try {
    const result = await p.query(
      `SELECT repo_url, runtime_kind, image_name, tool_schema, created_at, last_used_at FROM wrapped_repos WHERE repo_url = $1`,
      [repoUrl],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      repoUrl: row.repo_url,
      runtimeKind: row.runtime_kind,
      imageName: row.image_name,
      toolSchema: row.tool_schema ?? null,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    };
  } catch (error) {
    console.warn(
      `[registry] Failed to query registry for ${repoUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export async function saveRegistryEntry(entry: {
  repoUrl: string;
  runtimeKind: string;
  imageName: string;
  toolSchema?: ToolSchema;
}): Promise<void> {
  const p = getPool();
  if (!p) return;

  try {
    await p.query(
      `INSERT INTO wrapped_repos (repo_url, runtime_kind, image_name, tool_schema)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (repo_url) DO UPDATE SET
         runtime_kind = EXCLUDED.runtime_kind,
         image_name = EXCLUDED.image_name,
         tool_schema = COALESCE(EXCLUDED.tool_schema, wrapped_repos.tool_schema),
         last_used_at = NOW()`,
      [
        entry.repoUrl,
        entry.runtimeKind,
        entry.imageName,
        entry.toolSchema ? JSON.stringify(entry.toolSchema) : null,
      ],
    );
  } catch (error) {
    console.warn(
      `[registry] Failed to save registry entry for ${entry.repoUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function touchLastUsed(repoUrl: string): Promise<void> {
  const p = getPool();
  if (!p) return;

  try {
    await p.query(
      `UPDATE wrapped_repos SET last_used_at = NOW() WHERE repo_url = $1`,
      [repoUrl],
    );
  } catch (error) {
    console.warn(
      `[registry] Failed to update last_used_at for ${repoUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function checkImageExists(imageName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["image", "inspect", imageName], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export async function tryUseCache(
  repoUrl: string,
): Promise<{ imageName: string; runtimeKind: string } | null> {
  const entry = await getRegistryEntry(repoUrl);
  if (!entry) return null;

  const imageExists = await checkImageExists(entry.imageName);
  if (!imageExists) {
    console.warn(
      `[registry] DB record found for ${repoUrl} but image ${entry.imageName} is missing locally. Rebuilding.`,
    );
    return null;
  }

  const dateStr = entry.lastUsedAt
    ? new Date(entry.lastUsedAt).toLocaleString()
    : "unknown date";
  console.log(`[registry] Using cached image for ${repoUrl} (last built ${dateStr})`);

  touchLastUsed(repoUrl).catch(() => {});

  return { imageName: entry.imageName, runtimeKind: entry.runtimeKind };
}

export async function listWrappedRepos(): Promise<string> {
  const p = getPool();
  if (!p) return "Registry is not available (DATABASE_URL not set or Postgres unreachable).";

  try {
    const result = await p.query(
      `SELECT repo_url, runtime_kind, last_used_at FROM wrapped_repos ORDER BY last_used_at DESC`,
    );

    if (result.rows.length === 0) return "No wrapped repos found in the registry.";

    return result.rows
      .map(
        (row: { repo_url: string; runtime_kind: string; last_used_at: Date }) =>
          `- ${row.repo_url} (${row.runtime_kind}, last used: ${new Date(row.last_used_at).toLocaleString()})`,
      )
      .join("\n");
  } catch (error) {
    return `Registry query failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
