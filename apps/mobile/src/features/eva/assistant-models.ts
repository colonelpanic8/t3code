import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { stop } from "./assistant-outcome";

export const ModelSelectionPlan = Schema.Struct({
  instanceId: Schema.String,
  model: Schema.String,
  options: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: Schema.String, value: Schema.Union([Schema.String, Schema.Boolean]) }),
    ),
  ),
});
export type ModelSelectionPlan = typeof ModelSelectionPlan.Type;

function usable(provider: ServerProvider): boolean {
  return provider.enabled && provider.status !== "disabled";
}

function defaultModel(provider: ServerProvider): string | null {
  return (provider.models.find((model) => model.isDefault) ?? provider.models[0])?.slug ?? null;
}

/** The request's provider and model, else the project's default, else the first ready provider's. */
export function resolveModelSelection(input: {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly projectDefault: ModelSelection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
}): { readonly instanceId: string; readonly model: string } {
  if (input.provider !== undefined) {
    const provider = input.providers.find((candidate) => candidate.instanceId === input.provider);
    if (!provider || !usable(provider)) {
      throw stop(
        "rejected",
        "unknown_provider",
        `Provider ${input.provider} is not enabled on this environment.`,
      );
    }
    if (provider.status === "error") {
      throw stop(
        "rejected",
        "provider_unavailable",
        `Provider ${input.provider} reports an error.`,
      );
    }
    const model = input.model ?? defaultModel(provider);
    if (
      model === null ||
      (input.model !== undefined && !provider.models.some((m) => m.slug === model))
    ) {
      throw stop(
        "rejected",
        "unknown_model",
        `Model ${input.model} is not offered by ${input.provider}.`,
      );
    }
    return { instanceId: provider.instanceId, model };
  }
  if (input.projectDefault) {
    return { instanceId: input.projectDefault.instanceId, model: input.projectDefault.model };
  }
  const ready = input.providers.find((provider) => usable(provider) && provider.status === "ready");
  const model = ready ? defaultModel(ready) : null;
  if (!ready || model === null) {
    throw stop(
      "needs_configuration",
      "provider_required",
      "No provider is ready on this environment.",
    );
  }
  return { instanceId: ready.instanceId, model };
}

export function findProviderModel(
  providers: ReadonlyArray<ServerProvider>,
  selection: { readonly instanceId: string; readonly model: string },
): ServerProviderModel | null {
  return (
    providers
      .find((provider) => provider.instanceId === selection.instanceId)
      ?.models.find((model) => model.slug === selection.model) ?? null
  );
}

function descriptors(model: ServerProviderModel | null): ReadonlyArray<ProviderOptionDescriptor> {
  return model?.capabilities?.optionDescriptors ?? [];
}

function describeDescriptor(descriptor: ProviderOptionDescriptor): string {
  if (descriptor.type === "boolean") return `${descriptor.id}=true|false`;
  const fallback = descriptor.options.find((option) => option.isDefault)?.id;
  const current = descriptor.currentValue ?? fallback;
  const values = descriptor.options.map((option) => option.id).join("|");
  return current === undefined
    ? `${descriptor.id}=${values}`
    : `${descriptor.id}=${values} (default ${current})`;
}

/** The model's options in the id=value form `modelOptions` takes, for the models catalog. */
export function describeModelOptions(model: ServerProviderModel | null): string {
  return descriptors(model).map(describeDescriptor).join("; ");
}

const normalize = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, "");

const BOOLEAN_WORDS = new Map<string, boolean>([
  ["true", true],
  ["yes", true],
  ["on", true],
  ["false", false],
  ["no", false],
  ["off", false],
]);

/** Parses `id=value,id=value` against the model's option descriptors; ids and labels both match. */
export function parseModelOptions(
  text: string,
  model: ServerProviderModel | null,
): ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> {
  const available = descriptors(model);
  const invalid = (message: string) => {
    const listed = describeModelOptions(model);
    return stop(
      "rejected",
      "invalid_model_option",
      listed === "" ? `${message} This model takes no options.` : `${message} Options: ${listed}.`,
    );
  };
  const selections = new Map<string, string | boolean>();
  for (const pair of text.split(",")) {
    if (pair.trim() === "") continue;
    const separator = pair.search(/[=:]/);
    if (separator <= 0) throw invalid(`"${pair.trim()}" is not id=value.`);
    const key = normalize(pair.slice(0, separator));
    const raw = pair.slice(separator + 1).trim();
    const descriptor = available.find(
      (candidate) => normalize(candidate.id) === key || normalize(candidate.label) === key,
    );
    if (!descriptor) throw invalid(`The model has no option ${pair.slice(0, separator).trim()}.`);
    if (descriptor.type === "boolean") {
      const value = BOOLEAN_WORDS.get(raw.toLowerCase());
      if (value === undefined) throw invalid(`${descriptor.id} takes true or false.`);
      selections.set(descriptor.id, value);
      continue;
    }
    const choice = descriptor.options.find(
      (option) =>
        normalize(option.id) === normalize(raw) || normalize(option.label) === normalize(raw),
    );
    if (!choice) throw invalid(`${descriptor.id} has no value ${raw}.`);
    selections.set(descriptor.id, choice.id);
  }
  return Array.from(selections, ([id, value]) => ({ id, value }));
}
