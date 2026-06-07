import './immersive.css';
import type { SpecEventSource } from './events';
import { createStreamState } from './stream-state';
import { mountActivityStream } from './activity-stream';
import { mountLiveSpec } from './live-spec';

export interface ImmersiveOpts {
  host: HTMLElement;
  source: SpecEventSource;
  cwd: string | null;
  draftId?: string | null;
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
        <div class="spine-host" style="flex:1"></div>
        <div class="kbd">esc</div>
      </header>
      <div class="stage">
        <div class="left"><div class="col-head">Reasoning &amp; exploration</div>
          <div class="stream-host"></div>
          <div class="composer"><div class="box">
            <textarea rows="1" placeholder="Describe the problem…"></textarea>
            <button class="send">▸</button></div></div>
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

  mountActivityStream(root.querySelector('.stream-host') as HTMLElement, state);
  // mountLiveSpec appends both .spine and .spec to its host; we want the spine in
  // the header and the spec in the right column. Mount into a temp host, then move.
  const tmp = document.createElement('div');
  mountLiveSpec(tmp, state);
  const spine = tmp.querySelector('.spine');
  const spec = tmp.querySelector('.spec');
  if (spine) (root.querySelector('.spine-host') as HTMLElement).appendChild(spine);
  if (spec) (root.querySelector('.spec-host') as HTMLElement).appendChild(spec);

  const off = opts.source.subscribe((e) => state.apply(e));

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
    if (md && draftId) opts.onPublish?.(md, draftId);
  });

  const ta = root.querySelector('textarea') as HTMLTextAreaElement;
  const submit = () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    void opts.source.send(draftId, text, opts.cwd).then((id) => { draftId = id; });
  };
  (root.querySelector('.send') as HTMLElement).addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    off();
    root.classList.remove('open');
    setTimeout(() => root.remove(), 420);
    opts.onClose?.();
  };

  return { submit, close };
}
