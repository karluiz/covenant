import { describe, expect, it } from "vitest";

import { formatPerceptionToast } from "./toast";

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
