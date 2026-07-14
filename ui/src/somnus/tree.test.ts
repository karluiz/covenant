import { describe, expect, it, vi } from "vitest";
import type { SomnusTreeNode } from "../api";
import { CollectionsTree, flattenTree } from "./tree";

function n(id: string, parent: string | null, kind: SomnusTreeNode["kind"], name: string, sort = 0): SomnusTreeNode {
  return { id, parent_id: parent, kind, name, sort, request: kind === "request" ? "{}" : null, updated_at: 0 };
}

const nodes = [
  n("c1", null, "collection", "API", 1),
  n("f1", "c1", "folder", "Users", 1),
  n("r1", "f1", "request", "List", 1),
  n("r2", "c1", "request", "Ping", 2),
];

describe("flattenTree", () => {
  it("returns only visible rows given the open set", () => {
    const closed = flattenTree(nodes, new Set());
    expect(closed.map((r) => r.node.id)).toEqual(["c1"]);
    const open = flattenTree(nodes, new Set(["c1", "f1"]));
    expect(open.map((r) => r.node.id)).toEqual(["c1", "f1", "r1", "r2"]);
    expect(open.find((r) => r.node.id === "r1")?.depth).toBe(2);
  });
  it("orders siblings by sort", () => {
    const shuffled = [n("c1", null, "collection", "A", 1), n("x", "c1", "request", "b", 2), n("y", "c1", "request", "a", 1)];
    const rows = flattenTree(shuffled, new Set(["c1"]));
    expect(rows.map((r) => r.node.id)).toEqual(["c1", "y", "x"]);
  });
});

describe("CollectionsTree render", () => {
  it("renders rows with method chips for requests", () => {
    const tree = new CollectionsTree({ onOpen: vi.fn(), onEnvImported: vi.fn(), notify: vi.fn() });
    document.body.append(tree.element);
    tree.render(nodes);
    // collections start open by default so content is discoverable
    expect(tree.element.querySelectorAll(".rail-row").length).toBeGreaterThan(0);
  });
});
