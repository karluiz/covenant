import type { DocSection } from "../panel";

export const projectNotesDoc: DocSection = {
  id: "project-notes",
  title: "Project Notes — Commands, Notes, Docs",
  subtitle: "Per-group scratch space: paste-ready commands, append-only notes, and a markdown doc.",
  body: `
    <h3>What it is</h3>
    <p>
      Every tab group has its own panel with three tabs:
    </p>
    <ul>
      <li>
        <strong>Commands</strong> — saved commands you run often. Click
        <em>paste</em> to drop the command into the active tab of the
        group without executing it. Useful for build/test/deploy
        invocations that vary per project.
      </li>
      <li>
        <strong>Notes</strong> — append-only log. Type, press
        <kbd>⌘</kbd>+<kbd>↵</kbd>, done. Stamped with relative time.
        Scope is the group, so notes about <em>raven</em> stay with
        <em>raven</em>.
      </li>
      <li>
        <strong>Docs</strong> — single markdown buffer. Auto-saves on
        idle. Good for the README-of-the-moment: env vars, gotchas,
        the one-liner you keep forgetting.
      </li>
    </ul>

    <h3>How to open it</h3>
    <ul>
      <li><kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>N</kbd> — opens the panel for the
          group of the active tab. Closes with <kbd>Esc</kbd>.</li>
      <li>Right-click a group chip → <em>Open notes</em>.</li>
      <li>Click <kbd>⤢</kbd> in the panel header to expand to fullscreen
          (handy for editing the docs tab).</li>
    </ul>

    <h3>Why per-group</h3>
    <p>
      Tabs come and go; groups represent the actual project. Pinning
      this content to the group means you can close every tab in
      <em>covenant</em>, reopen them tomorrow, and your commands and
      notes are still there.
    </p>

    <h3>Storage</h3>
    <p>
      Stored locally in the app's data directory. Nothing is sent to
      the LLM. Deleting a group ungroups its tabs but does not delete
      its notes — the data stays keyed to the group id.
    </p>
  `.trim(),
};
