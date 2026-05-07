import type { DocSection } from "../panel";

export const familiarsDoc: DocSection = {
  id: "familiars",
  title: "Familiars — per-tab named assistants",
  subtitle: "A small, persistent agent bound to a single session: chats with you, proposes directives, respects a daily budget.",
  body: `
    <h3>What a Familiar is</h3>
    <p>
      A <strong>Familiar</strong> is a lightweight agent attached to one
      terminal session. Unlike the super-agent (which watches every
      tab) or the Operator (which types autonomously), a Familiar is
      conversational and named. You spawn one, give it a personality,
      and it builds a rolling memory of what happens in <em>that</em>
      tab.
    </p>

    <h3>Anatomy</h3>
    <ul>
      <li><strong>Name</strong> — yours to choose. Shown in the
          status bar when the active tab has a Familiar bound.</li>
      <li><strong>Style</strong> — <em>concise</em>, <em>formal</em>,
          <em>conversational</em>, or <em>sarcastic</em>. Drives the
          tone of every reply.</li>
      <li><strong>Daily cap (USD)</strong> — hard ceiling on LLM spend
          per UTC day. Once hit, the Familiar freezes until the next
          day rolls over.</li>
      <li><strong>Rolling summary</strong> — its memory of the session,
          updated after each block.</li>
    </ul>

    <h3>How you use it</h3>
    <ul>
      <li>Open the Familiars roster, spawn one against the active
          session. The tab now has a Familiar indicator in the status
          bar.</li>
      <li>Chat with it from the Familiar panel. It can answer questions
          about the session and propose <em>directives</em> — concrete
          actions like running a command or editing a file.</li>
      <li>Each directive is shown as a card you must explicitly
          <em>approve</em> or <em>reject</em>. Nothing executes
          unattended; the safety blocklist (<code>rm&nbsp;-rf</code>,
          <code>sudo</code>, force-pushes, secrets paths) blocks
          dangerous proposals before they ever surface.</li>
      <li>Approved directives flow to the Operator for execution.
          Rejected directives are logged in the audit trail with your
          reason.</li>
    </ul>

    <h3>Audit log</h3>
    <p>
      Every chat turn, every proposed/approved/rejected/executed
      directive, every safety block — recorded with timestamps. Open
      the audit panel from the Familiar's view to inspect what it has
      done and why.
    </p>

    <h3>When to spawn one</h3>
    <ul>
      <li>Long-running session where you want a persistent collaborator
          that remembers context across many commands.</li>
      <li>Tasks where you want suggestions but always with a human in
          the loop — Familiars never type without approval.</li>
      <li>Cost-sensitive contexts: the daily cap is enforced
          server-side, not advisory.</li>
    </ul>

    <h3>Familiar vs. Operator vs. super-agent</h3>
    <ul>
      <li><strong>Super-agent</strong> — global, read-only. Sees every
          tab, never types.</li>
      <li><strong>Operator</strong> — per-tab, can type
          autonomously under a policy (SuggestOnly by default).</li>
      <li><strong>Familiar</strong> — per-tab, conversational, proposes
          directives that <em>route through</em> the Operator after
          you approve. Adds personality and budget; subtracts
          autonomy.</li>
    </ul>
  `.trim(),
};
