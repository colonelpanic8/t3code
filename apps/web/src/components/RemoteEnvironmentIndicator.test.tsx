import { ServerIcon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import {
  RemoteEnvironmentIndicator,
  shouldShowRemoteEnvironmentIndicator,
} from "./RemoteEnvironmentIndicator";

describe("RemoteEnvironmentIndicator", () => {
  const primaryEnvironmentId = EnvironmentId.make("primary");
  const remoteEnvironmentId = EnvironmentId.make("remote");
  const wslEnvironmentId = EnvironmentId.make("wsl");

  it("renders the environment name next to an accessible remote icon", () => {
    const markup = renderToStaticMarkup(
      <RemoteEnvironmentIndicator icon={ServerIcon} label="ryzen-shine" iconClassName="size-3.5" />,
    );

    expect(markup).toContain('aria-label="Remote environment: ryzen-shine"');
    expect(markup).toContain("thread-remote-environment-label");
    expect(markup).toContain(">ryzen-shine</span>");
    expect(markup.indexOf(">ryzen-shine</span>")).toBeLessThan(markup.indexOf("<svg"));
  });

  it("only identifies non-local secondary environments as remote", () => {
    expect(
      shouldShowRemoteEnvironmentIndicator({
        presenceScope: {
          kind: "local-owner",
          localEnvironmentId: primaryEnvironmentId,
        },
        threadEnvironmentId: remoteEnvironmentId,
        isDesktopLocal: false,
      }),
    ).toBe(true);
    expect(
      shouldShowRemoteEnvironmentIndicator({
        presenceScope: {
          kind: "local-owner",
          localEnvironmentId: primaryEnvironmentId,
        },
        threadEnvironmentId: wslEnvironmentId,
        isDesktopLocal: true,
      }),
    ).toBe(false);
    expect(
      shouldShowRemoteEnvironmentIndicator({
        presenceScope: {
          kind: "local-owner",
          localEnvironmentId: primaryEnvironmentId,
        },
        threadEnvironmentId: primaryEnvironmentId,
        isDesktopLocal: false,
      }),
    ).toBe(false);
  });

  it("identifies every environment as remote for a client-only app", () => {
    expect(
      shouldShowRemoteEnvironmentIndicator({
        presenceScope: { kind: "remote-client" },
        threadEnvironmentId: remoteEnvironmentId,
        isDesktopLocal: false,
      }),
    ).toBe(true);
  });
});
