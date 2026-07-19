/** Copy `text`, surviving the loss of user activation.
 *
 * WKWebView rejects `navigator.clipboard.writeText` with NotAllowedError when
 * the call happens after an await (network round-trip), because transient
 * activation is gone by then. The textarea + execCommand path has no such
 * requirement. ponytail: no Rust command needed — execCommand is deprecated
 * but still works everywhere we ship; revisit if a webview drops it.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("clipboard write blocked");
}
