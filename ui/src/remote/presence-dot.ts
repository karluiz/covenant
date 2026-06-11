import { listen } from "@tauri-apps/api/event";
import { disarmAllRemote, setRemoteAllowOpen, getRemoteAllowOpen } from "../api";
import { attachTooltip } from "../tooltip/tooltip";

const GRACE_MS = 200;

/** Pulsing red dot beside the COVENANT brand, shown only while >=1 web client
 *  is remote-controlling this desktop. Hover opens a popover with the remote
 *  count, the "allow new tabs" toggle, and the Disable-all kill switch; click
 *  pins it open. Replaces the old fixed top-right pill that covered the
 *  titlebar action buttons. */
export function mountRemotePresenceDot(doc: Document = document): void {
  if (doc.getElementById("rc-presence-dot")) return; // guard against double-mount
  const center = doc.getElementById("app-titlebar-center");
  if (!center) return;

  const dot = doc.createElement("button");
  dot.id = "rc-presence-dot";
  dot.className = "rc-presence-dot";
  dot.type = "button";
  dot.setAttribute("aria-label", "Remote control active");
  dot.setAttribute("aria-haspopup", "true");
  dot.setAttribute("aria-expanded", "false");
  center.appendChild(dot);

  const pop = doc.createElement("div");
  pop.id = "rc-presence-popover";
  pop.className = "rc-presence-popover";

  const status = doc.createElement("div");
  status.className = "rc-presence-status";
  const statusDot = doc.createElement("span");
  statusDot.className = "rc-presence-status-dot";
  const label = doc.createElement("span");
  status.append(statusDot, label);

  const openWrap = doc.createElement("label");
  openWrap.className = "rc-presence-allow";
  const openCb = doc.createElement("input");
  openCb.type = "checkbox";
  attachTooltip(openWrap, "Allow remote clients to open new tabs");
  const openTxt = doc.createElement("span");
  openTxt.textContent = "allow new tabs";
  openWrap.append(openCb, openTxt);
  openCb.addEventListener("change", () => { void setRemoteAllowOpen(openCb.checked); });
  void getRemoteAllowOpen().then((v) => { openCb.checked = v; }).catch(() => {});

  // Disarming doesn't change the presence count (web clients stay
  // connected), so the button itself must confirm: flip to "Disarmed ✓",
  // hold briefly, then close. On failure stay open and offer a retry.
  const KILL_IDLE_LABEL = "Disable all";
  const KILL_CONFIRM_MS = 900;
  const kill = doc.createElement("button");
  kill.type = "button";
  kill.className = "rc-presence-kill";
  kill.textContent = KILL_IDLE_LABEL;
  attachTooltip(kill, "Disarm every tab and cut remote control");
  let killReset: number | undefined;
  const resetKill = () => {
    if (killReset !== undefined) { clearTimeout(killReset); killReset = undefined; }
    kill.textContent = KILL_IDLE_LABEL;
    kill.disabled = false;
    kill.classList.remove("rc-presence-kill-done");
  };
  kill.addEventListener("click", () => {
    kill.disabled = true;
    disarmAllRemote().then(() => {
      kill.textContent = "Disarmed ✓";
      kill.classList.add("rc-presence-kill-done");
      killReset = window.setTimeout(close, KILL_CONFIRM_MS);
    }).catch(() => {
      kill.textContent = "Failed — retry";
      kill.disabled = false;
    });
  });

  pop.append(status, openWrap, kill);
  doc.body.appendChild(pop);

  let pinned = false;
  let closeTimer: number | undefined;

  const position = () => {
    const r = dot.getBoundingClientRect();
    pop.style.left = `${r.left + r.width / 2}px`;
    pop.style.top = `${r.bottom + 8}px`;
  };
  const open = () => {
    if (closeTimer !== undefined) { clearTimeout(closeTimer); closeTimer = undefined; }
    position();
    pop.classList.add("rc-presence-popover-open");
    dot.setAttribute("aria-expanded", "true");
  };
  const close = () => {
    pinned = false;
    if (closeTimer !== undefined) { clearTimeout(closeTimer); closeTimer = undefined; }
    pop.classList.remove("rc-presence-popover-open");
    dot.setAttribute("aria-expanded", "false");
    resetKill();
  };
  const scheduleClose = () => {
    if (pinned) return;
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    closeTimer = window.setTimeout(close, GRACE_MS);
  };

  dot.addEventListener("mouseenter", open);
  dot.addEventListener("mouseleave", scheduleClose);
  pop.addEventListener("mouseenter", open);
  pop.addEventListener("mouseleave", scheduleClose);
  dot.addEventListener("click", () => {
    if (pinned) { close(); return; }
    pinned = true;
    open();
  });
  doc.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  doc.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (!dot.contains(t) && !pop.contains(t)) close();
  });

  let count = 0;
  const render = () => {
    const live = count > 0;
    dot.style.display = live ? "" : "none";
    if (!live) close();
    label.textContent = `remote · ${count}`;
  };
  render();

  void listen<number>("rc://web-presence", (e) => {
    count = typeof e.payload === "number" ? e.payload : 0;
    render();
  });
}
