/// Normalize address-bar input into a navigable URL.
/// - schemed URL → as-is
/// - localhost / IP, optionally with :port and path → http://
/// - bare domain (has a dot, no spaces) → https://
/// - anything else → DuckDuckGo search
export function normalizeAddress(input: string): string {
  const raw = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;

  const localRe = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d{1,5})?(\/.*)?$/i;
  if (localRe.test(raw)) return new URL(`http://${raw}`).toString();

  const ipPortRe = /^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?(\/.*)?$/;
  if (ipPortRe.test(raw)) return new URL(`http://${raw}`).toString();

  const domainRe = /^[^\s.]+(\.[^\s.]+)+(:\d{1,5})?(\/.*)?$/;
  if (domainRe.test(raw)) return new URL(`https://${raw}`).toString();

  return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
}
