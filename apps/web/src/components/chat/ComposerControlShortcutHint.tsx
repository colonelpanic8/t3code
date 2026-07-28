import { ChevronDownIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Kbd } from "../ui/kbd";

/**
 * Trailing affordance for a composer control: the disclosure chevron normally,
 * and the shortcut keycap in its place while a modifier is held. Reusing the
 * chevron's slot keeps hints in layout — they never spill into the row below —
 * and costs no horizontal space beyond the keycap's own width.
 */
export function ComposerControlChevron(props: {
  hintLabel?: string | null | undefined;
  className?: string | undefined;
  chevronClassName?: string | undefined;
}) {
  if (props.hintLabel) {
    return <ComposerShortcutKeycap label={props.hintLabel} className={props.className} />;
  }
  return (
    <ChevronDownIcon
      aria-hidden="true"
      className={cn("size-3 shrink-0 opacity-60", props.chevronClassName)}
    />
  );
}

/**
 * Keycap for a hold-modifier hint. The label is the chord minus the platform
 * mod key, so its width stays fixed for as long as the modifier is held.
 */
export function ComposerShortcutKeycap(props: { label: string; className?: string | undefined }) {
  return (
    <Kbd
      className={cn(
        "h-4 min-w-4 rounded-[4px] border border-foreground/15 bg-foreground/10 px-1 font-medium text-[10px] text-foreground/85 leading-none",
        props.className,
      )}
    >
      {props.label}
    </Kbd>
  );
}
