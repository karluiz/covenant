import { scoreSummary, type Summary } from "./api";
import { getCurrentUser, onUserChanged } from "./user";

export interface ScoreChip {
  el: HTMLElement;
  refresh: () => Promise<void>;
  setOnClick: (h: () => void) => void;
}

function renderChipText(s: Summary, u: { login: string; avatar_url: string } | null): string {
  if (!u && s.total_prompts === 0 && s.total_commits === 0) return "Sign in";
  const streak = s.current_streak > 0 ? ` · ${s.current_streak}d` : "";
  if (!u) return `${s.total_prompts} prompts${streak}`;
  const safeLogin = u.login.replace(/[<>"&]/g, "");
  const safeAvatar = u.avatar_url.replace(/"/g, "");
  return `<img class="score-chip-avatar" src="${safeAvatar}" alt=""> ${safeLogin}${streak}`;
}

export function makeScoreChip(): ScoreChip {
  const el = document.createElement("button");
  el.className = "status-segment status-score";
  el.setAttribute("aria-label", "Metrics — click to open");
  el.style.cursor = "pointer";

  const text = document.createElement("span");
  text.className = "score-chip-text";
  text.textContent = "Sign in";
  el.appendChild(text);

  let onClick: (() => void) | null = null;
  el.addEventListener("click", () => onClick?.());

  async function refresh(): Promise<void> {
    try {
      const [s, u] = await Promise.all([scoreSummary(), getCurrentUser()]);
      text.innerHTML = renderChipText(s, u);
    } catch (e) {
      console.warn("score chip refresh failed", e);
    }
  }

  onUserChanged(() => { void refresh(); });

  return {
    el,
    refresh,
    setOnClick: (h) => { onClick = h; },
  };
}
