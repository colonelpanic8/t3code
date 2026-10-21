import type { PromptLinkRepository } from "@t3tools/shared/promptLinks";

export const PROMPT_LINK_PARAM_KEYS = ["prompt", "repo", "pr", "provider", "model"] as const;

type RouteParams = Readonly<Record<string, unknown>> | undefined;

export function promptLinkSearchFromParams(
  params: RouteParams,
  keys: ReadonlyArray<string> = PROMPT_LINK_PARAM_KEYS,
): string | null {
  const search = new URLSearchParams();
  for (const key of keys) {
    const raw = params?.[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string") search.set(key, value);
  }
  return search.size > 0 ? search.toString() : null;
}

export function clearedPromptLinkParams(keys: ReadonlyArray<string> = PROMPT_LINK_PARAM_KEYS) {
  return Object.fromEntries(keys.map((key) => [key, undefined]));
}

export type LinkedPromptSendBlock = "disabled" | "reopened" | "hidden-characters";

export type LinkedPromptDelivery =
  | { readonly kind: "send" }
  | { readonly kind: "draft"; readonly sendBlocked: LinkedPromptSendBlock | null };

export function promptLinkRequestsSend(search: string): boolean {
  const flag = new URLSearchParams(search).get("send")?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

/**
 * A link may only send when the user opted in. A replayed launch or a prompt
 * that needed hidden characters stripped is drafted for review instead.
 */
export function linkedThreadPromptDelivery(input: {
  readonly sendRequested: boolean;
  readonly sendEnabled: boolean;
  readonly launchedFromHistory: boolean;
  readonly hiddenCharacters: number;
}): LinkedPromptDelivery {
  if (!input.sendRequested) return { kind: "draft", sendBlocked: null };
  if (!input.sendEnabled) return { kind: "draft", sendBlocked: "disabled" };
  if (input.launchedFromHistory) return { kind: "draft", sendBlocked: "reopened" };
  if (input.hiddenCharacters > 0) return { kind: "draft", sendBlocked: "hidden-characters" };
  return { kind: "send" };
}

export function promptLinkNotice(input: {
  readonly hiddenCharacters: number;
  readonly modelUnavailable?: boolean;
  readonly pullRequestUnavailable?: number | null;
  readonly sendBlocked?: LinkedPromptSendBlock | null;
}): string {
  return [
    input.hiddenCharacters > 0
      ? "This prompt had hidden characters, it may be malicious. They were removed. Read it before you send."
      : "This prompt came from a link. Read it before you send.",
    input.sendBlocked === "disabled"
      ? "The link asked to send it, but sending from links is off in Settings > Thread behavior."
      : null,
    input.sendBlocked === "reopened"
      ? "The link was reopened from recent apps, so it was not sent again."
      : null,
    input.modelUnavailable
      ? "The requested model is not available, so your default is used."
      : null,
    input.pullRequestUnavailable != null
      ? `Pull request #${input.pullRequestUnavailable} could not be loaded, so this task starts from your default branch.`
      : null,
  ]
    .filter((line) => line !== null)
    .join("\n\n");
}

export function linkedThreadDraftAction(currentText: string, prompt: string) {
  if (currentText.trim().length === 0) return "fill" as const;
  return currentText === prompt ? ("keep" as const) : ("ask" as const);
}

export function promptLinkScratchEnvironmentId<Id extends string>(
  environmentIdsMostRecentFirst: ReadonlyArray<Id>,
  scratchEnvironmentIds: ReadonlyArray<Id>,
): Id | null {
  return (
    environmentIdsMostRecentFirst.find((id) => scratchEnvironmentIds.includes(id)) ??
    scratchEnvironmentIds[0] ??
    null
  );
}

export function latestThreadEnvironmentIds<Id extends string>(
  threads: ReadonlyArray<{ readonly environmentId: Id; readonly updatedAt: string }>,
): ReadonlyArray<Id> {
  const latest = new Map<Id, string>();
  for (const thread of threads) {
    if (thread.updatedAt > (latest.get(thread.environmentId) ?? "")) {
      latest.set(thread.environmentId, thread.updatedAt);
    }
  }
  return Array.from(latest.keys()).sort((left, right) =>
    (latest.get(right) ?? "").localeCompare(latest.get(left) ?? ""),
  );
}

export const promptLinkRepositoryName = (repository: PromptLinkRepository) =>
  `${repository.owner}/${repository.name}`;
