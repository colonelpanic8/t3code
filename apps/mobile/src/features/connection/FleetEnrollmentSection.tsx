import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  decodeFleetEnrollment,
  type FleetEnrollment,
  type FleetEnrollmentEntry,
} from "@t3tools/shared/fleetEnrollment";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { AsyncResult } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { Fragment, type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import {
  failedFleetEntries,
  type FleetJoinOutcome,
  type FleetJoinOutcomes,
  isFleetEnrollmentEntryExpired,
} from "../../connection/fleet-enrollment";
import { connectFleetEnrollment } from "../../connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "../threads/RequestActionButton";
import { FleetEnrollmentKeyField } from "./FleetEnrollmentKeyField";
import { decryptFleetEnrollmentFile } from "./fleetEnrollmentKey";
import type { FleetEnrollmentUrl } from "./fleetEnrollmentLink";
import { downloadFleetEnrollmentFile, pickFleetEnrollmentFile } from "./fleetEnrollmentFile";

/**
 * A scanned or deep-linked fleet file to open, or why its link was rejected.
 * Each arrival is a new object, so the same link opens again after the user
 * cancels it.
 */
export type FleetFileRequest = { readonly link: Result.Result<FleetEnrollmentUrl, string> };

type FleetFileState =
  | { readonly step: "pick" }
  | { readonly step: "download"; readonly host: string }
  /** An encrypted file waiting for the key that opens it. */
  | { readonly step: "key"; readonly bytes: Uint8Array }
  /** Outcomes stay empty until the user joins, then hold each machine's latest attempt. */
  | {
      readonly step: "confirm";
      readonly enrollment: FleetEnrollment;
      readonly outcomes: FleetJoinOutcomes;
    };

const expiryFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const formatDate = (date: DateTime.Utc) => expiryFormatter.format(DateTime.toDateUtc(date));

const hostOf = (entry: FleetEnrollmentEntry) => new URL(entry.environment.httpBaseUrl).host;

function outcomeLabel(outcome: FleetJoinOutcome): string {
  switch (outcome.kind) {
    case "joined":
      return "Joined";
    case "already-connected":
      return "Already added";
    case "expired":
      return "Expired";
    case "failed":
      return outcome.message;
  }
}

/**
 * Imports an encrypted fleet enrollment, opened with this device's fleet
 * enrollment key, and pairs every machine in it once the user confirms.
 */
export function FleetEnrollmentSection(props: {
  readonly onDone: () => void;
  readonly request: FleetFileRequest | null;
}) {
  const [state, setState] = useState<FleetFileState>({ step: "pick" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const enroll = useAtomCommand(connectFleetEnrollment, { reportFailure: false });

  const show = (next: FleetFileState, nextError: string | null = null) => {
    if (!mounted.current) return;
    setState(next);
    setError(nextError);
  };

  const openEnrollment = async (bytes: Uint8Array) => {
    const decrypted = await Effect.runPromise(Effect.result(decryptFleetEnrollmentFile(bytes)));
    if (Result.isFailure(decrypted)) {
      switch (decrypted.failure.reason) {
        case "no-identity":
          show({ step: "key", bytes });
          break;
        case "not-a-recipient":
        case "storage":
          show({ step: "key", bytes }, decrypted.failure.message);
          break;
        default:
          show({ step: "pick" }, decrypted.failure.message);
      }
      return;
    }
    const decoded = decodeFleetEnrollment(decrypted.success);
    if (Result.isFailure(decoded)) {
      show({ step: "pick" }, decoded.failure.message);
      return;
    }
    const { environments } = decoded.success;
    const now = DateTime.nowUnsafe();
    if (environments.every((entry) => isFleetEnrollmentEntryExpired(entry, now))) {
      const lastExpiry = environments
        .map((entry) => entry.expiresAt)
        .reduce((latest, next) => DateTime.max(latest, next));
      show(
        { step: "pick" },
        `This fleet enrollment expired on ${formatDate(lastExpiry)}. Export a new one.`,
      );
    } else {
      show({ step: "confirm", enrollment: decoded.success, outcomes: new Map() });
    }
  };

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch {
      if (mounted.current) setError("Could not finish that action. Try again.");
    }
    if (mounted.current) setBusy(false);
  };

  const openFile = async (result: Result.Result<Uint8Array, string>) => {
    if (Result.isFailure(result)) show({ step: "pick" }, result.failure);
    else await openEnrollment(result.success);
  };

  const handleImport = () =>
    run(async () => {
      const result = await pickFleetEnrollmentFile();
      if (result !== null) await openFile(result);
    });

  const openRequest = useEffectEvent((request: FleetFileRequest) => {
    if (Result.isFailure(request.link)) {
      show({ step: "pick" }, request.link.failure);
      return;
    }
    const url = request.link.success;
    void run(async () => {
      show({ step: "download", host: new URL(url).host });
      try {
        await openFile(await downloadFleetEnrollmentFile(url));
      } catch (cause) {
        show({ step: "pick" });
        throw cause;
      }
    });
  });
  // A request that arrives mid-action waits for it, then replaces whatever
  // file is open.
  const handledRequest = useRef<FleetFileRequest | null>(null);
  useEffect(() => {
    const request = props.request;
    if (request === null || request === handledRequest.current || busy) return;
    handledRequest.current = request;
    openRequest(request);
  }, [busy, props.request]);

  const handleJoin = (
    enrollment: FleetEnrollment,
    outcomes: FleetJoinOutcomes,
    entries: ReadonlyArray<FleetEnrollmentEntry>,
  ) =>
    run(async () => {
      const result = await enroll(entries);
      if (!mounted.current) return;
      if (AsyncResult.isSuccess(result)) {
        const next = new Map([...outcomes, ...result.value]);
        void Haptics.notificationAsync(
          failedFleetEntries(enrollment.environments, next).length > 0
            ? Haptics.NotificationFeedbackType.Error
            : Haptics.NotificationFeedbackType.Success,
        );
        show({ step: "confirm", enrollment, outcomes: next });
      } else if (!isAtomCommandInterrupted(result)) {
        setError("Could not join the fleet. Try again.");
      }
    });

  const handleClear = () => show({ step: "pick" });

  const errorText = error ? (
    <Text accessibilityLiveRegion="polite" className="px-4 text-sm text-danger-foreground">
      {error}
    </Text>
  ) : null;

  switch (state.step) {
    case "pick":
    case "download":
      return (
        <View collapsable={false} className="gap-2">
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void handleImport()}
            className="min-h-13 flex-row items-center gap-3 rounded-[26px] border-continuous bg-grouped-card px-4 active:opacity-70"
          >
            <SymbolView
              name="doc.text"
              size={18}
              tintColorClassName="accent-icon"
              type="monochrome"
            />
            <View className="min-w-0 flex-1 py-3">
              <Text className="text-base text-foreground">Import fleet file</Text>
              <Text className="text-sm text-foreground-muted">
                {state.step === "download"
                  ? `Opening fleet file from ${state.host}…`
                  : "Join your fleet with an encrypted enrollment file."}
              </Text>
            </View>
          </Pressable>
          {errorText}
        </View>
      );
    case "key":
      return (
        <FleetFileCard title="Fleet enrollment key" onDismiss={handleClear} busy={busy}>
          <Text className="px-4 pt-4 text-sm leading-normal text-foreground-muted">
            This file is encrypted. Paste the fleet enrollment key from your backup to open it.
          </Text>
          {errorText}
          <FleetEnrollmentKeyField onImported={() => void run(() => openEnrollment(state.bytes))} />
        </FleetFileCard>
      );
    case "confirm": {
      const { enrollment, outcomes } = state;
      const attempted = outcomes.size > 0;
      const failed = failedFleetEntries(enrollment.environments, outcomes);
      const now = DateTime.nowUnsafe();
      const pending = enrollment.environments.filter(
        (entry) => !isFleetEnrollmentEntryExpired(entry, now),
      );
      const firstExpiry = (pending.length > 0 ? pending : enrollment.environments)
        .map((entry) => entry.expiresAt)
        .reduce((earliest, next) => DateTime.min(earliest, next));
      const action = !attempted
        ? {
            label: pending.length <= 1 ? "Join" : `Join ${pending.length} machines`,
            onPress: () => void handleJoin(enrollment, outcomes, enrollment.environments),
          }
        : failed.length > 0
          ? {
              label: failed.length === 1 ? "Retry failed machine" : `Retry ${failed.length} failed`,
              onPress: () => void handleJoin(enrollment, outcomes, failed),
            }
          : { label: "Done", onPress: props.onDone };
      return (
        <View collapsable={false} className="gap-2">
          <FleetFileCard
            title="Fleet enrollment"
            dismissLabel={attempted ? "Done" : "Cancel"}
            onDismiss={attempted ? props.onDone : handleClear}
            busy={busy}
          >
            {enrollment.environments.map((entry, index) => {
              const outcome =
                outcomes.get(entry.environment.environmentId) ??
                (isFleetEnrollmentEntryExpired(entry, now) ? { kind: "expired" as const } : null);
              return (
                <Fragment key={entry.environment.environmentId}>
                  {index > 0 ? <View className="ml-4 border-t border-border-subtle" /> : null}
                  <View className="gap-0.5 px-4 py-3">
                    <Text className="text-base text-foreground" numberOfLines={1}>
                      {entry.environment.label}
                    </Text>
                    <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                      {hostOf(entry)}
                    </Text>
                    {outcome === null ? null : (
                      <Text
                        accessibilityLiveRegion="polite"
                        className={
                          outcome.kind === "failed" || outcome.kind === "expired"
                            ? "text-sm text-danger-foreground"
                            : "text-sm text-foreground-muted"
                        }
                      >
                        {outcomeLabel(outcome)}
                      </Text>
                    )}
                  </View>
                </Fragment>
              );
            })}
            <View className="gap-3 border-t border-border-subtle p-4">
              <Text className="text-sm text-foreground-muted">
                Expires {formatDate(firstExpiry)}
              </Text>
              <RequestActionButton
                label={busy ? "Joining…" : action.label}
                disabled={busy}
                onPress={action.onPress}
              />
            </View>
          </FleetFileCard>
          {errorText ??
            (attempted ? null : (
              <Text className="px-4 text-sm leading-normal text-foreground-muted">
                Only join if you expected these machines.
              </Text>
            ))}
        </View>
      );
    }
  }
}

function FleetFileCard(props: {
  readonly title: string;
  readonly dismissLabel?: string;
  readonly onDismiss: () => void;
  readonly busy: boolean;
  readonly children: ReactNode;
}) {
  return (
    <View collapsable={false} className="gap-2">
      <View className="flex-row items-center justify-between px-4">
        <Text className="text-sm font-t3-medium text-foreground-muted">{props.title}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={props.onDismiss}
          disabled={props.busy}
          hitSlop={8}
        >
          <Text className="text-sm font-t3-medium text-foreground-muted">
            {props.dismissLabel ?? "Cancel"}
          </Text>
        </Pressable>
      </View>
      <View
        collapsable={false}
        className="overflow-hidden rounded-[26px] border-continuous bg-grouped-card"
      >
        {props.children}
      </View>
    </View>
  );
}
