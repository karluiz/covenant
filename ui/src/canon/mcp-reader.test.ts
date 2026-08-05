import { describe, it, expect } from "vitest";
import {
  parseMcpConfig,
  unprobableReason,
  mcpReaderBody,
  fillTools,
} from "./mcp-reader";
import type { McpToolInfo } from "../api";

/** The real Canon unit shipped at .covenant/canon/mcp/covenant.json. */
const SELF = JSON.stringify({
  type: "stdio",
  command: "covenant",
  args: ["mcp-stdio"],
  description: "The running Covenant app — tasks, notes, saved commands.",
});

describe("parseMcpConfig", () => {
  it("reads the covenant bridge as its own stdio server", () => {
    const cfg = parseMcpConfig(SELF);
    expect(cfg.transport).toBe("stdio");
    expect(cfg.invocation).toBe("covenant mcp-stdio");
    expect(cfg.isSelf).toBe(true);
    expect(cfg.description).toContain("tasks, notes");
    expect(cfg.parseError).toBe("");
  });

  it("infers http from a url even when type is absent", () => {
    const cfg = parseMcpConfig(JSON.stringify({ url: "https://x.dev/mcp" }));
    expect(cfg.transport).toBe("http");
    expect(cfg.url).toBe("https://x.dev/mcp");
    expect(cfg.isSelf).toBe(false);
  });

  it("exposes env and header keys but never their values", () => {
    const raw = JSON.stringify({
      command: "some-server",
      env: { API_TOKEN: "sk-live-abc123", REGION: "us" },
      headers: { Authorization: "Bearer sk-live-abc123" },
    });
    const cfg = parseMcpConfig(raw);
    expect(cfg.envKeys).toEqual(["API_TOKEN", "REGION"]);
    expect(cfg.headerKeys).toEqual(["Authorization"]);
    expect(JSON.stringify(cfg)).not.toContain("sk-live-abc123");
  });

  it("survives a hand-broken file instead of throwing", () => {
    const cfg = parseMcpConfig("{ not json");
    expect(cfg.parseError).not.toBe("");
    expect(cfg.transport).toBe("unknown");
  });
});

describe("unprobableReason", () => {
  it("lets the covenant bridge and http servers through", () => {
    expect(unprobableReason(parseMcpConfig(SELF))).toBeNull();
    expect(unprobableReason(parseMcpConfig(JSON.stringify({ url: "https://x.dev/mcp" })))).toBeNull();
  });

  it("refuses to promise tools for a foreign stdio server", () => {
    // Probing it would mean spawning its command — a safety review, not UI.
    const reason = unprobableReason(parseMcpConfig(JSON.stringify({ command: "npx", args: ["-y", "foo"] })));
    expect(reason).toMatch(/safety review/);
  });
});

describe("mcpReaderBody", () => {
  it("renders the description as prose, not inside a code fence", () => {
    const cfg = parseMcpConfig(SELF);
    const { body } = mcpReaderBody("covenant", cfg, SELF);
    const prose = body.querySelector(".mcp-prose");
    expect(prose?.textContent).toContain("tasks, notes");
    // The long description must not live in the mono invocation slot.
    expect(body.querySelector(".mcp-invoke")?.textContent).toBe("covenant mcp-stdio");
  });

  it("keeps the raw config, folded shut", () => {
    const { body } = mcpReaderBody("covenant", parseMcpConfig(SELF), SELF);
    const details = body.querySelector("details.mcp-raw") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(details.querySelector("pre")?.textContent).toContain('"mcp-stdio"');
  });
});

describe("fillTools", () => {
  const tools: McpToolInfo[] = [
    {
      name: "task_list", description: "List tasks.", writes: false,
      params: [{ name: "status", ty: "string", required: false, doc: "Filter." }],
    },
    { name: "session_list", description: "List sessions.", writes: false, params: [] },
    {
      name: "notes_append", description: "Append a note.", writes: true,
      params: [{ name: "group_id", ty: "string", required: true, doc: "" }],
    },
  ];

  it("counts reads and writes separately in the band label", () => {
    const { toolsBand } = mcpReaderBody("covenant", parseMcpConfig(SELF), SELF);
    fillTools(toolsBand, tools, null);
    expect(toolsBand.querySelector(".mcp-band-count")?.textContent).toBe("3 · 2 read · 1 write");
    expect(toolsBand.querySelectorAll(".mcp-tool")).toHaveLength(3);
  });

  it("marks a mutating tool as a write and an optional param with ?", () => {
    const { toolsBand } = mcpReaderBody("covenant", parseMcpConfig(SELF), SELF);
    fillTools(toolsBand, tools, null);
    const rows = [...toolsBand.querySelectorAll(".mcp-tool")];
    const append = rows.find((r) => r.querySelector(".mcp-tool-name")?.textContent === "notes_append");
    expect(append?.querySelector(".mcp-pill")?.classList.contains("is-write")).toBe(true);
    const list = rows.find((r) => r.querySelector(".mcp-tool-name")?.textContent === "task_list");
    expect(list?.querySelector(".mcp-type")?.textContent).toBe("string?");
    expect(rows[1].querySelector(".mcp-no-params")).toBeTruthy();
  });

  it("expands a row on click", () => {
    const { toolsBand } = mcpReaderBody("covenant", parseMcpConfig(SELF), SELF);
    fillTools(toolsBand, tools, null);
    const row = toolsBand.querySelector(".mcp-tool") as HTMLElement;
    const head = row.querySelector(".mcp-tool-head") as HTMLButtonElement;
    expect(row.dataset.open).toBe("false");
    head.click();
    expect(row.dataset.open).toBe("true");
    expect(head.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows the reason instead of an empty list when a server can't be probed", () => {
    const { toolsBand } = mcpReaderBody("foo", parseMcpConfig('{"command":"npx"}'), "{}");
    fillTools(toolsBand, [], "spawning needs a safety review");
    expect(toolsBand.querySelector(".mcp-note")?.textContent).toMatch(/safety review/);
    expect(toolsBand.querySelector(".mcp-tools")).toBeNull();
  });

  it("replaces the placeholder note once tools arrive", () => {
    const { toolsBand } = mcpReaderBody("covenant", parseMcpConfig(SELF), SELF);
    fillTools(toolsBand, [], "Listing tools…");
    fillTools(toolsBand, tools, null);
    expect(toolsBand.querySelector(".mcp-note")).toBeNull();
    expect(toolsBand.querySelectorAll(".mcp-tool")).toHaveLength(3);
  });
});
