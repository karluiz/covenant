import { scoreSummary, type Summary } from "./api";

export interface ScoreChip {
  el: HTMLElement;
  refresh: () => Promise<void>;
  setOnClick: (h: () => void) => void;
}

export function makeScoreChip(): ScoreChip {
  const el = document.createElement("button");
  el.className = "status-segment status-score";
  el.setAttribute("aria-label", "Covenant score — click to open");
  el.style.cursor = "pointer";

  const text = document.createElement("span");
  text.className = "score-chip-text";
  text.textContent = "Sign in";
  el.appendChild(text);

  let onClick: (() => void) | null = null;
  el.addEventListener("click", () => onClick?.());

  async function refresh(): Promise<void> {
    try {
      const s: Summary = await scoreSummary();
      if (s.total_prompts === 0 && s.total_commits === 0) {
        text.textContent = "Sign in";
      } else {
        const streak = s.current_streak > 0 ? ` · ${s.current_streak}d` : "";
        text.textContent = `${s.total_prompts} prompts${streak}`;
      }
    } catch (e) {
      console.warn("score chip refresh failed", e);
    }
  }

  return {
    el,
    refresh,
    setOnClick: (h) => { onClick = h; },
  };
}
