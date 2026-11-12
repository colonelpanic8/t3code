import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { assistantMessageRows, assistantModelRows } from "./assistant-rows";

describe("assistantMessageRows", () => {
  it("keeps the newest user and assistant messages, clipped, most recent first", () => {
    const rows = assistantMessageRows({
      environmentId: "env",
      environmentName: "Laptop",
      threadId: "t",
      threadTitle: "Fix login",
      limit: 2,
      messages: [
        { id: "1", role: "user", text: "first", createdAt: "2026-10-18T10:00:00.000Z" },
        { id: "2", role: "system", text: "setup", createdAt: "2026-10-18T10:01:00.000Z" },
        {
          id: "3",
          role: "assistant",
          text: "x".repeat(1500),
          createdAt: "2026-10-18T10:02:00.000Z",
        },
        { id: "4", role: "assistant", text: "  ", createdAt: "2026-10-18T10:03:00.000Z" },
        { id: "5", role: "user", text: "latest", createdAt: "2026-10-18T10:04:00.000Z" },
      ],
    });
    expect(rows.map((row) => row.id)).toEqual(["5", "3"]);
    expect(Array.from(rows[1]!.text)).toHaveLength(1000);
    expect(rows[0]).toMatchObject({ environmentName: "Laptop", threadTitle: "Fix login" });
  });
});

describe("assistantModelRows", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: "codex",
      displayName: "Codex",
      enabled: true,
      status: "ready",
      models: [
        { slug: "gpt-a", name: "GPT A", isCustom: false, isDefault: true },
        { slug: "gpt-b", name: "GPT B", isCustom: false },
      ],
    },
    {
      instanceId: ProviderInstanceId.make("claude"),
      driver: "claudeAgent",
      enabled: false,
      status: "disabled",
      models: [{ slug: "opus", name: "Opus", isCustom: false }],
    },
  ] as unknown as ReadonlyArray<ServerProvider>;

  it("lists one row per model and explains a provider with none to offer", () => {
    const rows = assistantModelRows({
      environmentId: "env",
      environmentName: "Laptop",
      providers,
      provider: null,
      q: null,
    });
    expect(rows.map((row) => [row.provider, row.model, row.isDefault, row.status])).toEqual([
      ["codex", "gpt-a", 1, "ready"],
      ["codex", "gpt-b", 0, "ready"],
      ["claude", "", 0, "disabled"],
    ]);
    expect(rows[2]?.note).toBe("This provider is turned off.");
  });

  it("filters by provider and by a name fragment", () => {
    const filter = (provider: string | null, q: string | null) =>
      assistantModelRows({ environmentId: "env", environmentName: "", providers, provider, q }).map(
        (row) => row.model,
      );
    expect(filter("codex", "b")).toEqual(["gpt-b"]);
    expect(filter(null, "codex")).toEqual(["gpt-a", "gpt-b"]);
  });
});
