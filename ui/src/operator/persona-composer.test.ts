import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonaComposerModal } from "./persona-composer";
import { OPERATOR_PERSONA_TEMPLATES } from "./persona-templates";

describe("PersonaComposerModal", () => {
  let modal: PersonaComposerModal;

  beforeEach(() => {
    modal = new PersonaComposerModal();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("attaches to body and shows the initial text on open", () => {
    modal.open("hello world", () => {});
    const ta = document.querySelector<HTMLTextAreaElement>(
      ".persona-composer__textarea",
    );
    expect(ta).not.toBeNull();
    expect(ta!.value).toBe("hello world");
  });

  it("renders one pill per shipped template", () => {
    modal.open("", () => {});
    const pills = document.querySelectorAll(".persona-composer__template");
    expect(pills.length).toBe(OPERATOR_PERSONA_TEMPLATES.length);
  });

  it("loading a template into an empty editor replaces text without confirm", () => {
    modal.open("", () => {});
    const confirmSpy = vi.spyOn(window, "confirm");
    const firstPill = document.querySelector<HTMLButtonElement>(
      ".persona-composer__template",
    );
    firstPill!.click();
    const ta = document.querySelector<HTMLTextAreaElement>(
      ".persona-composer__textarea",
    )!;
    expect(ta.value).toBe(OPERATOR_PERSONA_TEMPLATES[0].persona);
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("loading a template into non-empty editor prompts confirm", () => {
    modal.open("existing content", () => {});
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const firstPill = document.querySelector<HTMLButtonElement>(
      ".persona-composer__template",
    );
    firstPill!.click();
    expect(confirmSpy).toHaveBeenCalledOnce();
    const ta = document.querySelector<HTMLTextAreaElement>(
      ".persona-composer__textarea",
    )!;
    expect(ta.value).toBe(OPERATOR_PERSONA_TEMPLATES[0].persona);
    confirmSpy.mockRestore();
  });

  it("declined confirm leaves text untouched", () => {
    modal.open("existing content", () => {});
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const firstPill = document.querySelector<HTMLButtonElement>(
      ".persona-composer__template",
    );
    firstPill!.click();
    const ta = document.querySelector<HTMLTextAreaElement>(
      ".persona-composer__textarea",
    )!;
    expect(ta.value).toBe("existing content");
    confirmSpy.mockRestore();
  });

  it("Save fires onSave with current text and removes modal from DOM", () => {
    const onSave = vi.fn();
    modal.open("initial", onSave);
    const ta = document.querySelector<HTMLTextAreaElement>(
      ".persona-composer__textarea",
    )!;
    ta.value = "edited";
    const saveBtn = document.querySelector<HTMLButtonElement>(
      ".persona-composer__save",
    )!;
    saveBtn.click();
    expect(onSave).toHaveBeenCalledWith("edited");
    expect(document.querySelector(".persona-composer")).toBeNull();
  });

  it("Esc closes without firing onSave", () => {
    const onSave = vi.fn();
    modal.open("initial", onSave);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector(".persona-composer")).toBeNull();
  });

  it("Cmd+S triggers save", () => {
    const onSave = vi.fn();
    modal.open("foo", onSave);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true }),
    );
    expect(onSave).toHaveBeenCalledWith("foo");
    expect(document.querySelector(".persona-composer")).toBeNull();
  });

  it("backdrop click does NOT close", () => {
    const onSave = vi.fn();
    modal.open("foo", onSave);
    const backdrop = document.querySelector<HTMLElement>(
      ".persona-composer__backdrop",
    )!;
    backdrop.click();
    expect(document.querySelector(".persona-composer")).not.toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Esc keydown handler is removed after close", () => {
    const onSave = vi.fn();
    modal.open("foo", onSave);
    const closeBtn = document.querySelector<HTMLButtonElement>(
      ".persona-composer__cancel",
    )!;
    closeBtn.click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onSave).not.toHaveBeenCalled();
  });
});
