import chalk from "chalk";

import { wrapRepoAsTool } from "./tool-generator";

async function main(): Promise<void> {
  const repoUrl = "https://github.com/piuccio/cowsay.git";

  console.log(chalk.cyan("Cloning repo and building image..."));
  console.log(chalk.cyan(`Repo: ${repoUrl}`));

  console.log(chalk.cyan("Generating tool schema from CLI help..."));
  const schema = await wrapRepoAsTool(repoUrl);

  console.log(chalk.green("✓ Schema generated"));
  console.log(chalk.cyan("Tool schema:"));
  console.log(chalk.magenta(JSON.stringify(schema, null, 2)));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      chalk.red(
        error instanceof Error ? error.message : String(error),
      ),
    );
    process.exitCode = 1;
  });
}
