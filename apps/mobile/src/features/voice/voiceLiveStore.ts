import type { EnvironmentId } from "@t3tools/contracts";

/**
 * App-global Live Voice call state. Module-level store consumed through
 * useSyncExternalStore (same pattern as reviewCommentSelection) so the
 * session controller can drive it from outside React and the banner can
 * follow the call across navigation.
 */

export type VoiceLiveStatus =
  | "idle"
  | "requesting-permission"
  | "connecting"
  | "active"
  | "ending";

export interface VoiceLiveTranscriptLine {
  readonly id: number;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface VoiceLiveState {
  readonly status: VoiceLiveStatus;
  readonly environmentId: EnvironmentId | null;
  readonly environmentLabel: string | null;
  readonly muted: boolean;
  /** Terminal error from the last call attempt; cleared on the next start. */
  readonly error: string | null;
  readonly transcripts: ReadonlyArray<VoiceLiveTranscriptLine>;
  readonly expanded: boolean;
  readonly pickerOpen: boolean;
}

/** Bounded history: the banner is a live surface, not a durable log. */
export const VOICE_LIVE_MAX_TRANSCRIPT_LINES = 100;

const IDLE_STATE: VoiceLiveState = {
  status: "idle",
  environmentId: null,
  environmentLabel: null,
  muted: false,
  error: null,
  transcripts: [],
  expanded: false,
  pickerOpen: false,
};

let state: VoiceLiveState = IDLE_STATE;
let nextTranscriptId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeVoiceLiveState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getVoiceLiveState(): VoiceLiveState {
  return state;
}

function update(partial: Partial<VoiceLiveState>) {
  state = { ...state, ...partial };
  emit();
}

export function appendBoundedTranscript(
  transcripts: ReadonlyArray<VoiceLiveTranscriptLine>,
  line: VoiceLiveTranscriptLine,
  maxLines: number,
): ReadonlyArray<VoiceLiveTranscriptLine> {
  const next = [...transcripts, line];
  return next.length > maxLines ? next.slice(next.length - maxLines) : next;
}

export const voiceLiveStoreActions = {
  callStarting(environmentId: EnvironmentId, environmentLabel: string) {
    update({
      status: "requesting-permission",
      environmentId,
      environmentLabel,
      muted: false,
      error: null,
      transcripts: [],
      expanded: false,
      pickerOpen: false,
    });
  },
  callConnecting() {
    update({ status: "connecting" });
  },
  callActive() {
    update({ status: "active" });
  },
  callEnding() {
    update({ status: "ending" });
  },
  /** Terminal teardown; a non-null error keeps the banner up to explain why. */
  callClosed(error: string | null) {
    update({
      ...IDLE_STATE,
      error,
      pickerOpen: state.pickerOpen,
    });
  },
  transcript(role: "user" | "assistant", text: string) {
    if (text.trim().length === 0) {
      return;
    }
    update({
      transcripts: appendBoundedTranscript(
        state.transcripts,
        { id: nextTranscriptId++, role, text },
        VOICE_LIVE_MAX_TRANSCRIPT_LINES,
      ),
    });
  },
  setMuted(muted: boolean) {
    update({ muted });
  },
  setExpanded(expanded: boolean) {
    update({ expanded });
  },
  openPicker() {
    update({ pickerOpen: true });
  },
  closePicker() {
    update({ pickerOpen: false });
  },
  dismissError() {
    update({ error: null });
  },
};
