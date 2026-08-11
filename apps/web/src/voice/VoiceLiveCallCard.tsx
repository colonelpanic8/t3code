import {
  ChevronDownIcon,
  ChevronUpIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  XIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import {
  resumeVoiceLiveAudio,
  setVoiceLiveMuted,
  stopVoiceLiveCall,
} from "./voiceLiveSession";
import { useVoiceLiveStore, type VoiceLiveTranscriptEntry } from "./voiceLiveStore";

function transcriptRoleLabel(entry: VoiceLiveTranscriptEntry): string {
  return entry.role === "user" ? "You" : "Agent";
}

/**
 * Global active-call surface. Rendered from the root route so it survives
 * navigation; docked above the bottom-right corner so it stays clear of the
 * centered composer. The status dot is static per status — no continuous
 * animation.
 */
export const VoiceLiveCallCard = memo(function VoiceLiveCallCard() {
  const status = useVoiceLiveStore((state) => state.status);
  const environmentLabel = useVoiceLiveStore((state) => state.environmentLabel);
  const transcripts = useVoiceLiveStore((state) => state.transcripts);
  const muted = useVoiceLiveStore((state) => state.muted);
  const autoplayBlocked = useVoiceLiveStore((state) => state.autoplayBlocked);
  const errorMessage = useVoiceLiveStore((state) => state.errorMessage);
  const [expanded, setExpanded] = useState(false);

  // Newest-first for the column-reverse scroller, which pins to the bottom
  // (the latest line) natively without scroll effects.
  const reversedTranscripts = useMemo(() => transcripts.toReversed(), [transcripts]);

  if (status === "idle") {
    return null;
  }

  const lastTranscript = transcripts.at(-1) ?? null;
  const statusDotClass =
    status === "active"
      ? muted
        ? "bg-amber-500"
        : "bg-emerald-500"
      : status === "connecting"
        ? "bg-amber-500"
        : "bg-red-500";
  const statusLine =
    status === "error"
      ? (errorMessage ?? "Call failed")
      : status === "connecting"
        ? "Connecting..."
        : muted
          ? "Live · muted"
          : "Live";

  return (
    <div className="fixed right-3 bottom-3 z-[120] w-80 max-w-[calc(100vw-1.5rem)] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
      <div className="flex items-center gap-2 px-3 py-2">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", statusDotClass)} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            Live Voice{environmentLabel ? ` · ${environmentLabel}` : ""}
          </div>
          <div
            className={cn(
              "truncate text-xs",
              status === "error" ? "text-destructive-foreground" : "text-muted-foreground",
            )}
            title={status === "error" ? (errorMessage ?? undefined) : undefined}
          >
            {statusLine}
          </div>
        </div>
        {status === "error" ? (
          <Button aria-label="Dismiss" onClick={stopVoiceLiveCall} size="icon-xs" variant="ghost">
            <XIcon />
          </Button>
        ) : (
          <>
            <Button
              aria-label={expanded ? "Collapse transcript" : "Expand transcript"}
              disabled={transcripts.length === 0}
              onClick={() => setExpanded((current) => !current)}
              size="icon-xs"
              variant="ghost"
            >
              {expanded ? <ChevronDownIcon /> : <ChevronUpIcon />}
            </Button>
            <Button
              aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              onClick={() => setVoiceLiveMuted(!muted)}
              size="icon-xs"
              variant="ghost"
            >
              {muted ? <MicOffIcon className="text-destructive-foreground" /> : <MicIcon />}
            </Button>
            <Button aria-label="End call" onClick={stopVoiceLiveCall} size="icon-xs" variant="ghost">
              <PhoneOffIcon />
            </Button>
          </>
        )}
      </div>
      {status === "active" && autoplayBlocked ? (
        <button
          className="w-full border-t border-border px-3 py-2 text-left text-xs text-amber-500"
          onClick={() => {
            void resumeVoiceLiveAudio();
          }}
          type="button"
        >
          The browser paused audio — tap to unmute
        </button>
      ) : null}
      {status !== "error" ? (
        expanded && transcripts.length > 0 ? (
          <div className="flex max-h-48 flex-col-reverse overflow-y-auto border-t border-border px-3 py-2">
            {reversedTranscripts.map((entry) => (
              <p className="py-0.5 text-xs leading-snug" key={entry.id}>
                <span className="text-muted-foreground">{transcriptRoleLabel(entry)}: </span>
                {entry.text}
              </p>
            ))}
          </div>
        ) : lastTranscript !== null ? (
          <p className="truncate border-t border-border px-3 py-2 text-xs">
            <span className="text-muted-foreground">{transcriptRoleLabel(lastTranscript)}: </span>
            {lastTranscript.text}
          </p>
        ) : null
      ) : null}
    </div>
  );
});
