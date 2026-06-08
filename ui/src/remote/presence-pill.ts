import { listen } from "@tauri-apps/api/event";
import { disarmAllRemote } from "../api";
import { attachTooltip } from "../tooltip/tooltip";

/** Corner indicator shown only while >=1 web client is remote-controlling this
 *  desktop. Click "Disable all" to disarm every tab and cut remote control. */
export function mountRemotePresencePill(doc: Document = document): void {
  if (doc.getElementById("rc-presence-pill")) return; // guard against double-mount
  const pill = doc.createElement("div");
  pill.id = "rc-presence-pill";
  pill.setAttribute("role", "status");
  pill.style.cssText = [
    "position:fixed","top:10px","right:12px","z-index:99999",
    "display:none","align-items:center","gap:8px",
    "padding:4px 8px 4px 10px","border-radius:999px",
    "background:rgba(20,8,8,0.92)","border:1px solid rgba(255,80,80,0.5)",
    "box-shadow:0 2px 10px rgba(0,0,0,0.4)",
    "font:600 11px ui-monospace,Menlo,monospace","color:#ffb3b3",
    "-webkit-app-region:no-drag","user-select:none",
  ].join(";");

  const dot = doc.createElement("span");
  dot.style.cssText = "width:7px;height:7px;border-radius:50%;background:#ff5050;box-shadow:0 0 6px #ff5050;animation:rc-pulse 1.6s ease-in-out infinite";

  const label = doc.createElement("span");

  const kill = doc.createElement("button");
  kill.textContent = "Disable all";
  kill.style.cssText = "border:1px solid rgba(255,80,80,0.5);background:rgba(255,80,80,0.12);color:#ffd0d0;border-radius:999px;padding:2px 8px;font:inherit;cursor:pointer";
  attachTooltip(kill, "Disarm every tab and cut remote control");
  kill.addEventListener("click", () => { void disarmAllRemote(); });

  pill.append(dot, label, kill);
  doc.body.appendChild(pill);

  if (!doc.getElementById("rc-pulse-kf")) {
    const style = doc.createElement("style");
    style.id = "rc-pulse-kf";
    style.textContent = "@keyframes rc-pulse{0%,100%{opacity:1}50%{opacity:.3}}";
    doc.head.appendChild(style);
  }

  let count = 0;
  const render = () => {
    pill.style.display = count > 0 ? "flex" : "none";
    label.textContent = `remote · ${count}`;
  };
  render();

  void listen<number>("rc://web-presence", (e) => {
    count = typeof e.payload === "number" ? e.payload : 0;
    render();
  });
}
