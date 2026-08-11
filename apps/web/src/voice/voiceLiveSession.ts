import {
  createVoiceLiveCallDriver,
  voiceLiveHostsFromPresentations,
  type VoiceLiveCallEnd,
  type VoiceLiveCallHandle,
} from "@t3tools/client-runtime/state/voice-live";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, VoiceLiveHost } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { useVoiceLiveStore } from "./voiceLiveStore";

/**
 * Browser side of a Live Voice call: microphone capture, the WebRTC peer, and
 * the remote-audio element. The `voice.live.start` stream itself runs through
 * the shared client-runtime driver, so this file only owns media and the
 * zustand store the UI renders.
 */

const voiceLiveDriver = createVoiceLiveCallDriver(connectionAtomRuntime);

const ICE_GATHERING_TIMEOUT_MS = 3_000;

interface ActiveVoiceLiveSession {
  readonly environmentId: EnvironmentId;
  readonly peer: RTCPeerConnection;
  readonly localStream: MediaStream;
  readonly audio: HTMLAudioElement;
  handle: VoiceLiveCallHandle | null;
  disposed: boolean;
}

let activeSession: ActiveVoiceLiveSession | null = null;

export const VOICE_LIVE_INSECURE_CONTEXT_REASON = "Voice needs HTTPS or localhost";

function listVoiceLiveHosts(): ReadonlyArray<VoiceLiveHost> {
  return voiceLiveHostsFromPresentations(
    appAtomRegistry.get(environmentPresentations.presentationsAtom),
  );
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Live Voice call failed.";
}

async function waitForIceGatheringComplete(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    };
    const onStateChange = () => {
      if (peer.iceGatheringState === "complete") {
        finish();
      }
    };
    const timer = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
    peer.addEventListener("icegatheringstatechange", onStateChange);
  });
}

async function playRemoteAudio(audio: HTMLAudioElement): Promise<void> {
  try {
    await audio.play();
    useVoiceLiveStore.getState().setAutoplayBlocked(false);
  } catch {
    // Autoplay policy blocked playback; the call card offers a tap-to-unmute.
    useVoiceLiveStore.getState().setAutoplayBlocked(true);
  }
}

function disposeSessionMedia(session: ActiveVoiceLiveSession): void {
  if (session.disposed) {
    return;
  }
  session.disposed = true;
  for (const track of session.localStream.getTracks()) {
    track.stop();
  }
  session.peer.ontrack = null;
  session.peer.close();
  session.audio.pause();
  session.audio.srcObject = null;
}

function settleSession(
  session: ActiveVoiceLiveSession,
  result: AtomCommandResult<VoiceLiveCallEnd, unknown>,
): void {
  disposeSessionMedia(session);
  if (activeSession === session) {
    activeSession = null;
  }
  const store = useVoiceLiveStore.getState();
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) {
      store.reset();
    } else {
      store.fail(errorMessageOf(squashAtomCommandFailure(result)));
    }
    return;
  }
  if (result.value.type === "failed") {
    store.fail(result.value.message);
    return;
  }
  if (result.value.type !== "stopped" && store.status === "error") {
    // A surfaced error stays visible until the user dismisses it.
    return;
  }
  store.reset();
}

async function applyAnswer(session: ActiveVoiceLiveSession, sdp: string): Promise<void> {
  if (session.disposed) {
    return;
  }
  try {
    await session.peer.setRemoteDescription({ type: "answer", sdp });
    useVoiceLiveStore.getState().markActive();
  } catch (error) {
    useVoiceLiveStore.getState().fail(errorMessageOf(error));
    session.handle?.stop();
  }
}

export async function startVoiceLiveCall(target: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}): Promise<void> {
  if (activeSession !== null || useVoiceLiveStore.getState().status !== "idle") {
    return;
  }
  const store = useVoiceLiveStore.getState();
  if (!window.isSecureContext) {
    store.fail(VOICE_LIVE_INSECURE_CONTEXT_REASON);
    return;
  }
  store.beginConnecting(target.environmentId, target.label);

  let localStream: MediaStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    useVoiceLiveStore.getState().fail(errorMessageOf(error));
    return;
  }

  const peer = new RTCPeerConnection();
  const audio = new Audio();
  audio.autoplay = true;
  const session: ActiveVoiceLiveSession = {
    environmentId: target.environmentId,
    peer,
    localStream,
    audio,
    handle: null,
    disposed: false,
  };
  activeSession = session;

  try {
    for (const track of localStream.getAudioTracks()) {
      peer.addTrack(track, localStream);
    }
    // Codex's realtime v3 transport expects both an audio m-line and an
    // events data channel in the offer.
    peer.createDataChannel("oai-events");
    peer.ontrack = (event) => {
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void playRemoteAudio(audio);
    };

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIceGatheringComplete(peer);
    const offerSdp = peer.localDescription?.sdp ?? offer.sdp;
    if (offerSdp === undefined || offerSdp.length === 0) {
      throw new Error("Could not build a WebRTC offer.");
    }
    if (useVoiceLiveStore.getState().status !== "connecting" || activeSession !== session) {
      // The user bailed out while media was being set up.
      disposeSessionMedia(session);
      if (activeSession === session) {
        activeSession = null;
      }
      return;
    }

    session.handle = voiceLiveDriver.startVoiceLiveCall(
      appAtomRegistry,
      {
        environmentId: target.environmentId,
        offerSdp,
        crossHostRouting: true,
        listHosts: listVoiceLiveHosts,
      },
      {
        onAnswer: (sdp) => {
          void applyAnswer(session, sdp);
        },
        onTranscript: ({ role, text }) => {
          if (text.trim().length > 0) {
            useVoiceLiveStore.getState().appendTranscript(role, text);
          }
        },
        onError: (message) => {
          useVoiceLiveStore.getState().fail(message);
        },
      },
    );
    void session.handle.result.then((result) => {
      settleSession(session, result);
    });
  } catch (error) {
    disposeSessionMedia(session);
    if (activeSession === session) {
      activeSession = null;
    }
    useVoiceLiveStore.getState().fail(errorMessageOf(error));
  }
}

/** Interrupts the call (or clears a finished/error card when no call is live). */
export function stopVoiceLiveCall(): void {
  const session = activeSession;
  if (session === null) {
    useVoiceLiveStore.getState().reset();
    return;
  }
  if (session.handle === null) {
    // Still in media setup; startVoiceLiveCall notices the reset and cleans up.
    useVoiceLiveStore.getState().reset();
    return;
  }
  session.handle.stop();
}

export function setVoiceLiveMuted(muted: boolean): void {
  const session = activeSession;
  if (session !== null) {
    for (const track of session.localStream.getAudioTracks()) {
      track.enabled = !muted;
    }
  }
  useVoiceLiveStore.getState().setMuted(muted);
}

/** Retries remote playback after the browser blocked autoplay. */
export async function resumeVoiceLiveAudio(): Promise<void> {
  const session = activeSession;
  if (session === null || session.disposed) {
    return;
  }
  await playRemoteAudio(session.audio);
}
