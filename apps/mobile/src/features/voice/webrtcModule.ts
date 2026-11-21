import { NativeModules } from "react-native";

export interface VoiceWebRtc {
  readonly RTCPeerConnection: typeof import("react-native-webrtc").RTCPeerConnection;
  readonly mediaDevices: typeof import("react-native-webrtc").mediaDevices;
}

let cached: VoiceWebRtc | null | undefined;

export const VOICE_WEBRTC_UNAVAILABLE_MESSAGE =
  "Live Voice needs an app update. Install the latest build to make calls from this device.";

/**
 * react-native-webrtc is resolved lazily and behind a native-module presence
 * check so an OTA-updated JS bundle running on a binary built without the
 * WebRTC native module degrades to the "needs an app update" state instead of
 * crashing at startup (same guard style as nativeTerminalModule).
 */
export async function loadVoiceWebRtc(): Promise<VoiceWebRtc | null> {
  if (cached !== undefined) {
    return cached;
  }
  try {
    if (NativeModules.WebRTCModule == null) {
      cached = null;
      return cached;
    }
    const module = await import("react-native-webrtc");
    cached = {
      RTCPeerConnection: module.RTCPeerConnection,
      mediaDevices: module.mediaDevices,
    };
  } catch (cause) {
    console.error("Live Voice: failed to load react-native-webrtc", cause);
    cached = null;
  }
  return cached;
}
