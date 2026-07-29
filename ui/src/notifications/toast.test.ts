import { describe, expect, it } from "vitest";

import { ToastHost, formatPerceptionToast } from "./toast";

describe("pushInfo dedupe", () => {
  it("does not stack identical visible info toasts", () => {
    const mount = document.createElement("div");
    const host = new ToastHost(mount, { onClick: () => {} });
    host.pushInfo({ message: "Worktree is gone — back to the main checkout" });
    host.pushInfo({ message: "Worktree is gone — back to the main checkout" });
    host.pushInfo({ message: "something else" });
    expect(mount.querySelectorAll(".toast-info")).toHaveLength(2);
  });
});

describe("formatPerceptionToast", () => {
  it("renders option and subject after the WHO", () => {
    expect(
      formatPerceptionToast({
        operatorName: "Default",
        optionLabel: "1. Yes",
        subject: "git status",
      }),
    ).toBe(' answered "1. Yes" · git status');
  });

  it("omits the subject separator when subject is empty", () => {
    expect(
      formatPerceptionToast({
        operatorName: "Raven",
        optionLabel: "1. Yes",
        subject: "",
      }),
    ).toBe(' answered "1. Yes"');
  });
});
