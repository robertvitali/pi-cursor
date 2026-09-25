import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCacheDir } from "../src/utils/cache-dir.js";
import {
  deleteConversationJournal,
  evictStaleJournals,
  readConversationJournal,
  writeConversationJournal,
} from "../src/stream/run-journal.js";
import type { StoredConversation } from "../src/stream/types.js";

vi.mock("../src/utils/cache-dir.js", () => ({ getCacheDir: vi.fn() }));

const stored: StoredConversation = {
  conversationId: "test-conversation",
  checkpoint: null,
  sessionScoped: true,
  sessionId: "test-session",
  blobStore: new Map([["blob", new Uint8Array([1, 2, 3])]]),
  lastAccessMs: Date.now(),
};
let cache: string;
beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "cursor-journal-test-"));
  vi.stubEnv("PI_CURSOR_RUN_JOURNAL", undefined);
  vi.mocked(getCacheDir).mockReturnValue(cache);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(cache, { recursive: true, force: true });
});

describe("journal persistence opt-out", () => {
  it("preserves default journal persistence and recovery", () => {
    expect(writeConversationJournal("conversation", stored)).toBe(true);
    expect(readConversationJournal("conversation")?.blobStore).toEqual(stored.blobStore);
    deleteConversationJournal("conversation");
    expect(readConversationJournal("conversation")).toBeUndefined();
  });

  it("does not resolve or create a journal directory when disabled", () => {
    vi.stubEnv("PI_CURSOR_RUN_JOURNAL", "0");
    expect(writeConversationJournal("conversation", stored)).toBe(false);
    expect(readConversationJournal("conversation")).toBeUndefined();
    deleteConversationJournal("conversation");
    expect(evictStaleJournals()).toBe(0);
    expect(getCacheDir).not.toHaveBeenCalled();
    expect(readdirSync(cache)).toEqual([]);
  });

  it("does not read, overwrite, delete or sweep existing journals when disabled", () => {
    expect(writeConversationJournal("conversation", stored)).toBe(true);
    const path = join(cache, "run-journal", "conversation.json");
    const before = readFileSync(path, "utf8");
    vi.mocked(getCacheDir).mockClear();
    vi.stubEnv("PI_CURSOR_RUN_JOURNAL", "0");
    expect(readConversationJournal("conversation")).toBeUndefined();
    expect(writeConversationJournal("conversation", { ...stored, conversationId: "changed" })).toBe(
      false,
    );
    deleteConversationJournal("conversation");
    expect(evictStaleJournals(Date.now() + 100_000, 0)).toBe(0);
    expect(getCacheDir).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
