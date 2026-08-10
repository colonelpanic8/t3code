import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { orderedListGutterStyle } from "./ChatMarkdown";

import type { AssetUrlState } from "../assets/assetUrls";

const assetUrlState = vi.hoisted(() => ({
  current: { _tag: "Success", url: "https://environment.example/assets/shot.png" } as AssetUrlState,
  requests: [] as Array<unknown>,
}));

vi.mock("../assets/assetUrls", () => ({
  useAssetUrlState: (environmentId: unknown, resource: unknown) => {
    assetUrlState.requests.push({ environmentId, resource });
    return assetUrlState.current;
  },
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => undefined }));
vi.mock("../state/assets", () => ({ assetEnvironment: { createUrl: () => ({}) } }));
vi.mock("../state/server", () => ({ serverEnvironment: { configValueAtom: () => ({}) } }));
vi.mock("../state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("../state/entities", () => ({ useActiveEnvironmentId: () => "environment-1" }));
vi.mock("../state/session", () => ({ usePreparedConnection: () => ({ _tag: "None" }) }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => () => Promise.resolve() }));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => () => Promise.resolve(),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => () => Promise.resolve(),
}));

const ChatMarkdown = (await import("./ChatMarkdown")).default;

const CWD = "/home/dev/project";
const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

function render(text: string): string {
  return renderToStaticMarkup(<ChatMarkdown text={text} cwd={CWD} threadRef={threadRef} />);
}

describe("ChatMarkdown images", () => {
  beforeEach(() => {
    assetUrlState.current = {
      _tag: "Success",
      url: "https://environment.example/assets/shot.png",
    };
    assetUrlState.requests = [];
  });

  it("serves a workspace image path through a signed asset url", () => {
    const markup = render("![portrait pip](docs/shots/portrait.png)");

    expect(assetUrlState.requests).toEqual([
      {
        environmentId: threadRef.environmentId,
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: `${CWD}/docs/shots/portrait.png`,
        },
      },
    ]);
    expect(markup).toContain('src="https://environment.example/assets/shot.png"');
    expect(markup).toContain('alt="portrait pip"');
    expect(markup).not.toContain('src="docs/shots/portrait.png"');
  });

  it("resolves absolute workspace paths the agent writes out in full", () => {
    render(`![landscape pip](${CWD}/docs/shots/landscape.png)`);

    expect(assetUrlState.requests).toEqual([
      {
        environmentId: threadRef.environmentId,
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: `${CWD}/docs/shots/landscape.png`,
        },
      },
    ]);
  });

  it("falls back to a file chip when the environment refuses the asset", () => {
    assetUrlState.current = { _tag: "Failure" };

    const markup = render("![docked](docs/shots/docked.png)");

    expect(markup).not.toContain("<img");
    expect(markup).toContain("docked.png");
    expect(markup).toContain("chat-markdown-file-link");
  });

  it("leaves remote image sources untouched", () => {
    const markup = render("![logo](https://example.com/logo.png)");

    expect(assetUrlState.requests).toEqual([]);
    expect(markup).toContain('src="https://example.com/logo.png"');
  });
});

describe("orderedListGutterStyle", () => {
  it("leaves the default gutter alone for single-digit lists", () => {
    expect(orderedListGutterStyle(9, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for two-digit lists", () => {
    expect(orderedListGutterStyle(99, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for a two-digit list that starts above 1", () => {
    // start=50 + 49 items => last marker is "98", still two digits.
    expect(orderedListGutterStyle(49, 50)).toBeUndefined();
  });

  it("widens the gutter once the last marker reaches three digits", () => {
    // item 100 is the bug from #6512: a 100-item list starting at 1.
    expect(orderedListGutterStyle(100, undefined)).toEqual({ "--list-gutter": "4ch" });
  });

  it("accounts for a non-default start attribute", () => {
    // start=95 + 9 items => last marker is "103", three digits.
    expect(orderedListGutterStyle(9, 95)).toEqual({ "--list-gutter": "4ch" });
  });

  it("scales further for four-digit markers", () => {
    expect(orderedListGutterStyle(1000, undefined)).toEqual({ "--list-gutter": "5ch" });
  });

  it("treats a missing/zero item count as a single item", () => {
    expect(orderedListGutterStyle(0, undefined)).toBeUndefined();
  });
});
||||||| parent of d2a449fff (Rebase PR #4631 onto orchestration v2 + latest main)
