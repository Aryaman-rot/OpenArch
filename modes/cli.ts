import chalk from "chalk";
import { select, isCancel } from "@clack/prompts";
import { stdin } from "node:process";
import { runAgentMode } from "./agent/orchestrator";
import { runAskMode } from "./ask/orchestrator";
import { runPlanMode } from "./plan/orchestrator";
import { runPragmatistMode } from "./pragmatist/orchestrator";
import { handleAgentModelError } from "../ai";

function restoreStdinState(): void {
  try {
    const stream = stdin as NodeJS.ReadStream & {
      setRawMode?: (mode: boolean) => void;
      isRaw?: boolean;
    };
    if (typeof stream.setRawMode === "function" && stream.isRaw) {
      stream.setRawMode(false);
    }
    stream.resume();
  } catch {
    // best-effort terminal restore
  }
}

async function runModeSafely(label: string, run: () => Promise<void>): Promise<void> {
    try {
        await run();
    } catch (err) {
        restoreStdinState();
        if (!handleAgentModelError(err)) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(chalk.red(`\n✖  ${label} failed: ${message}\n`));
        }
    }
}

export async function runCliMode() {
    while (true) {
        const mode = await select({
            message: "Choose your CLI Mode",
            options: [
                { value: "agent", label: "Agent Mode" },
                { value: "plan", label: "Plan Mode" },
                { value: "ask", label: "Ask Mode" },
                { value: "pragmatist", label: "Pragmatist Mode" },
                { value: "back", label: "Back to Main Menu" },
            ],
        });

        if (isCancel(mode) || mode === "back") return;

        if (mode === "agent") {
            await runModeSafely("Agent Mode", runAgentMode);
        }
        if (mode === "plan") {
            await runModeSafely("Plan Mode", runPlanMode);
        }
        if (mode === "ask") {
            await runModeSafely("Ask Mode", runAskMode);
        }
        if (mode === "pragmatist") {
            await runModeSafely("Pragmatist Mode", runPragmatistMode);
        }

        if (mode !== "agent" && mode !== "plan" && mode !== "ask" && mode !== "pragmatist") {
            console.log(chalk.red("Invalid mode selected."));
        }
    }


}
