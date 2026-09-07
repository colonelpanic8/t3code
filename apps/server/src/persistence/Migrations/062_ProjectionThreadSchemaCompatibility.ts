import * as Effect from "effect/Effect";

import Migration0034 from "./034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./036_ProjectionThreadsPinned.ts";
import Migration0048 from "./048_ProjectionThreadBranchPullRequest.ts";
import Migration0049 from "./049_ProjectionThreadsActiveOrderKey.ts";

export default Effect.gen(function* () {
  yield* Migration0034;
  yield* Migration0035;
  yield* Migration0036;
  yield* Migration0048;
  yield* Migration0049;
});
