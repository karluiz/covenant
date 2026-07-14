import { describe, expect, it, vi } from "vitest";
import { RequestTabs } from "./tabs";

describe("RequestTabs", () => {
  it("renders tabs with method chips, dirty dots, active state", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const tabs = new RequestTabs({ onSelect, onClose, onNew: vi.fn() });
    document.body.append(tabs.element);
    tabs.render(
      [
        { title: "List users", method: "GET", dirty: false },
        { title: "Login", method: "POST", dirty: true },
      ],
      1,
    );
    const els = tabs.element.querySelectorAll(".somnus-reqtab");
    expect(els.length).toBe(2);
    expect(els[1].classList.contains("is-active")).toBe(true);
    expect(els[1].querySelector(".somnus-tab-dot")).not.toBeNull();
    expect(els[0].querySelector(".somnus-tab-dot")).toBeNull();
    (els[0] as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith(0);
    (els[1].querySelector(".somnus-reqtab-close") as HTMLElement).click();
    expect(onClose).toHaveBeenCalledWith(1);
  });
});
