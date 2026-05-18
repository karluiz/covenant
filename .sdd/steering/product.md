# Product steering — Covenant

## Product identity

Covenant is an AI-native terminal for macOS built with Tauri 2, Rust, and xterm.js. It is not a conventional terminal with an assistant sidebar; the terminal is the substrate an autonomous operator observes and acts on.

## North star

Every terminal session emits structured events — commands, outputs, exit codes, and working-directory changes. A long-lived super-agent subscribes across all sessions, maintains a live world model, correlates work across tabs, surfaces next-best actions, and can act autonomously only under explicit policy.

## Core user value

- Keep developers in the terminal while still giving agents enough context to help.
- Reduce copy/paste between terminal output and AI tools.
- Let autonomous operators continue low-risk execution while respecting user-defined boundaries.
- Make multi-session work understandable at a glance through blocks, operators, summaries, notifications, convergence views, and project notes.

## Product guardrails

- PTY-first architecture is non-negotiable: Covenant owns the pseudo-terminal and observes bytes before rendering.
- Shell integration and OSC 133 blocks are the reliable unit of work. Do not replace them with ad hoc stdout parsing.
- AI capabilities must go through the central dispatch/safety path; never add direct provider calls in feature code.
- Secrets and raw ANSI content must not be persisted or sent to LLM paths unmasked.
- The UI should stay terminal-centric. File trees, docs, notes, and editors are supporting surfaces, not a full IDE replacement.

## Current product areas

- Multi-session terminal tabs and block-based command history.
- Master/operator workflows and autonomous mission execution.
- Familiars and higher-level capability surfaces.
- Spec chat, docs hub, project notes, command recall, notifications, and convergence/status views.

## Out-of-scope by default

Unless a spec explicitly says otherwise, avoid:

- Reimplementing a VT parser or xterm rendering behavior.
- Introducing heavyweight frontend frameworks or broad UI rewrites.
- Bypassing safety, dispatch, cost guardrails, or command policy boundaries.
- Silently installing shell integration or changing user shell profiles without consent.
