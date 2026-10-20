import { AppText as Text } from "../../components/ui/AppText";

export function ManagedBySettingsFeedNote() {
  return (
    <Text className="px-2 text-sm text-foreground-muted">
      Your settings feed controls settings here. Change them in the feed, or stop tracking it in
      Settings → Environments.
    </Text>
  );
}
