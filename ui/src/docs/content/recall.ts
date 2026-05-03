import type { DocSection } from "../panel";

export const recallDoc: DocSection = {
  id: "recall",
  title: "Recall — Searchable command history",
  subtitle: "Every command you've ever run, ranked by recency × frequency.",
  body: `
    <h3>What it is</h3>
    <p>
      Recall is a SQLite-backed index of every block parsed in
      Covenant — across all sessions, surviving restarts. On first
      launch we seed it from <code>~/.zsh_history</code> so the
      sidebar isn't empty on day one. New blocks land in the index
      automatically.
    </p>

    <h3>When to use it</h3>
    <ul>
      <li><em>"What was that one command I ran last Tuesday to dump
          the staging DB?"</em> — type <code>pg_dump</code> in the
          palette and the most-recent / most-used hit floats up.</li>
      <li>Pinning a long, awkward command you don't want to retype
          (think: <code>kubectl&nbsp;…&nbsp;--context=…&nbsp;-n&nbsp;…</code>).</li>
      <li>Sharing the exact command you ran when filing a bug.</li>
    </ul>

    <h3>Keyboard shortcuts</h3>
    <ul>
      <li><kbd>⌘</kbd>+<kbd>P</kbd> — Recall palette over the
          workspace.</li>
      <li>The sidebar's <strong>Recall</strong> tab — same data,
          docked instead of modal. Switches contextually with the
          Blocks tab.</li>
    </ul>
    <p>
      Inline ghost-text completions are a separate thing: install
      <code>zsh-autosuggestions</code> and Covenant picks them up
      automatically.
    </p>

    <h3>Example</h3>
    <p>
      Press <kbd>⌘</kbd>+<kbd>P</kbd>, type <code>migrate</code>. The
      top hit is the <code>diesel migration run</code> you ran twice
      yesterday in the staging tab; the second is the
      <code>cargo run --bin migrate</code> from a week ago. Press
      <kbd>↵</kbd> to inject it into the active tab — Covenant types
      it into the prompt without auto-executing, so you can edit
      flags before pressing return.
    </p>
  `.trim(),
};
