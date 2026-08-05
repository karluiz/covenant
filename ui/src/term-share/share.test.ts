import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../notifications/toast", () => ({ pushInfoToast: vi.fn() }));
vi.mock("../ui/clipboard", () => ({ copyText: vi.fn(async () => {}) }));

import { invoke } from "@tauri-apps/api/core";
import {
  isTermShared,
  isRoShared,
  isCollabShared,
  shareSession,
  stopSharing,
  revokeIfShared,
  _resetForTest,
} from "./share";

const mockInvoke = vi.mocked(invoke);

describe("term-share local state", () => {
  beforeEach(() => {
    _resetForTest();
    mockInvoke.mockReset();
  });

  it("marks a session shared after shareSession (ro)", async () => {
    mockInvoke.mockResolvedValue({ shareId: 1, token: "t", url: "u", mode: "ro" });
    expect(isTermShared("S1")).toBe(false);
    await shareSession("S1", "ro");
    expect(isTermShared("S1")).toBe(true);
    expect(isRoShared("S1")).toBe(true);
    expect(isCollabShared("S1")).toBe(false);
  });

  it("keeps ro and collab shares independent for the same session", async () => {
    mockInvoke.mockResolvedValue({ shareId: 1, token: "a", url: "u1", mode: "ro" });
    await shareSession("S1", "ro");
    mockInvoke.mockResolvedValue({ shareId: 2, token: "b", url: "u2", mode: "collab" });
    await shareSession("S1", "collab");

    expect(isRoShared("S1")).toBe(true);
    expect(isCollabShared("S1")).toBe(true);
    expect(isTermShared("S1")).toBe(true);

    mockInvoke.mockResolvedValue(undefined);
    await stopSharing("S1", "ro");
    expect(isRoShared("S1")).toBe(false);
    expect(isCollabShared("S1")).toBe(true);
    expect(isTermShared("S1")).toBe(true);
  });

  it("clears the flag after stopSharing", async () => {
    mockInvoke.mockResolvedValue({ shareId: 1, token: "t", url: "u", mode: "ro" });
    await shareSession("S1", "ro");
    mockInvoke.mockResolvedValue(undefined);
    await stopSharing("S1", "ro");
    expect(isTermShared("S1")).toBe(false);
  });

  it("revokeIfShared revokes all modes for a shared session and clears both flags", async () => {
    mockInvoke.mockResolvedValue({ shareId: 1, token: "a", url: "u1", mode: "ro" });
    await shareSession("S1", "ro");
    mockInvoke.mockResolvedValue({ shareId: 2, token: "b", url: "u2", mode: "collab" });
    await shareSession("S1", "collab");
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);

    const result = revokeIfShared("S1");
    expect(result).toBeUndefined();
    expect(isTermShared("S1")).toBe(false);
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("term_share_revoke", {
        sessionId: "S1",
        mode: "ro",
      });
      expect(mockInvoke).toHaveBeenCalledWith("term_share_revoke", {
        sessionId: "S1",
        mode: "collab",
      });
    });
  });

  it("revokeIfShared no-ops for a session that isn't shared", () => {
    const result = revokeIfShared("S2");
    expect(result).toBeUndefined();
    expect(isTermShared("S2")).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
