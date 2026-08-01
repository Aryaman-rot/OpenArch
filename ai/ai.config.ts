import { createOpenRouter } from "@openrouter/ai-sdk-provider";
export { handleAgentModelError } from "./ai-error.ts";

export function getAgentModel() {
    const provider = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

    const modelid = process.env.MODEL || process.env.OPENROUTER_DEFAULT_MODEL || "openrouter/free";

    return provider(modelid);
}
