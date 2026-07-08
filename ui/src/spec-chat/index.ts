/**
 * spec-chat/index.ts — façade that wires the panel + state + entrance.
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
import { mountImmersiveSpecCreator } from "./immersive";
import { mountSpecEntrance, EXIT_MS } from "./entrance";
import type { EntranceInstance } from "./entrance";
import { tauriEventSource } from "./tauri-event-source";

export interface SpecChatDeps {
  openWizardWithBody: (body: string, opts?: { canonContext?: boolean }) => void;
  openBlankWizard: () => void;
  /** Resolves the active workspace cwd so the agent gets repo grounding. */
  getCwd?: () => string | null;
}

export interface SpecChatOpenOpts {
  canonContext?: boolean;
}

export interface SpecChatController {
  /** Open the entrance. Pass a draftId to resume that draft directly. */
  open: (draftId?: string, opts?: SpecChatOpenOpts) => void;
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

  let panelMounted = false;
  let canonContext = false;
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
        deps.openWizardWithBody(markdown, { canonContext });
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

  let entrance: EntranceInstance | null = null;
  let entranceMounted = false;

  function removeEntrance(): void {
    entranceMounted = false;
    if (entrance) {
      entrance.dismiss();
      entrance = null;
    }
  }

  function renderEntrance(drafts: SpecDraftSummary[]): void {
    removeEntrance();
    // Unhide BEFORE mounting: the sky canvas measures itself at mount, and a
    // display:none host reads 0×0 — collapsing every particle to a point.
    host.hidden = false;
    entrance = mountSpecEntrance(host, drafts, {
      onResume: (id) => {
        removeEntrance();
        openImmersive(id);
      },
      onNew: () => {
        removeEntrance();
        openImmersive(null);
      },
      onBlank: () => {
        controller.close();
        deps.openBlankWizard();
      },
      onDismiss: () => controller.close(),
      deleteDraft: (id) => deleteDraft(id),
      onEmptied: () => {
        // Last draft deleted — stay on the entrance (now its empty welcome
        // state) so the user keeps the AI-vs-blank choice. The entrance already
        // removed the card from the DOM; the :empty cards row collapses itself.
      },
    });
    entranceMounted = true;
  }

  const controller: SpecChatController = {
    isOpen: () => panelMounted || entranceMounted,

    open(draftId?: string, opts?: SpecChatOpenOpts) {
      canonContext = opts?.canonContext ?? false;
      if (controller.isOpen()) return;

      // Direct resume: the drafts tab clicks straight into a known draft,
      // skipping the entrance/list lookup.
      if (draftId) {
        openImmersive(draftId);
        return;
      }

      // Always land on the entrance — even with zero drafts — so the user
      // gets the AI-vs-blank choice (and first-run users see the welcome).
      void listDrafts().then((all) => {
        renderEntrance(all.filter(isInProgress));
      }).catch(() => {
        // On error, still show the entrance so the user can start fresh.
        renderEntrance([]);
      });
    },

    close() {
      const fadingEntrance = entranceMounted && !panelMounted;
      removeEntrance();
      if (panelMounted) {
        currentPanel.close();
        panelMounted = false;
      }
      if (fadingEntrance) {
        // Let the entrance's exit fade play out; skip the hide if reopened meanwhile.
        setTimeout(() => {
          if (!controller.isOpen()) host.hidden = true;
        }, EXIT_MS);
      } else {
        host.hidden = true;
      }
    },
  };

  return controller;
}
