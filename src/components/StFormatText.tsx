/**
 * StFormatText — renders text with SillyTavern-style inline formatting.
 *
 * Supported syntax:
 *   "Dialogue in double quotes"   → white, slightly bright
 *   *Action / narration text*     → italic, soft purple/lavender tint
 *   ((Out-of-character note))     → dimmed, small, gray
 *
 * Everything else is rendered as plain text.
 */

interface Props {
  text: string;
  className?: string;
}

type Chunk =
  | { kind: "dialogue";  text: string }
  | { kind: "action";    text: string }
  | { kind: "ooc";       text: string }
  | { kind: "plain";     text: string };

// Matches (in order): OOC ((…)), action *…*, dialogue "…" (non-greedy, no newline crossing)
const RE = /(\(\([\s\S]*?\)\))|(\*[^\n*]+\*)|("(?:[^"\n])*")/g;

function parse(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = RE.exec(text)) !== null) {
    if (m.index > last) {
      chunks.push({ kind: "plain", text: text.slice(last, m.index) });
    }
    if (m[1] !== undefined) {
      // (( … ))
      chunks.push({ kind: "ooc",      text: m[1].slice(2, -2).trim() });
    } else if (m[2] !== undefined) {
      // * … *
      chunks.push({ kind: "action",   text: m[2].slice(1, -1) });
    } else if (m[3] !== undefined) {
      // " … "
      chunks.push({ kind: "dialogue", text: m[3] });
    }
    last = m.index + m[0].length;
  }

  if (last < text.length) {
    chunks.push({ kind: "plain", text: text.slice(last) });
  }

  return chunks;
}

export default function StFormatText({ text, className }: Props) {
  const chunks = parse(text);

  return (
    <span className={className}>
      {chunks.map((c, i) => {
        switch (c.kind) {
          case "dialogue":
            // Quoted dialogue — keep quotes, slightly brighter
            return (
              <span key={i} className="text-white/95 font-[450]">
                {c.text}
              </span>
            );
          case "action":
            // Narration/action — italic lavender
            return (
              <em key={i} className="not-italic text-purple-300/75">
                <span className="opacity-50 select-none">*</span>
                {c.text}
                <span className="opacity-50 select-none">*</span>
              </em>
            );
          case "ooc":
            // Out-of-character — dimmed gray, small
            return (
              <span key={i} className="text-white/30 text-[0.85em]">
                (({c.text}))
              </span>
            );
          default:
            return <span key={i}>{c.text}</span>;
        }
      })}
    </span>
  );
}

/** Quick-insert buttons for the textarea (shown in character panel tips) */
export const ST_FORMAT_EXAMPLES = [
  {
    label: '"Dialogue"',
    syntax: '"Your message here"',
    description: 'Spoken dialogue — wrap in double quotes',
    color: 'text-white/80',
  },
  {
    label: '*Action*',
    syntax: '*does something*',
    description: 'Narration / character action — wrap in asterisks',
    color: 'text-purple-300',
  },
  {
    label: '((OOC))',
    syntax: '((your note))',
    description: 'Out-of-character note — wrap in double parentheses',
    color: 'text-white/40',
  },
] as const;
