export interface NavEvent {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

export interface NavState extends NavEvent {
  label: string;
}

export function initialNavState(): NavState {
  return { url: "", title: "", canGoBack: false, canGoForward: false, loading: false, label: "New Tab" };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function applyNav(prev: NavState, e: NavEvent): NavState {
  const label = e.title.trim() || hostOf(e.url) || prev.label;
  return { ...e, label };
}
