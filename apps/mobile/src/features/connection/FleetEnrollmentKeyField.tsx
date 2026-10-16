import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { RequestActionButton } from "../threads/RequestActionButton";
import { type AgeRecipient, importEnrollmentIdentity } from "./fleetEnrollmentKey";

/**
 * Takes the fleet enrollment identity from the user's backup. The field is
 * masked, and the pasted text is never shown back, even in an error.
 */
export function FleetEnrollmentKeyField(props: {
  readonly onImported: (recipient: AgeRecipient) => void;
}) {
  const [identity, setIdentity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const save = async () => {
    if (saving || identity.trim().length === 0) return;
    setSaving(true);
    const result = await Effect.runPromise(
      Effect.result(importEnrollmentIdentity(Redacted.make(identity))),
    );
    if (!mounted.current) return;
    setSaving(false);
    if (Result.isFailure(result)) {
      setError(result.failure.message);
      return;
    }
    setIdentity("");
    setError(null);
    props.onImported(result.success.recipient);
  };

  return (
    <View className="gap-3 p-4">
      <TextInput
        accessibilityLabel="Fleet enrollment key"
        placeholder="AGE-SECRET-KEY-1…"
        value={identity}
        onChangeText={(value) => {
          setIdentity(value);
          setError(null);
        }}
        editable={!saving}
        secureTextEntry
        autoCorrect={false}
        autoCapitalize="none"
        autoComplete="off"
        textContentType="none"
        importantForAutofill="no"
        spellCheck={false}
        returnKeyType="done"
        onSubmitEditing={() => void save()}
      />
      {error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
      <RequestActionButton
        label="Import key"
        disabled={saving || identity.trim().length === 0}
        onPress={() => void save()}
      />
    </View>
  );
}
