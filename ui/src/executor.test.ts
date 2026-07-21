import { describe, expect, it } from "vitest";
import { detectExecutor } from "./executor";

describe("detectExecutor", () => {
  it("recognizes Pi as an agent executor", () => {
    expect(detectExecutor("pi")).toBe("pi");
    expect(detectExecutor("env FOO=1 pi --mode rpc")).toBe("pi");
    expect(detectExecutor("/opt/homebrew/bin/pi")).toBe("pi");
  });

  it("recognizes Hermes as an agent executor", () => {
    expect(detectExecutor("hermes")).toBe("hermes");
    expect(detectExecutor("env NOUS_API_KEY=xxx hermes")).toBe("hermes");
    expect(detectExecutor("/usr/local/bin/hermes")).toBe("hermes");
    // Hermes subcommands still light up the chip — the running process
    // is still the hermes binary.
    expect(detectExecutor("hermes setup")).toBe("hermes");
    expect(detectExecutor("hermes model")).toBe("hermes");
  });

  // Covenant's own reuse-idle launch is `cd <worktree> && claude …`; if this
  // returns null the tab stays "idle" forever and the next Start-agent
  // types into the running agent instead of spawning a session.
  it("sees past a leading cd in a compound command", () => {
    expect(detectExecutor("cd '/tmp/wt' && claude --effort high")).toBe("claude");
    expect(detectExecutor("cd /tmp && ls")).toBe(null);
  });
});
