import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../api", () => ({ canonCreateOrg: vi.fn().mockResolvedValue({}) }));

import { openCreateOrgExperience } from "./view";
import { canonCreateOrg } from "../../api";

function q<T extends Element>(sel: string): T {
  return document.querySelector(sel) as T;
}

describe("openCreateOrgExperience", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.mocked(canonCreateOrg).mockClear();
  });

  it("forms the identity live and creates on submit", async () => {
    const onCreated = vi.fn();
    openCreateOrgExperience({ onCreated });

    const surface = q<HTMLElement>(".canon-createorg");
    expect(surface).toBeTruthy();
    const name = q<HTMLInputElement>(".canon-createorg-name");
    const mono = q<HTMLElement>(".canon-createorg-mono");
    const slug = q<HTMLElement>(".canon-createorg-slug-val");
    const create = q<HTMLButtonElement>(".canon-createorg-create");

    // Empty: create disabled, monogram in placeholder state.
    expect(create.disabled).toBe(true);
    expect(mono.classList.contains("is-empty")).toBe(true);

    // Typing forms the monogram + slug live and enables create.
    name.value = "Cleverit SpA";
    name.dispatchEvent(new Event("input"));
    expect(mono.textContent).toBe("CS");
    expect(slug.textContent).toBe("cleverit-spa");
    expect(create.disabled).toBe(false);

    create.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(canonCreateOrg).toHaveBeenCalledWith("cleverit-spa", "Cleverit SpA");
    expect(onCreated).toHaveBeenCalledWith("cleverit-spa");
  });

  it("surfaces a friendly error on a taken slug and does not call onCreated", async () => {
    vi.mocked(canonCreateOrg).mockRejectedValueOnce(new Error("conflict: slug taken"));
    const onCreated = vi.fn();
    openCreateOrgExperience({ onCreated });

    const name = q<HTMLInputElement>(".canon-createorg-name");
    name.value = "Taken";
    name.dispatchEvent(new Event("input"));
    q<HTMLButtonElement>(".canon-createorg-create").click();

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const err = q<HTMLElement>(".canon-createorg-err");
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain("taken");
    expect(onCreated).not.toHaveBeenCalled();
  });
});
