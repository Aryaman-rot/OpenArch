import { callService, stopService } from "./sandbox";
import { runRepoAsService } from "./repo-runner";

async function main(): Promise<void> {
  const defaultRepoUrl = "https://github.com/auchenberg/node-express-hello-world.git";
  const defaultPort = 3000;
  const repoUrl = process.argv[2] ?? defaultRepoUrl;
  const portArg = process.argv[3];
  const containerPort = portArg ? Number(portArg) : defaultPort;

  if (!Number.isFinite(containerPort) || !Number.isInteger(containerPort)) {
    throw new Error(`Invalid port: ${portArg ?? ""}`);
  }

  let handle: Awaited<ReturnType<typeof runRepoAsService>> | null = null;

  try {
    console.log("Starting service repo test...");
    handle = await runRepoAsService(repoUrl, containerPort);
    console.log(`Service started: ${handle.containerName}`);
    console.log(`Host port: ${handle.hostPort}`);

    console.log("Calling service...");
    const response = await callService(handle, "/");
    const body = await response.text();

    console.log(`Response status: ${response.status}`);
    console.log("Response body:");
    console.log(body);
  } finally {
    if (handle) {
      console.log("Stopping service...");
      await stopService(handle);
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
