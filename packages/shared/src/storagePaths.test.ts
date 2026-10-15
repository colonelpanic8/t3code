// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "node:path";

import {
  applyT3StorageDirectoryOverrides,
  resolveDefaultT3StorageRoots,
  resolveLegacyT3StorageRoots,
  resolveT3StorageDirectoryOverrides,
  selectT3Storage,
  t3StorageEnvironment,
} from "./storagePaths.ts";

const path = {
  join: NodePath.posix.join,
  resolve: NodePath.posix.resolve,
  isAbsolute: NodePath.posix.isAbsolute,
};

const linuxDefaults = (environment: Readonly<Record<string, string | undefined>> = {}) =>
  resolveDefaultT3StorageRoots({
    platform: "linux",
    homeDirectory: "/home/alice",
    temporaryDirectory: "/tmp",
    userId: 1000,
    isDevelopment: false,
    environment,
    path,
  });

describe("T3 storage paths", () => {
  it("resolves all five Linux XDG roots independently", () => {
    expect(
      linuxDefaults({
        XDG_CONFIG_HOME: "/xdg/config",
        XDG_DATA_HOME: "/xdg/data",
        XDG_STATE_HOME: "/xdg/state",
        XDG_CACHE_HOME: "/xdg/cache",
        XDG_RUNTIME_DIR: "/run/user/1000",
      }),
    ).toEqual({
      layout: "split",
      configDir: "/xdg/config/t3code",
      dataDir: "/xdg/data/t3code",
      stateDir: "/xdg/state/t3code",
      cacheDir: "/xdg/cache/t3code",
      runtimeDir: "/run/user/1000/t3code",
    });
  });

  it("uses the XDG defaults and a per-user temporary runtime fallback", () => {
    expect(linuxDefaults()).toEqual({
      layout: "split",
      configDir: "/home/alice/.config/t3code",
      dataDir: "/home/alice/.local/share/t3code",
      stateDir: "/home/alice/.local/state/t3code",
      cacheDir: "/home/alice/.cache/t3code",
      runtimeDir: "/tmp/t3code-1000",
    });
  });

  it("ignores XDG variables on macOS, where a Finder-launched app never sees them", () => {
    expect(
      resolveDefaultT3StorageRoots({
        platform: "darwin",
        homeDirectory: "/Users/alice",
        temporaryDirectory: "/tmp",
        userId: 501,
        isDevelopment: false,
        environment: { XDG_CACHE_HOME: "/custom/cache", XDG_CONFIG_HOME: "/custom/config" },
        path,
      }),
    ).toEqual({
      layout: "split",
      configDir: "/Users/alice/Library/Application Support/t3code/config",
      dataDir: "/Users/alice/Library/Application Support/t3code/data",
      stateDir: "/Users/alice/Library/Application Support/t3code/state",
      cacheDir: "/Users/alice/Library/Caches/t3code",
      runtimeDir: "/Users/alice/Library/Application Support/t3code/runtime",
    });
  });

  it("ignores relative XDG base directories", () => {
    expect(
      linuxDefaults({
        XDG_CONFIG_HOME: "relative/config",
        XDG_RUNTIME_DIR: "relative/runtime",
      }),
    ).toMatchObject({
      configDir: "/home/alice/.config/t3code",
      runtimeDir: "/tmp/t3code-1000",
    });
  });

  it("applies granular T3 overrides without collapsing the other roots", () => {
    const overrides = resolveT3StorageDirectoryOverrides({
      environment: {
        T3CODE_CONFIG_DIR: "~/dotfiles/t3code",
        T3CODE_STATE_DIR: "/machine/t3code",
      },
      homeDirectory: "/home/alice",
      path,
    });

    expect(applyT3StorageDirectoryOverrides(linuxDefaults(), overrides)).toEqual({
      layout: "split",
      configDir: "/home/alice/dotfiles/t3code",
      dataDir: "/home/alice/.local/share/t3code",
      stateDir: "/machine/t3code",
      cacheDir: "/home/alice/.cache/t3code",
      runtimeDir: "/tmp/t3code-1000",
    });
  });

  it("models the legacy tree without pretending it has five independent roots", () => {
    const roots = resolveLegacyT3StorageRoots({
      baseDir: "/home/alice/.t3",
      stateDirectoryName: "userdata",
      path,
    });
    expect(roots).toEqual({
      layout: "legacy",
      configDir: "/home/alice/.t3/userdata",
      dataDir: "/home/alice/.t3",
      stateDir: "/home/alice/.t3/userdata",
      cacheDir: "/home/alice/.t3/caches",
      runtimeDir: "/home/alice/.t3/userdata",
      legacyBaseDir: "/home/alice/.t3",
    });
    expect(t3StorageEnvironment(roots)).toEqual({ T3CODE_HOME: "/home/alice/.t3" });
  });

  describe("selectT3Storage", () => {
    const select = (
      input: {
        readonly environment?: Readonly<Record<string, string | undefined>>;
        readonly existing?: ReadonlyArray<string>;
        readonly baseDir?: string;
        readonly forcedLayout?: "xdg" | "legacy";
        readonly isDevelopment?: boolean;
        readonly exists?: (path: string) => boolean;
      } = {},
    ) =>
      selectT3Storage({
        platform: "linux",
        homeDirectory: "/home/alice",
        temporaryDirectory: "/tmp",
        userId: 1000,
        isDevelopment: input.isDevelopment ?? false,
        environment: input.environment ?? {},
        path,
        baseDir: input.baseDir,
        forcedLayout: input.forcedLayout,
        exists: input.exists ?? ((candidate) => (input.existing ?? []).includes(candidate)),
      });
    const legacy = (stateDirectoryName: "userdata" | "dev" = "userdata") =>
      resolveLegacyT3StorageRoots({ baseDir: "/home/alice/.t3", stateDirectoryName, path });

    it("uses the split defaults for a new installation", () => {
      expect(select()).toEqual({
        _tag: "Selected",
        roots: linuxDefaults(),
        baseDirIsExplicit: false,
      });
    });

    it("keeps an initialized ~/.t3", () => {
      expect(select({ existing: ["/home/alice/.t3/userdata/statev2.sqlite"] })).toEqual({
        _tag: "Selected",
        roots: legacy(),
        baseDirIsExplicit: false,
      });
    });

    it("keeps ~/.t3 when only its caches show a legacy server ran there", () => {
      // A server whose config and data dirs are both overridden leaves nothing in userdata.
      expect(select({ existing: ["/home/alice/.t3/caches"] })).toMatchObject({ roots: legacy() });
    });

    it("keeps an initialized split install when something later initializes ~/.t3", () => {
      expect(
        select({
          existing: [
            "/home/alice/.local/state/t3code/statev2.sqlite",
            "/home/alice/.t3/userdata/statev2.sqlite",
          ],
        }),
      ).toEqual({
        _tag: "Selected",
        roots: linuxDefaults(),
        baseDirIsExplicit: false,
        shadowedLegacyStateDir: "/home/alice/.t3/userdata",
      });
    });

    it("names an explicit home's userdata even in development", () => {
      expect(select({ environment: { T3CODE_HOME: "~/t3" }, isDevelopment: true })).toEqual({
        _tag: "Selected",
        roots: resolveLegacyT3StorageRoots({
          baseDir: "/home/alice/t3",
          stateDirectoryName: "userdata",
          path,
        }),
        baseDirIsExplicit: true,
      });
      expect(select({ forcedLayout: "legacy", isDevelopment: true })).toMatchObject({
        roots: legacy("dev"),
        baseDirIsExplicit: false,
      });
    });

    it("lets selectors or a forced layout skip detection", () => {
      const existing = ["/home/alice/.t3/userdata/statev2.sqlite"];
      expect(select({ existing, forcedLayout: "xdg" })).toMatchObject({ roots: linuxDefaults() });
      expect(select({ existing, environment: { T3CODE_STATE_DIR: "/state" } })).toMatchObject({
        roots: { ...linuxDefaults(), stateDir: "/state" },
      });
    });

    it.each([
      [{ environment: { T3CODE_HOME: "/t3", T3CODE_CACHE_DIR: "/c" } }, "home-with-selectors"],
      [{ baseDir: "/t3", forcedLayout: "xdg" as const }, "xdg-with-home"],
    ])("reports conflicting controls %#", (input, conflict) => {
      const selection = select(input);
      expect(selection._tag === "Conflict" && selection.error.conflict).toBe(conflict);
    });

    it("lets command-line controls outrank inherited variables", () => {
      // A split service exports the selectors into every shell it starts.
      const inherited = { T3CODE_CONFIG_DIR: "/c", T3CODE_STATE_DIR: "/s" };
      expect(select({ baseDir: "/scratch", environment: inherited })).toMatchObject({
        roots: { layout: "legacy", legacyBaseDir: "/scratch" },
        baseDirIsExplicit: true,
      });
      expect(select({ forcedLayout: "legacy", environment: inherited })).toMatchObject({
        roots: legacy(),
      });
      expect(
        select({ forcedLayout: "legacy", environment: { ...inherited, T3CODE_HOME: "/t3" } }),
      ).toMatchObject({ roots: { legacyBaseDir: "/t3" }, baseDirIsExplicit: true });
      expect(select({ forcedLayout: "xdg", environment: { T3CODE_HOME: "/t3" } })).toMatchObject({
        roots: linuxDefaults(),
      });
    });

    it("fails rather than guess when a marker cannot be checked", () => {
      const selection = select({
        exists: (candidate) => {
          if (candidate.startsWith("/home/alice/.t3")) throw new Error("EACCES");
          return false;
        },
      });
      expect(selection._tag === "ProbeFailed" && selection.error.path).toBe(
        "/home/alice/.t3/userdata/state.sqlite",
      );
    });
  });
});
