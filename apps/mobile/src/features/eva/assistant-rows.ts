import type { ServerProvider } from "@t3tools/contracts";

const MAX_TEXT_LENGTH = 1000;
const ELLIPSIS = "…";

export interface AssistantMessageRow {
  readonly id: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly role: string;
  readonly createdAt: string | null;
  readonly text: string;
}

export interface AssistantModelRow {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly provider: string;
  readonly providerLabel: string;
  readonly status: string;
  readonly model: string;
  readonly modelLabel: string;
  readonly isDefault: number;
  readonly note: string;
}

interface ThreadMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
}

function clipText(text: string): string {
  const trimmed = text.trim();
  const chars = Array.from(trimmed);
  return chars.length <= MAX_TEXT_LENGTH
    ? trimmed
    : `${chars.slice(0, MAX_TEXT_LENGTH - ELLIPSIS.length).join("")}${ELLIPSIS}`;
}

/** The newest user and assistant messages of one thread, most recent first. */
export function assistantMessageRows(input: {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly messages: ReadonlyArray<ThreadMessage>;
  readonly limit: number;
}): ReadonlyArray<AssistantMessageRow> {
  return input.messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") && message.text.trim() !== "",
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, input.limit)
    .map((message) => ({
      id: message.id,
      environmentId: input.environmentId,
      environmentName: input.environmentName,
      threadId: input.threadId,
      threadTitle: input.threadTitle,
      role: message.role,
      createdAt: message.createdAt,
      text: clipText(message.text),
    }));
}

export function assistantMessageNoticeRow(input: {
  readonly environmentId: string | null;
  readonly threadId: string;
  readonly text: string;
}): AssistantMessageRow {
  return {
    id: "notice",
    environmentId: input.environmentId ?? "",
    environmentName: "",
    threadId: input.threadId,
    threadTitle: "",
    role: "notice",
    createdAt: null,
    text: input.text,
  };
}

/**
 * One row per selectable model. A provider with nothing selectable is one row
 * with an empty model and the reason in note.
 */
export function assistantModelRows(input: {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly provider: string | null;
  readonly q: string | null;
}): ReadonlyArray<AssistantModelRow> {
  const query = input.q?.toLowerCase() ?? null;
  const rows: AssistantModelRow[] = [];
  for (const provider of input.providers) {
    if (input.provider !== null && provider.instanceId !== input.provider) continue;
    const base = {
      environmentId: input.environmentId,
      environmentName: input.environmentName,
      provider: provider.instanceId,
      providerLabel: provider.displayName ?? provider.driver,
      status: provider.enabled ? provider.status : "disabled",
    };
    if (!provider.enabled || provider.models.length === 0) {
      rows.push({
        ...base,
        model: "",
        modelLabel: "",
        isDefault: 0,
        note: provider.enabled ? "This provider offers no models." : "This provider is turned off.",
      });
      continue;
    }
    for (const model of provider.models) {
      rows.push({
        ...base,
        model: model.slug,
        modelLabel: model.name,
        isDefault: model.isDefault ? 1 : 0,
        note: provider.message ?? "",
      });
    }
  }
  if (query === null) return rows;
  return rows.filter((row) =>
    [row.provider, row.providerLabel, row.model, row.modelLabel].some((value) =>
      value.toLowerCase().includes(query),
    ),
  );
}

export function assistantModelNoticeRow(environmentId: string, note: string): AssistantModelRow {
  return {
    environmentId,
    environmentName: "",
    provider: "",
    providerLabel: "",
    status: "notice",
    model: "",
    modelLabel: "",
    isDefault: 0,
    note,
  };
}
