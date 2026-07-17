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
