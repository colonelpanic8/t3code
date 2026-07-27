import { parseStackProvenance } from "./stackProvenance.logic";

/**
 * What this build is assembled from, when it was assembled by the stack
 * rebuild. Null for an ordinary build of a plain checkout, which is most of
 * them -- there is no stack to describe.
 *
 * Embedded as text rather than an object literal so the bundle carries one
 * string constant. Only the Build route imports this module, so the parse
 * happens when that route's chunk loads.
 */
export const STACK_PROVENANCE = parseStackProvenance(import.meta.env.STACK_BUILD_INFO ?? "");
