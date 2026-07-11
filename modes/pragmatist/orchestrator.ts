import chalk from "chalk";
import { isCancel, text } from "@clack/prompts";

import { runRepoWithEnvCheck } from "../../services/repo-runner";
import { runWithRepoProgress } from "../../services/repo-progress";

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of input.trim()) {
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
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

function isValidRepoUrl(value: string): boolean {
  const patterns = [
    /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+(\.git)?\/?$/i,
    /^git@github\.com:[\w.-]+\/[\w.-]+(\.git)?$/i,
    /^https?:\/\/(www\.)?gitlab\.com\/[\w.-]+\/[\w.-]+(\.git)?\/?$/i,
    /^git@gitlab\.com:[\w.-]+\/[\w.-]+(\.git)?$/i,
    /^https?:\/\/(www\.)?bitbucket\.org\/[\w.-]+\/[\w.-]+(\.git)?\/?$/i,
    /^git@bitbucket\.org:[\w.-]+\/[\w.-]+(\.git)?$/i,
  ];

  return patterns.some((pattern) => pattern.test(value.trim()));
}

export async function runPragmatistMode(): Promise<void> {
  console.log(chalk.bold("\nPragmatist Mode\n"));
  console.log(
    chalk.dim(
      "Clone a repo, detect required env vars, prompt for values, and run it safely.\n",
    ),
  );

  const repoUrl = await text({
    message: "GitHub repo URL",
    placeholder: "https://github.com/user/repo.git",
    validate: (value) => {
      const trimmed = (value ?? "").trim();
      if (!trimmed) {
        return "Repo URL is required.";
      }

      if (!isValidRepoUrl(trimmed)) {
        return "That doesn't look like a valid GitHub repo URL - expected something like https://github.com/user/repo";
      }
    },
  });

  if (isCancel(repoUrl) || !repoUrl.trim()) return;

  const rawArgs = await text({
    message: "Arguments to pass to the repo (optional)",
    placeholder: '--help',
    initialValue: "",
  });

  if (isCancel(rawArgs)) return;

  const args = rawArgs.trim() ? splitArgs(rawArgs) : [];

  try {
    const result = await runWithRepoProgress("pragmatist run", async () => {
      return runRepoWithEnvCheck(repoUrl.trim(), args);
    });

    if ("error" in result) {
      console.log(chalk.red(`\nPragmatist mode failed: ${result.error}\n`));
      return;
    }

    console.log(chalk.green("\n✓ Repo finished running.\n"));
    console.log(chalk.bold("Exit code:"), result.exitCode);

    if (result.stdout.trim()) {
      console.log(chalk.cyan("\nstdout:\n"));
      console.log(result.stdout.trimEnd());
    }

    if (result.stderr.trim()) {
      console.log(chalk.yellow("\nstderr:\n"));
      console.log(result.stderr.trimEnd());
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`\nPragmatist mode failed: ${message}\n`));
  }
}
