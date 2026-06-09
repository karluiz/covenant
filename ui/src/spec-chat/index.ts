/**
 * spec-chat/index.ts — façade that wires the panel + state + chooser.
 *
 * Factory (not singleton) — tests can construct multiple instances.
 */

import type { SpecDraftSummary } from "../api";
import {
  specAuthorListDrafts as defaultListDrafts,
  specAuthorMarkPublished as defaultMarkPublished,
  specAuthorDeleteDraft as defaultDeleteDraft,
} from "../api";
import { createSpecChatState } from "./state";
import { mountSpecChatPanel } from "./panel";
import { Icons } from "../icons";
import { mountImmersiveSpecCreator } from "./immersive";
import { tauriEventSource } from "./tauri-event-source";

export interface SpecChatDeps {
  openWizardWithBody: (body: string) => void;
  openBlankWizard: () => void;
  /** Resolves the active workspace cwd so the agent gets repo grounding. */
  getCwd?: () => string | null;
}

export interface SpecChatController {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
}

import type { SpecChatPanel } from "./panel";
import type { ImmersiveOpts, ImmersiveInstance } from "./immersive";

/** Injectable API overrides (for tests). */
export interface SpecChatApis {
  listDrafts?: () => Promise<SpecDraftSummary[]>;
  markPublished?: (id: string) => Promise<void>;
  deleteDraft?: (id: string) => Promise<void>;
  /** Optional panel factory — allows tests to inject a mock panel. */
  mountPanel?: (host: HTMLElement, state: ReturnType<typeof createSpecChatState>) => SpecChatPanel;
  /** Optional state factory — allows tests to inject pre-configured state. */
  createState?: () => ReturnType<typeof createSpecChatState>;
  /**
   * Optional immersive creator factory — allows tests to inject a mock surface
   * instead of the real Tauri-backed one.
   */
  mountImmersive?: (opts: ImmersiveOpts) => ImmersiveInstance;
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
  const deleteDraft = apis?.deleteDraft ?? defaultDeleteDraft;
  const panelFactory = apis?.mountPanel ?? mountSpecChatPanel;
  const stateFactory = apis?.createState ?? (() => createSpecChatState({ getCwd: deps.getCwd }));
  const immersiveFactory = apis?.mountImmersive ?? mountImmersiveSpecCreator;

  let chooserEl: HTMLElement | null = null;
  let panelMounted = false;
  // Sentinel panel — replaced by mountImmersive on first open.
  let currentPanel: SpecChatPanel = panelFactory(host, stateFactory());

  /**
   * Mount the immersive creator for the two AI-assisted options (new / resume).
   * The publish sequence is intentionally identical to the old panel's onPublishRequest:
   *   1. markPublished(draftId) — best-effort
   *   2. deps.openWizardWithBody(markdown) — opens the draft wizard pre-filled
   *   3. controller.close() — closes the immersive surface
   */
  function openImmersive(draftId: string | null): void {
    const source = tauriEventSource(draftId);
    const cwd = deps.getCwd?.() ?? null;
    host.hidden = false;
    panelMounted = true;
    const instance = immersiveFactory({
      host,
      source,
      cwd,
      draftId,
      onPublish: (markdown: string, id: string) => {
        // Exact same sequence as the old panel's onPublishRequest.
        void markPublished(id).catch(() => {/* best-effort */});
        deps.openWizardWithBody(markdown);
        controller.close();
      },
      onClose: () => {
        panelMounted = false;
        host.hidden = true;
      },
    });
    // Replace sentinel so controller.close() reaches the immersive instance.
    currentPanel = {
      open: () => { /* already open */ },
      close: () => instance.close(),
      isOpen: () => panelMounted,
      onPublishRequest: null,
      onClose: null,
    };
  }

  let chooserKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  function removeChooser(): void {
    if (chooserEl) {
      chooserEl.remove();
      chooserEl = null;
    }
    if (chooserKeyHandler) {
      document.removeEventListener("keydown", chooserKeyHandler);
      chooserKeyHandler = null;
    }
  }

  function renderChooser(drafts: SpecDraftSummary[]): void {
    removeChooser();

    const el = document.createElement("div");
    el.className = "spec-chat-chooser";
    // Backdrop click (anywhere outside a button) dismisses the chooser.
    el.addEventListener("click", (e) => {
      if (e.target === el) controller.close();
    });
    // Esc dismisses while the chooser is mounted.
    chooserKeyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        controller.close();
      }
    };
    document.addEventListener("keydown", chooserKeyHandler);

    const head = document.createElement("header");
    head.className = "spec-chat-chooser-head";

    const brand = document.createElement("h2");
    brand.className = "spec-chat-chooser-brand";
    const brandIcon = document.createElement("span");
    brandIcon.className = "spec-chat-chooser-brand-icon";
    brandIcon.innerHTML = Icons.sparkles({ size: 16 });
    brandIcon.setAttribute("aria-hidden", "true");
    const brandText = document.createElement("span");
    brandText.textContent = "Spec Creator";
    brand.appendChild(brandIcon);
    brand.appendChild(brandText);

    const lead = document.createElement("p");
    lead.className = "spec-chat-chooser-lead";
    lead.textContent = "what do you want to do?";

    head.appendChild(brand);
    head.appendChild(lead);
    el.appendChild(head);

    // "Retomar" options (up to 3)
    const recent = drafts.slice(0, 3);
    for (const draft of recent) {
      const row = document.createElement("div");
      row.className = "spec-chat-chooser-row";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "spec-chat-chooser-btn";
      btn.textContent = `Resume "${shortSummary(draft)}" (last edited: ${relativeTime(draft.last_updated)})`;
      btn.addEventListener("click", () => {
        removeChooser();
        openImmersive(draft.id);
      });
      row.appendChild(btn);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "spec-chat-chooser-del";
      delBtn.setAttribute("aria-label", "Delete draft");
      delBtn.innerHTML = Icons.trash({ size: 14 });
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await deleteDraft(draft.id);
          row.remove();
          // If no drafts left, re-render as if no in-progress drafts
          if (el.querySelectorAll(".spec-chat-chooser-row").length === 0) {
            removeChooser();
            openImmersive(null);
          }
        } catch {
          // silently ignore deletion failures
        }
      });
      row.appendChild(delBtn);

      el.appendChild(row);
    }

    // "Empezar nuevo"
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "spec-chat-chooser-btn spec-chat-chooser-btn--new";
    newBtn.textContent = "Start a new one";
    newBtn.addEventListener("click", () => {
      removeChooser();
      openImmersive(null);
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
          openImmersive(null);
        }
      }).catch(() => {
        // On error, open a fresh immersive session
        openImmersive(null);
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
