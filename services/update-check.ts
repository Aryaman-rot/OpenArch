import https from "node:https";

function parseVersion(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lNum = l[i] ?? 0;
    const cNum = c[i] ?? 0;
    if (lNum > cNum) return true;
    if (lNum < cNum) return false;
  }
  return false;
}

/**
  Checks npm registry asynchronously for a newer version of openarch without blocking CLI startup.
 */
export function checkForUpdatesAsync(currentVersion: string): void {
  try {
    const req = https.get(
      "https://registry.npmjs.org/openarch/latest",
      {
        timeout: 1500,
        headers: { "User-Agent": "openarch-cli" },
      },
      (res) => {
        if (res.statusCode !== 200) return;
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            const latestVersion = json.version;
            if (latestVersion && isNewer(latestVersion, currentVersion)) {
              console.log(
                `\n\x1b[33m💡 A newer version of OpenArch is available (${latestVersion}). Run \x1b[36mbun install -g openarch\x1b[33m (or \x1b[36mnpm install -g openarch\x1b[33m) to update.\x1b[0m\n`
              );
            }
          } catch {
            // Silent failure
          }
        });
      }
    );

    req.on("error", () => {});
    req.on("timeout", () => {
      req.destroy();
    });
  } catch {
    // Silent failure
  }
}
