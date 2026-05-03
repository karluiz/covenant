import type { DocSection } from "../panel";

export const agentsDoc: DocSection = {
  id: "agents",
  title: "Agents — Super-agent and Operator",
  subtitle: "One brain that watches every tab; one operator per tab that types.",
  body: `
    <h3>What they are</h3>
    <p>
      Covenant runs <strong>two</strong> agents.
    </p>
    <ul>
      <li>
        The <strong>super-agent</strong> subscribes to the event bus
        across every open session, keeps a rolling summary per tab plus
        a global cross-session view, and answers ad-hoc questions about
        what's going on. It does not type into your shell.
      </li>
      <li>
        The <strong>Operator</strong> is per-tab. It can type into the
        PTY autonomously, gated by a hard safety blocklist (no
        <code>rm&nbsp;-rf</code>, <code>sudo</code>, <code>curl…|sh</code>,
        force-pushes, secrets paths). Defaults to <em>SuggestOnly</em>;
        switch a tab to live mode from the Operator panel.
      </li>
    </ul>

    <h3>When to use them</h3>
    <ul>
      <li>Ask the super-agent <em>"why is tab 2 failing?"</em> — it
          correlates with your edits in tab 1.</li>
      <li>Enable the Operator on a tab when you want hands-off
          execution within blocklist limits.</li>
      <li>If a command exits non-zero, the super-agent drops a fix
          suggestion inline on the failed block.</li>
    </ul>

    <h3>Keyboard shortcuts</h3>
    <ul>
      <li><kbd>⌘</kbd>+<kbd>K</kbd> — super-agent chat panel.</li>
      <li><kbd>⌘</kbd>+<kbd>O</kbd> — Operator decisions panel for the active tab.</li>
    </ul>

    <h3>Example</h3>
    <p>
      You save <code>auth.rs</code> in your editor. In tab 2,
      <code>cargo&nbsp;test</code> starts failing. Hit
      <kbd>⌘</kbd>+<kbd>K</kbd> and ask <em>"what broke?"</em>. The
      super-agent already saw both events on the bus and points at the
      function you renamed. Open <kbd>⌘</kbd>+<kbd>O</kbd> to see what
      the Operator would have typed; flip the tab to live mode if you
      want it to apply the fix itself.
    </p>
  `.trim(),
};
