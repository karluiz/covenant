export type MarkdownEditorMode = "full" | "inline";

export interface MarkdownEditorOptions {
  value?: string;
  placeholder?: string;
  mode?: MarkdownEditorMode;
  className?: string;
  onChange?: (markdown: string) => void;
  /** inline mode only: Enter (no shift) calls this instead of inserting a newline. */
  onSubmit?: () => void;
}

/**
 * Lazy WYSIWYG markdown editor over Milkdown. The DOM `element` is available
 * synchronously; Milkdown boots asynchronously via dynamic import, so the heavy
 * ProseMirror bundle is paid only on first use. Value reads/writes and destroy()
 * work before boot completes (buffered).
 */
export class MarkdownEditor {
  readonly element: HTMLElement;

  private readonly opts: MarkdownEditorOptions;
  private buffered: string;
  private destroyed = false;

  private editor: { destroy: () => void } | null = null;
  private getMd: (() => string) | null = null;
  private setMd: ((markdown: string) => void) | null = null;

  constructor(opts: MarkdownEditorOptions) {
    this.opts = opts;
    this.buffered = opts.value ?? "";
    this.element = document.createElement("div");
    this.element.className = [
      "md-editor",
      `md-editor--${opts.mode ?? "full"}`,
      opts.className ?? "",
    ].filter(Boolean).join(" ");
    if (opts.placeholder) this.element.dataset.placeholder = opts.placeholder;
    void this.boot();
  }

  get value(): string {
    return this.getMd ? this.getMd() : this.buffered;
  }

  set value(markdown: string) {
    this.buffered = markdown;
    this.setMd?.(markdown);
  }

  focus(): void {
    this.element.querySelector<HTMLElement>(".ProseMirror")?.focus();
  }

  destroy(): void {
    this.destroyed = true;
    this.editor?.destroy();
    this.editor = null;
    this.getMd = null;
    this.setMd = null;
  }

  private async boot(): Promise<void> {
    try {
      const [core, commonmarkMod, listenerMod, utils] = await Promise.all([
        import("@milkdown/kit/core"),
        import("@milkdown/kit/preset/commonmark"),
        import("@milkdown/kit/plugin/listener"),
        import("@milkdown/kit/utils"),
      ]);
      if (this.destroyed) return;

      const { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx } = core;
      const { commonmark } = commonmarkMod;
      const { listener, listenerCtx } = listenerMod;
      const { getMarkdown, replaceAll } = utils;

      const self = this;

      const editorInstance = await Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, self.element);
          ctx.set(defaultValueCtx, self.buffered);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (ctx.get(listenerCtx) as any).markdownUpdated(
            (_ctx: unknown, markdown: string) => {
              if (self.destroyed) return;
              self.buffered = markdown;
              self.opts.onChange?.(markdown);
            }
          );
          if (self.opts.mode === "inline" && self.opts.onSubmit) {
            // editorViewOptionsCtx typing varies by Milkdown version; cast is safe here.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ctx.update(editorViewOptionsCtx as any, (prev: Record<string, unknown>) => ({
              ...prev,
              handleKeyDown: (_view: unknown, event: KeyboardEvent) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  self.opts.onSubmit?.();
                  return true;
                }
                return false;
              },
            }));
          }
        })
        .use(commonmark)
        .use(listener)
        .create();

      if (this.destroyed) { editorInstance.destroy(); return; }

      this.editor = editorInstance;
      // The placeholder pseudo-element reads `attr(data-placeholder)` from the
      // .ProseMirror node it's attached to, so mirror the host's placeholder
      // onto the ProseMirror root once it exists.
      if (this.opts.placeholder) {
        this.element
          .querySelector<HTMLElement>(".ProseMirror")
          ?.setAttribute("data-placeholder", this.opts.placeholder);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.getMd = () => (editorInstance as any).action(getMarkdown());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.setMd = (markdown: string) => (editorInstance as any).action(replaceAll(markdown));
    } catch (err) {
      // Boot failures are non-fatal to the contract; log for diagnostics.
      console.error("[MarkdownEditor] boot failed", err);
    }
  }
}
