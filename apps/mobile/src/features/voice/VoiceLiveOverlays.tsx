import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { GlassSurface } from "../../components/GlassSurface";
import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { useThemeColor } from "../../lib/useThemeColor";
import { useVoiceLiveState, useVoiceLiveTargets, type VoiceLiveTarget } from "./useVoiceLive";
import { startVoiceCall, stopVoiceCall, toggleVoiceMute } from "./voiceLiveSession.native";
import { voiceLiveStoreActions, type VoiceLiveStatus } from "./voiceLiveStore";

/**
 * App-root Live Voice surfaces: the environment picker sheet and the active
 * call banner. Mounted once in App.tsx as a sibling of OverlayPortalHost —
 * deliberately not an RN Modal (a Modal is a separate native window that
 * steals focus; see components/OverlayPortal.tsx) — so the banner persists
 * across all navigation.
 */
export function VoiceLiveSurface() {
  const state = useVoiceLiveState();
  const showBanner = state.status !== "idle" || state.error !== null;
  if (!state.pickerOpen && !showBanner) {
    return null;
  }
  return (
    <View pointerEvents="box-none" className="absolute inset-0">
      {showBanner ? <VoiceLiveBanner /> : null}
      {state.pickerOpen ? <VoiceLivePicker /> : null}
    </View>
  );
}

const STATUS_TONES: Record<Exclude<VoiceLiveStatus, "idle">, StatusTone> = {
  "requesting-permission": {
    label: "Starting",
    pillClassName: "bg-amber-500/12 dark:bg-amber-500/16",
    textClassName: "text-amber-700 dark:text-amber-300",
  },
  connecting: {
    label: "Connecting",
    pillClassName: "bg-sky-500/12 dark:bg-sky-500/16",
    textClassName: "text-sky-700 dark:text-sky-300",
  },
  active: {
    label: "Live",
    pillClassName: "bg-emerald-500/12 dark:bg-emerald-500/16",
    textClassName: "text-emerald-700 dark:text-emerald-300",
  },
  ending: {
    label: "Ending",
    pillClassName: "bg-subtle",
    textClassName: "text-foreground-muted",
  },
};

const ERROR_TONE: StatusTone = {
  label: "Error",
  pillClassName: "bg-rose-500/12 dark:bg-rose-500/16",
  textClassName: "text-rose-700 dark:text-rose-300",
};

function VoiceLiveBanner() {
  const state = useVoiceLiveState();
  const insets = useSafeAreaInsets();
  const mutedColor = useThemeColor("--color-foreground-muted");

  const bottomOffset = insets.bottom + 12;

  if (state.status === "idle") {
    if (state.error === null) {
      return null;
    }
    return (
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0"
        style={{ bottom: bottomOffset, paddingHorizontal: 12 }}
      >
        <GlassSurface style={{ borderRadius: 24 }}>
          <View className="flex-row items-center gap-3 px-4 py-3">
            <StatusPill {...ERROR_TONE} size="compact" />
            <Text className="flex-1 text-sm text-foreground" numberOfLines={2}>
              {state.error}
            </Text>
            <Pressable
              accessibilityLabel="Dismiss Live Voice error"
              accessibilityRole="button"
              hitSlop={10}
              onPress={voiceLiveStoreActions.dismissError}
            >
              <SymbolView name="xmark" size={15} tintColor={mutedColor} type="monochrome" />
            </Pressable>
          </View>
        </GlassSurface>
      </View>
    );
  }

  const tone = STATUS_TONES[state.status];
  const lastTranscript = state.transcripts[state.transcripts.length - 1] ?? null;

  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0"
      style={{ bottom: bottomOffset, paddingHorizontal: 12 }}
    >
      <GlassSurface style={{ borderRadius: 24 }}>
        <View className="px-4 py-3">
          <Pressable
            accessibilityLabel={
              state.expanded ? "Collapse Live Voice transcript" : "Expand Live Voice transcript"
            }
            accessibilityRole="button"
            onPress={() => voiceLiveStoreActions.setExpanded(!state.expanded)}
            className="gap-1"
          >
            <View className="flex-row items-center gap-2.5">
              <StatusPill {...tone} size="compact" />
              <Text
                className="flex-1 text-sm font-t3-medium text-foreground"
                numberOfLines={1}
              >
                {state.environmentLabel ?? "Live Voice"}
              </Text>
            </View>
            {state.expanded ? null : lastTranscript ? (
              <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                {lastTranscript.role === "user" ? "You: " : ""}
                {lastTranscript.text}
              </Text>
            ) : (
              <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                {state.status === "active" ? "Listening…" : "Setting up the call…"}
              </Text>
            )}
          </Pressable>

          {state.expanded ? (
            <ScrollView style={{ maxHeight: 280 }} className="mt-2">
              {state.transcripts.length === 0 ? (
                <Text className="text-sm text-foreground-muted">No transcript yet.</Text>
              ) : (
                state.transcripts.map((line) => (
                  <View key={line.id} className="mb-1.5">
                    <Text className="text-2xs font-t3-bold uppercase tracking-wide text-foreground-muted">
                      {line.role === "user" ? "You" : "Agent"}
                    </Text>
                    <Text className="text-sm text-foreground" selectable>
                      {line.text}
                    </Text>
                  </View>
                ))
              )}
            </ScrollView>
          ) : null}

          <View className="mt-2.5 flex-row items-center justify-end gap-2.5">
            <ControlPill
              accessibilityLabel={state.muted ? "Unmute microphone" : "Mute microphone"}
              icon={state.muted ? "mic.slash.fill" : "mic.fill"}
              onPress={toggleVoiceMute}
            />
            <ControlPill
              accessibilityLabel="End Live Voice call"
              icon="stop.fill"
              onPress={stopVoiceCall}
              variant="danger"
            />
          </View>
        </View>
      </GlassSurface>
    </View>
  );
}

function VoiceLivePicker() {
  const targets = useVoiceLiveTargets();
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-foreground-muted");

  const handleSelect = (target: VoiceLiveTarget) => {
    voiceLiveStoreActions.closePicker();
    void startVoiceCall(target);
  };

  return (
    <View className="absolute inset-0">
      <Pressable
        accessibilityLabel="Close Live Voice picker"
        className="absolute inset-0 bg-black/40"
        onPress={voiceLiveStoreActions.closePicker}
      />
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0"
        style={{ bottom: insets.bottom + 12, paddingHorizontal: 12 }}
      >
        <GlassSurface style={{ borderRadius: 28 }}>
          <View className="px-5 py-4">
            <View className="flex-row items-center gap-2.5">
              <SymbolView name="waveform" size={18} tintColor={iconColor} type="monochrome" />
              <Text className="flex-1 text-base font-t3-bold text-foreground">Live Voice</Text>
              <Pressable
                accessibilityLabel="Close"
                accessibilityRole="button"
                hitSlop={10}
                onPress={voiceLiveStoreActions.closePicker}
              >
                <SymbolView name="xmark" size={15} tintColor={mutedColor} type="monochrome" />
              </Pressable>
            </View>
            <Text className="mt-1 text-sm text-foreground-muted">
              Talk to an agent that can see and act on all of your connected environments. Pick
              the environment that hosts the call.
            </Text>
            <View className="mt-3 gap-2">
              {targets.length === 0 ? (
                <Text className="text-sm text-foreground-muted">
                  No connected environment supports Live Voice. Update your T3 Code servers to
                  enable it.
                </Text>
              ) : (
                targets.map((target) => (
                  <Pressable
                    key={target.environmentId}
                    accessibilityLabel={`Start Live Voice on ${target.label}`}
                    accessibilityRole="button"
                    onPress={() => handleSelect(target)}
                    className="min-h-12 flex-row items-center gap-3 rounded-2xl bg-subtle px-4 py-3"
                  >
                    <SymbolView name="server.rack" size={16} tintColor={iconColor} type="monochrome" />
                    <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
                      {target.label}
                    </Text>
                    <SymbolView
                      name="chevron.right"
                      size={14}
                      tintColor={mutedColor}
                      type="monochrome"
                    />
                  </Pressable>
                ))
              )}
            </View>
          </View>
        </GlassSurface>
      </View>
    </View>
  );
}
