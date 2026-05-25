// Operator avatar pack — pixel portraits the user purchased.
//
// Two coexisting catalogs:
//
//   v1 (`pack:<id>`)        — single pose per character, 18 entries from
//                             `ui/operators/*_transparent.png`.
//   v2 (`pack2:<character>`) — 18 characters × 9 emotional poses from
//                             `ui/operatorsv2/<char>_<emotion>.png`. The
//                             character is the persistent identity stored
//                             on the Operator record; the emotion is a
//                             runtime sentiment passed into the renderer.
//
// Stored on the Operator record as `emoji: "pack:<id>"` or
// `emoji: "pack2:<character>"`. The `parseAvatar` helper recognizes both
// prefixes; anything else is treated as a plain emoji string (back-compat).

// ──────────────── v1 catalog ────────────────

const v1Modules = import.meta.glob<string>(
  "../../operators/*_transparent.png",
  { query: "?url", import: "default", eager: true },
);

const URL_BY_ID: Record<string, string> = {};
for (const [key, url] of Object.entries(v1Modules)) {
  const file = key.split("/").pop()!;
  const id = file.replace("_transparent.png", "");
  URL_BY_ID[id] = url as string;
}

const V1_LABELS: Record<string, string> = {
  femalebaker1: "Baker",
  femalecafemaid1: "Café Maid",
  femaleelder1: "Elder",
  femaleofficeworker1: "Office Worker",
  femalestudent1: "Student",
  femaletrendy1: "Trendy",
  femaleyouth1: "Youth",
  guttychan1: "Gutty-chan",
  malecasual1: "Casual",
  malepunk1: "Punk",
  malestudent1: "Student M1",
  malestudent2: "Student M2",
  maletraditional1: "Traditional",
  maletrafficcop1: "Traffic Cop",
  maleyouth1: "Youth M",
  oldbusinessman1: "Old Businessman",
  witch1: "Witch",
  youngbusinessman1: "Young Businessman",
};

// ──────────────── v2 catalog ────────────────

/// The 9 emotional poses every v2 character ships. Token == filename suffix
/// (Spanish, lowercase) so the URL lookup is a direct concat.
export const EMOTIONS = [
  "neutral",
  "feliz",
  "triste",
  "enojo",
  "sorpresa",
  "duda",
  "expectacion",
  "incomodidad",
  "ver",
] as const;
export type Emotion = (typeof EMOTIONS)[number];

/// English display labels surfaced in the sentiment badge UI.
/// Spanish-form (filename token) is preserved as a tooltip on the badge.
export const EMOTION_LABEL: Record<Emotion, string> = {
  neutral: "neutral",
  feliz: "happy",
  triste: "sad",
  enojo: "angry",
  sorpresa: "surprised",
  duda: "unsure",
  expectacion: "eager",
  incomodidad: "uneasy",
  ver: "watching",
};

const v2Modules = import.meta.glob<string>(
  "../../operatorsv2/*.png",
  { query: "?url", import: "default", eager: true },
);

// {character → {emotion → url}}
const URL_BY_V2: Record<string, Partial<Record<Emotion, string>>> = {};
for (const [key, url] of Object.entries(v2Modules)) {
  const file = key.split("/").pop()!; // e.g. "bella_feliz.png"
  const stem = file.replace(/\.png$/, "");
  const idx = stem.lastIndexOf("_");
  if (idx <= 0) continue;
  const character = stem.slice(0, idx);
  const emotion = stem.slice(idx + 1) as Emotion;
  if (!EMOTIONS.includes(emotion)) continue;
  (URL_BY_V2[character] ??= {})[emotion] = url as string;
}

const V2_LABELS: Record<string, string> = {
  alan: "Alan",
  alberto: "Alberto",
  bella: "Bella",
  jota: "Jota",
  junior: "Junior",
  ken: "Ken",
  lina: "Lina",
  maria: "Maria",
  martin: "Martin",
  morrie: "Morrie",
  norma: "Norma",
  ollie: "Ollie",
  oni: "Oni",
  ricardo: "Ricardo",
  sally: "Sally",
  sara: "Sara",
  seba: "Seba",
  yuki: "Yuki",
};

// ──────────────── Public API ────────────────

export interface AvatarEntry {
  id: string;
  label: string; // human label for picker
  url: string;
}

export const AVATAR_PACK: AvatarEntry[] = Object.keys(URL_BY_ID)
  .sort()
  .map((id) => ({
    id,
    label: V1_LABELS[id] ?? id,
    url: URL_BY_ID[id]!,
  }));

export interface AvatarPack2Entry {
  character: string;
  label: string;
  /// Default-pose URL for picker tiles (neutral).
  url: string;
  /// All emotion→URL mappings for hover previews / settings.
  urlsByEmotion: Partial<Record<Emotion, string>>;
}

export const AVATAR_PACK_V2: AvatarPack2Entry[] = Object.keys(URL_BY_V2)
  .sort()
  .map((character) => ({
    character,
    label: V2_LABELS[character] ?? character,
    url: URL_BY_V2[character]?.neutral ?? Object.values(URL_BY_V2[character] ?? {})[0] ?? "",
    urlsByEmotion: URL_BY_V2[character] ?? {},
  }));

export type ParsedAvatar =
  | { kind: "pack"; id: string; url: string }
  | { kind: "pack2"; character: string; urlsByEmotion: Partial<Record<Emotion, string>> }
  | { kind: "emoji"; char: string };

export function parseAvatar(raw: string): ParsedAvatar {
  if (raw.startsWith("pack2:")) {
    const character = raw.slice("pack2:".length);
    const urlsByEmotion = URL_BY_V2[character];
    if (urlsByEmotion) return { kind: "pack2", character, urlsByEmotion };
    return { kind: "emoji", char: "❓" };
  }
  if (raw.startsWith("pack:")) {
    const id = raw.slice("pack:".length);
    const url = URL_BY_ID[id];
    if (url) return { kind: "pack", id, url };
    return { kind: "emoji", char: "❓" };
  }
  return { kind: "emoji", char: raw || "🤖" };
}

/// Resolve a v2 character's URL for the given emotion, falling back to
/// neutral, then any-available, then "". Exported so callers that already
/// have a parsed avatar (e.g. settings tiles) can preview different poses
/// without re-parsing.
export function pack2Url(
  parsed: { urlsByEmotion: Partial<Record<Emotion, string>> },
  emotion: Emotion | null | undefined,
): string {
  const e = emotion ?? "neutral";
  return (
    parsed.urlsByEmotion[e] ??
    parsed.urlsByEmotion.neutral ??
    Object.values(parsed.urlsByEmotion)[0] ??
    ""
  );
}

/// Inline HTML for an avatar at the given size.
/// `extraClass` lets the caller add layout-specific classes.
/// `emotion` only applies to pack2 avatars (ignored otherwise); defaults
/// to "neutral" so callers that don't know about sentiment keep working.
export function renderAvatarHtml(
  raw: string,
  sizePx: number,
  extraClass = "",
  emotion: Emotion | null = null,
): string {
  const parsed = parseAvatar(raw);
  if (parsed.kind === "pack") {
    return `<img class="op-avatar op-avatar-pixel${extraClass ? " " + extraClass : ""}"
                 src="${parsed.url}"
                 width="${sizePx}" height="${sizePx}"
                 alt="" draggable="false" />`;
  }
  if (parsed.kind === "pack2") {
    const url = pack2Url(parsed, emotion);
    return `<img class="op-avatar op-avatar-pixel op-avatar-pack2${extraClass ? " " + extraClass : ""}"
                 data-character="${parsed.character}"
                 data-emotion="${emotion ?? "neutral"}"
                 src="${url}"
                 width="${sizePx}" height="${sizePx}"
                 alt="" draggable="false" />`;
  }
  return `<span class="op-avatar op-avatar-emoji${extraClass ? " " + extraClass : ""}"
               style="font-size:${Math.max(sizePx - 2, 10)}px;
                      line-height:${sizePx}px;
                      width:${sizePx}px; height:${sizePx}px;">${escapeHtml(parsed.char)}</span>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
