import chalk from "chalk";
import { confirm, isCancel, text } from "@clack/prompts";
import { tool, ToolLoopAgent, stepCountIs } from "ai";
import { z } from "zod";
import { getAgentModel, handleAgentModelError } from "../../ai/ai.config.ts";
import { ActionTracker } from "../agent/action-tracker.ts";
import { ToolExecutor } from "../agent/tool-executor.ts";
import { createAgentTools } from "../agent/agent-tools.ts";
import { defaultAgentConfig } from "../agent/types.ts";
import { runApprovalFlow } from "../agent/approval.ts";
import { renderTerminalMarkdown } from "../../tui/terminal-md.ts";
import { generatePlan } from "./planner.ts";
import { printPlan, selectSteps } from "./selection.ts";
import type { PlanStep } from "./types.ts";
import { createWebTools } from "./web-tools.ts";
import { wrapToolsWithStatus } from "../../services/repo-progress.ts";
import { listAvailableTools } from "../../services/tool-context.ts";
import { restoreTerminalStdin, settleTerminalState } from "../../services/terminal-state.ts";


function stepPrompt(goal: string, step: PlanStep): string {
  return [`Goal: ${goal}`, `Step: ${step.title}`, step.description].join('\n');
}


const EXIT_PATTERN = /^(exit|back|quit)$/i;

export async function runPlanMode(): Promise<void> {
  console.log(chalk.bold("\n🧭 Plan Mode"));
  console.log(chalk.dim("Tip: ask me what tools I have available."));
  console.log(chalk.dim("Type 'exit', 'back', or 'quit' (or press Esc) to return to the mode menu.\n"));

  while (true) {
    await settleTerminalState(80);
    const goal = await text({ message: "What is your goal?" });
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

    const plan = await generatePlan(trimmed);
    if (!plan) continue;

    printPlan(plan);

    const selected = await selectSteps(plan);
    if (selected.length === 0) continue;

    const proceed = await confirm({
      message: `Execute ${selected.length} step(s)`,
      initialValue: true,
    });

    if (isCancel(proceed) || !proceed) continue;

    const config = defaultAgentConfig();
    const tracker = new ActionTracker();
    const executor = new ToolExecutor(tracker, config);


    const agentTools = createAgentTools(executor, { showProgress: true });
    const webTools = createWebTools(tracker);
    const baseTools = { ...agentTools, ...wrapToolsWithStatus(webTools) };
    const tools = {
      ...baseTools,
      list_available_tools: tool({
        description:
          "List all available tools in the current mode with their descriptions.",
        inputSchema: z.object({}),
        execute: async () =>
          listAvailableTools(baseTools as Record<string, { description?: string }>),
      }),
    };

    let executedCount = 0;
    for (const [index, step] of selected.entries()) {
      console.log(chalk.bold(`\n🔧 Step ${index + 1}/${selected.length}: ${step.title}\n`));

      const agent = new ToolLoopAgent({
        model: getAgentModel(),
        stopWhen: stepCountIs(30),
        tools,
      });

      let r: Awaited<ReturnType<typeof agent.generate>>;
      try {
        r = await agent.generate({ prompt: stepPrompt(plan.goal, step) });
      } catch (err) {
        if (handleAgentModelError(err)) {
          await settleTerminalState(80);
          return;
        }
        throw err;
      }

      if (r.text) {
        console.log(renderTerminalMarkdown(r.text));
      }
      executedCount++;
    }

    console.log(chalk.green(`\n✓ Executed ${executedCount}/${selected.length} selected step(s).\n`));

    const ok = await runApprovalFlow(tracker);

    if(!ok) { executor.clearStaging(); continue; }

     const { errors } = executor.applyApprovedFromTracker();
    if (errors.length) {
      console.log(chalk.red('\nSome operations reported errors:\n'));
      for (const e of errors) console.log(chalk.red(`  • ${e}`));
    } else {
      console.log(chalk.green('\n✓ Applied.\n'));
    }
    executor.clearStaging();
  }
}