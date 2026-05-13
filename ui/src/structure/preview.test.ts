// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { previewKindForPath, XlsxPreview } from "./preview";
import * as XLSX from "xlsx";

describe("previewKindForPath xlsx coverage", () => {
  it.each(["xlsx", "xls", "xlsm", "ods"])("returns 'xlsx' for .%s", (ext) => {
    expect(previewKindForPath(`/x/file.${ext}`)).toBe("xlsx");
  });

  it("still returns 'png' for image files", () => {
    expect(previewKindForPath("/x/photo.png")).toBe("png");
  });

  it("returns null for unsupported types", () => {
    expect(previewKindForPath("/x/code.rs")).toBeNull();
  });
});

function fixtureBytes(): string {
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet([
    ["name", "qty"],
    ["apples", 3],
    ["pears", 5],
  ]);
  XLSX.utils.book_append_sheet(wb, ws1, "Inventory");
  const ws2 = XLSX.utils.aoa_to_sheet([["greeting"], ["hello"]]);
  XLSX.utils.book_append_sheet(wb, ws2, "Notes");
  // XLSX.write with type:"array" returns ArrayBuffer in some environments;
  // wrap with Uint8Array to ensure Array.from produces the actual bytes.
  const raw = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer | Uint8Array;
  const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return JSON.stringify(Array.from(buf));
}

describe("XlsxPreview", () => {
  it("renders the first sheet's cells", async () => {
    const host = document.createElement("div");
    const p = new XlsxPreview();
    p.mount(host, fixtureBytes());
    await new Promise((r) => setTimeout(r, 80));
    expect(host.textContent).toContain("apples");
    expect(host.textContent).toContain("pears");
    p.dispose();
  });

  it("exposes both sheet names as tabs", async () => {
    const host = document.createElement("div");
    const p = new XlsxPreview();
    p.mount(host, fixtureBytes());
    await new Promise((r) => setTimeout(r, 80));
    const tabs = host.querySelectorAll(".structure-preview-xlsx-tab");
    const names = Array.from(tabs).map((t) => t.textContent);
    expect(names).toEqual(["Inventory", "Notes"]);
    p.dispose();
  });

  it("switches sheet when a tab is clicked", async () => {
    const host = document.createElement("div");
    const p = new XlsxPreview();
    p.mount(host, fixtureBytes());
    await new Promise((r) => setTimeout(r, 80));
    const notesTab = Array.from(
      host.querySelectorAll<HTMLElement>(".structure-preview-xlsx-tab"),
    ).find((t) => t.textContent === "Notes")!;
    notesTab.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(host.textContent).toContain("hello");
    expect(host.textContent).not.toContain("apples");
    p.dispose();
  });

  it("renders a placeholder when payload exceeds the size guard", () => {
    const host = document.createElement("div");
    const p = new XlsxPreview();
    // 26 MB worth of zero bytes — placeholder path doesn't even parse.
    const huge = JSON.stringify(new Array(26 * 1024 * 1024).fill(0));
    p.mount(host, huge);
    expect(host.textContent?.toLowerCase()).toContain("demasiado grande");
    p.dispose();
  });
});
