import { select, text, isCancel, note } from "@clack/prompts";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";

export const MODEL_OPTIONS = [
  { value: "openrouter/free", label: "OpenRouter Free (Default - auto-selects free model)", hint: "Free" },
  { value: "anthropic/claude-3.5-sonnet", label: "Anthropic: Claude 3.5 Sonnet", hint: "Paid" },
  { value: "openai/gpt-4o", label: "OpenAI: GPT-4o", hint: "Paid" },
  { value: "google/gemini-2.0-flash-001", label: "Google: Gemini 2.0 Flash", hint: "Paid" },
  { value: "deepseek/deepseek-r1", label: "DeepSeek: R1", hint: "Paid" },
  { value: "meta-llama/llama-3.3-70b-instruct", label: "Meta: Llama 3.3 70B Instruct", hint: "Paid" },
  { value: "custom", label: "Enter a custom model ID...", hint: "Custom" },
];

export function saveModelToEnv(modelId: string): void {
  const envPath = path.resolve(process.cwd(), ".env");
  let envContent = "";

  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf-8");
    if (/^MODEL=.*\r?$/m.test(envContent)) {
      envContent = envContent.replace(/^MODEL=.*\r?$/m, `MODEL=${modelId}`);
    } else if (/^OPENROUTER_DEFAULT_MODEL=.*\r?$/m.test(envContent)) {
      envContent = envContent.replace(/^OPENROUTER_DEFAULT_MODEL=.*\r?$/m, `MODEL=${modelId}`);
    } else {
      if (envContent.length > 0 && !envContent.endsWith("\n")) {
        envContent += "\n";
      }
      envContent += `MODEL=${modelId}\n`;
    }
  } else {
    envContent = `MODEL=${modelId}\n`;
  }

  fs.writeFileSync(envPath, envContent, "utf-8");
  process.env.MODEL = modelId;
}

export async function promptAndSaveModel(): Promise<string | undefined> {
  const currentModel = process.env.MODEL || process.env.OPENROUTER_DEFAULT_MODEL || "openrouter/free";
  
  const chosen = await select({
    message: `Select OpenRouter AI Model (Current: ${chalk.cyan(currentModel)})`,
    options: MODEL_OPTIONS,
  });

  if (isCancel(chosen)) {
    return undefined;
  }

  let finalModel = chosen as string;

  if (finalModel === "custom") {
    const customInput = await text({
      message: "Enter OpenRouter model ID:",
      placeholder: "e.g. mistralai/mistral-large",
      validate: (value) => {
        if (!value || value.trim().length === 0) {
          return "Model ID cannot be empty";
        }
      },
    });

    if (isCancel(customInput)) {
      return undefined;
    }

    finalModel = customInput.trim();
  }

  saveModelToEnv(finalModel);

  note(
    `AI Model configured to: ${chalk.bold.green(finalModel)}\nSaved to .env`,
    "Model Configuration"
  );

  return finalModel;
}
