/// Unified mention source orchestrator. Each provider can fail; the
/// orchestrator interleaves results so partial failures still produce
/// a useful popup.

import type { FileHit, CommandHit, Operator, SpecHit } from "../api";

export type Source = "files" | "sessions" | "commands" | "teammates" | "specs";
export type Tab = "all" | Source;

export interface OpenSessionInfo {
  session_id: string;
  short_id: string;
  cwd: string;
  tab_index: number;
  shell: string;
  last_command: string | null;
  block_count: number;
}

export interface MentionHit {
  kind: Source;
  /// Canonical insertion token (without the leading "@"):
  /// files → rel_path; sessions → "session:<short_id>";
  /// commands → "cmd:<block_id>"; teammates → "teammate:<name>".
  token: string;
  primary: string;
  secondary: string;
  matchIndices: number[];
  payload:
    | { kind: "files";     abs: string; rel: string }
    | { kind: "sessions";  session_id: string; cwd: string; shell: string; tab_index: number; block_count: number; last_command: string | null }
    | { kind: "commands";  block_id: string; session_id: string }
    | { kind: "teammates"; operator_id: string; name: string }
    | { kind: "specs";     abs: string; id: string; title: string; goal: string };
}

export interface MentionSourcesDeps {
  findFiles:           (cwd: string, query: string, limit: number) => Promise<FileHit[]>;
  listOperators:       () => Promise<Operator[]>;
  listOpenSessions:    () => OpenSessionInfo[];
  findRecentCommands:  (query: string, limit: number) => Promise<CommandHit[]>;
  findSpecs:           (cwd: string, query: string, limit: number) => Promise<SpecHit[]>;
}

export interface FindMentionsArgs {
  query: string;
  cwd: string | null;
  activeTab: Tab;
  limit: number;
  deps: MentionSourcesDeps;
}

const PER_SOURCE_ON_ALL = 3;

export async function findMentions(args: FindMentionsArgs): Promise<MentionHit[]> {
  const { query, cwd, activeTab, limit, deps } = args;
  const want = (s: Source) => activeTab === "all" || activeTab === s;

  const filesP: Promise<MentionHit[]> =
    want("files") && cwd
      ? deps.findFiles(cwd, query, limit).then(asFileHits).catch(logZero("findFiles"))
      : Promise.resolve([]);

  const specsP: Promise<MentionHit[]> =
    want("specs") && cwd
      ? deps.findSpecs(cwd, query, limit).then(asSpecHits).catch(logZero("findSpecs"))
      : Promise.resolve([]);

  const sessionsP: Promise<MentionHit[]> =
    want("sessions")
      ? Promise.resolve(filterSessions(safeCall(deps.listOpenSessions, "listOpenSessions"), query))
      : Promise.resolve([]);

  const commandsP: Promise<MentionHit[]> =
    want("commands")
      ? deps.findRecentCommands(query, limit).then(asCommandHits).catch(logZero("findRecentCommands"))
      : Promise.resolve([]);

  const teammatesP: Promise<MentionHit[]> =
    want("teammates")
      ? deps.listOperators().then((ops) => filterTeammates(ops, query)).catch(logZero("listOperators"))
      : Promise.resolve([]);

  const [files, specs, sessions, commands, teammates] = await Promise.all([filesP, specsP, sessionsP, commandsP, teammatesP]);

  if (activeTab !== "all") {
    return ({ files, specs, sessions, commands, teammates } as Record<Source, MentionHit[]>)[activeTab].slice(0, limit);
  }
  return [
    ...files.slice(0, PER_SOURCE_ON_ALL),
    ...specs.slice(0, PER_SOURCE_ON_ALL),
    ...sessions.slice(0, PER_SOURCE_ON_ALL),
    ...commands.slice(0, PER_SOURCE_ON_ALL),
    ...teammates.slice(0, PER_SOURCE_ON_ALL),
  ].slice(0, limit);
}

function logZero(name: string): (e: unknown) => MentionHit[] {
  return (e) => { console.error(`mention source ${name} failed`, e); return []; };
}

function safeCall<T>(fn: () => T, name: string): T | [] {
  try { return fn(); } catch (e) { console.error(`mention source ${name} failed`, e); return [] as unknown as T; }
}

function asFileHits(hits: FileHit[]): MentionHit[] {
  return hits.map((h) => ({
    kind: "files",
    token: h.rel_path,
    primary: basename(h.rel_path),
    secondary: h.rel_path,
    matchIndices: h.match_indices,
    payload: { kind: "files", abs: h.path, rel: h.rel_path },
  }));
}

function asSpecHits(hits: SpecHit[]): MentionHit[] {
  return hits.map((h) => ({
    kind: "specs",
    token: `spec:${h.id}`,
    primary: `${h.id}  ${h.title}`,
    secondary: h.goal || "(no description)",
    matchIndices: h.match_indices.map((i) => i + h.id.length + 2), // offset for "ID  " prefix
    payload: { kind: "specs", abs: h.abs_path, id: h.id, title: h.title, goal: h.goal },
  }));
}

function asCommandHits(hits: CommandHit[]): MentionHit[] {
  return hits.map((h) => ({
    kind: "commands",
    token: `cmd:${h.block_id}`,
    primary: h.command,
    secondary: `exit ${h.exit_code ?? "?"} · ${relativeTime(h.finished_at_unix_ms)} · ${shortCwd(h.cwd)}`,
    matchIndices: h.match_indices,
    payload: { kind: "commands", block_id: h.block_id, session_id: h.session_id },
  }));
}

function filterSessions(sessions: OpenSessionInfo[], query: string): MentionHit[] {
  const q = query.toLowerCase();
  return sessions
    .filter((s) =>
      q === "" ||
      s.cwd.toLowerCase().includes(q) ||
      s.shell.toLowerCase().includes(q) ||
      String(s.tab_index) === q,
    )
    .map((s) => ({
      kind: "sessions",
      token: `session:${s.short_id}`,
      primary: `tab ${s.tab_index} · ${s.shell}`,
      secondary: `${shortCwd(s.cwd)} · ${s.block_count} blocks${s.last_command ? ` · last: ${s.last_command}` : ""}`,
      matchIndices: [],
      payload: {
        kind: "sessions",
        session_id: s.session_id,
        cwd: s.cwd,
        shell: s.shell,
        tab_index: s.tab_index,
        block_count: s.block_count,
        last_command: s.last_command,
      },
    }));
}

function filterTeammates(ops: Operator[], query: string): MentionHit[] {
  const q = query.toLowerCase();
  return ops
    .filter((o) => q === "" || o.name.toLowerCase().includes(q))
    .map((o) => ({
      kind: "teammates",
      token: `teammate:${o.name}`,
      primary: o.name,
      secondary: `teammate${o.model ? ` · ${o.model}` : ""}`,
      matchIndices: [],
      payload: { kind: "teammates", operator_id: o.id, name: o.name },
    }));
}

function basename(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }
function shortCwd(cwd: string): string { return cwd.replace(/^.*\/([^/]+\/[^/]+)$/, "…/$1"); }
function relativeTime(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
