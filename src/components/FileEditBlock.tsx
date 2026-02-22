/**
 * FileEditBlock — renders an assistant message that may contain
 * <<<FILE:path>>> … <<<END_FILE>>> edit suggestions.
 *
 * Non-edit text is rendered as Markdown; each FILE block becomes a
 * collapsible code card with an "Apply" button that writes the file to disk.
 */
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAssistantStore, parseFileEdits, type FileEdit } from "../store/assistantStore";

interface Props {
  text: string;
}

// Split the raw text into alternating prose / file-edit segments
function splitText(text: string): Array<{ kind: "prose"; text: string } | { kind: "edit"; edit: FileEdit; raw: string }> {
  const RE = /<<<FILE:([^\n>]+)>>>\n([\s\S]*?)<<<END_FILE>>>/g;
  const result: Array<{ kind: "prose"; text: string } | { kind: "edit"; edit: FileEdit; raw: string }> = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = RE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      result.push({ kind: "prose", text: text.slice(lastIndex, m.index) });
    }
    result.push({
      kind: "edit",
      raw: m[0],
      edit: { filePath: m[1].trim(), content: m[2], applied: false },
    });
    lastIndex = m.index + m[0].length;
  }

  if (lastIndex < text.length) {
    result.push({ kind: "prose", text: text.slice(lastIndex) });
  }

  return result;
}

// Detect language from file extension for syntax highlighting label
function langFromPath(p: string): string {
  const ext = p.split(".").pop() ?? "";
  const map: Record<string, string> = {
    rs: "rust", ts: "typescript", tsx: "tsx", js: "javascript",
    jsx: "jsx", py: "python", go: "go", cpp: "cpp", c: "c",
    cs: "csharp", java: "java", html: "html", css: "css",
    json: "json", toml: "toml", yaml: "yaml", yml: "yaml",
    sh: "bash", md: "markdown",
  };
  return map[ext] ?? ext;
}

function EditCard({ edit }: { edit: FileEdit }) {
  const { applyEdit, indexedRoot } = useAssistantStore();
  const [status,   setStatus]   = useState<"idle" | "applying" | "done" | "error">("idle");
  const [errMsg,   setErrMsg]   = useState("");
  const [expanded, setExpanded] = useState(false);

  const lineCount = edit.content.split("\n").length;
  const lang      = langFromPath(edit.filePath);

  const handleApply = async () => {
    setStatus("applying");
    setErrMsg("");
    try {
      await applyEdit(edit.filePath, edit.content, indexedRoot || undefined);
      setStatus("done");
    } catch (e) {
      setErrMsg(String(e));
      setStatus("error");
    }
  };

  return (
    <div className={[
      "my-2 rounded-xl border overflow-hidden text-xs font-mono",
      status === "done"
        ? "border-green-500/40 bg-green-900/20"
        : status === "error"
        ? "border-red-500/40 bg-red-900/20"
        : "border-white/15 bg-white/5",
    ].join(" ")}>
      {/* Card header */}
      <div className="flex items-center justify-between px-3 py-2 bg-white/5">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-1.5 text-left truncate grow hover:text-white/80 transition-colors"
        >
          <span className="text-base shrink-0">{status === "done" ? "✅" : "📝"}</span>
          <span className="text-white/70 truncate">{edit.filePath}</span>
          <span className="text-white/30 shrink-0 ml-1">({lineCount} lines · {lang})</span>
          <span className="ml-1 text-white/30 shrink-0">{expanded ? "▲" : "▼"}</span>
        </button>

        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          {status === "done" && (
            <span className="text-green-400 text-[10px]">Applied ✓</span>
          )}
          {status === "error" && (
            <span className="text-red-400 text-[10px]" title={errMsg}>Failed ✗</span>
          )}
          {(status === "idle" || status === "error") && (
            <button
              onClick={handleApply}
              className="bg-blue-600 hover:bg-blue-500 text-white px-2.5 py-1
                rounded-lg text-[10px] font-semibold transition-colors"
            >
              Apply
            </button>
          )}
          {status === "applying" && (
            <span className="text-white/40 text-[10px] animate-pulse">Writing…</span>
          )}
        </div>
      </div>

      {/* Collapsible code preview */}
      {expanded && (
        <pre className="px-3 py-2 text-[10px] leading-relaxed text-white/60
          overflow-x-auto max-h-64 overflow-y-auto whitespace-pre"
        >
          {edit.content}
        </pre>
      )}

      {status === "error" && errMsg && (
        <p className="px-3 py-1.5 text-[10px] text-red-300 bg-red-900/30">{errMsg}</p>
      )}
    </div>
  );
}

export default function FileEditBlock({ text }: Props) {
  const fileEdits = parseFileEdits(text);

  // If no file edits at all — render plain Markdown (fast path)
  if (fileEdits.length === 0) {
    return (
      <div className="prose prose-invert prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    );
  }

  const segments = splitText(text);

  return (
    <div>
      {segments.map((seg, i) =>
        seg.kind === "prose" ? (
          seg.text.trim() ? (
            <div key={i} className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text}</ReactMarkdown>
            </div>
          ) : null
        ) : (
          <EditCard key={i} edit={seg.edit} />
        )
      )}
    </div>
  );
}
