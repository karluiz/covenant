import { it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const pushInfoToast = vi.fn();
vi.mock("../notifications/toast", () => ({ pushInfoToast }));

beforeEach(() => {
  invoke.mockReset();
  pushInfoToast.mockReset();
  Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
});

it("shareFileAsGist publishes, copies link, toasts", async () => {
  invoke.mockResolvedValue({ gistId: 1, token: "abc", url: "https://forge.covenant.uno/g/abc" });
  const { shareFileAsGist } = await import("./share");
  await shareFileAsGist("/tmp/main.rs");
  expect(invoke).toHaveBeenCalledWith("gist_publish", { path: "/tmp/main.rs" });
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://forge.covenant.uno/g/abc");
  expect(pushInfoToast).toHaveBeenCalled();
});

it("share/revoke keep the shared-paths cache in sync and fire the event", async () => {
  invoke.mockResolvedValue({ gistId: 1, token: "abc", url: "https://forge.covenant.uno/g/abc" });
  const { shareFileAsGist, revokeGist, isGistShared, GIST_SHARES_EVENT } = await import("./share");
  const onChange = vi.fn();
  window.addEventListener(GIST_SHARES_EVENT, onChange);

  expect(isGistShared("/tmp/other.rs")).toBe(false);
  await shareFileAsGist("/tmp/other.rs");
  expect(isGistShared("/tmp/other.rs")).toBe(true);
  expect(onChange).toHaveBeenCalledTimes(1);

  invoke.mockResolvedValue(undefined);
  await revokeGist("/tmp/other.rs");
  expect(isGistShared("/tmp/other.rs")).toBe(false);
  expect(onChange).toHaveBeenCalledTimes(2);
  window.removeEventListener(GIST_SHARES_EVENT, onChange);
});

it("ensureGistSharesLoaded seeds the cache from the backend", async () => {
  invoke.mockResolvedValue(["/tmp/shared.md"]);
  const { ensureGistSharesLoaded, isGistShared } = await import("./share");
  ensureGistSharesLoaded();
  await vi.waitFor(() => expect(isGistShared("/tmp/shared.md")).toBe(true));
  ensureGistSharesLoaded(); // idempotent — no second fetch
  expect(invoke).toHaveBeenCalledTimes(1);
});
