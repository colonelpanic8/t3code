import * as Layer from "effect/Layer";

import * as PullRequestCacheStore from "../connection/pull-request-cache-store";
import * as EnvironmentCacheStore from "../connection/environment-cache-store";
import * as UsageSummaryCacheStore from "../connection/usage-summary-cache-store";
import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";
import * as MobileStorage from "./mobile-storage";

const layerBase = Layer.merge(MobileDatabase.layer, MobileSecureStorage.layer);
const layerDependent = Layer.mergeAll(
  MobilePreferences.layer,
  MobileStorage.layer,
  EnvironmentCacheStore.layer,
  PullRequestCacheStore.layer,
  UsageSummaryCacheStore.layer,
).pipe(Layer.provide(layerBase));

export const layer = Layer.merge(layerBase, layerDependent);
