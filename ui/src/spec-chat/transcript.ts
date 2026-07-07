import type { ConvMessage, TimelineItem } from './stream-state';

// The agentic tool-loop persists each round's tool results back into the draft
// transcript as a synthetic `user` turn so the model sees them on the next
// replay (crates/agent/src/spec_author/stream.rs). Each result opens with a
// header line `[tool <name> → <id>] <arg> · <summary>`. These are model
// context, NOT conversation — during live streaming they render as compact
// chips via tool_start/tool_result events, never as bubbles. On resume we must
// reconstruct that: turn the feedback back into the same inline tool chips
// (verb · arg · hit) instead of dumping the raw text.

// A whole message is tool-feedback when it opens with the marker.
const TOOL_FEEDBACK_HEAD = /^\[tool\s+\S+\s+→\s+\S+\]/;
// A single header line: captures the verb and everything after the marker
// (`<arg> · <summary>`, absent in pre-parity drafts).
const TOOL_HEADER = /^\[tool\s+(\S+)\s+→\s+\S+\](.*)$/;

// ask_user questions persist as assistant messages `<!--question:{json}-->`
// (crates/agent/src/spec_author/stream.rs). Close marker matched from the END
// so `-->` inside the JSON can't truncate the parse.
const QUESTION_OPEN = '<!--question:';
const QUESTION_CLOSE = '-->';

function parseQuestionMarker(text: string): { question: string; options: { label: string; detail?: string }[] } | null {
  const start = text.indexOf(QUESTION_OPEN);
  if (start < 0) return null;
  const end = text.lastIndexOf(QUESTION_CLOSE);
  const from = start + QUESTION_OPEN.length;
  if (end <= from) return null;
  try {
    const parsed = JSON.parse(text.slice(from, end)) as { question?: unknown; options?: unknown };
    if (typeof parsed.question !== 'string' || !Array.isArray(parsed.options)) return null;
    return { question: parsed.question, options: parsed.options as { label: string; detail?: string }[] };
  } catch {
    return null;
  }
}

/** Convert a persisted draft transcript into a renderable timeline, replacing
 *  synthetic tool-feedback turns with the tool chips they represent and
 *  question markers with question cards (answered unless nothing follows). */
export function parsePersistedTranscript(
  messages: readonly ConvMessage[],
): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const m of messages) {
    if (m.role === 'user' && TOOL_FEEDBACK_HEAD.test(m.content)) {
      for (const line of m.content.split('\n')) {
        const h = TOOL_HEADER.exec(line);
        if (!h) continue;
        const chip: TimelineItem = { role: 'tool', tool: h[1]! };
        const trailing = h[2]!.trim();
        if (trailing) {
          const sep = trailing.indexOf(' · ');
          if (sep >= 0) {
            chip.arg = trailing.slice(0, sep).trim();
            chip.summary = trailing.slice(sep + 3).trim();
          } else {
            chip.arg = trailing;
          }
        }
        out.push(chip);
      }
      continue;
    }
    if (m.role === 'assistant') {
      const q = parseQuestionMarker(m.content);
      if (q) {
        out.push({ role: 'question', question: q.question, options: q.options, answered: true });
        continue;
      }
    }
    out.push({ role: m.role, content: m.content });
  }
  // Only a trailing question (nothing after it) is still awaiting an answer.
  const last = out[out.length - 1];
  if (last && last.role === 'question') last.answered = false;
  return out;
}
