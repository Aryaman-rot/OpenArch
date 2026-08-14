import { stdin, stdout } from "node:process";

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
 * Waits for pending event-loop ticks / stream pauses to settle,
 * then restores terminal stdin state.
 */
export async function settleTerminalState(delayMs = 80): Promise<void> {
  restoreTerminalStdin();
  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
  restoreTerminalStdin();
}
