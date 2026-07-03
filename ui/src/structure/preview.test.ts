// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { previewKindForPath, XlsxPreview, CsvPreview, parseCsv, serializeCsv } from "./preview";
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
    await p.ready;
    expect(host.textContent).toContain("apples");
    expect(host.textContent).toContain("pears");
    p.dispose();
  });

  it("exposes both sheet names as tabs", async () => {
    const host = document.createElement("div");
    const p = new XlsxPreview();
    p.mount(host, fixtureBytes());
    await p.ready;
    const tabs = host.querySelectorAll(".structure-preview-xlsx-tab");
    const names = Array.from(tabs).map((t) => t.textContent);
    expect(names).toEqual(["Inventory", "Notes"]);
    p.dispose();
  });

  it("switches sheet when a tab is clicked", async () => {
    const host = document.createElement("div");
    const p = new XlsxPreview();
    p.mount(host, fixtureBytes());
    await p.ready;
    const notesTab = Array.from(
      host.querySelectorAll<HTMLElement>(".structure-preview-xlsx-tab"),
    ).find((t) => t.textContent === "Notes")!;
    notesTab.click();
    await p.ready;
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

describe("previewKindForPath csv coverage", () => {
  it.each(["csv", "tsv"])("returns 'csv' for .%s", (ext) => {
    expect(previewKindForPath(`/x/data.${ext}`)).toBe("csv");
  });
});

describe("parseCsv / serializeCsv", () => {
  it("round-trips a plain file byte-faithfully", () => {
    const text = "a,b,c\n1,2,3\n4,5,6";
    expect(serializeCsv(parseCsv(text))).toBe(text);
  });

  it("preserves numeric-looking strings exactly (no SheetJS-style coercion)", () => {
    const text = "v\n3e-06\n0.1666013328\n00123\n90071992547409919";
    expect(serializeCsv(parseCsv(text))).toBe(text);
  });

  it("handles quoted fields with embedded delimiters, quotes, newlines", () => {
    const rows = parseCsv('a,"b,1","say ""hi""","two\nlines"');
    expect(rows).toEqual([["a", "b,1", 'say "hi"', "two\nlines"]]);
    expect(serializeCsv(rows)).toBe('a,"b,1","say ""hi""","two\nlines"');
  });

  it("does not emit a phantom row for a trailing newline", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("splits CRLF rows and can serialize them back with CRLF", () => {
    const rows = parseCsv("a,b\r\n1,2\r\n");
    expect(rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(serializeCsv(rows, { eol: "\r\n" })).toBe("a,b\r\n1,2");
  });

  it("supports tab delimiter", () => {
    const rows = parseCsv("a\tb\n1\t2", "\t");
    expect(rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(serializeCsv(rows, { delim: "\t" })).toBe("a\tb\n1\t2");
  });
});

describe("CsvPreview", () => {
  function mountCsv(content: string, onEdit?: (t: string) => void) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const p = new CsvPreview();
    p.mount(host, content, { path: "/x/data.csv", onEdit });
    return { host, p };
  }

  it("renders header row as th and data as editable td", () => {
    const { host, p } = mountCsv("name,qty\napples,3\n");
    const ths = host.querySelectorAll("th");
    expect(Array.from(ths).map((t) => t.textContent)).toEqual(["name", "qty"]);
    const td = host.querySelector("td")!;
    expect(td.getAttribute("contenteditable")).toBe("plaintext-only");
    expect(host.textContent).toContain("apples");
    p.dispose();
    host.remove();
  });

  it("commits a cell edit and reports the full re-serialized text", () => {
    let edited: string | null = null;
    const { host, p } = mountCsv("name,qty\napples,3\n", (t) => (edited = t));
    const cell = host.querySelector<HTMLElement>('td[data-r="1"][data-c="1"]')!;
    cell.textContent = "7";
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(edited).toBe("name,qty\napples,7\n");
    p.dispose();
    host.remove();
  });

  it("preserves rows beyond the render cap when serializing an edit", () => {
    const lines = ["h"].concat(Array.from({ length: 600 }, (_, i) => `r${i}`));
    let edited: string | null = null;
    const { host, p } = mountCsv(lines.join("\n"), (t) => (edited = t));
    expect(host.querySelectorAll("tr").length).toBe(500);
    expect(host.textContent).toContain("more rows not shown");
    const cell = host.querySelector<HTMLElement>('td[data-r="1"][data-c="0"]')!;
    cell.textContent = "EDITED";
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    const out = (edited ?? "").split("\n");
    expect(out.length).toBe(601);
    expect(out[1]).toBe("EDITED");
    expect(out[600]).toBe("r599");
    p.dispose();
    host.remove();
  });

  it("does not report an edit when the value is unchanged", () => {
    let calls = 0;
    const { host, p } = mountCsv("a,b\n1,2\n", () => calls++);
    const cell = host.querySelector<HTMLElement>('td[data-r="1"][data-c="0"]')!;
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(calls).toBe(0);
    p.dispose();
    host.remove();
  });

  it("pads ragged rows for display without mutating them until edited", () => {
    let edited: string | null = null;
    const { host, p } = mountCsv("a,b,c\n1\n", (t) => (edited = t));
    // Row 1 renders 3 cells even though the file has 1.
    const cells = host.querySelectorAll('td[data-r="1"]');
    expect(cells.length).toBe(3);
    // Blurring a virtual (padding) cell unchanged reports nothing.
    cells[2].dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(edited).toBeNull();
    // Editing it materializes the row out to that column.
    (cells[2] as HTMLElement).textContent = "x";
    cells[2].dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(edited).toBe("a,b,c\n1,,x\n");
    p.dispose();
    host.remove();
  });
});
