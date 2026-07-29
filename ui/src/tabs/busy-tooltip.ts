/// What the busy-process glyph on a tab pill says on hover.
///
/// "node running" named the runtime and withheld the one thing you'd act
/// on. The badge only lights when the backend found a LISTEN socket in the
/// tab's process tree — so the port is already known, and the port is what
/// tells three identical `node` tabs apart.
///
/// Pure so the segment dropping is testable without a DOM.

import type { TooltipContent } from "../tooltip/tooltip";

export interface BusyTooltipInput {
  proc: string;
  /// Lowest port held in LISTEN. `null` when the socket closed between the
  /// backend's walk and its read — then there is nothing to open, either.
  port: number | null;
  pid: number | null;
  /// When the frontend first saw this server running. `null` on a tab
  /// restored with the server already up: we know it's serving, not since when.
  since: number | null;
  cwd: string | null;
  nowMs: number;
}

/// Coarse on purpose: this is a "has it been up long enough to trust?"
/// signal, not a stopwatch.
function upFor(sinceMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  if (s < 60) return `up ${s}s`;
  if (s < 3600) return `up ${Math.floor(s / 60)}m`;
  return `up ${Math.floor(s / 3600)}h`;
}

/// `~` the home prefix — the full path is noise in a 340px tip.
function shortCwd(cwd: string): string {
  const home = cwd.match(/^\/Users\/[^/]+/)?.[0];
  return home ? cwd.replace(home, "~") : cwd;
}

export function busyTooltip(input: BusyTooltipInput): TooltipContent {
  const { proc, port, pid, since, cwd, nowMs } = input;

  const meta = [
    since !== null ? upFor(since, nowMs) : null,
    pid !== null ? `pid ${pid}` : null,
    // The runtime name is a detail once the port has identified the server.
    port !== null ? proc : null,
  ].filter((s): s is string => s !== null);

  return {
    title: port !== null ? `${proc} is serving on :${port}` : `${proc} is running here`,
    meta: meta.length > 0 ? meta.join(" · ") : undefined,
    preview: cwd ? shortCwd(cwd) : undefined,
    // No port, no click: never advertise a door that opens onto nothing.
    hint: port !== null ? "Click to open in a browser tab" : undefined,
  };
}

/// The URL the glyph opens. Kept beside the tooltip that advertises it so
/// the two can't disagree about which port.
export function busyUrl(port: number): string {
  return `http://localhost:${port}`;
}
