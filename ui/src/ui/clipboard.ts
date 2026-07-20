import { writeText as nativeWriteText } from "@tauri-apps/plugin-clipboard-manager";

/** Copy `text`, surviving the loss of user activation.
 *
 * The native plugin writes to NSPasteboard from Rust, so it has no user
 * activation requirement at all — WKWebView rejects
 * `navigator.clipboard.writeText` with NotAllowedError when the call happens
 * after an await (network round-trip), because transient activation is gone
 * by then. The web paths stay as fallbacks for `npm run dev` in a plain
 * browser, where the plugin has no backend to call.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await nativeWriteText(text);
    return;
  } catch {
    // fall through
  }
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through
  }
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  // execCommand("copy") copies the *selection*, so the node must be both
  // focused and selectable — ancestors with user-select:none otherwise win.
  ta.style.userSelect = "text";
  ta.style.webkitUserSelect = "text";
  document.body.appendChild(ta);
  ta.focus();
  ta.setSelectionRange(0, text.length);
  const ok = document.execCommand("copy");
  ta.remove();
  active?.focus?.();
  if (!ok) throw new Error("clipboard write blocked");
}
