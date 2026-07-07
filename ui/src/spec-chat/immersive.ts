import './immersive.css';
import type { SpecEventSource, OutgoingImage } from './events';
import { createStreamState } from './stream-state';
import { MarkdownEditor } from '../ui/markdown-editor';
import { mountActivityStream } from './activity-stream';
import { mountLiveSpec } from './live-spec';
import { MAX_ATTACHMENTS, toAttachment, imagesFromClipboard, type PendingAttachment } from './attachments';
import {
  specAuthorLoadDraft, specAuthorDeleteDraft, specAuthorSaveMarkdown,
  specAuthorMaterializeAssets,
} from '../api';
import { scheduleCloudPush } from '../settings/cloud_push';
import type { SpecDraftSummary } from '../api';
import { Icons } from '../icons';
import { attachTooltip } from '../tooltip/tooltip';

export interface ImmersiveOpts {
  host: HTMLElement;
  source: SpecEventSource;
  cwd: string | null;
  draftId?: string | null;
  /** Loads a persisted draft for resume; injectable for tests. */
  loadDraft?: (id: string) => Promise<SpecDraftSummary>;
  onClose?: () => void;
  onPublish?: (markdown: string, draftId: string) => void;
}

export interface ImmersiveInstance { submit(): void; close(): void; }

export function mountImmersiveSpecCreator(opts: ImmersiveOpts): ImmersiveInstance {
  const state = createStreamState();
  let draftId: string | null = opts.draftId ?? null;

  const root = document.createElement('div');
  root.className = 'spec-creator';
  root.innerHTML = `
    <div class="scrim"></div>
    <div class="creator" role="dialog" aria-label="Spec Creator">
      <header>
        <div class="brand">✦ Spec Creator</div>
        <div class="repo-chip"></div>
        <div class="spine-host" style="flex:1"></div>
        <button class="spec-creator-del" aria-label="Delete draft" type="button">${Icons.trash({ size: 14 })}</button>
        <div class="kbd">esc</div>
      </header>
      <div class="stage">
        <div class="left"><div class="col-head">Reasoning &amp; exploration</div>
          <div class="stream-host"></div>
          <div class="composer">
            <div class="starters"></div>
            <div class="attachments" hidden></div>
            <div class="box">
              <svg class="box-spark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.6 5.2L19 9l-5.4 1.8L12 16l-1.6-5.2L5 9l5.4-1.8L12 2z"/></svg>
<button class="attach" aria-label="Attach image" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg></button>
<button class="send" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
            </div>
            <div class="composer-hint"><span><b>⏎</b> send · <b>⇧⏎</b> newline · <b>esc</b> close</span><span class="composer-engine"></span></div>
          </div>
        </div>
        <div class="right"><div class="col-head">Specification</div>
          <div class="spec-host"></div>
          <div class="publishbar"><div class="summary"></div>
            <button class="btn primary" disabled>Review &amp; publish</button></div>
        </div>
      </div>
    </div>`;
  opts.host.appendChild(root);
  requestAnimationFrame(() => root.classList.add('open'));

  // Repo grounding chip — shows which repo the agent's tools are jailed to,
  // or warns when the active tab never reported a cwd (agent flies blind).
  const repoChip = root.querySelector('.repo-chip') as HTMLElement;
  const repoName = opts.cwd?.replace(/\/+$/, '').split('/').pop() || null;
  if (repoName) {
    repoChip.textContent = repoName;
    attachTooltip(repoChip, `Agent grounded in ${opts.cwd}`);
  } else {
    repoChip.textContent = 'No repo attached';
    repoChip.classList.add('ungrounded');
    attachTooltip(repoChip,
      'No working directory from the active tab — the agent cannot explore your project');
  }

  mountActivityStream(root.querySelector('.stream-host') as HTMLElement, state, {
    onAnswer: (label) => sendText(label),
  });
  // mountLiveSpec appends both .spine and .spec to its host; we want the spine in
  // the header and the spec in the right column. Mount into a temp host, then move.
  const tmp = document.createElement('div');
  mountLiveSpec(tmp, state, (md) => {
    if (draftId) { void specAuthorSaveMarkdown(draftId, md); scheduleCloudPush(); }
  });
  const spine = tmp.querySelector('.spine');
  const spec = tmp.querySelector('.spec');
  if (spine) (root.querySelector('.spine-host') as HTMLElement).appendChild(spine);
  if (spec) (root.querySelector('.spec-host') as HTMLElement).appendChild(spec);

  const off = opts.source.subscribe((e) => state.apply(e));

  // Resume: rehydrate prior conversation + completed spec from disk. The backend
  // keeps the full transcript; without this the chat column starts blank.
  if (draftId) {
    const load = opts.loadDraft ?? specAuthorLoadDraft;
    void load(draftId)
      .then((draft) => {
        state.hydrate({
          messages: draft.messages.map((m) => ({
            role: m.role === 'User' ? 'user' : 'assistant',
            content: m.content,
          })),
          // Rebuild the section cards/nav from whatever was authored so far.
          markdown: draft.partial_md,
          // Publish stays gated on a completed (Ready) draft.
          finalMarkdown: draft.status === 'Ready' ? draft.partial_md : null,
        });
      })
      .catch(() => {/* fresh-start on load failure — non-fatal */});
  }

  const pubBtn = root.querySelector('.btn.primary') as HTMLButtonElement;
  state.onChange(() => {
    if (state.ready()) {
      pubBtn.disabled = false;
      (root.querySelector('.publishbar') as HTMLElement).classList.add('ready');
      (root.querySelector('.summary') as HTMLElement).textContent =
        `${state.tools().length} tool calls · ready to publish`;
    }
  });
  pubBtn.addEventListener('click', () => {
    const md = state.finalMarkdown();
    if (!md || !draftId) return;
    const id = draftId;
    // Materialize attached images into the repo so the spec's visual
    // references resolve for the executor. Best-effort — publish proceeds
    // even if the copy fails (e.g. no repo attached).
    const materialize = opts.cwd
      ? specAuthorMaterializeAssets(id, opts.cwd).catch(() => [] as string[])
      : Promise.resolve([] as string[]);
    void materialize.then(() => opts.onPublish?.(md, id));
  });

  const delBtn = root.querySelector('.spec-creator-del') as HTMLButtonElement;
  delBtn.addEventListener('click', async () => {
    if (!draftId) return;
    if (!confirm('Delete this spec draft?')) return;
    try {
      await specAuthorDeleteDraft(draftId);
      close();
    } catch { /* non-fatal */ }
  });

  const boxEl = root.querySelector('.box') as HTMLElement;
  const sendBtn = root.querySelector('.send') as HTMLElement;
  const attachBtn = root.querySelector('.attach') as HTMLButtonElement;
  const attachRow = root.querySelector('.attachments') as HTMLElement;
  let composer: MarkdownEditor;

  // Pending composer attachments (already downscaled + base64).
  let pending: PendingAttachment[] = [];
  const renderAttachments = () => {
    attachRow.replaceChildren();
    attachRow.hidden = pending.length === 0;
    pending.forEach((p, i) => {
      const chip = document.createElement('div');
      chip.className = 'att-chip';
      const img = document.createElement('img');
      img.src = p.previewUrl;
      img.alt = `attachment ${i + 1}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'att-del';
      del.setAttribute('aria-label', 'Remove attachment');
      del.textContent = '×';
      del.addEventListener('click', () => { pending.splice(i, 1); renderAttachments(); });
      chip.append(img, del);
      attachRow.appendChild(chip);
    });
  };
  const addBlobs = async (blobs: Blob[]) => {
    for (const b of blobs) {
      if (pending.length >= MAX_ATTACHMENTS) break;
      const att = await toAttachment(b);
      if (att) pending.push(att);
    }
    renderAttachments();
  };

  const sendText = (text: string, images: OutgoingImage[] = []) => {
    if (!text.trim() && images.length === 0) return;
    const shown = images.length
      ? `${text.trim()}${text.trim() ? '\n' : ''}📎 ${images.length} imagen${images.length > 1 ? 'es' : ''}`
      : text.trim();
    state.addUserMessage(shown);
    void opts.source
      .send(draftId, text.trim(), opts.cwd, images.length ? images : undefined)
      .then((id) => { draftId = id; })
      .catch((err) => state.apply({ kind: 'error', message: String(err?.message ?? err) }));
  };
  const submit = () => {
    const text = composer.value.trim();
    if (!text && pending.length === 0) return;
    const images: OutgoingImage[] = pending.map((p) => ({ dataB64: p.dataB64, mediaType: p.mediaType }));
    composer.value = '';
    pending = [];
    renderAttachments();
    sendText(text, images);
  };
  composer = new MarkdownEditor({
    mode: 'inline',
    placeholder: 'Describe the problem, paste an error, or name the feature…',
    onSubmit: () => submit(),
  });
  boxEl.insertBefore(composer.element, attachBtn);
  sendBtn.addEventListener('click', submit);

  // ⌘V screenshots/wireframes → attachment chips.
  boxEl.addEventListener('paste', (e) => {
    const blobs = imagesFromClipboard(e as ClipboardEvent);
    if (blobs.length) { e.preventDefault(); void addBlobs(blobs); }
  }, true);
  // Explicit picker for files on disk.
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.multiple = true;
  picker.style.display = 'none';
  root.appendChild(picker);
  picker.addEventListener('change', () => {
    void addBlobs(Array.from(picker.files ?? []));
    picker.value = '';
  });
  attachBtn.addEventListener('click', () => picker.click());

  // Starter chips — seed the empty state, vanish after the first turn.
  const startersEl = root.querySelector('.starters') as HTMLElement;
  const STARTERS = [
    'Esc doesn’t close my modals when the terminal is focused',
    'Add a light theme for the terminal',
    'Operators should be able to read my tasker tasks',
    'Refactor the spec-chat panel into smaller files',
  ];
  for (const s of STARTERS) {
    const chip = document.createElement('button');
    chip.className = 'starter-chip';
    chip.type = 'button';
    chip.textContent = s;
    chip.addEventListener('click', () => { composer.value = s; composer.focus(); submit(); });
    startersEl.appendChild(chip);
  }
  state.onChange(() => {
    startersEl.style.display = state.messages().length ? 'none' : '';
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    off();
    opts.source.dispose?.();
    root.classList.remove('open');
    setTimeout(() => root.remove(), 420);
    opts.onClose?.();
  };

  return { submit, close };
}
