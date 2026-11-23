import { requireOptionalNativeModule } from "expo";

const T3AndroidIntents = requireOptionalNativeModule<{
  isLaunchedFromHistory(): boolean;
}>("T3AndroidIntents");

/** True when Android reopened the app from recents, replaying its original launch link. */
export function isLaunchedFromHistory(): boolean {
  return T3AndroidIntents?.isLaunchedFromHistory() ?? false;
}
