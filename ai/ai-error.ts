import chalk from "chalk";

// Error shape returned by the AI SDK when an API call fails.
// The actual class is `APICallError` with name "AI_APICallError".
interface AIAPICallError {
  name: string;
  statusCode?: number;
  message?: string;
  responseBody?: string;
  data?: {
    error?: {
      code?: number;
      message?: string;
    };
  };
}

function isAPICallError(err: unknown): err is AIAPICallError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as AIAPICallError).name === "AI_APICallError"
  );
}

/**
 * Inspects an error thrown by the AI SDK / OpenRouter and prints a
 * friendly, actionable message to the console.
 *
 * Returns `true` if the error was a known, handled API error (callers
 * should abort cleanly).  Returns `false` for unknown errors (callers
 * should re-throw or handle themselves).
 */
export function handleAgentModelError(err: unknown): boolean {
  if (!isAPICallError(err)) return false;

  const status = err.statusCode ?? err.data?.error?.code;
  const message = (err.message ?? err.data?.error?.message ?? "").toLowerCase();

  // --- 404: Model not found / no endpoints ---
  if (
    status === 404 ||
    message.includes("no endpoints found") ||
    message.includes("not found")
  ) {
    const modelId = process.env.MODEL ?? process.env.OPENROUTER_DEFAULT_MODEL ?? "unknown";
    console.error(
      "\n" +
        chalk.red("✖  Model unavailable.\n") +
        chalk.yellow(
          `   The selected model ${chalk.bold(`'${modelId}'`)} isn't currently available on OpenRouter.\n`
        ) +
        chalk.dim(
          `   • Run ${chalk.cyan("bun index.ts config")} to pick a different model.\n` +
          `   • Or browse live models at ${chalk.cyan("https://openrouter.ai/models")}\n`
        )
    );
    return true;
  }

  // --- 402: Insufficient credits / payment required ---
  if (
    status === 402 ||
    message.includes("insufficient") ||
    message.includes("credit") ||
    message.includes("payment required") ||
    message.includes("billing")
  ) {
    console.error(
      "\n" +
        chalk.red("✖  Insufficient OpenRouter credits.\n") +
        chalk.yellow("   Your account has run out of credits.\n") +
        chalk.dim(
          `   • Add funds at ${chalk.cyan("https://openrouter.ai/credits")}\n` +
          `   • Or switch to a free model: ${chalk.cyan("bun index.ts config")}\n`
        )
    );
    return true;
  }

  // --- 401: Invalid / missing API key ---
  if (
    status === 401 ||
    message.includes("unauthorized") ||
    message.includes("api key") ||
    message.includes("invalid key") ||
    message.includes("authentication")
  ) {
    console.error(
      "\n" +
        chalk.red("✖  OpenRouter authentication failed.\n") +
        chalk.yellow("   Your API key is invalid or missing.\n") +
        chalk.dim(
          `   • Check ${chalk.cyan("OPENROUTER_API_KEY")} in your .env file.\n` +
          `   • Get a key at ${chalk.cyan("https://openrouter.ai/keys")}\n`
        )
    );
    return true;
  }

  // --- Generic API error (known shape, unknown status) ---
  console.error(
    "\n" +
      chalk.red("✖  OpenRouter API error.\n") +
      chalk.yellow(`   ${err.message ?? "An unexpected error occurred."}\n`) +
      chalk.dim(
        `   Status: ${status ?? "unknown"}\n` +
        `   If this persists, run ${chalk.cyan("bun index.ts config")} to switch models.\n`
      )
  );
  return true;
}
