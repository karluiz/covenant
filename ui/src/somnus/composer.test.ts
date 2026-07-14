import { describe, expect, it, vi } from "vitest";
import type { SomnusDraft } from "../api";
import { RequestComposer } from "./composer";

function mk() {
  const opts = {
    onSend: vi.fn(),
    onSave: vi.fn(),
    onDirty: vi.fn(),
    onEnvChange: vi.fn(),
  };
  const c = new RequestComposer(opts);
  document.body.append(c.element);
  return { c, opts };
}

const full: SomnusDraft = {
  method: "POST",
  url: "https://{{base_url}}/u?page=2",
  headers: [["Accept", "application/json"]],
  body: '{"a":1}',
  body_mode: "json",
  auth: { type: "bearer", token: "{{tok}}" },
};

describe("RequestComposer", () => {
  it("round-trips a full draft through setDraft/getDraft", () => {
    const { c } = mk();
    c.setDraft(full);
    expect(c.getDraft()).toEqual(full);
  });

  it("projects URL query into param rows and back", () => {
    const { c } = mk();
    c.setDraft({ ...full, url: "https://x.test/u?a=1&b=2" });
    const keys = [...c.element.querySelectorAll(".somnus-pane-params input")].map(
      (i) => (i as HTMLInputElement).value,
    );
    expect(keys).toContain("a");
    expect(keys).toContain("b");
  });

  it("form mode round-trips rows through the body string", () => {
    const { c } = mk();
    c.setDraft({ ...full, body: "u=a&p=b", body_mode: "form", auth: { type: "none" } });
    const d = c.getDraft();
    expect(d.body).toBe("u=a&p=b");
    expect(d.body_mode).toBe("form");
  });

  it("shows the unresolved warning", () => {
    const { c } = mk();
    c.markUnresolved(["base_url"], true);
    const warn = c.element.querySelector(".somnus-var-warn") as HTMLElement;
    expect(warn.textContent).toContain("base_url");
    expect(warn.classList.contains("hidden")).toBe(false);
    c.markUnresolved([], false);
    expect(warn.classList.contains("hidden")).toBe(true);
  });

  it("send disabled only when URL is blank", () => {
    const { c } = mk();
    const send = c.element.querySelector(".somnus-send") as HTMLButtonElement;
    c.setDraft({ ...full, url: "" });
    expect(send.disabled).toBe(true);
    c.setDraft({ ...full, url: "{{base_url}}/x" });
    expect(send.disabled).toBe(false);
  });
});
