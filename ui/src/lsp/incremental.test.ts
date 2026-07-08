// T3 glue-code coverage: `LspDoc.changeIncremental` maps a CM6 `ViewUpdate`
// (possibly carrying MULTIPLE edits from a single dispatch) into LSP
// `contentChanges`. See the long comment on `changeIncremental` in
// manager.ts for why the array must come out in DESCENDING offset order
// (LSP applies entries sequentially against a doc that shifts after each
// one) — this test builds a real two-edit transaction and asserts that
// invariant directly against the method CM6 wiring actually calls, so an
// accidental removal of the `.reverse()` fails loudly instead of only
// showing up as silent corruption against a live rust-analyzer.
import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";

import { LspDoc } from "./manager";
import { offsetToLsp } from "./positions";
import type { LspClient } from "./client";

describe("LspDoc.changeIncremental", () => {
  it("maps a two-edit transaction (delete near start + insert near end) to descending-order contentChanges", () => {
    const initial = "const one = 1;\nconst two = 2;\nconst three = 3;\n";

    let captured: ViewUpdate | null = null;
    const state = EditorState.create({
      doc: initial,
      extensions: [EditorView.updateListener.of((u) => { captured = u; })],
    });
    const view = new EditorView({ state, parent: document.body });
    const preDoc = view.state.doc; // pre-transaction doc — every expected
    // position below is computed against THIS, matching the contract
    // `changeIncremental`'s doc comment describes for `startState.doc`.

    // Edit A — delete "one " (offsets 6..10), near the start of the doc.
    const delFrom = 6;
    const delTo = 10;
    // Edit B — insert text right at the end of the doc.
    const insAt = preDoc.length;
    const insertText = " // trailing note";

    view.dispatch({
      changes: [
        { from: delFrom, to: delTo, insert: "" },
        { from: insAt, to: insAt, insert: insertText },
      ],
    });

    expect(captured).not.toBeNull();
    const update = captured!;
    // Sanity: CM6 hands `changeIncremental` the PRE-change doc via
    // `update.startState`, which is what makes reversing safe.
    expect(update.startState.doc.toString()).toBe(initial);

    const didChange = vi.fn();
    const fakeClient = { didChange } as unknown as LspClient;
    const doc = new LspDoc(fakeClient, "file:///scratch.rs", () => {});

    doc.changeIncremental(update);

    expect(didChange).toHaveBeenCalledTimes(1);
    const [uri, changes] = didChange.mock.calls[0] as [
      string,
      Array<{ range?: { start: { line: number; character: number }; end: { line: number; character: number } }; text: string }>,
    ];
    expect(uri).toBe("file:///scratch.rs");
    expect(changes).toHaveLength(2);

    const [first, second] = changes;
    // The LATER edit (tail insert) must be sent FIRST …
    expect(first.range!.start).toEqual(offsetToLsp(preDoc, insAt));
    expect(first.range!.end).toEqual(offsetToLsp(preDoc, insAt));
    expect(first.text).toBe(insertText);
    // … and the EARLIER edit (head delete) sent SECOND.
    expect(second.range!.start).toEqual(offsetToLsp(preDoc, delFrom));
    expect(second.range!.end).toEqual(offsetToLsp(preDoc, delTo));
    expect(second.text).toBe("");

    // Explicit descending-order assertion — this is the line an
    // ascending-order regression (e.g. deleting the `.reverse()` call)
    // would fail: `first` must start at or after `second`.
    expect(first.range!.start.line).toBeGreaterThanOrEqual(second.range!.start.line);
    if (first.range!.start.line === second.range!.start.line) {
      expect(first.range!.start.character).toBeGreaterThan(second.range!.start.character);
    }

    view.destroy();
  });

  it("sends nothing when the transaction carries no document changes", () => {
    let captured: ViewUpdate | null = null;
    const state = EditorState.create({
      doc: "unchanged\n",
      extensions: [EditorView.updateListener.of((u) => { captured = u; })],
    });
    const view = new EditorView({ state, parent: document.body });

    // A selection-only transaction — no `changes` — still fires the
    // updateListener but must not produce a didChange call.
    view.dispatch({ selection: { anchor: 0 } });
    expect(captured).not.toBeNull();

    const didChange = vi.fn();
    const fakeClient = { didChange } as unknown as LspClient;
    const doc = new LspDoc(fakeClient, "file:///scratch.rs", () => {});
    doc.changeIncremental(captured!);

    expect(didChange).not.toHaveBeenCalled();
    view.destroy();
  });
});
