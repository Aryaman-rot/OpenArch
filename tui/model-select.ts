import { select, text, isCancel, note, spinner } from "@clack/prompts";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenRouterModel {
  id: string;
  name: string;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

interface SelectOption {
  value: string;
  label: string;
  hint: string;
}

// ---------------------------------------------------------------------------
// Fallback safety-net list (may go stale — live fetch is always preferred)
// ---------------------------------------------------------------------------

const FALLBACK_OPTIONS: SelectOption[] = [
  {
    value: "openrouter/auto",
    label: "OpenRouter Auto (routes to best available model)",
    hint: "Free",
  },
  {
    value: "anthropic/claude-sonnet-5",
    label: "Anthropic: Claude Sonnet 5",
    hint: "Paid — offline fallback",
  },
  {
    value: "openai/gpt-4o",
    label: "OpenAI: GPT-4o",
    hint: "Paid — offline fallback",
  },
];

// ---------------------------------------------------------------------------
// Curated provider prefixes we surface first in the picker
// ---------------------------------------------------------------------------

const PRIORITY_PROVIDERS = [
  "anthropic/",
  "openai/",
  "google/",
  "deepseek/",
  "meta-llama/",
];

// ---------------------------------------------------------------------------
// Pricing helpers
// ---------------------------------------------------------------------------

function formatPricePerMillion(raw: string | undefined): string | null {
  const val = parseFloat(raw ?? "");
  if (isNaN(val)) return null;
  if (val === 0) return "Free";
  return `$${(val * 1_000_000).toFixed(2)}/M`;
}

function buildHint(model: OpenRouterModel, isFree: boolean): string {
  if (isFree) return "Free";
  const inp = formatPricePerMillion(model.pricing?.prompt);
  const out = formatPricePerMillion(model.pricing?.completion);
  if (inp && out) return `${inp} in / ${out} out`;
  if (inp) return inp;
  return "Paid";
}

// ---------------------------------------------------------------------------
// Session cache — fetched fresh each time config flow starts, not on every
// render, to keep the list current without hammering the API.
// ---------------------------------------------------------------------------

let sessionCache: SelectOption[] | null = null;

/**
 * Fetches the live OpenRouter model catalog and builds a curated list
 * for the interactive picker.  Falls back to FALLBACK_OPTIONS on error.
 */
async function fetchOpenRouterModels(): Promise<SelectOption[]> {
  if (sessionCache) return sessionCache;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = (await res.json()) as { data: OpenRouterModel[] };
    const allModels: OpenRouterModel[] = json.data ?? [];

    // Classify free / priority models
    const freeModels: OpenRouterModel[] = [];
    const priorityModels: OpenRouterModel[] = [];
    const otherModels: OpenRouterModel[] = [];

    for (const m of allModels) {
      const isFree =
        m.id.endsWith(":free") ||
        (m.pricing?.prompt === "0" && m.pricing?.completion === "0");

      const isPriority = PRIORITY_PROVIDERS.some((pfx) => m.id.startsWith(pfx));

      if (isFree) {
        freeModels.push(m);
      } else if (isPriority) {
        priorityModels.push(m);
      } else {
        otherModels.push(m);
      }
    }

    // Cap at a manageable list size: up to 4 free, up to 6 priority, up to 4 others
    const pick = [
      ...freeModels.slice(0, 4),
      ...priorityModels.slice(0, 6),
      ...otherModels.slice(0, 4),
    ];

    const options: SelectOption[] = pick.map((m) => {
      const isFree =
        m.id.endsWith(":free") ||
        (m.pricing?.prompt === "0" && m.pricing?.completion === "0");
      return {
        value: m.id,
        label: m.name ?? m.id,
        hint: buildHint(m, isFree),
      };
    });

    sessionCache = options;
    return options;
  } catch (_err) {
    clearTimeout(timeout);
    return FALLBACK_OPTIONS;
  }
}

// ---------------------------------------------------------------------------
// .env writer
// ---------------------------------------------------------------------------

import { getEnvWritePath, writeEnvFileSafely } from "../services/env-config";
import { restoreTerminalStdin } from "../services/terminal-state";

export function saveApiKeyToEnv(apiKey: string): void {
  const envPath = getEnvWritePath();
  let envContent = "";

  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf-8");
    if (/^OPENROUTER_API_KEY=.*\r?$/m.test(envContent)) {
      envContent = envContent.replace(
        /^OPENROUTER_API_KEY=.*\r?$/m,
        `OPENROUTER_API_KEY=${apiKey}`
      );
    } else {
      if (envContent.length > 0 && !envContent.endsWith("\n")) {
        envContent += "\n";
      }
      envContent += `OPENROUTER_API_KEY=${apiKey}\n`;
    }
  } else {
    envContent = `OPENROUTER_API_KEY=${apiKey}\n`;
  }

  writeEnvFileSafely(envPath, envContent);
  process.env.OPENROUTER_API_KEY = apiKey;
}

export async function promptAndSaveApiKey(): Promise<string | undefined> {
  restoreTerminalStdin();
  const currentKey = process.env.OPENROUTER_API_KEY ? " (Key set)" : "";
  const input = await text({
    message: `Enter your OpenRouter API key${currentKey} (get one at https://openrouter.ai/keys):`,
    placeholder: "sk-or-v1-...",
    validate: (value) => {
      if (!value || value.trim().length === 0) {
        return "API key cannot be empty";
      }
    },
  });

  if (isCancel(input)) {
    restoreTerminalStdin();
    return undefined;
  }

  const key = input.trim();
  saveApiKeyToEnv(key);

  note(
    `OpenRouter API key saved to ${getEnvWritePath()}`,
    "API Key Configuration"
  );

  restoreTerminalStdin();
  return key;
}

export function saveModelToEnv(modelId: string): void {
  const envPath = getEnvWritePath();
  let envContent = "";

  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf-8");
    if (/^MODEL=.*\r?$/m.test(envContent)) {
      envContent = envContent.replace(/^MODEL=.*\r?$/m, `MODEL=${modelId}`);
    } else if (/^OPENROUTER_DEFAULT_MODEL=.*\r?$/m.test(envContent)) {
      envContent = envContent.replace(
        /^OPENROUTER_DEFAULT_MODEL=.*\r?$/m,
        `MODEL=${modelId}`
      );
    } else {
      if (envContent.length > 0 && !envContent.endsWith("\n")) {
        envContent += "\n";
      }
      envContent += `MODEL=${modelId}\n`;
    }
  } else {
    envContent = `MODEL=${modelId}\n`;
  }

  writeEnvFileSafely(envPath, envContent);
  process.env.MODEL = modelId;
}

// ---------------------------------------------------------------------------
// Interactive picker
// ---------------------------------------------------------------------------

export async function promptAndSaveModel(): Promise<string | undefined> {
  restoreTerminalStdin();
  // Invalidate session cache so we always fetch a fresh list when the
  // config flow is entered.
  sessionCache = null;

  const currentModel =
    process.env.MODEL ??
    process.env.OPENROUTER_DEFAULT_MODEL ??
    "openrouter/auto";

  // Fetch live list with a spinner
  const s = spinner();
  s.start("Fetching current model catalog from OpenRouter…");
  const liveOptions = await fetchOpenRouterModels();
  const isFallback = liveOptions === FALLBACK_OPTIONS;
  s.stop(
    isFallback
      ? chalk.yellow("⚠  Could not reach OpenRouter — showing offline fallback list.")
      : `Loaded ${liveOptions.length} models from OpenRouter.`
  );

  restoreTerminalStdin();

  const allOptions = [
    ...liveOptions,
    { value: "custom", label: "Enter a custom model ID…", hint: "Custom" },
  ];

  const chosen = await select({
    message: `Select OpenRouter AI Model (Current: ${chalk.cyan(currentModel)})`,
    options: allOptions,
  });

  if (isCancel(chosen)) {
    restoreTerminalStdin();
    return undefined;
  }

  let finalModel = chosen as string;

  if (finalModel === "custom") {
    restoreTerminalStdin();
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
      restoreTerminalStdin();
      return undefined;
    }
    finalModel = customInput.trim();
  }

  saveModelToEnv(finalModel);

  note(
    `AI Model configured to: ${chalk.bold.green(finalModel)}\nSaved to ${getEnvWritePath()}`,
    "Model Configuration"
  );

  restoreTerminalStdin();
  return finalModel;
}
