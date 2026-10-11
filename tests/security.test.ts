import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseMessages } from "../src/stream/message-parsing.js";
import { assertSafeCursorBaseUrl, redactSecrets } from "../src/utils/security.js";
import { debugLog, resetStreamDebugForTests, sanitizeForDebug } from "../src/stream/debug-log.js";

describe("Cursor endpoint validation", () => {
  it("requires TLS for remote Cursor endpoints", () => {
    expect(() => assertSafeCursorBaseUrl("http://agent.cursor.sh")).toThrow(/HTTPS/);
    expect(assertSafeCursorBaseUrl("https://agent.cursor.sh///")).toBe("https://agent.cursor.sh");
  });

  it("allows plaintext only for loopback development servers", () => {
    expect(assertSafeCursorBaseUrl("http://localhost:8080/test/")).toBe(
      "http://localhost:8080/test",
    );
    expect(assertSafeCursorBaseUrl("http://[::1]:8080/test")).toBe("http://[::1]:8080/test");
  });

  it("rejects embedded credentials and unrelated hosts", () => {
    expect(() => assertSafeCursorBaseUrl("https://token@agent.cursor.sh")).toThrow(/credentials/);
    expect(() => assertSafeCursorBaseUrl("https://cursor.sh.example.test")).toThrow(/not allowed/);
  });
});

describe("secret redaction", () => {
  it("redacts JWTs and bearer tokens in error text", () => {
    const jwt = [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "eyJzdWIiOiIxMjM0In0",
      "signaturepad",
    ].join(".");
    expect(redactSecrets(`Cursor token refresh failed: ${jwt}`)).toContain("[redacted-jwt]");
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).toMatch(/\[redacted\]/);
  });

  it("redacts refresh tokens in debug payloads", () => {
    const sanitized = sanitizeForDebug({
      refreshToken: "secret-refresh",
      access: "secret-access",
      modelId: "composer-2",
    }) as Record<string, unknown>;
    expect(sanitized.refreshToken).toBe("<redacted>");
    expect(sanitized.access).toBe("<redacted>");
    expect(sanitized.modelId).toBe("composer-2");
  });
});

describe("explicit credential diagnostics", () => {
  it("redacts normalized credential keys while preserving useful content", () => {
    const value = sanitizeForDebug({
      token: "CANARY-token",
      PASSWORD: "CANARY-password",
      client_secret: "CANARY-secret",
      "Api-Key": "CANARY-api",
      credential: "CANARY-credential",
      session_token: "CANARY-session",
      nested: { secret: "CANARY-nested" },
      tokenCount: 42,
      secretPolicy: "keep",
      message: "use the registered tool",
      session: "conversation-1",
    });
    expect(JSON.stringify(value)).not.toContain("CANARY");
    expect(value).toMatchObject({
      tokenCount: 42,
      secretPolicy: "keep",
      message: "use the registered tool",
      session: "conversation-1",
    });
  });

  it.each([
    'password="CANARY with spaces" next=keep',
    "client_secret='CANARY with spaces' next=keep",
    "api_key=CANARY&next=keep",
    "session-token: CANARY, next=keep",
    "credential=CANARY next=keep",
    "Authorization: Basic CANARY next=keep",
    '"refresh_token":"CANARY", next=keep',
  ])("redacts explicit assignment %s", (input) => {
    const result = redactSecrets(input);
    expect(result).not.toContain("CANARY");
    expect(result).not.toContain("with spaces");
    expect(result).toContain("next=keep");
  });

  it("does not match credential-looking suffixes or ordinary prose", () => {
    const input = "tokenCount=42 notpassword=visible secretPolicy=keep password reset instructions";
    expect(redactSecrets(input)).toBe(input);
  });
});

it("redacts long quoted assignments before truncating debug text", () => {
  const result = sanitizeForDebug('password="CANARY ' + "x".repeat(5000) + '" next=keep');
  expect(result).not.toContain("CANARY");
  expect(result).toContain("next=keep");
  expect(String(sanitizeForDebug("x".repeat(5000))).length).toBeLessThan(4100);
});

it.each([
  { nested: [{ "x-api-key": "CANARY-header", X_API_KEY: "CANARY-normalized" }] },
  {
    message:
      'x-api-key=CANARY-bare next=keep; "X-Api-Key":"CANARY quoted value"; x_api_key=CANARY-underscore',
  },
])("redacts API-key header canaries through the actual debug sink", async (payload) => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-debug-redaction-"));
  const path = join(directory, "debug.jsonl");
  vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG", "1");
  vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG_FILE", path);
  resetStreamDebugForTests();
  try {
    debugLog("server_message", { ...payload, benign: "prefix-x-api-key=keep", keyCount: 2 });
    let text = "";
    await vi.waitFor(async () => {
      text = await readFile(path, "utf8");
      expect(text.endsWith("\n")).toBe(true);
    });
    expect(text).not.toContain("CANARY");
    expect(text).not.toContain("quoted value");
    expect(JSON.parse(text)).toMatchObject({
      event: "server_message",
      benign: "prefix-x-api-key=keep",
      keyCount: 2,
    });
  } finally {
    vi.unstubAllEnvs();
    resetStreamDebugForTests();
    await rm(directory, { recursive: true, force: true });
  }
});

it("redacts image URL assignments logged before production image validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-image-redaction-"));
  const path = join(directory, "debug.jsonl");
  vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG", "1");
  vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG_FILE", path);
  resetStreamDebugForTests();
  try {
    expect(() =>
      parseMessages([
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.test/image?x-api-key=CANARY-image&next=keep" },
            },
          ],
        },
      ]),
    ).toThrow(/Remote image URLs are not supported/);
    let text = "";
    await vi.waitFor(async () => {
      text = await readFile(path, "utf8");
      expect(text.endsWith("\n")).toBe(true);
    });
    expect(text).not.toContain("CANARY-image");
    expect(JSON.parse(text)).toMatchObject({
      event: "parse_messages.start",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.test/image?x-api-key=[redacted]&next=keep" },
            },
          ],
        },
      ],
    });
  } finally {
    vi.unstubAllEnvs();
    resetStreamDebugForTests();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  { type: "authorization=CANARY", image_url: { url: "https://example.test/image" } },
  { type: "authorization=CANARY", mimeType: "image/png", data: "aGVsbG8=" },
  { type: "authorization=CANARY", mimeType: "image/png", data: new Uint8Array([1, 2]) },
  { type: "image", mimeType: "image/png authorization=CANARY", data: "aGVsbG8=" },
  { type: "image", mimeType: "image/png authorization=CANARY", data: new Uint8Array([1, 2]) },
  { type: "image_url", image_url: { url: "data:image/png authorization=CANARY;base64,aGVsbG8=" } },
])(
  "redacts recognized assignments in every image summary string at the JSONL sink",
  async (image) => {
    const directory = await mkdtemp(join(tmpdir(), "cursor-image-metadata-redaction-"));
    const path = join(directory, "debug.jsonl");
    vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG", "1");
    vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG_FILE", path);
    resetStreamDebugForTests();
    try {
      debugLog("image_metadata", { image, benign: "keep" });
      let text = "";
      await vi.waitFor(async () => {
        text = await readFile(path, "utf8");
        expect(text.endsWith("\n")).toBe(true);
      });
      expect(text.toLowerCase()).not.toContain("canary");
      expect(text).toContain("authorization=[redacted]");
      expect(JSON.parse(text)).toMatchObject({ event: "image_metadata", benign: "keep" });
      expect(text).toContain(image.image_url ? "image_url" : "byteLength");
    } finally {
      vi.unstubAllEnvs();
      resetStreamDebugForTests();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
