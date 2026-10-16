import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { useEffect, useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { CopyTextButton } from "../../components/CopyTextButton";
import { SettingsSection } from "../settings/components/SettingsSection";
import { FleetEnrollmentKeyField } from "./FleetEnrollmentKeyField";
import {
  type AgeRecipient,
  loadEnrollmentIdentity,
  removeEnrollmentIdentity,
} from "./fleetEnrollmentKey";

/**
 * Settings for the age identity that opens encrypted fleet enrollment files.
 * Only its public recipient is ever shown, for adding to the file's recipients.
 */
export function FleetEnrollmentKeySettings() {
  // undefined while loading; null when no key is stored.
  const [recipient, setRecipient] = useState<AgeRecipient | null | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void Effect.runPromise(Effect.result(loadEnrollmentIdentity())).then((result) => {
      if (!active) return;
      if (Result.isSuccess(result)) {
        setRecipient(Option.getOrNull(Option.map(result.success, (key) => key.recipient)));
      } else {
        setLoadFailed(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const confirmRemove = () =>
    showConfirmDialog({
      title: "Remove fleet enrollment key?",
      message:
        "This device can no longer open fleet enrollment files until you import the key again. Environments you already added stay connected.",
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => {
        void Effect.runPromise(Effect.result(removeEnrollmentIdentity())).then((result) => {
          if (Result.isSuccess(result)) setRecipient(null);
          else Alert.alert("Could not remove the key", result.failure.message);
        });
      },
    });

  if (recipient === undefined && !loadFailed) return null;

  return (
    <View className="mt-5 gap-3">
      <SettingsSection title="Fleet enrollment key">
        {recipient ? (
          <>
            <View className="flex-row items-center gap-3 p-4">
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-base text-foreground">Public recipient</Text>
                <Text
                  selectable
                  className="font-mono text-xs text-foreground-muted"
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {recipient}
                </Text>
              </View>
              <CopyTextButton accessibilityLabel="Copy public recipient" text={recipient} />
            </View>
            <View className="ml-4 border-t border-border-subtle" />
            <Pressable
              accessibilityRole="button"
              onPress={confirmRemove}
              className="p-4 active:opacity-70"
            >
              <Text className="text-base text-danger-foreground">Remove key</Text>
            </Pressable>
          </>
        ) : (
          <FleetEnrollmentKeyField
            onImported={(imported) => {
              setLoadFailed(false);
              setRecipient(imported);
            }}
          />
        )}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {loadFailed
          ? "The stored key could not be read. Import it again from your backup."
          : "Opens encrypted fleet files. Paste the age identity from your backup; it stays on this device and is not included in device backups."}
      </Text>
    </View>
  );
}
