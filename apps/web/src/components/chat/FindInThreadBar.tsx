import { useEffect, useRef, type KeyboardEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { formatThreadFindCount } from "./threadFind";

interface FindInThreadBarProps {
  query: string;
  matchCount: number;
  activeIndex: number;
  /** Bumped by the caller to pull focus back into the field on a repeat Cmd+F. */
  focusRequestId: number;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export function FindInThreadBar({
  query,
  matchCount,
  activeIndex,
  focusRequestId,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
}: FindInThreadBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    input.select();
  }, [focusRequestId]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        onPrevious();
      } else {
        onNext();
      }
    }
  };

  const hasQuery = query.trim().length > 0;
  const noResults = hasQuery && matchCount === 0;

  return (
    <div
      role="search"
      aria-label="Find in thread"
      className="pointer-events-auto flex items-center gap-1 rounded-full border border-border/60 bg-card px-2 py-1 shadow-md"
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        aria-label="Find in thread"
        placeholder="Find in thread"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        className="h-6 w-44 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/72"
      />
      <span
        aria-live="polite"
        className={
          noResults
            ? "min-w-10 shrink-0 text-center text-xs tabular-nums text-destructive"
            : "min-w-10 shrink-0 text-center text-xs tabular-nums text-muted-foreground"
        }
      >
        {hasQuery ? formatThreadFindCount(activeIndex, matchCount) : ""}
      </span>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label="Previous match"
        disabled={matchCount === 0}
        onClick={onPrevious}
        className="size-6 p-0"
      >
        <ChevronUpIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label="Next match"
        disabled={matchCount === 0}
        onClick={onNext}
        className="size-6 p-0"
      >
        <ChevronDownIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label="Close find"
        onClick={onClose}
        className="size-6 p-0"
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}
