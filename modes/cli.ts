import chalk from "chalk";
import { select, isCancel } from "@clack/prompts";
import { runAgentMode } from "./agent/orchestrator";
import { runAskMode } from "./ask/orchestrator";
import { runPlanMode } from "./plan/orchestrator";
import { runPragmatistMode } from "./pragmatist/orchestrator";
import { handleAgentModelError } from "../ai";
import { restoreTerminalStdin } from "../services/terminal-state";

async function runModeSafely(label: string, run: () => Promise<void>): Promise<void> {
    restoreTerminalStdin();
    try {
        await run();
    } catch (err) {
        if (!handleAgentModelError(err)) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(chalk.red(`\n✖  ${label} failed: ${message}\n`));
        }
    } finally {
        restoreTerminalStdin();
    }
}

export async function runCliMode() {
    while (true) {
        restoreTerminalStdin();
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

        if (isCancel(mode) || mode === "back") {
            restoreTerminalStdin();
            return;
        }

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

        restoreTerminalStdin();

        if (mode !== "agent" && mode !== "plan" && mode !== "ask" && mode !== "pragmatist") {
            console.log(chalk.red("Invalid mode selected."));
        }
    }
}
