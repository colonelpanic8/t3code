import type { EnvironmentId, VoiceLiveTranscriptRole } from "@t3tools/contracts";
import { create } from "zustand";

export type VoiceLiveStatus = "idle" | "connecting" | "active" | "error";

export interface VoiceLiveTranscriptEntry {
  readonly id: number;
  readonly role: VoiceLiveTranscriptRole;
  readonly text: string;
}

export const VOICE_LIVE_TRANSCRIPT_LIMIT = 200;

interface VoiceLiveStoreState {
  readonly status: VoiceLiveStatus;
  readonly environmentId: EnvironmentId | null;
  readonly environmentLabel: string | null;
  readonly transcripts: ReadonlyArray<VoiceLiveTranscriptEntry>;
  readonly muted: boolean;
  readonly autoplayBlocked: boolean;
  readonly errorMessage: string | null;
  readonly beginConnecting: (environmentId: EnvironmentId, environmentLabel: string) => void;
  readonly markActive: () => void;
  readonly appendTranscript: (role: VoiceLiveTranscriptRole, text: string) => void;
  readonly setMuted: (muted: boolean) => void;
  readonly setAutoplayBlocked: (autoplayBlocked: boolean) => void;
  readonly fail: (errorMessage: string) => void;
  readonly reset: () => void;
}

let nextTranscriptId = 0;

const IDLE_STATE = {
  status: "idle",
  environmentId: null,
  environmentLabel: null,
  transcripts: [],
  muted: false,
  autoplayBlocked: false,
  errorMessage: null,
} as const;

export const useVoiceLiveStore = create<VoiceLiveStoreState>()((set) => ({
  ...IDLE_STATE,
  beginConnecting: (environmentId, environmentLabel) =>
    set({ ...IDLE_STATE, status: "connecting", environmentId, environmentLabel }),
  markActive: () =>
    set((state) => (state.status === "connecting" ? { status: "active" } : state)),
  appendTranscript: (role, text) =>
    set((state) => {
      const entry: VoiceLiveTranscriptEntry = { id: nextTranscriptId++, role, text };
      const overflow = state.transcripts.length - (VOICE_LIVE_TRANSCRIPT_LIMIT - 1);
      const transcripts =
        overflow > 0
          ? [...state.transcripts.slice(overflow), entry]
          : [...state.transcripts, entry];
      return { transcripts };
    }),
  setMuted: (muted) => set({ muted }),
  setAutoplayBlocked: (autoplayBlocked) => set({ autoplayBlocked }),
  fail: (errorMessage) => set({ status: "error", errorMessage }),
  reset: () => set(IDLE_STATE),
}));
