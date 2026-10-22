const { AndroidConfig, withInfoPlist } = require("expo/config-plugins");

// Native configuration for Live Voice calls (react-native-webrtc, audio-only).
// A custom plugin instead of @config-plugins/react-native-webrtc: that plugin
// unconditionally adds camera permissions (NSCameraUsageDescription, Android
// CAMERA) plus SYSTEM_ALERT_WINDOW, none of which this mic-only feature uses,
// and it omits the background-audio and foreground-service pieces we do need.

const MICROPHONE_USAGE_DESCRIPTION =
  "Allow T3 Code to access your microphone so you can talk to your agents with Live Voice.";

module.exports = function withVoiceCall(config) {
  config = withInfoPlist(config, (nextConfig) => {
    const infoPlist = nextConfig.modResults;
    infoPlist.NSMicrophoneUsageDescription = MICROPHONE_USAGE_DESCRIPTION;
    // Keeps the WebRTC audio session (and with it the app and its sockets)
    // alive while a call continues in the background.
    const backgroundModes = new Set(infoPlist.UIBackgroundModes ?? []);
    backgroundModes.add("audio");
    infoPlist.UIBackgroundModes = [...backgroundModes];
    return nextConfig;
  });

  // RECORD_AUDIO/MODIFY_AUDIO_SETTINGS/ACCESS_NETWORK_STATE/WAKE_LOCK are what
  // react-native-webrtc needs for audio-only calls. The FOREGROUND_SERVICE
  // pair is declared ahead of the v2 microphone foreground service so enabling
  // true background calls on Android needs no new permission grant.
  return AndroidConfig.Permissions.withPermissions(config, [
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.MODIFY_AUDIO_SETTINGS",
    "android.permission.RECORD_AUDIO",
    "android.permission.WAKE_LOCK",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_MICROPHONE",
  ]);
};
