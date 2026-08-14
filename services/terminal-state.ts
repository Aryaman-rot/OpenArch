import { stdin, stdout } from "node:process";

let guardInitialized = false;

/**
 * Installs a persistent auto-resume guard on process.stdin.
 *
 * @clack/core's Prompt class calls `this.rl.close()` when any prompt
 * finishes (submit OR cancel/Esc), which internally calls
 * process.stdin.pause(). The next prompt then attaches a 'keypress' listener
 * and calls setRawMode(true) but NEVER calls stdin.resume() itself.
 *
 * To make this robust against the Esc key specifically, we use a small timer
 * (80ms, past @clack/core's escapeCodeTimeout:50ms) on the 'newListener'
 * hook so we don't resume BEFORE readline's internal escape-sequence timeout
 * has finished processing and potentially re-paused stdin.
 *
 * This guard is a module-level singleton and is installed once on import.
 */
export function initTerminalStateGuard(): void {
  if (guardInitialized) return;
  guardInitialized = true;

  try {
    if (stdin && typeof stdin.on === "function") {
      stdin.on("newListener", (event) => {
        if (event === "keypress" || event === "data") {
          // Delay must be > escapeCodeTimeout (50ms in @clack/core) to
          // ensure any pending readline escape-sequence flush timer has
          // already fired before we call resume().
          setTimeout(() => {
            try {
              if (typeof stdin.resume === "function" && stdin.isPaused()) {
                stdin.resume();
              }
            } catch {}
          }, 80);
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
export function restoreTerminalStdin(): void {
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
 * Waits long enough to outlast @clack/core's escapeCodeTimeout (50ms),
 * then restores stdin. The delay must be > 50ms to handle the Esc key path,
 * where readline's internal escape-sequence timer fires at t+50ms and may
 * re-pause stdin after our first resume() call.
 */
export async function settleTerminalState(delayMs = 80): Promise<void> {
  restoreTerminalStdin();
  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
  restoreTerminalStdin();
}
