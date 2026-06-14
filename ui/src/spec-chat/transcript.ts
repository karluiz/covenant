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

/** Convert a persisted draft transcript into a renderable timeline, replacing
 *  synthetic tool-feedback turns with the tool chips they represent. */
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
    out.push({ role: m.role, content: m.content });
  }
  return out;
}
