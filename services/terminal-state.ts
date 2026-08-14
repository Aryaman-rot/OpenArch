import { stdin, stdout } from "node:process";
import chalk from "chalk";

let guardInitialized = false;

/**
 * Initializes automatic stdin auto-resume guards.
 * Whenever @clack/core or any prompt attaches a 'keypress' or 'data' listener,
 * this guard ensures process.stdin is actively resumed so the prompt never
 * hangs waiting on a paused input stream.
 */
export function initTerminalStateGuard(): void {
  if (guardInitialized) return;
  guardInitialized = true;

  try {
    if (stdin && typeof stdin.on === "function") {
      stdin.on("newListener", (event) => {
        if (event === "keypress" || event === "data") {
          process.nextTick(() => {
            try {
              if (stdin.isTTY && typeof stdin.resume === "function" && stdin.isPaused()) {
                stdin.resume();
              }
            } catch {}
          });
        }
      });
    }
  } catch {}
}

// Auto-initialize guard on module import
initTerminalStateGuard();

/**
 * Restores terminal stdin to a clean, active, non-raw state and ensures
 * cursor visibility.
 */
export function restoreTerminalStdin(tag?: string): void {
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
  } catch {
    // Best-effort terminal restore
  }
}

/**
 * Explicitly waits for pending event-loop ticks / stream pauses to settle,
 * then restores terminal stdin state.
 */
export async function settleTerminalState(delayMs = 40): Promise<void> {
  restoreTerminalStdin();
  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
  restoreTerminalStdin();
}
