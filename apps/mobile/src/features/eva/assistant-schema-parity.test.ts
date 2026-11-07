import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { assistantArgumentsDecode, type AssistantOperationName } from "./assistant-requests";
import { THREAD_ACTION_OPERATIONS } from "./assistant-thread-actions";

interface PropertySchema {
  readonly type: "string" | "integer";
  readonly enum?: ReadonlyArray<string>;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

interface InputSchema {
  readonly properties: Record<string, PropertySchema>;
  readonly required: ReadonlyArray<string>;
}

// The native module's advertised input schemas; its EvaSchemaParityTest keeps this file current.
const schemas = JSON.parse(
  NodeFS.readFileSync(
    new URL(
      "../../../modules/t3-eva-extension/android/src/test/resources/eva-input-schemas.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, InputSchema>;

const OPERATIONS: ReadonlyArray<AssistantOperationName> = [
  "start_thread",
  "send_message",
  ...THREAD_ACTION_OPERATIONS,
];

/** Values at the edges of what EVA's schema lets through. */
function samples(schema: PropertySchema): ReadonlyArray<unknown> {
  if (schema.enum) return schema.enum;
  if (schema.type === "integer") return [schema.minimum, schema.maximum];
  return ["a".repeat(Math.max(schema.minLength ?? 1, 1)), "a".repeat(schema.maxLength ?? 1)];
}

describe("advertised input schemas", () => {
  it("covers every operation the executor runs", () => {
    for (const operation of OPERATIONS) expect(schemas[operation], operation).toBeDefined();
  });

  it("decode every value EVA can send, one property at a time", () => {
    for (const operation of OPERATIONS) {
      const { properties, required } = schemas[operation]!;
      const base = Object.fromEntries(
        required.map((name) => [name, samples(properties[name]!)[0]]),
      );
      for (const [name, schema] of Object.entries(properties)) {
        for (const value of samples(schema)) {
          expect(
            assistantArgumentsDecode(operation, { ...base, [name]: value }),
            `${operation}.${name}=${String(value).slice(0, 20)}`,
          ).toBe(true);
        }
      }
    }
  });
});
