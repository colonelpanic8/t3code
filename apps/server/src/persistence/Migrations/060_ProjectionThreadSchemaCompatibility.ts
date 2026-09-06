import * as Effect from "effect/Effect";

import Migration0034 from "./034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./036_ProjectionThreadsPinned.ts";

export default Effect.gen(function* () {
  yield* Migration0034;
  yield* Migration0035;
  yield* Migration0036;
});
