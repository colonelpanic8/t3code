import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

export function RemoteEnvironmentIndicator({
  icon: Icon,
  label,
  className,
  iconClassName,
  style,
  ...props
}: ComponentProps<"span"> & {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly iconClassName?: string;
}) {
  return (
    <span
      role="img"
      aria-label={`Remote environment: ${label}`}
      className={cn("inline-flex min-w-0 items-center gap-1", className)}
      style={style}
      {...props}
    >
      {/* `style` is applied to the icon too, not just the wrapping span: an
          accent color set via `iconClassName` (e.g. text-muted-foreground/40)
          is an explicit color on the icon itself, which an inherited color
          from the ancestor span cannot override. */}
      <span className="thread-remote-environment-label min-w-0 max-w-20 truncate">{label}</span>
      <Icon aria-hidden className={cn("shrink-0", iconClassName)} style={style} />
    </span>
  );
}

export function shouldShowRemoteEnvironmentIndicator(input: {
  readonly currentEnvironmentId: string | null;
  readonly threadEnvironmentId: string;
  readonly isDesktopLocal: boolean;
}) {
  return (
    input.currentEnvironmentId !== null &&
    input.threadEnvironmentId !== input.currentEnvironmentId &&
    !input.isDesktopLocal
  );
}
