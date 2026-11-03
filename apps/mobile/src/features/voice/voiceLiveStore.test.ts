import { describe, expect, it } from "@effect/vitest";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  appendBoundedTranscript,
  getVoiceLiveState,
  VOICE_LIVE_MAX_TRANSCRIPT_LINES,
  voiceLiveStoreActions,
  type VoiceLiveTranscriptLine,
} from "./voiceLiveStore";

const envId = "env-1" as EnvironmentId;

describe("appendBoundedTranscript", () => {
  it("appends in order below the bound", () => {
    let lines: ReadonlyArray<VoiceLiveTranscriptLine> = [];
    lines = appendBoundedTranscript(lines, { id: 1, role: "user", text: "hi" }, 3);
    lines = appendBoundedTranscript(lines, { id: 2, role: "assistant", text: "hello" }, 3);
    expect(lines.map((line) => line.id)).toEqual([1, 2]);
  });

  it("drops the oldest lines past the bound", () => {
    let lines: ReadonlyArray<VoiceLiveTranscriptLine> = [];
    for (let i = 1; i <= 5; i++) {
      lines = appendBoundedTranscript(lines, { id: i, role: "user", text: `t${i}` }, 3);
    }
    expect(lines.map((line) => line.id)).toEqual([3, 4, 5]);
  });
});

describe("voiceLiveStoreActions", () => {
  it("runs a call through its lifecycle and resets on close", () => {
    voiceLiveStoreActions.callStarting(envId, "Laptop");
    expect(getVoiceLiveState().status).toBe("requesting-permission");
    expect(getVoiceLiveState().environmentLabel).toBe("Laptop");

    voiceLiveStoreActions.callConnecting();
    voiceLiveStoreActions.callActive();
    voiceLiveStoreActions.transcript("user", "start the tests");
    voiceLiveStoreActions.transcript("assistant", "on it");
    voiceLiveStoreActions.transcript("assistant", "");
    expect(getVoiceLiveState().status).toBe("active");
    expect(getVoiceLiveState().transcripts.map((line) => line.text)).toEqual([
      "start the tests",
      "on it",
    ]);

    voiceLiveStoreActions.callClosed(null);
    const closed = getVoiceLiveState();
    expect(closed.status).toBe("idle");
    expect(closed.transcripts).toEqual([]);
    expect(closed.environmentId).toBeNull();
    expect(closed.error).toBeNull();
  });

  it("keeps a terminal error visible until dismissed and clears it on restart", () => {
    voiceLiveStoreActions.callStarting(envId, "Laptop");
    voiceLiveStoreActions.callClosed("mic denied");
    expect(getVoiceLiveState().status).toBe("idle");
    expect(getVoiceLiveState().error).toBe("mic denied");

    voiceLiveStoreActions.callStarting(envId, "Laptop");
    expect(getVoiceLiveState().error).toBeNull();
    voiceLiveStoreActions.callClosed("boom");
    voiceLiveStoreActions.dismissError();
    expect(getVoiceLiveState().error).toBeNull();
  });

  it("bounds the transcript history", () => {
    voiceLiveStoreActions.callStarting(envId, "Laptop");
    for (let i = 0; i < VOICE_LIVE_MAX_TRANSCRIPT_LINES + 10; i++) {
      voiceLiveStoreActions.transcript("assistant", `line ${i}`);
    }
    const transcripts = getVoiceLiveState().transcripts;
    expect(transcripts.length).toBe(VOICE_LIVE_MAX_TRANSCRIPT_LINES);
    expect(transcripts[transcripts.length - 1]?.text).toBe(
      `line ${VOICE_LIVE_MAX_TRANSCRIPT_LINES + 9}`,
    );
    voiceLiveStoreActions.callClosed(null);
  });
});
