import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("embedding API", () => {
  it.each([
    "createCursorNativeStream",
    "getStartupCursorAccessToken",
    "discoverCursorCatalog",
    "cleanupSessionState",
  ])("exports %s without activating the extension", (name) => {
    expect((api as Record<string, unknown>)[name]).toBeTypeOf("function");
  });
});
