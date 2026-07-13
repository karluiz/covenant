import { describe, expect, it } from "vitest";
import { composePresence } from "./presence";

describe("composePresence", () => {
  it("workspace + plural sessions + operator", () => {
    expect(
      composePresence({ workspace: "karlTerminal", tabs: 3, operatorLive: true }),
    ).toEqual({ details: "In karlTerminal", state: "3 sessions · operator running" });
  });

  it("singular session, no operator", () => {
    expect(
      composePresence({ workspace: "karlTerminal", tabs: 1, operatorLive: false }),
    ).toEqual({ details: "In karlTerminal", state: "1 session" });
  });

  it("falls back to Covenant when workspace unknown", () => {
    expect(
      composePresence({ workspace: null, tabs: 0, operatorLive: false }),
    ).toEqual({ details: "In Covenant", state: "0 sessions" });
  });
});
