import * as Brand from "effect/Brand";
import * as Result from "effect/Result";

/**
 * A fleet enrollment link names where to download a fleet file. It reaches
 * the app as the `fleetEnrollment` param of a deep link, or inside a scanned
 * page URL that forwards to that deep link. The link only starts an import:
 * the user still confirms its machines before anything joins.
 */
export const FLEET_ENROLLMENT_LINK_PARAM = "fleetEnrollment";

export type FleetEnrollmentUrl = string & Brand.Brand<"FleetEnrollmentUrl">;
const FleetEnrollmentUrl = Brand.nominal<FleetEnrollmentUrl>();

/** Validates a deep link's `fleetEnrollment` param, which is the file URL itself. */
export function parseFleetEnrollmentUrl(value: unknown): Result.Result<FleetEnrollmentUrl, string> {
  const invalid = Result.fail("That fleet enrollment link is not a plain https:// address.");
  if (typeof value !== "string") return invalid;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return invalid;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return invalid;
  return Result.succeed(FleetEnrollmentUrl(url.href));
}

/**
 * Reads a scanned payload. Null means it is not an enrollment link, so the
 * caller can try it as a pairing code instead.
 */
export function parseFleetEnrollmentLink(
  payload: string,
): Result.Result<FleetEnrollmentUrl, string> | null {
  let url: URL;
  try {
    url = new URL(payload.trim());
  } catch {
    return null;
  }
  const value = url.searchParams.get(FLEET_ENROLLMENT_LINK_PARAM);
  return value === null ? null : parseFleetEnrollmentUrl(value);
}
