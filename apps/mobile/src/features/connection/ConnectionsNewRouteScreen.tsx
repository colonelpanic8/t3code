import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAuth } from "@clerk/expo";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import type { EnvironmentId, ServerFleetEnvironment } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { AppText as Text, AppTextInput, type AppTextInputProps } from "../../components/ui/AppText";
import { FrostedCutout } from "../../components/ui/FrostedCutout";
import { buildPairingUrl, extractPairingUrlFromQrPayload, parsePairingUrl } from "./pairing";
import {
  setPendingConnectionError,
  useRemoteConnections,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { SymbolView } from "../../components/ui/AppSymbol";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { CloudEnvironmentRows } from "./CloudEnvironmentRows";
import { FleetImportSection } from "./FleetImportSection";
import { splitEnvironmentSections } from "./environmentSections";

type ConnectionsNewRouteParams = {
  readonly mode?: string;
  readonly pairingUrl?: string;
  readonly autoConnect?: string;
  readonly routeFor?: EnvironmentId;
};

export function ConnectionsNewRouteScreen({
  route,
}: StaticScreenProps<ConnectionsNewRouteParams | undefined>) {
  const {
    connectionPairingUrl,
    onChangeConnectionPairingUrl,
    onConnectPress,
    pairingConnectionError,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const routeName = useRoute().name;
  const params = route.params ?? {};
  // Deep-link prefill exists for development automation only. A production
  // link must not arrive with attacker-chosen host and token already filled.
  const routePairingUrl = __DEV__ ? (params.pairingUrl?.trim() ?? "") : "";
  const shouldAutoConnect =
    __DEV__ &&
    routePairingUrl.length > 0 &&
    (params.autoConnect === "1" || params.autoConnect === "true");
  const insets = useSafeAreaInsets();
  const [hostInput, setHostInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const screenFocused = useIsFocused();
  const [scannerLocked, setScannerLocked] = useState(false);
  // A good scan parks the camera so it can't re-read the code over later edits.
  const [scanComplete, setScanComplete] = useState(false);
  const attemptedAutoConnectRef = useRef<string | null>(null);
  // An imported fleet machine the user chose. Pairing must then reach that
  // machine, so any manual edit of the address or a scan drops the choice.
  const [importedEnvironmentId, setImportedEnvironmentId] = useState<EnvironmentId | null>(null);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const savedEnvironmentIds = new Set(Object.keys(savedConnectionsById) as EnvironmentId[]);

  const headerIconColor = useUniwindTheme()["--color-icon"];

  const connectDisabled = isSubmitting || hostInput.trim().length === 0;

  useEffect(() => {
    const { host, code } = parsePairingUrl(connectionPairingUrl);
    setHostInput(host);
    setCodeInput(code);
  }, [connectionPairingUrl]);

  useEffect(() => {
    if (routePairingUrl.length === 0) {
      return;
    }

    const { host, code } = parsePairingUrl(routePairingUrl);
    setHostInput(host);
    setCodeInput(code);
  }, [routePairingUrl]);

  useEffect(() => {
    if (pairingConnectionError) {
      setIsSubmitting(false);
    }
  }, [pairingConnectionError]);

  const handleHostChange = (value: string) => {
    setHostInput(value);
    setImportedEnvironmentId(null);
    setPendingConnectionError(null);
  };

  // The code is cleared so a code meant for another machine is never sent to
  // the imported address.
  const handleImportedSelect = (environment: ServerFleetEnvironment) => {
    setImportedEnvironmentId(environment.environmentId);
    setHostInput(environment.httpBaseUrl);
    setCodeInput("");
    setScanComplete(true);
    setPendingConnectionError(null);
  };

  const handleImportedClear = () => {
    if (importedEnvironmentId !== null) {
      setHostInput("");
      setCodeInput("");
    }
    setImportedEnvironmentId(null);
    setPendingConnectionError(null);
  };

  const openSavedEnvironment = (environmentId: EnvironmentId) => {
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsEnvironmentDetail", params: { environmentId } },
    });
  };

  const handleCodeChange = (value: string) => {
    setCodeInput(value);
    setPendingConnectionError(null);
  };

  useEffect(() => () => setPendingConnectionError(null), []);

  const handleScanPress = async () => {
    const permission = await requestCameraPermission();
    if (permission.granted) {
      setScanComplete(false);
      return;
    }
    if (permission.canAskAgain) return;
    Dialog.alert(
      "Camera access needed",
      "Camera access was denied for this app. Open Settings to enable it.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  };

  const handleQrScan = ({ data }: { readonly data: string }) => {
    if (scannerLocked) {
      return;
    }

    setScannerLocked(true);

    try {
      const pairingUrl = extractPairingUrlFromQrPayload(data);
      const { host, code } = parsePairingUrl(pairingUrl);
      setHostInput(host);
      setCodeInput(code);
      setImportedEnvironmentId(null);
      onChangeConnectionPairingUrl(pairingUrl);
      setScanComplete(true);
      setScannerLocked(false);
    } catch (error) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Dialog.alert(
        "Invalid QR code",
        error instanceof Error ? error.message : "Scanned QR code was not recognized.",
      );
      setTimeout(() => {
        setScannerLocked(false);
      }, 600);
    }
  };

  const connectAndClose = async (
    pairingUrl: string,
    expectedEnvironmentId: EnvironmentId | undefined,
  ) => {
    setIsSubmitting(true);
    onChangeConnectionPairingUrl(pairingUrl);
    const result = await onConnectPress(pairingUrl, expectedEnvironmentId);
    setIsSubmitting(false);
    void Haptics.notificationAsync(
      AsyncResult.isSuccess(result)
        ? Haptics.NotificationFeedbackType.Success
        : Haptics.NotificationFeedbackType.Error,
    );
    if (AsyncResult.isSuccess(result)) {
      // Return to whatever opened the sheet. Replacing it with Home would
      // nest Home inside any sheet still below it.
      if (!navigation.canGoBack()) {
        navigation.dispatch(StackActions.replace("Home"));
      } else {
        navigation.goBack();
      }
    }
  };

  const handleSubmit = async () => {
    if (importedEnvironmentId !== null && savedEnvironmentIds.has(importedEnvironmentId)) {
      setPendingConnectionError("That machine is already saved.");
      return;
    }
    await connectAndClose(
      buildPairingUrl(hostInput, codeInput),
      params.routeFor ?? importedEnvironmentId ?? undefined,
    );
  };

  useEffect(() => {
    if (!shouldAutoConnect || attemptedAutoConnectRef.current === routePairingUrl) {
      return;
    }

    attemptedAutoConnectRef.current = routePairingUrl;
    void connectAndClose(routePairingUrl, params.routeFor);
  }, [connectAndClose, params.routeFor, routePairingUrl, shouldAutoConnect]);

  return (
    <SettingsScreen
      formSheet={routeName === "ConnectionsNew"}
      title="Add environment"
      actions={[
        {
          accessibilityLabel: isSubmitting ? "Connecting" : "Add environment",
          loading: isSubmitting,
          icon: "checkmark",
          tintColor: headerIconColor,
          disabled: connectDisabled,
          onPress: () => {
            void handleSubmit();
          },
        },
      ]}
    >
      <ScrollView
        nestedScrollEnabled
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 4,
        }}
      >
        <View collapsable={false} className="gap-6.5">
          <PairingScanCard
            cameraActive={cameraPermission?.granted === true && screenFocused && !scanComplete}
            onScan={handleQrScan}
            onScanPress={() => {
              void handleScanPress();
            }}
          />

          {params.routeFor === undefined ? (
            <FleetImportSection
              savedEnvironmentIds={savedEnvironmentIds}
              selectedEnvironmentId={importedEnvironmentId}
              onSelect={handleImportedSelect}
              onClearSelection={handleImportedClear}
              onOpenSaved={openSavedEnvironment}
            />
          ) : null}

          <View collapsable={false} className="gap-2">
            <Text className="px-4 text-sm font-t3-medium text-foreground-muted">Or enter it</Text>
            <View
              collapsable={false}
              className={cn(
                "overflow-hidden rounded-[26px] border-continuous border bg-grouped-card",
                pairingConnectionError ? "border-danger-foreground" : "border-transparent",
              )}
            >
              <PairingInputRow
                label="Address"
                keyboardType="url"
                placeholder="192.168.1.100:3773"
                value={hostInput}
                onChangeText={handleHostChange}
              />
              <View className="ml-4 border-t border-border-subtle" />
              <PairingInputRow
                label="Code"
                placeholder="Pairing code"
                returnKeyType="go"
                value={codeInput}
                onChangeText={handleCodeChange}
                onSubmitEditing={() => {
                  if (!connectDisabled) void handleSubmit();
                }}
              />
            </View>
            <Text
              accessibilityLiveRegion="polite"
              className={cn(
                "px-4 text-sm leading-normal",
                pairingConnectionError ? "text-danger-foreground" : "text-foreground-muted",
              )}
            >
              {pairingConnectionError ??
                "For machines on your local network or tailnet. The machine keeps its own provider credentials."}
            </Text>
          </View>

          {hasCloudPublicConfig() ? <T3ConnectSection /> : null}
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

const SCAN_CARD_HEIGHT = 250;
const SCAN_RETICLE_SIZE = 150;
const SCAN_RETICLE_TOP = 36;
const SCAN_RETICLE_RADIUS = 28;

function PairingScanCard(props: {
  readonly cameraActive: boolean;
  readonly onScan: (result: { readonly data: string }) => void;
  readonly onScanPress: () => void;
}) {
  const light = useAppearancePreferences().themeAppearance === "light";
  return (
    <Pressable
      accessibilityRole={props.cameraActive ? undefined : "button"}
      accessibilityLabel={props.cameraActive ? undefined : "Scan QR code"}
      disabled={props.cameraActive}
      onPress={props.onScanPress}
      className={cn(
        "overflow-hidden rounded-[26px] border-continuous",
        light ? "bg-white" : "bg-black",
      )}
      style={{ height: SCAN_CARD_HEIGHT }}
    >
      <Svg accessibilityElementsHidden height="100%" style={StyleSheet.absoluteFill} width="100%">
        <Defs>
          <RadialGradient id="pairing-scan-backdrop" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={light ? "#f4f4f5" : "#2e2e2e"} />
            <Stop offset="100%" stopColor={light ? "#d9d9dc" : "#0e0e0e"} />
          </RadialGradient>
        </Defs>
        <Rect fill="url(#pairing-scan-backdrop)" height="100%" width="100%" />
      </Svg>

      {props.cameraActive ? (
        <>
          <CameraView
            active
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={props.onScan}
            style={StyleSheet.absoluteFill}
          />
          <FrostedCutout
            cutoutTop={SCAN_RETICLE_TOP}
            cutoutWidth={SCAN_RETICLE_SIZE}
            cutoutHeight={SCAN_RETICLE_SIZE}
            cutoutRadius={SCAN_RETICLE_RADIUS}
            appearance={light ? "light" : "dark"}
          />
        </>
      ) : null}

      <View
        pointerEvents="none"
        className="absolute inset-x-0 items-center gap-3.5"
        style={{ top: SCAN_RETICLE_TOP }}
      >
        <View
          className={cn(
            "items-center justify-center gap-2 border-continuous border-[3px]",
            light ? "border-black/70" : "border-white/80",
          )}
          style={{
            borderRadius: SCAN_RETICLE_RADIUS,
            height: SCAN_RETICLE_SIZE,
            width: SCAN_RETICLE_SIZE,
          }}
        >
          {props.cameraActive ? null : (
            <>
              <SymbolView
                name="qrcode.viewfinder"
                size={44}
                tintColorClassName={light ? "accent-black/60" : "accent-white/70"}
                type="monochrome"
                weight="light"
              />
              <Text
                className={cn("font-t3-medium text-sm", light ? "text-black/70" : "text-white/80")}
              >
                Tap to scan
              </Text>
            </>
          )}
        </View>
        <Text className={cn("text-center text-sm", light ? "text-black/70" : "text-white/80")}>
          Scan the code from t3 pair or desktop Connections settings
        </Text>
      </View>
    </Pressable>
  );
}

function T3ConnectSection() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const navigation = useNavigation();
  const { connectedEnvironments, onSetEnvironmentEnabled, onRemoveEnvironmentPress } =
    useRemoteConnections();
  const { connectedCloudEnvironments } = splitEnvironmentSections({
    connectedEnvironments,
    cloudEnvironments: null,
  });

  return (
    <View collapsable={false} className="gap-2">
      <Text className="px-4 text-sm font-t3-medium text-foreground-muted">
        Or use the managed relay
      </Text>
      {isSignedIn ? (
        <CloudEnvironmentRows
          connectedCloudEnvironments={connectedCloudEnvironments}
          onSetEnvironmentEnabled={onSetEnvironmentEnabled}
          onRemoveEnvironment={onRemoveEnvironmentPress}
          showHeader={false}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          disabled={!isLoaded}
          onPress={() => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" })}
          className="min-h-13 flex-row items-center gap-3 rounded-[26px] border-continuous bg-grouped-card px-4 active:opacity-70"
        >
          <View className="min-w-0 flex-1 py-3">
            <Text className="text-base text-foreground">Sign in to T3 Connect</Text>
            <Text className="text-sm text-foreground-muted">
              Reach your machines from anywhere, no network setup.
            </Text>
          </View>
          <SymbolView
            name="chevron.right"
            size={14}
            tintColorClassName="accent-chevron"
            type="monochrome"
            weight="semibold"
          />
        </Pressable>
      )}
    </View>
  );
}

function PairingInputRow({
  label,
  ...inputProps
}: Omit<AppTextInputProps, "accessibilityLabel" | "className"> & {
  readonly label: string;
}) {
  return (
    <View collapsable={false} className="h-13 flex-row items-center gap-3 px-4">
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="w-20 text-base leading-[23px] text-foreground-muted"
      >
        {label}
      </Text>
      <AppTextInput
        {...inputProps}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        className="min-h-0 flex-1 rounded-none border-0 bg-transparent p-0 text-base leading-[23px]"
      />
    </View>
  );
}
