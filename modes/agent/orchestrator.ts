import { isCancel, text } from "@clack/prompts";
import chalk from "chalk";
import { defaultAgentConfig } from "./types";
import { ActionTracker } from "./action-tracker";
import { ToolExecutor } from "./tool-executor";
import { createAgentTools } from "./agent-tools";
import { stepCountIs, ToolLoopAgent, type ModelMessage } from "ai";
import { getAgentModel, handleAgentModelError } from "../../ai";
import { renderTerminalMarkdown } from "../../tui/terminal-md";
import { runApprovalFlow } from "./approval";
import { settleTerminalState } from "../../services/terminal-state";

const EXIT_PATTERN = /^(exit|back|quit)$/i;

export async function runAgentMode() {
    console.log(chalk.bold("Running in Agent Mode..."));
    console.log(chalk.dim("Tip: ask me what tools I have available."));
    console.log(chalk.dim("Type 'exit', 'back', or 'quit' (or press Esc) to return to the mode menu."));

    const config = defaultAgentConfig();
    const tracker = new ActionTracker();
    const executor = new ToolExecutor(tracker, config);
    const tools = createAgentTools(executor, { showProgress: true });

    const agent = new ToolLoopAgent({
        model: getAgentModel(),
        stopWhen: stepCountIs(67),
        instructions: [
            `Workspace root: ${config.codebasePath}`,
            "All mutations are staged until approval.",
        ].join("\n"),
        tools,
    });

    let history: ModelMessage[] = [];

    while (true) {
        await settleTerminalState(80);
        const goal = await text({
            message: "What would you like me to do?",
            placeholder: "Concrete task for this codebase",
        });

        if (isCancel(goal)) {
            await settleTerminalState(80);
            return;
        }

        const trimmed = goal.trim();
        if (!trimmed || EXIT_PATTERN.test(trimmed)) {
            await settleTerminalState(80);
            console.log(chalk.dim("\nReturning to mode selection..."));
            return;
        }

        let result: Awaited<ReturnType<typeof agent.generate>>;
        try {
            result = await agent.generate({
                messages: [...history, { role: "user", content: trimmed }],
                onStepFinish: ({ toolCalls }) => {
                    for (const tc of toolCalls) {
                        const preview = JSON.stringify(tc.input).slice(0, 160);
                        console.log(
                            chalk.green("  ✓"),
                            chalk.bold(String(tc.toolName)),
                            chalk.dim(preview + (preview.length >= 160 ? "..." : "")),
                        );
                    }
                },
            });
        } catch (err) {
            if (handleAgentModelError(err)) return;
            throw err;
        }

        history = result.response.messages;

        if (result.text?.trim()) console.log(renderTerminalMarkdown(result.text));

        const ok = await runApprovalFlow(tracker);
        if (!ok) {
            executor.clearStaging();
            continue;
        }

        const { errors } = executor.applyApprovedFromTracker();

        if (errors.length) {
            console.log(chalk.red("\nSome actions failed to apply:\n"));
            for (const e of errors) console.log(chalk.red(`  - ${e}`));
        } else {
            console.log(chalk.green('\n✓ Applied.\n'));
        }

        executor.clearStaging();
    }
}