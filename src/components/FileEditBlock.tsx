/**
 * FileEditBlock — renders an assistant message that may contain
 * <<<FILE:path>>> … <<<END_FILE>>> and <<<DELETE_FILE:path>>> markers.
 *
 * All operations (create / overwrite / delete) are applied automatically
 * on render — no buttons or confirmation steps.
 */
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAssistantStore, parseFileEdits, type FileEdit } from "../store/assistantStore";

interface Props {
  text: string;
}

// Split the raw text into alternating prose / file-edit / file-delete segments
type Segment =
  | { kind: "prose"; text: string }
  | { kind: "edit"; edit: FileEdit; raw: string }
  | { kind: "delete"; filePath: string; raw: string };

function splitText(text: string): Segment[] {
  // Match DELETE_FILE markers and FILE edit blocks
  const RE = /<<<DELETE_FILE:([^\n>]+)>>>|<<<FILE:([^\n>]+)>>>\n([\s\S]*?)<<<END_FILE>>>/g;
  const result: Segment[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = RE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      result.push({ kind: "prose", text: text.slice(lastIndex, m.index) });
    }
    if (m[1] !== undefined) {
      // <<<DELETE_FILE:path>>>
      result.push({ kind: "delete", filePath: m[1].trim(), raw: m[0] });
    } else {
      // <<<FILE:path>>> … <<<END_FILE>>>
      result.push({
        kind: "edit",
        raw: m[0],
        edit: { filePath: m[2].trim(), content: m[3], applied: false },
      });
    }
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

// ── Delete card ───────────────────────────────────────────────────────────

function DeleteCard({ filePath }: { filePath: string }) {
  const { deleteFile, indexedRoot } = useAssistantStore();
  const [status, setStatus] = useState<"deleting" | "done" | "error">("deleting");
  const [errMsg, setErrMsg] = useState("");

  useEffect(() => {
    deleteFile(filePath, indexedRoot || undefined)
      .then(() => setStatus("done"))
      .catch((e) => { setErrMsg(String(e)); setStatus("error"); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={[
      "my-2 rounded-xl border overflow-hidden text-xs font-mono",
      status === "done"  ? "border-red-500/40 bg-red-900/20" :
      status === "error" ? "border-red-500/40 bg-red-900/20" :
                           "border-white/15 bg-white/5",
    ].join(" ")}>
      <div className="flex items-center gap-1.5 px-3 py-2 bg-white/5">
        <span className="text-base shrink-0">{status === "done" ? "🗑️" : status === "error" ? "❌" : "⏳"}</span>
        <span className="text-white/70 truncate">{filePath}</span>
        <span className="text-white/30 shrink-0 ml-1">(delete)</span>
        {status === "done"    && <span className="ml-auto text-red-300 text-[10px]">Deleted ✓</span>}
        {status === "error"   && <span className="ml-auto text-red-400 text-[10px]">Failed ✗</span>}
        {status === "deleting" && <span className="ml-auto text-white/40 text-[10px] animate-pulse">Deleting…</span>}
      </div>
      {status === "error" && errMsg && (
        <p className="px-3 py-1.5 text-[10px] text-red-300 bg-red-900/30">{errMsg}</p>
      )}
    </div>
  );
}

// ── Edit card ─────────────────────────────────────────────────────────────

function EditCard({ edit }: { edit: FileEdit }) {
  const { applyEdit, indexedRoot } = useAssistantStore();
  const [status,   setStatus]   = useState<"applying" | "done" | "error">("applying");
  const [errMsg,   setErrMsg]   = useState("");
  const [expanded, setExpanded] = useState(false);

  const lineCount = edit.content.split("\n").length;
  const lang      = langFromPath(edit.filePath);

  useEffect(() => {
    applyEdit(edit.filePath, edit.content, indexedRoot || undefined)
      .then(() => setStatus("done"))
      .catch((e) => { setErrMsg(String(e)); setStatus("error"); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={[
      "my-2 rounded-xl border overflow-hidden text-xs font-mono",
      status === "done"  ? "border-green-500/40 bg-green-900/20" :
      status === "error" ? "border-red-500/40 bg-red-900/20"     :
                           "border-white/15 bg-white/5",
    ].join(" ")}>
      {/* Card header */}
      <div className="flex items-center justify-between px-3 py-2 bg-white/5">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-1.5 text-left truncate grow hover:text-white/80 transition-colors"
        >
          <span className="text-base shrink-0">
            {status === "done" ? "✅" : status === "error" ? "❌" : "⏳"}
          </span>
          <span className="text-white/70 truncate">{edit.filePath}</span>
          <span className="text-white/30 shrink-0 ml-1">({lineCount} lines · {lang})</span>
          <span className="ml-1 text-white/30 shrink-0">{expanded ? "▲" : "▼"}</span>
        </button>

        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          {status === "done"     && <span className="text-green-400 text-[10px]">Applied ✓</span>}
          {status === "error"    && <span className="text-red-400 text-[10px]" title={errMsg}>Failed ✗</span>}
          {status === "applying" && <span className="text-white/40 text-[10px] animate-pulse">Writing…</span>}
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
  const hasDeleteMarker = /<<<DELETE_FILE:[^\n>]+>>>/.test(text);
  const fileEdits = parseFileEdits(text);

  // If no file edits or delete markers — render plain Markdown (fast path)
  if (fileEdits.length === 0 && !hasDeleteMarker) {
    return (
      <div className="prose prose-invert prose-sm max-w-none">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            em: ({ children }) => (
              <em className="not-italic text-purple-300/75">
                <span className="opacity-40 select-none">*</span>
                {children}
                <span className="opacity-40 select-none">*</span>
              </em>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
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
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  em: ({ children }) => (
                    <em className="not-italic text-purple-300/75">
                      <span className="opacity-40 select-none">*</span>
                      {children}
                      <span className="opacity-40 select-none">*</span>
                    </em>
                  ),
                }}
              >
                {seg.text}
              </ReactMarkdown>
            </div>
          ) : null
        ) : seg.kind === "delete" ? (
          <DeleteCard key={i} filePath={seg.filePath} />
        ) : (
          <EditCard key={i} edit={seg.edit} />
        )
      )}
    </div>
  );
}
