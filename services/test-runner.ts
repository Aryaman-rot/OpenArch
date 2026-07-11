import { runRepo } from "./repo-runner";

async function main(): Promise<void> {
  const result = await runRepo("https://github.com/piuccio/cowsay.git", [
    "Hello",
    "from",
    "OpenArch",
  ]);

  console.log("Run result:");
  console.log(`exitCode: ${result.exitCode}`);
  if (result.stdout.trim()) {
    console.log("stdout:");
    console.log(result.stdout);
  }
  if (result.stderr.trim()) {
    console.log("stderr:");
    console.log(result.stderr);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
