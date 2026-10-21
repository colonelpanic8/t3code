import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  ResolvedKeybindingsConfig,
  KeybindingRule,
  ResolvedKeybindingRule,
} from "./keybindings.ts";
const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;
const decodeResolvedRule = Schema.decodeUnknownEffect(ResolvedKeybindingRule as never);
const encodeResolvedKeybindings = Schema.encodeEffect(ResolvedKeybindingsConfig);
it.effect("decodes direct model and reasoning selections", () =>
  Effect.gen(function* () {
    const parsedModelSelect = yield* decode(KeybindingRule, {
      key: "f15",
      command: "model.select.codex.gpt-5.6-sol",
    });
    assert.strictEqual(parsedModelSelect.command, "model.select.codex.gpt-5.6-sol");
    const parsedReasoningSelect = yield* decode(KeybindingRule, {
      key: "f19",
      command: "reasoning.select.high",
    });
    assert.strictEqual(parsedReasoningSelect.command, "reasoning.select.high");
  }),
);
it.effect("rejects malformed direct selection commands", () =>
  Effect.gen(function* () {
    for (const command of [
      "model.select.codex",
      "model.select.1bad.model",
      "model.select.codex.model with spaces",
      "reasoning.select.",
      "reasoning.select.extra.high",
    ]) {
      const result = yield* Effect.exit(
        decode(KeybindingRule, {
          key: "f13",
          command,
        }),
      );
      assert.strictEqual(result._tag, "Failure");
    }
  }),
);
const shortcut = {
  key: "p",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
};
it.effect("drops resolved rules with commands this build does not know", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      {
        command: "terminal.toggle",
        shortcut,
      },
      {
        command: "someFuture.toggle",
        shortcut,
      },
      {
        command: "filePicker.toggle",
        shortcut,
      },
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["terminal.toggle", "filePicker.toggle"],
    );
  }),
);
it.effect("drops malformed resolved rule entries", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      "garbage",
      {
        command: "terminal.toggle",
        shortcut,
      },
      null,
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["terminal.toggle"],
    );
  }),
);
