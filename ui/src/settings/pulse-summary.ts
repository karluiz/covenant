import { scoreSummaryFiltered } from "../score/api";
import { formatChord } from "../platform";

/// Compact Settings strip: keeps the metrics discoverable in Settings while
/// the real home is the full-screen Pulse surface (⌘⌥M).
export async function renderPulseSummary(host: HTMLElement, onOpen: () => void): Promise<void> {
  const s = await scoreSummaryFiltered({ range: "all" });
  host.innerHTML = `
    <div class="pulse-mini">
      <div class="pulse-mini-stat"><b>${s.current_streak}d</b><span>streak</span></div>
      <div class="pulse-mini-stat"><b>${s.today_prompts}</b><span>today</span></div>
      <div class="pulse-mini-stat"><b>${s.total_prompts.toLocaleString()}</b><span>prompts</span></div>
      <div class="pulse-mini-stat"><b>${s.total_commits.toLocaleString()}</b><span>commits</span></div>
      <button type="button" class="pulse-open-btn">Open Pulse → <kbd>${formatChord(["mod", "alt", "M"])}</kbd></button>
    </div>
  `;
  host.querySelector<HTMLButtonElement>(".pulse-open-btn")!.addEventListener("click", onOpen);
}
