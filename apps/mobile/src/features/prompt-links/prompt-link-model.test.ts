import { parseNewThreadLink } from "@t3tools/shared/promptLinks";
import { describe, expect, it } from "vite-plus/test";
import {
  linkedThreadPromptDelivery,
  promptLinkRequestsSend,
  promptLinkSearchFromParams,
} from "./prompt-link-model";
describe("promptLinkSearchFromParams", () => {
  it("round-trips decoded route params into the shared parser", () => {
    const search = promptLinkSearchFromParams({
      prompt: "Fix the bug & add tests = done?",
      repo: ["pingdotgg/t3code", "ignored/second"],
      provider: "codex",
      screen: "NewTask",
    });
    expect(parseNewThreadLink(search ?? "")).toEqual({
      ok: true,
      value: {
        kind: "new",
        prompt: {
          text: "Fix the bug & add tests = done?",
          hiddenCharacters: 0,
        },
        repository: {
          owner: "pingdotgg",
          name: "t3code",
        },
        provider: "codex",
        model: null,
      },
    });
  });
});
describe("linkedThreadPromptDelivery", () => {
  const allowed = {
    sendRequested: true,
    sendEnabled: true,
    launchedFromHistory: false,
    hiddenCharacters: 0,
  };
  it("sends only when the link asks and the user opted in", () => {
    expect(linkedThreadPromptDelivery(allowed)).toEqual({
      kind: "send",
    });
    expect(
      linkedThreadPromptDelivery({
        ...allowed,
        sendRequested: false,
      }),
    ).toEqual({
      kind: "draft",
      sendBlocked: null,
    });
    expect(
      linkedThreadPromptDelivery({
        ...allowed,
        sendEnabled: false,
      }),
    ).toEqual({
      kind: "draft",
      sendBlocked: "disabled",
    });
  });
  it("drafts a replayed launch or a prompt that hid characters", () => {
    expect(
      linkedThreadPromptDelivery({
        ...allowed,
        launchedFromHistory: true,
      }),
    ).toEqual({
      kind: "draft",
      sendBlocked: "reopened",
    });
    expect(
      linkedThreadPromptDelivery({
        ...allowed,
        hiddenCharacters: 2,
      }),
    ).toEqual({
      kind: "draft",
      sendBlocked: "hidden-characters",
    });
  });
});
describe("promptLinkRequestsSend", () => {
  it.each(["send=1", "send=true", "send=YES"])("accepts %s", (search) => {
    expect(promptLinkRequestsSend(search)).toBe(true);
  });
  it.each(["", "send=0", "send=", "prompt=hi"])("rejects %s", (search) => {
    expect(promptLinkRequestsSend(search)).toBe(false);
  });
});
