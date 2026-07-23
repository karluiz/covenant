import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../notifications/toast", () => ({ pushInfoToast: vi.fn() }));
vi.mock("../ui/clipboard", () => ({ copyText: vi.fn(async () => {}) }));

import { invoke } from "@tauri-apps/api/core";
import { isTermShared, shareSession, stopSharing, revokeIfShared, _resetForTest } from "./share";

const mockInvoke = vi.mocked(invoke);

describe("term-share local state", () => {
  beforeEach(() => {
    _resetForTest();
    mockInvoke.mockReset();
  });

  it("marks a session shared after shareSession", async () => {
    mockInvoke.mockResolvedValue({ shareId: 1, token: "t", url: "u" });
    expect(isTermShared("S1")).toBe(false);
    await shareSession("S1");
    expect(isTermShared("S1")).toBe(true);
  });

  it("clears the flag after stopSharing", async () => {
    mockInvoke.mockResolvedValue({ shareId: 1, token: "t", url: "u" });
    await shareSession("S1");
    mockInvoke.mockResolvedValue(undefined);
    await stopSharing("S1");
    expect(isTermShared("S1")).toBe(false);
  });

  it("revokeIfShared revokes a shared session and clears the flag", async () => {
    mockInvoke.mockResolvedValue({ shareId: 1, token: "t", url: "u" });
    await shareSession("S1");
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);

    const result = revokeIfShared("S1");
    expect(result).toBeUndefined();
    expect(isTermShared("S1")).toBe(false);
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("term_share_revoke", { sessionId: "S1" });
    });
  });

  it("revokeIfShared no-ops for a session that isn't shared", () => {
    const result = revokeIfShared("S2");
    expect(result).toBeUndefined();
    expect(isTermShared("S2")).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
