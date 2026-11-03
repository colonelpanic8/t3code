import type { UsageProviderKind } from "@t3tools/contracts";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { PROVIDER_PRESENTATION } from "./usageProviders";

/** Brand mark for the harness a row belongs to. */
export function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const presentation = PROVIDER_PRESENTATION[provider];
  return (
    <ProviderInstanceIcon
      driverKind={presentation.driverKind}
      displayName={presentation.label}
      iconClassName={className}
    />
  );
}
