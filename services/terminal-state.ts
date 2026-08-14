import { stdin, stdout } from "node:process";

/**
 * Restores terminal stdin to a clean, active, non-raw state and ensures
 * cursor visibility.
 *
 * This must be called at every state transition boundary (entering/exiting
 * menus, before/after prompts, and in finally blocks after mode/tool runs)
 * to prevent stdin unresponsiveness / input freezing across mode switches.
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
