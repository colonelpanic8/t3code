import { useAtomValue } from "@effect/atom-react";
import type { PendingFleetMember } from "@t3tools/client-runtime/connection";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { pendingFleetJoinsAtom, retryPendingFleetMembers } from "../../connection/fleet";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionStatusDot } from "./ConnectionStatusDot";

const STATUS_TEXT = {
  "not-joined": "Not joined",
  joining: "Joining",
  failed: "Could not join",
} satisfies Record<PendingFleetMember["status"], string>;

export function PendingFleetMemberRows() {
  const pending = useAtomValue(pendingFleetJoinsAtom);
  const retry = useAtomCommand(retryPendingFleetMembers, "fleet retry");
  if (pending.length === 0) return null;

  return (
    <View collapsable={false} className="mt-5 gap-3">
      <View className="flex-row items-center justify-between px-1">
        <Text className="text-sm font-t3-bold uppercase text-foreground-muted">Fleet</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry joining pending fleet machines"
          disabled={pending.some((member) => member.status === "joining")}
          onPress={() => {
            void retry(undefined);
          }}
          className="rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
        >
          <Text className="text-xs font-t3-bold text-foreground">Retry all</Text>
        </Pressable>
      </View>
      <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
        {pending.map((member) => (
          <View key={member.environmentId} className="flex-row items-center gap-3 px-4 py-3.5">
            <View className="flex-1 gap-0.5">
              <View className="flex-row items-center gap-1.5">
                <ConnectionStatusDot
                  state={
                    member.status === "joining"
                      ? "connecting"
                      : member.status === "failed"
                        ? "error"
                        : "available"
                  }
                  pulse={false}
                  size={8}
                />
                <Text
                  className="min-w-0 flex-shrink text-base font-t3-bold leading-snug text-foreground"
                  numberOfLines={1}
                >
                  {member.label}
                </Text>
              </View>
              <Text
                className={cn(
                  "text-xs",
                  member.status === "failed" ? "text-danger-foreground" : "text-foreground-muted",
                )}
              >
                {STATUS_TEXT[member.status]}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
