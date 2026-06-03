// Favicon rendering: DuckDuckGo's favicon proxy (consistent with the default search
// engine), with a colored monogram fallback when the icon fails to load.

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function monogram(title: string, domain: string): HTMLElement {
  const m = document.createElement("span");
  m.className = "fav-icon-mono";
  const ch = (title.trim()[0] || domain.trim()[0] || "?").toUpperCase();
  m.textContent = ch;
  // Deterministic hue from the seed so the same site keeps the same color.
  const seed = domain || title;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  m.style.background = `hsl(${h} 45% 32%)`;
  return m;
}

/** A 16px icon element for a link favorite, with monogram fallback on error. */
export function faviconEl(url: string, title: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "fav-icon";
  const domain = domainOf(url);
  if (!domain) {
    wrap.appendChild(monogram(title, domain));
    return wrap;
  }
  const img = document.createElement("img");
  img.className = "fav-icon-img";
  img.src = `https://icons.duckduckgo.com/ip3/${domain}.ico`;
  img.alt = "";
  img.loading = "lazy";
  img.addEventListener("error", () => {
    wrap.replaceChildren(monogram(title, domain));
  });
  wrap.appendChild(img);
  return wrap;
}
