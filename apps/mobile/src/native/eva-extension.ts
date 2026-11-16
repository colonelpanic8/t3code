import { requireOptionalNativeModule } from "expo";

interface T3EvaExtensionModule {
  publishAssistantCatalog(json: string): void;
  resolveAssistantQuery(requestId: string, json: string): void;
  /** Resolves with the stored request JSON once the journal committed the update. */
  reportAssistantRequest(key: string, json: string): Promise<string | null>;
  finishAssistantRequest(key: string): void;
  isAssistantAutomationAllowed(): boolean;
  setAssistantAutomationAllowed(allowed: boolean): void;
}

/** Android only; null elsewhere and in builds without the module. */
export const evaExtension = requireOptionalNativeModule<T3EvaExtensionModule>("T3EvaExtension");
