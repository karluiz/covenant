/**
 * spec-chat/index.ts — façade that wires the panel + state + chooser.
 *
 * Factory (not singleton) — tests can construct multiple instances.
 */

import type { SpecDraftSummary } from "../api";
import {
  specAuthorListDrafts as defaultListDrafts,
  specAuthorMarkPublished as defaultMarkPublished,
} from "../api";
import { createSpecChatState } from "./state";
import { mountSpecChatPanel } from "./panel";

export interface SpecChatDeps {
  openWizardWithBody: (body: string) => void;
  openBlankWizard: () => void;
}

export interface SpecChatController {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
}

import type { SpecChatPanel } from "./panel";

/** Injectable API overrides (for tests). */
export interface SpecChatApis {
  listDrafts?: () => Promise<SpecDraftSummary[]>;
  markPublished?: (id: string) => Promise<void>;
  /** Optional panel factory — allows tests to inject a mock panel. */
  mountPanel?: (host: HTMLElement, state: ReturnType<typeof createSpecChatState>) => SpecChatPanel;
  /** Optional state factory — allows tests to inject pre-configured state. */
  createState?: () => ReturnType<typeof createSpecChatState>;
}

// ---------------------------------------------------------------------------
// Relative-time helper
// ---------------------------------------------------------------------------
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "< 1 min";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function shortSummary(draft: SpecDraftSummary): string {
  const firstUser = draft.messages.find((m) => m.role === "User");
  if (!firstUser) return "No messages";
  return firstUser.content.length > 60
    ? firstUser.content.slice(0, 60) + "…"
    : firstUser.content;
}

function isInProgress(d: SpecDraftSummary): boolean {
  return (
    typeof (d.status as { InProgress?: unknown }).InProgress === "object" &&
    (d.status as { InProgress?: unknown }).InProgress !== null
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function mountSpecChat(
  host: HTMLElement,
  deps: SpecChatDeps,
  apis?: SpecChatApis,
): SpecChatController {
  const listDrafts = apis?.listDrafts ?? defaultListDrafts;
  const markPublished = apis?.markPublished ?? defaultMarkPublished;
  const panelFactory = apis?.mountPanel ?? mountSpecChatPanel;
  const stateFactory = apis?.createState ?? createSpecChatState;

  let chooserEl: HTMLElement | null = null;
  let panelMounted = false;
  let currentState = stateFactory();
  let currentPanel = panelFactory(host, currentState);

  function wirePanel(state: ReturnType<typeof createSpecChatState>): void {
    currentState = state;
    currentPanel = panelFactory(host, currentState);
    currentPanel.onPublishRequest = (markdown: string, draftId: string) => {
      // v0: mark published immediately when user clicks "Revisar y publicar".
      // The file on disk is the source of truth; if the user abandons the
      // wizard without saving, the JSON status says Published but no file
      // was written — acceptable for v0.
      void markPublished(draftId).catch(() => {/* best-effort */});
      deps.openWizardWithBody(markdown);
      controller.close();
    };
    currentPanel.open();
    panelMounted = true;
  }

  function removeChooser(): void {
    if (chooserEl) {
      chooserEl.remove();
      chooserEl = null;
    }
  }

  function renderChooser(drafts: SpecDraftSummary[]): void {
    removeChooser();

    const el = document.createElement("div");
    el.className = "spec-chat-chooser";

    const title = document.createElement("p");
    title.className = "spec-chat-chooser-title";
    title.textContent = "What do you want to do?";
    el.appendChild(title);

    // "Retomar" options (up to 3)
    const recent = drafts.slice(0, 3);
    for (const draft of recent) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "spec-chat-chooser-btn";
      btn.textContent = `Resume "${shortSummary(draft)}" (last edited: ${relativeTime(draft.last_updated)})`;
      btn.addEventListener("click", () => {
        removeChooser();
        const state = stateFactory();
        void state.restoreDraft(draft.id).then(() => {
          wirePanel(state);
        });
      });
      el.appendChild(btn);
    }

    // "Empezar nuevo"
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "spec-chat-chooser-btn spec-chat-chooser-btn--new";
    newBtn.textContent = "Start a new one";
    newBtn.addEventListener("click", () => {
      removeChooser();
      const state = stateFactory();
      wirePanel(state);
    });
    el.appendChild(newBtn);

    // "Borrador en blanco"
    const blankBtn = document.createElement("button");
    blankBtn.type = "button";
    blankBtn.className = "spec-chat-chooser-btn spec-chat-chooser-btn--blank";
    blankBtn.textContent = "Blank draft (no chat)";
    blankBtn.addEventListener("click", () => {
      controller.close();
      deps.openBlankWizard();
    });
    el.appendChild(blankBtn);

    host.appendChild(el);
    host.hidden = false;
    chooserEl = el;
  }

  const controller: SpecChatController = {
    isOpen: () => panelMounted || chooserEl !== null,

    open() {
      if (controller.isOpen()) return;

      void listDrafts().then((all) => {
        const inProgress = all.filter(isInProgress);
        if (inProgress.length > 0) {
          renderChooser(inProgress);
        } else {
          const state = stateFactory();
          wirePanel(state);
        }
      }).catch(() => {
        // On error, open fresh state
        const state = stateFactory();
        wirePanel(state);
      });
    },

    close() {
      removeChooser();
      if (panelMounted) {
        currentPanel.close();
        panelMounted = false;
      }
      host.hidden = true;
    },
  };

  return controller;
}
