import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { type RefObject, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

import { isElectron } from "../../env";
import { cn } from "~/lib/utils";
import { useTerminalFocus } from "../../hooks/useTerminalFocus";
import {
  composerControlHintLabel,
  shouldShowComposerControlHintsForModifiers,
} from "../../keybindings";
import { type ShortcutModifierState, useShortcutModifierState } from "../../shortcutModifierState";
import { useThreadJumpHintVisibility } from "../Sidebar.logic";

/**
 * Where composer control triggers live: the composer shell, then the thread
 * details panel, which hosts the run-context controls while it is open.
 */
export function composerShortcutScopes(composer: Element | null): Element[] {
  const shell = composer?.closest('[data-slot="composer-shell"]');
  return [
    ...(shell ? [shell] : []),
    ...Array.from(document.querySelectorAll("[data-thread-panel-run-context]")),
  ];
}

interface PlacedHint {
  key: string;
  /** Panel rows span the panel, so their callout sits inside the trailing edge. */
  placement: "above" | "inline-end";
  top: number;
  left: number;
  labels: string[];
}

function measureHints(
  scopes: readonly Element[],
  modifiers: ShortcutModifierState,
  keybindings: ResolvedKeybindingsConfig,
  terminalFocus: boolean,
): PlacedHint[] {
  const options = {
    context: {
      terminalFocus,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: !isElectron,
      isDesktop: isElectron,
    },
  };
  const hints: PlacedHint[] = [];
  const triggers = scopes.flatMap((scope) =>
    Array.from(scope.querySelectorAll<HTMLElement>("[data-composer-shortcut]")),
  );
  triggers.forEach((trigger, index) => {
    if (trigger.matches(":disabled") || trigger.closest("[inert]")) return;
    if (!trigger.checkVisibility({ visibilityProperty: true })) return;
    const commands = (trigger.dataset.composerShortcut ?? "").split(/\s+/).filter(Boolean);
    const labels = [
      ...new Set(
        commands.flatMap((command) => {
          const label = composerControlHintLabel(
            command as KeybindingCommand,
            modifiers,
            keybindings,
            options,
          );
          return label ? [label] : [];
        }),
      ),
    ];
    if (labels.length === 0) return;
    const rect = trigger.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const inPanel = trigger.closest("[data-thread-panel-run-context]") !== null;
    hints.push({
      key: `${index}:${commands.join(" ")}`,
      placement: inPanel ? "inline-end" : "above",
      top: inPanel ? rect.top + rect.height / 2 : rect.top,
      left: inPanel ? rect.right - 28 : rect.left + rect.width / 2,
      labels,
    });
  });
  return hints;
}

/**
 * While the held modifiers match a composer control binding, pins a keycap
 * callout above every control in the composer shell that the chord opens.
 */
export function ComposerShortcutHints(props: {
  anchorRef: RefObject<HTMLElement | null>;
  keybindings: ResolvedKeybindingsConfig;
}) {
  const { anchorRef, keybindings } = props;
  const modifiers = useShortcutModifierState();
  const terminalFocus = useTerminalFocus();
  const { showThreadJumpHints: visible, updateThreadJumpHintsVisibility: updateVisibility } =
    useThreadJumpHintVisibility();
  const [hints, setHints] = useState<PlacedHint[]>([]);

  const shouldShow = shouldShowComposerControlHintsForModifiers(modifiers, keybindings, {
    context: {
      terminalFocus,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: !isElectron,
      isDesktop: isElectron,
    },
  });
  useEffect(() => {
    updateVisibility(shouldShow);
  }, [shouldShow, updateVisibility]);

  useLayoutEffect(() => {
    if (!visible) return;
    const update = () =>
      setHints(
        measureHints(
          composerShortcutScopes(anchorRef.current),
          modifiers,
          keybindings,
          terminalFocus,
        ),
      );
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, keybindings, modifiers, terminalFocus, visible]);

  if (!visible || hints.length === 0) return null;

  return createPortal(
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[120]">
      {hints.map((hint) => (
        <div
          key={hint.key}
          className={cn(
            "absolute transition-[opacity,translate] duration-150 ease-out starting:opacity-0 motion-reduce:transition-none",
            hint.placement === "above"
              ? "-translate-x-1/2 -translate-y-full pb-1.5 starting:translate-y-[calc(-100%+4px)]"
              : "-translate-x-full -translate-y-1/2 starting:-translate-x-[calc(100%-4px)]",
          )}
          style={{ top: hint.top, left: hint.left }}
        >
          <div className="relative flex items-center gap-1 rounded-md border border-primary/50 bg-popover px-1.5 py-0.5 text-popover-foreground shadow-lg shadow-black/15 dark:shadow-black/40">
            {hint.labels.map((label) => (
              <kbd
                key={label}
                className="font-mono font-semibold text-2xs leading-4 tracking-tight"
              >
                {label}
              </kbd>
            ))}
            {hint.placement === "above" ? (
              <span className="absolute -bottom-[5px] left-1/2 size-2 -translate-x-1/2 rotate-45 border-primary/50 border-r border-b bg-popover" />
            ) : null}
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}
