// The ⌘S binding lives on the persistent pageHost, but `render()` rebuilds
// the form on every tab switch. These cover the two ways that goes wrong:
// stacking a listener per render, and holding a stale form reference.
import { it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

let host: HTMLElement;
let panelModule: typeof import("./panel");

beforeEach(async () => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  panelModule = await import("./panel");
});

/// Stand in for one `render()` pass: wipe the host, mount a fresh form.
function mountForm(): { form: HTMLFormElement; submit: ReturnType<typeof vi.fn> } {
  host.innerHTML = "";
  const form = document.createElement("form");
  form.className = "settings-form";
  const submit = vi.fn();
  form.requestSubmit = submit;
  host.appendChild(form);
  return { form, submit };
}

function pressSaveChord(target: HTMLElement): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }),
  );
}

it("⌘S submits the live form exactly once, however many renders happened", () => {
  new panelModule.SettingsPanel(host, document.createElement("div"));

  // Save on the first tab, switch tabs, save again — the second chord must
  // hit the form that is actually on screen, and only it.
  const first = mountForm();
  pressSaveChord(first.form);
  expect(first.submit).toHaveBeenCalledTimes(1);

  const second = mountForm(); // tab switch — first form is gone
  pressSaveChord(second.form);

  expect(second.submit).toHaveBeenCalledTimes(1);
  expect(first.submit).toHaveBeenCalledTimes(1); // no stale re-submit
});

it("ignores ⌘⇧S / ⌥⌘S so it can't hijack other chords", () => {
  new panelModule.SettingsPanel(host, document.createElement("div"));
  const { form, submit } = mountForm();

  form.dispatchEvent(
    new KeyboardEvent("keydown", { key: "s", metaKey: true, shiftKey: true, bubbles: true }),
  );
  form.dispatchEvent(
    new KeyboardEvent("keydown", { key: "s", metaKey: true, altKey: true, bubbles: true }),
  );

  expect(submit).not.toHaveBeenCalled();
});
