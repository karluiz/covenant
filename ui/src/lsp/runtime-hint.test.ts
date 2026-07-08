import { describe, expect, it } from "vitest";
import { runtimeSuggestionLine } from "./runtime-hint";

describe("runtimeSuggestionLine", () => {
  it("on-disk-not-on-path yields a diagnosis + export command", () => {
    const r = runtimeSuggestionLine({
      kind: "on_disk_not_on_path",
      version: "26.0.1",
      dir: "/opt/homebrew/opt/openjdk/bin",
    });
    expect(r.text).toContain("26.0.1");
    expect(r.text).toContain("/opt/homebrew/opt/openjdk/bin");
    expect(r.command).toBe('export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"');
  });

  it("install yields the hint as the command", () => {
    const r = runtimeSuggestionLine({ kind: "install", hint: "brew install openjdk" });
    expect(r.text.toLowerCase()).toContain("install");
    expect(r.command).toBe("brew install openjdk");
  });

  it("null yields no command", () => {
    expect(runtimeSuggestionLine(null)).toEqual({ text: "", command: null });
  });
});
