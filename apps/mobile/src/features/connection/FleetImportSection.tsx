import type { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { decodeFleetEnrollment, type FleetEnrollment } from "@t3tools/shared/fleetEnrollment";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { isFleetEnrollmentExpired } from "../../connection/fleet-enrollment";
import { connectFleetEnrollment } from "../../connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "../threads/RequestActionButton";
import { FleetEnrollmentKeyField } from "./FleetEnrollmentKeyField";
import { decryptFleetEnrollmentFile } from "./fleetEnrollmentKey";
import type { FleetEnrollmentUrl } from "./fleetEnrollmentLink";
import { downloadFleetFile, pickFleetImportFile } from "./fleetImportFile";

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
  | { readonly step: "confirm"; readonly enrollment: FleetEnrollment };

const expiryFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const formatExpiry = (enrollment: FleetEnrollment) =>
  expiryFormatter.format(DateTime.toDateUtc(enrollment.expiresAt));

function enrollmentFailureMessage(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "ConnectionBlockedError" &&
    "reason" in error &&
    error.reason === "authentication"
  ) {
    return "This fleet enrollment was revoked or has expired. Export a new one.";
  }
  return error instanceof Error ? error.message : "Could not join the fleet.";
}

/**
 * Imports an encrypted fleet enrollment, opened with this device's fleet
 * enrollment key, and pairs its machine once the user confirms it.
 */
export function FleetImportSection(props: {
  readonly onOpenSaved: (environmentId: EnvironmentId) => void;
  readonly onEnrolled: () => void;
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
    } else if (isFleetEnrollmentExpired(decoded.success, DateTime.nowUnsafe())) {
      show(
        { step: "pick" },
        `This fleet enrollment expired on ${formatExpiry(decoded.success)}. Export a new one.`,
      );
    } else {
      show({ step: "confirm", enrollment: decoded.success });
    }
  };

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch {
      if (mounted.current) setError("Could not finish that action. Try again.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const openFile = async (result: Result.Result<Uint8Array, string>) => {
    if (Result.isFailure(result)) show({ step: "pick" }, result.failure);
    else await openEnrollment(result.success);
  };

  const handleImport = () =>
    run(async () => {
      const result = await pickFleetImportFile();
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
        await openFile(await downloadFleetFile(url));
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

  const handleJoin = (enrollment: FleetEnrollment) =>
    run(async () => {
      const result = await enroll(enrollment);
      if (!mounted.current) return;
      if (AsyncResult.isSuccess(result)) {
        if (result.value === "enrolled") props.onEnrolled();
        else props.onOpenSaved(enrollment.anchor.environmentId);
      } else if (!isAtomCommandInterrupted(result)) {
        setError(enrollmentFailureMessage(squashAtomCommandFailure(result)));
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
        <FleetFileCard title="Fleet enrollment key" onCancel={handleClear} busy={busy}>
          <Text className="px-4 pt-4 text-sm leading-normal text-foreground-muted">
            This file is encrypted. Paste the fleet enrollment key from your backup to open it.
          </Text>
          {errorText}
          <FleetEnrollmentKeyField onImported={() => void run(() => openEnrollment(state.bytes))} />
        </FleetFileCard>
      );
    case "confirm": {
      const { anchor } = state.enrollment;
      return (
        <View collapsable={false} className="gap-2">
          <FleetFileCard title="Fleet enrollment" onCancel={handleClear} busy={busy}>
            <View className="gap-1 p-4">
              <Text className="text-base text-foreground">Join fleet via {anchor.label}</Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                {anchor.httpBaseUrl}
              </Text>
              <Text className="text-sm text-foreground-muted">
                Expires {formatExpiry(state.enrollment)}
              </Text>
            </View>
            <View className="px-4 pb-4">
              <RequestActionButton
                label={busy ? "Joining…" : "Join fleet"}
                disabled={busy}
                onPress={() => void handleJoin(state.enrollment)}
              />
            </View>
          </FleetFileCard>
          {errorText ?? (
            <Text className="px-4 text-sm leading-normal text-foreground-muted">
              Only join if you expected this machine.
            </Text>
          )}
        </View>
      );
    }
  }
}

function FleetFileCard(props: {
  readonly title: string;
  readonly onCancel: () => void;
  readonly busy: boolean;
  readonly children: ReactNode;
}) {
  return (
    <View collapsable={false} className="gap-2">
      <View className="flex-row items-center justify-between px-4">
        <Text className="text-sm font-t3-medium text-foreground-muted">{props.title}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={props.onCancel}
          disabled={props.busy}
          hitSlop={8}
        >
          <Text className="text-sm font-t3-medium text-foreground-muted">Cancel</Text>
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
