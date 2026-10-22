import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";
import { parseFleetEnrollmentLink, parseFleetEnrollmentUrl } from "./fleetEnrollmentLink";
const INVALID = Result.fail("That fleet enrollment link is not a plain https:// address.");
describe("parseFleetEnrollmentUrl", () => {
  it("accepts the deep link param's https URL", () => {
    expect(
      parseFleetEnrollmentUrl(" https://example.github.io/dotfiles/t3code/fleet.age "),
    ).toEqual(Result.succeed("https://example.github.io/dotfiles/t3code/fleet.age"));
  });
  it.each([
    ["plain http", "http://example.test/fleet.age"],
    ["embedded credentials", "https://user:secret@example.test/fleet.age"],
    ["a bare username", "https://user@example.test/fleet.age"],
    ["a relative path", "/fleet.age"],
    ["a non-web scheme", "file:///sdcard/fleet.age"],
    ["a repeated query param", ["https://a.test/fleet.age", "https://b.test/fleet.age"]],
  ])("rejects %s", (_case, value) => {
    expect(parseFleetEnrollmentUrl(value)).toEqual(INVALID);
  });
});
describe("parseFleetEnrollmentLink", () => {
  it("reads the file URL from a scanned page URL", () => {
    expect(
      parseFleetEnrollmentLink(
        "https://example.github.io/dotfiles/t3code/?fleetEnrollment=https%3A%2F%2Fexample.github.io%2Fdotfiles%2Ft3code%2Ffleet.age",
      ),
    ).toEqual(Result.succeed("https://example.github.io/dotfiles/t3code/fleet.age"));
  });
  it("reads the file URL from a scanned deep link", () => {
    expect(
      parseFleetEnrollmentLink(
        "t3code-assembly://connections/new?fleetEnrollment=https%3A%2F%2Fexample.test%2Ffleet.age",
      ),
    ).toEqual(Result.succeed("https://example.test/fleet.age"));
  });
  it("rejects an enrollment link whose file URL is not https", () => {
    expect(
      parseFleetEnrollmentLink(
        "https://example.test/?fleetEnrollment=http%3A%2F%2Fexample.test%2Ff",
      ),
    ).toEqual(INVALID);
  });
  it.each([
    ["a pairing URL", "https://host.example.test/#token=abc"],
    ["text that is not a URL", "AGE-SECRET-KEY-1QQQ"],
    ["an empty payload", ""],
  ])("leaves %s to the pairing parser", (_case, payload) => {
    expect(parseFleetEnrollmentLink(payload)).toBeNull();
  });
});
