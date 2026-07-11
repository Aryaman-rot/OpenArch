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
