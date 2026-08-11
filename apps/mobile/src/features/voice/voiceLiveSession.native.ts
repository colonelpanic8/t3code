import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { PermissionsAndroid, Platform } from "react-native";

import { retainMobileCallActivity } from "../../connection/background-activity-scopes";
import { startVoiceLiveDriverCall, type VoiceLiveCallHandle } from "./voiceLiveDriver";
import { voiceLiveStoreActions } from "./voiceLiveStore";
import {
  loadVoiceWebRtc,
  VOICE_WEBRTC_UNAVAILABLE_MESSAGE,
  type VoiceWebRtc,
} from "./webrtcModule";

/**
 * Mobile Live Voice call session: mirrors the web session on top of
 * react-native-webrtc. Media flows this device <-> OpenAI over WebRTC; the
 * shared driver carries only SDP, transcripts, and routed tool calls over the
 * T3 socket.
 *
 * Lifetime and backgrounding:
 * - The call is NOT torn down on AppState changes. On iOS the active WebRTC
 *   audio session plus the `audio` UIBackgroundMode (added by
 *   plugins/withVoiceCall.cjs) keeps the app and its sockets alive in the
 *   background.
 * - Android v1 limitation: backgrounded calls are best-effort only. Keeping a
 *   call alive with the screen off requires a microphone foreground service
 *   (a native module we deliberately do not ship in v1; the
 *   FOREGROUND_SERVICE_MICROPHONE permission is already declared for it). The
 *   call survives while the app is foregrounded or recent, and the OS may
 *   reclaim it beyond that.
 * - Audio routing uses react-native-webrtc's defaults (AVAudioSession
 *   playAndRecord). Earpiece/speaker toggling would need InCallManager-style
 *   native support, which we intentionally avoid adding here.
 */

type PeerConnection = InstanceType<VoiceWebRtc["RTCPeerConnection"]>;
type LocalStream = Awaited<ReturnType<VoiceWebRtc["mediaDevices"]["getUserMedia"]>>;

const ICE_GATHERING_TIMEOUT_MS = 2000;

interface ActiveCall {
  readonly environmentId: EnvironmentId;
  pc: PeerConnection | null;
  localStream: LocalStream | null;
  driverHandle: VoiceLiveCallHandle | null;
  readonly releaseCallActivity: () => void;
  /** Last driver error; surfaced when the terminal `closed` arrives. */
  lastError: string | null;
  finished: boolean;
}

let activeCall: ActiveCall | null = null;

export function hasActiveVoiceCall(): boolean {
  return activeCall !== null;
}

export async function startVoiceCall(target: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}): Promise<void> {
  if (activeCall !== null) {
    return;
  }
  voiceLiveStoreActions.callStarting(target.environmentId, target.label);
  const call: ActiveCall = {
    environmentId: target.environmentId,
    pc: null,
    localStream: null,
    driverHandle: null,
    releaseCallActivity: retainMobileCallActivity(target.environmentId),
    lastError: null,
    finished: false,
  };
  activeCall = call;

  try {
    const rtc = await loadVoiceWebRtc();
    if (rtc === null) {
      finishCall(call, VOICE_WEBRTC_UNAVAILABLE_MESSAGE);
      return;
    }
    if (!(await requestMicrophonePermission())) {
      finishCall(call, "Microphone access was denied. Allow it in system settings to use Live Voice.");
      return;
    }

    let stream: LocalStream;
    try {
      stream = await rtc.mediaDevices.getUserMedia({ audio: true });
    } catch {
      finishCall(call, "Microphone access was denied. Allow it in system settings to use Live Voice.");
      return;
    }
    if (call.finished) {
      stopTracks(stream);
      return;
    }
    call.localStream = stream;

    const pc = new rtc.RTCPeerConnection();
    call.pc = pc;
    // OpenAI realtime event channel; must be in the offer even though events
    // are consumed provider-side (the T3 stream carries transcripts to us).
    pc.createDataChannel("oai-events");
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }

    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    // No trickle path exists on the voice.live wire: ship a complete offer.
    await waitForIceGatheringComplete(pc, ICE_GATHERING_TIMEOUT_MS);
    if (call.finished) {
      return;
    }
    const offerSdp = pc.localDescription?.sdp ?? offer.sdp;
    if (!offerSdp) {
      finishCall(call, "Could not build a WebRTC offer for this device.");
      return;
    }

    voiceLiveStoreActions.callConnecting();
    const driverHandle = startVoiceLiveDriverCall(
      {
        environmentId: target.environmentId,
        offerSdp,
        crossHostRouting: true,
      },
      {
        onAnswer: (sdp) => {
          void applyAnswer(call, sdp);
        },
        onTranscript: (line) => {
          if (call === activeCall && !call.finished) {
            voiceLiveStoreActions.transcript(line.role, line.text);
          }
        },
        onError: (message) => {
          if (!call.finished) {
            call.lastError = message;
          }
        },
      },
    );
    call.driverHandle = driverHandle;
    // The handle settles for every end (closed, stopped, ended, failed), so
    // no separate onClosed handling: teardown always converges here.
    void driverHandle.result.then(
      (result) => {
        if (result._tag === "Failure") {
          finishCall(
            call,
            call.lastError ??
              (isAtomCommandInterrupted(result)
                ? null
                : errorMessageOf(squashAtomCommandFailure(result))),
          );
          return;
        }
        if (result.value.type === "failed") {
          finishCall(call, call.lastError ?? result.value.message);
          return;
        }
        finishCall(call, call.lastError);
      },
      () => finishCall(call, call.lastError ?? "Live Voice call failed."),
    );
    if (call.finished) {
      driverHandle.stop();
    }
  } catch (cause) {
    finishCall(call, cause instanceof Error ? cause.message : "Live Voice call failed to start.");
  }
}

export function stopVoiceCall(): void {
  const call = activeCall;
  if (call === null) {
    return;
  }
  voiceLiveStoreActions.callEnding();
  finishCall(call, null);
}

export function toggleVoiceMute(): void {
  const call = activeCall;
  if (call === null || call.localStream === null) {
    return;
  }
  const tracks = call.localStream.getAudioTracks();
  const nextMuted = tracks.some((track) => track.enabled);
  for (const track of tracks) {
    track.enabled = !nextMuted;
  }
  voiceLiveStoreActions.setMuted(nextMuted);
}

async function applyAnswer(call: ActiveCall, sdp: string): Promise<void> {
  if (call !== activeCall || call.finished || call.pc === null) {
    return;
  }
  try {
    await call.pc.setRemoteDescription({ type: "answer", sdp });
    if (!call.finished) {
      voiceLiveStoreActions.callActive();
    }
  } catch {
    finishCall(call, "Could not establish the audio connection.");
  }
}

/** Idempotent teardown; every exit path (stop, driver close, failure) lands here. */
function finishCall(call: ActiveCall, error: string | null): void {
  if (call.finished) {
    return;
  }
  call.finished = true;
  if (activeCall === call) {
    activeCall = null;
  }
  try {
    call.driverHandle?.stop();
  } catch {
    // Driver teardown is idempotent; a throw here must not block media cleanup.
  }
  if (call.localStream !== null) {
    stopTracks(call.localStream);
    call.localStream = null;
  }
  try {
    call.pc?.close();
  } catch {
    // Closing an already-failed peer connection can throw on some platforms.
  }
  call.pc = null;
  call.releaseCallActivity();
  voiceLiveStoreActions.callClosed(error);
}

function stopTracks(stream: LocalStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Track may already be stopped by the peer connection teardown.
    }
  }
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Live Voice call failed.";
}

async function requestMicrophonePermission(): Promise<boolean> {
  if (Platform.OS !== "android") {
    // iOS prompts from getUserMedia itself (NSMicrophoneUsageDescription is
    // supplied by plugins/withVoiceCall.cjs).
    return true;
  }
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

function waitForIceGatheringComplete(pc: PeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pc.onicegatheringstatechange = null;
      resolve();
    };
    // Timeout rather than fail: a partially gathered offer can still connect.
    const timer = setTimeout(finish, timeoutMs);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        finish();
      }
    };
  });
}
