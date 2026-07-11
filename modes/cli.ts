import chalk from "chalk";
import { select, isCancel } from "@clack/prompts";
import { runAgentMode } from "./agent/orchestrator";
import { runAskMode } from "./ask/orchestrator";
import { runPlanMode } from "./plan/orchestrator";
import { runPragmatistMode } from "./pragmatist/orchestrator";

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
            await runAgentMode();
        }
        if (mode === "plan") {
            await runPlanMode();
        }
        if (mode === "ask") {
            await runAskMode();
        }
        if (mode === "pragmatist") {
            await runPragmatistMode();
        }

        if (mode !== "agent" && mode !== "plan" && mode !== "ask" && mode !== "pragmatist") {
            console.log(chalk.red("Invalid mode selected."));
        }
    }


}
