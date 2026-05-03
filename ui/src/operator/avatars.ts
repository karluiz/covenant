// Operator avatar pack — pixel portraits the user purchased.
// 18 entries, 96×96 PNGs with transparent backgrounds, served via
// Vite's import.meta.glob URL bundling.
//
// Stored on the Operator record as `emoji: "pack:<id>"`. The
// `parseAvatar` helper recognizes the `pack:` prefix and resolves
// the corresponding PNG URL from this catalog. Anything else is
// treated as a plain emoji string (back-compat with operators
// that haven't been re-skinned yet).

const modules = import.meta.glob<string>(
  "../../operators/*_transparent.png",
  { query: "?url", import: "default", eager: true },
);

// Build {id → url} from the glob keys. Key shape:
//   "../../operators/oldbusinessman1_transparent.png"
// id = stem with "_transparent" stripped.
const URL_BY_ID: Record<string, string> = {};
for (const [key, url] of Object.entries(modules)) {
  const file = key.split("/").pop()!;
  const id = file.replace("_transparent.png", "");
  URL_BY_ID[id] = url as string;
}

export interface AvatarEntry {
  id: string;
  label: string; // human label for picker
  url: string;
}

const LABELS: Record<string, string> = {
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

export const AVATAR_PACK: AvatarEntry[] = Object.keys(URL_BY_ID)
  .sort()
  .map((id) => ({
    id,
    label: LABELS[id] ?? id,
    url: URL_BY_ID[id]!,
  }));

export type ParsedAvatar =
  | { kind: "pack"; id: string; url: string }
  | { kind: "emoji"; char: string };

export function parseAvatar(raw: string): ParsedAvatar {
  if (raw.startsWith("pack:")) {
    const id = raw.slice("pack:".length);
    const url = URL_BY_ID[id];
    if (url) return { kind: "pack", id, url };
    // unknown pack id → fall back to a question-mark emoji so the UI
    // still renders something legible.
    return { kind: "emoji", char: "❓" };
  }
  return { kind: "emoji", char: raw || "🤖" };
}

/// Inline HTML for an avatar at the given size.
/// `extraClass` lets the caller add layout-specific classes.
export function renderAvatarHtml(raw: string, sizePx: number, extraClass = ""): string {
  const parsed = parseAvatar(raw);
  if (parsed.kind === "pack") {
    return `<img class="op-avatar op-avatar-pixel${extraClass ? " " + extraClass : ""}"
                 src="${parsed.url}"
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
