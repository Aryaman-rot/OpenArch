import { stdin, stdout } from "node:process";
import chalk from "chalk";

const startTime = Date.now();
function ts(): string {
  const diff = Date.now() - startTime;
  return chalk.magenta(`[+${String(diff).padStart(6, " ")}ms]`);
}

function getStdinState() {
  const s = stdin as NodeJS.ReadStream & { isRaw?: boolean };
  return `isPaused=${s.isPaused()}, isRaw=${s.isRaw}, keyListeners=${s.listenerCount("keypress")}, dataListeners=${s.listenerCount("data")}`;
}

export function logDiag(tag: string, detail = ""): void {
  const state = getStdinState();
  console.log(`${ts()} ${chalk.cyan("[DIAG]")} ${chalk.bold(tag)}${detail ? ` (${detail})` : ""} -> ${state}`);
}

let hooksInstalled = false;
export function installDiagnosticHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  try {
    const origPause = stdin.pause.bind(stdin);
    stdin.pause = function (...args: any[]) {
      logDiag("stdin.pause() CALLED");
      const res = origPause.apply(this, args as any);
      logDiag("stdin.pause() FINISHED");
      return res;
    };

    const origResume = stdin.resume.bind(stdin);
    stdin.resume = function (...args: any[]) {
      logDiag("stdin.resume() CALLED");
      const res = origResume.apply(this, args as any);
      logDiag("stdin.resume() FINISHED");
      return res;
    };

    if ("setRawMode" in stdin && typeof (stdin as any).setRawMode === "function") {
      const origSetRaw = (stdin as any).setRawMode.bind(stdin);
      (stdin as any).setRawMode = function (mode: boolean) {
        logDiag("stdin.setRawMode() CALLED", `target=${mode}`);
        const res = origSetRaw.apply(this, [mode]);
        logDiag("stdin.setRawMode() FINISHED", `currentIsRaw=${stdin.isRaw}`);
        return res;
      };
    }

    stdin.on("newListener", (event) => {
      logDiag("stdin.on(newListener)", `event=${String(event)}`);
      if (event === "keypress" || event === "data") {
        setTimeout(() => {
          logDiag("stdin.newListener timer fired", `event=${String(event)}`);
          try {
            if (typeof stdin.resume === "function" && stdin.isPaused()) {
              stdin.resume();
            }
          } catch {}
        }, 80);
      }
    });

    stdin.on("removeListener", (event) => {
      logDiag("stdin.on(removeListener)", `event=${String(event)}`);
    });
  } catch (e) {
    console.error("Failed to install diagnostic hooks:", e);
  }
}

// Auto-install diagnostic hooks on import
installDiagnosticHooks();

export function restoreTerminalStdin(tag?: string): void {
  logDiag(`restoreTerminalStdin${tag ? `:${tag}` : ""}:START`);
  try {
    const stream = stdin as NodeJS.ReadStream & {
      setRawMode?: (mode: boolean) => void;
      isRaw?: boolean;
    };
    if (stream && stream.isTTY && typeof stream.setRawMode === "function" && stream.isRaw) {
      stream.setRawMode(false);
    }
    if (stream && typeof stream.resume === "function") {
      stream.resume();
    }
    if (stdout && stdout.isTTY) {
      stdout.write("\x1b[?25h");
    }
  } catch {}
  logDiag(`restoreTerminalStdin${tag ? `:${tag}` : ""}:END`);
}

export async function settleTerminalState(delayMs = 80, tag?: string): Promise<void> {
  logDiag(`settleTerminalState${tag ? `:${tag}` : ""}:START`, `delay=${delayMs}ms`);
  restoreTerminalStdin(tag ? `${tag}:beforeDelay` : "beforeDelay");
  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
  restoreTerminalStdin(tag ? `${tag}:afterDelay` : "afterDelay");
  logDiag(`settleTerminalState${tag ? `:${tag}` : ""}:END`);
}
