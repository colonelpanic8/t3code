import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";
import { useOpenExternalUrl } from "../lib/openExternalUrl";

/** An anchor that opens in the system browser rather than navigating the app. */
export function ExternalLink({
  href,
  className,
  children,
  ...anchorProps
}: ComponentPropsWithoutRef<"a"> & { href: string }) {
  const openExternalUrl = useOpenExternalUrl();

  return (
    <a
      {...anchorProps}
      href={href}
      onClick={(event) => openExternalUrl(event, href)}
      className={cn(
        "underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground",
        className,
      )}
    >
      {children}
    </a>
  );
}
