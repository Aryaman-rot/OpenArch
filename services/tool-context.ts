export interface RepoToolContext {
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}

let activeRepoToolContext: RepoToolContext | undefined;

export function setRepoToolContext(context?: RepoToolContext): void {
  activeRepoToolContext = context;
}

export function getRepoToolContext(): RepoToolContext | undefined {
  return activeRepoToolContext;
}

export function listAvailableTools(tools: Record<string, { description?: string }>): string {
  const lines = Object.entries(tools)
    .filter(([name]) => name !== "list_available_tools")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, def]) => `  - **${name}**: ${def?.description ?? "No description"}`);

  return `Available tools:\n\n${lines.join("\n")}\n`;
}
