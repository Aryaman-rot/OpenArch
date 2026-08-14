import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { select, isCancel } from "@clack/prompts";
import { settleTerminalState } from "../services/terminal-state";

function runModeInChildProcess(submode: string): void {
    const entryScript = process.argv[1] || "dist/index.js";
    spawnSync(process.execPath, [entryScript, "submode", submode], {
        stdio: "inherit",
        env: process.env,
    });
}

export async function runCliMode() {
    while (true) {
        await settleTerminalState(80);
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
            await settleTerminalState(80);
            return;
        }

        if (mode === "agent") {
            runModeInChildProcess("agent");
        }
        if (mode === "plan") {
            runModeInChildProcess("plan");
        }
        if (mode === "ask") {
            runModeInChildProcess("ask");
        }
        if (mode === "pragmatist") {
            runModeInChildProcess("pragmatist");
        }

        await settleTerminalState(80);

        if (mode !== "agent" && mode !== "plan" && mode !== "ask" && mode !== "pragmatist") {
            console.log(chalk.red("Invalid mode selected."));
        }
    }
}
