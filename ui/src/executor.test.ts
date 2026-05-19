import { describe, expect, it } from "vitest";
import { detectExecutor } from "./executor";

describe("detectExecutor", () => {
  it("recognizes Pi as an agent executor", () => {
    expect(detectExecutor("pi")).toBe("pi");
    expect(detectExecutor("env FOO=1 pi --mode rpc")).toBe("pi");
    expect(detectExecutor("/opt/homebrew/bin/pi")).toBe("pi");
  });
});
