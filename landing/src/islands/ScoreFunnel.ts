const STAGES = [
  { id: "spc", final: 12 },
  { id: "pln", final: 38 },
  { id: "tsk", final: 214 },
  { id: "tok", final: 4_100_000, format: (n: number) => `${(n / 1_000_000).toFixed(1)}M` },
  { id: "cmt", final: 412 },
  { id: "pr", final: 27 },
] as const;

function animate(el: HTMLElement, final: number, format: (n: number) => string) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) { el.textContent = format(final); return; }
  const start = performance.now();
  const duration = 1100;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(Math.round(final * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-score-funnel]");
  if (!root) return;
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      io.disconnect();
      for (const stage of STAGES) {
        const el = root.querySelector<HTMLElement>(`[data-stage="${stage.id}"]`);
        if (!el) continue;
        const fmt = "format" in stage && stage.format ? stage.format : (n: number) => n.toLocaleString();
        animate(el, stage.final, fmt);
      }
    }
  }, { threshold: 0.4 });
  io.observe(root);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
