import chalk from "chalk";
import { select, isCancel } from "@clack/prompts";
import { runAgentMode } from "./agent/orchestrator";
import { runAskMode } from "./ask/orchestrator";
import { runPlanMode } from "./plan/orchestrator";
import { runPragmatistMode } from "./pragmatist/orchestrator";
import { handleAgentModelError } from "../ai";
import { restoreTerminalStdin, settleTerminalState } from "../services/terminal-state";

async function runModeSafely(label: string, run: () => Promise<void>): Promise<void> {
    await settleTerminalState(30);
    try {
        await run();
    } catch (err) {
        if (!handleAgentModelError(err)) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(chalk.red(`\n✖  ${label} failed: ${message}\n`));
        }
    } finally {
        await settleTerminalState(40);
    }
}

export async function runCliMode() {
    while (true) {
        await settleTerminalState(20);
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
            await settleTerminalState(20);
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

        await settleTerminalState(30);

        if (mode !== "agent" && mode !== "plan" && mode !== "ask" && mode !== "pragmatist") {
            console.log(chalk.red("Invalid mode selected."));
        }
    }
}
