import type { DocSection } from "../panel";

export const aomDoc: DocSection = {
  id: "aom",
  title: "AOM — Autonomous Operator Mode",
  subtitle: "Run Covenant unattended on a budget while you sleep.",
  body: `
    <h3>What it is</h3>
    <p>
      AOM lets the Operator drive every open tab autonomously inside a
      hard cost cap. While AOM is on, every tab is auto-enabled for
      Operator execution and reverted to its prior state when AOM
      stops. A morning report digests what happened: spend, decisions
      taken, escalations that need your attention.
    </p>

    <h3>When to use it</h3>
    <ul>
      <li>Long-running soak / batch work you don't want to babysit.</li>
      <li>Overnight cleanups (lint sweeps, codemod runs, log triage).</li>
      <li>Anything you'd otherwise schedule and check in the morning.</li>
    </ul>
    <p>
      Skip AOM for one-shot fixes — <kbd>⌘O</kbd> on a single tab is
      enough. AOM is for breadth, not depth.
    </p>

    <h3>Keyboard shortcuts</h3>
    <ul>
      <li><kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>A</kbd> — toggle AOM on / off.</li>
      <li><kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>R</kbd> — open the morning report.</li>
    </ul>
    <p>
      Budget is set in <kbd>⌘</kbd>+<kbd>,</kbd> → AOM (default
      <code>$10</code>, range <code>0.10</code>–<code>500</code>). When
      the cap is hit, AOM auto-stops and a toast surfaces the report.
    </p>

    <h3>Example</h3>
    <p>
      You're heading out for dinner. You've left two tabs running tests
      and one tab tailing logs. Press <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>A</kbd>
      with the budget at <code>$5</code>. Covenant decides per-tab when
      to act, escalates anything ambiguous, and stops itself once spend
      reaches <code>$5</code>. When you're back, <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>R</kbd>
      shows: 18 decisions, 2 escalations, $4.83 spent over 1h 47m.
    </p>
  `.trim(),
};
