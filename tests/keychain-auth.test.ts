import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  refresh: vi.fn(),
  expiry: vi.fn(),
  env: vi.fn(),
  exists: vi.fn(),
}));
vi.mock("node:util", async () => ({
  ...(await vi.importActual("node:util")),
  promisify: () => mocks.exec,
}));
vi.mock("node:os", async () => ({
  ...(await vi.importActual("node:os")),
  platform: () => "darwin",
}));
vi.mock("node:fs", async () => ({
  ...(await vi.importActual("node:fs")),
  existsSync: mocks.exists,
}));
vi.mock("../src/auth/oauth.js", () => ({
  refreshCursorToken: mocks.refresh,
  getTokenExpiry: mocks.expiry,
  getCursorAccessTokenFromEnv: mocks.env,
}));
vi.mock("../src/auth/refresh-guard.js", () => ({
  isRefreshKnownBad: () => false,
  markRefreshFailed: vi.fn(),
  markRefreshSucceeded: vi.fn(),
}));
import { getCursorKeychainToken } from "../src/auth/cli-credentials.js";

beforeEach(() => {
  vi.stubEnv("PI_CURSOR_SYSTEM_CREDENTIALS", undefined);
  mocks.exec.mockImplementation(async (_command, args) => ({
    stdout: args.includes("cursor-access-token") ? "fixture-access" : "fixture-refresh",
  }));
  mocks.expiry.mockReturnValue(Date.now() + 60_000);
  mocks.refresh.mockResolvedValue({ access: "fixture-refreshed" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("CLI-keychain-only embedding authentication", () => {
  it("uses a valid saved CLI token without consulting other credential stores", async () => {
    expect(await getCursorKeychainToken()).toEqual({
      accessToken: "fixture-access",
      source: "cli_keychain",
    });
    expect(mocks.exec).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.env).not.toHaveBeenCalled();
    expect(mocks.exists).not.toHaveBeenCalled();
    expect(
      mocks.exec.mock.calls.every(
        ([command, args]) => command === "security" && args[0] === "find-generic-password",
      ),
    ).toBe(true);
  });
  it("honors forced refresh even when the saved access token is still valid", async () => {
    expect(await getCursorKeychainToken({ forceRefresh: true })).toEqual({
      accessToken: "fixture-refreshed",
      source: "cli_keychain_refresh",
    });
    expect(mocks.refresh).toHaveBeenCalledWith("fixture-refresh");
  });
  it("refreshes expired CLI credentials", async () => {
    mocks.expiry.mockReturnValue(0);
    expect(await getCursorKeychainToken()).toEqual({
      accessToken: "fixture-refreshed",
      source: "cli_keychain_refresh",
    });
  });
  it("fails closed without falling back when forced refresh fails", async () => {
    mocks.refresh.mockRejectedValue(new Error("fixture failure"));
    expect(await getCursorKeychainToken({ forceRefresh: true })).toBeUndefined();
    expect(mocks.env).not.toHaveBeenCalled();
    expect(mocks.exists).not.toHaveBeenCalled();
  });
  it.each(["0", "false", "deny", "unrecognized"])(
    "respects system credential opt-out %s before keychain access",
    async (value) => {
      vi.stubEnv("PI_CURSOR_SYSTEM_CREDENTIALS", value);
      expect(await getCursorKeychainToken({ forceRefresh: true })).toBeUndefined();
      expect(mocks.exec).not.toHaveBeenCalled();
      expect(mocks.refresh).not.toHaveBeenCalled();
    },
  );
});
