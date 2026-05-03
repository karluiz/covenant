import type { DocSection } from "../panel";

export const blocksDoc: DocSection = {
  id: "blocks",
  title: "Blocks — Commands as first-class units",
  subtitle: "Every command and its output, parsed as one structured object.",
  body: `
    <h3>What they are</h3>
    <p>
      Each block is one command, its output, its exit code, and the
      cwd at the time. Blocks are produced by parsing
      <strong>OSC&nbsp;133</strong> markers emitted by your shell —
      not by guessing on prompt strings. Because they're structured,
      everything else (the agent, Recall, the Operator) reads them as
      data instead of scrolling text.
    </p>

    <h3>When to use them</h3>
    <ul>
      <li>Copy the output of a single command without selecting bytes
          by hand.</li>
      <li>Re-run, share, or pin a specific command from the sidebar.</li>
      <li>Spot failures fast — non-zero exit codes are tinted red and
          carry the agent's fix suggestion inline.</li>
    </ul>
    <p>
      If blocks aren't appearing, the OSC 133 snippet for your shell
      isn't installed. See <code>shell-integration/</code> in the
      Covenant repo and source the matching file from your
      <code>~/.zshrc</code> / <code>~/.bashrc</code> / fish config.
    </p>

    <h3>Keyboard shortcuts</h3>
    <ul>
      <li><strong>Right-click</strong> on a block — copy command, copy
          output, re-run, ask the agent.</li>
      <li><kbd>⌘</kbd>+<kbd>P</kbd> — Recall palette to find a past
          block by command text.</li>
    </ul>

    <h3>Example</h3>
    <p>
      <code>cargo&nbsp;test</code> exits <code>1</code>. The block in
      the sidebar tints red and shows a lightbulb. Click it to get the
      super-agent's proposed fix; right-click to copy the failing
      output into a Slack thread without dragging the cursor.
    </p>
  `.trim(),
};
