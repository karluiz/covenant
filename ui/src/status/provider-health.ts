// Provider health polling — checks the Atlassian Statuspage v2 API for
// known executor providers. Runs a single background interval per provider;
// consumers subscribe and are notified on every poll tick.
//
// Health states:
//   ok        — indicator "none"  (all systems operational)
//   degraded  — indicator "minor" (partial outage / some degradation)
//   down      — indicator "major" | "critical" (major outage)
//   unknown   — no status page for this provider, or fetch failed
//
// Providers without a public status page always return "unknown" and
// should be treated as "no signal" — don't show a dot at all.

export type ProviderHealth = "ok" | "degraded" | "down" | "unknown";

const POLL_INTERVAL_MS = 60_000;

interface CacheEntry {
  health: ProviderHealth;
  description: string; // e.g. "All Systems Operational"
  fetchedAt: number;
}

type HealthListener = (health: ProviderHealth, description: string) => void;

const cache = new Map<string, CacheEntry>();
const listeners = new Map<string, Set<HealthListener>>();
const polling = new Set<string>();

// Atlassian Statuspage v2 endpoints. Only providers with a public page
// are listed; everything else resolves to "unknown".
const STATUS_URLS: Record<string, string> = {
  claude: "https://status.anthropic.com/api/v2/status.json",
  copilot: "https://www.githubstatus.com/api/v2/status.json",
  codex: "https://status.openai.com/api/v2/status.json",
  opencode: "https://status.openai.com/api/v2/status.json",
};

function indicatorToHealth(indicator: string): ProviderHealth {
  if (indicator === "none") return "ok";
  if (indicator === "minor") return "degraded";
  return "down";
}

async function fetchHealth(
  provider: string,
): Promise<{ health: ProviderHealth; description: string }> {
  const url = STATUS_URLS[provider];
  if (!url) return { health: "unknown", description: "" };
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      // Status pages are public; cache for at most 30s on the network side.
      cache: "no-store",
    });
    if (!res.ok) return { health: "unknown", description: "" };
    const data = (await res.json()) as {
      status?: { indicator?: string; description?: string };
    };
    const indicator = data?.status?.indicator ?? "none";
    const description = data?.status?.description ?? "";
    return { health: indicatorToHealth(indicator), description };
  } catch {
    return { health: "unknown", description: "" };
  }
}

function notifyListeners(provider: string, entry: CacheEntry): void {
  for (const fn of listeners.get(provider) ?? []) {
    try {
      fn(entry.health, entry.description);
    } catch {
      // listener errors must not break the polling loop
    }
  }
}

async function poll(provider: string): Promise<void> {
  const { health, description } = await fetchHealth(provider);
  const prev = cache.get(provider);
  const entry: CacheEntry = { health, description, fetchedAt: Date.now() };
  cache.set(provider, entry);
  // Only notify when the status actually changed (avoids spurious re-renders).
  if (prev?.health !== health || prev?.description !== description) {
    notifyListeners(provider, entry);
  }
}

function startPolling(provider: string): void {
  if (polling.has(provider)) return;
  polling.add(provider);
  void poll(provider);
  window.setInterval(() => void poll(provider), POLL_INTERVAL_MS);
}

/** Current health for a provider. "unknown" if not yet fetched. */
export function getProviderHealth(provider: string): ProviderHealth {
  return cache.get(provider.toLowerCase())?.health ?? "unknown";
}

/** Human-readable status description, e.g. "All Systems Operational". */
export function getProviderDescription(provider: string): string {
  return cache.get(provider.toLowerCase())?.description ?? "";
}

/**
 * Subscribe to health updates for a provider. Returns an unsubscribe fn.
 * Starts polling automatically if this provider has a known status page.
 */
export function subscribeProviderHealth(
  provider: string,
  fn: HealthListener,
): () => void {
  const key = provider.toLowerCase();
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key)!.add(fn);
  startPolling(key);
  return () => {
    listeners.get(key)?.delete(fn);
  };
}
