import { ServerIcon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentBadge } from "./EnvironmentBadge";

describe("EnvironmentBadge", () => {
  it("renders the environment name next to an accessible host icon", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentBadge icon={ServerIcon} label="ryzen-shine" iconClassName="size-3.5" />,
    );

    expect(markup).toContain('aria-label="Environment: ryzen-shine"');
    expect(markup).toContain("thread-environment-label");
    expect(markup).toContain(">ryzen-shine</span>");
    expect(markup.indexOf(">ryzen-shine</span>")).toBeLessThan(markup.indexOf("<svg"));
  });
});
