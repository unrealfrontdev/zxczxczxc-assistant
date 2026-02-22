import { useState } from "react";
import { open } from "@tauri-apps/api/dialog";
import { useAssistantStore } from "../store/assistantStore";

export default function FileIndexer() {
  const { indexedFiles, indexedRoot, indexDirectory, clearIndex } = useAssistantStore();
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const handleBrowse = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Select project folder" });
    if (typeof selected !== "string") return;

    setLoading(true);
    setError(null);
    try {
      await indexDirectory(selected);
      setExpanded(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const shortRoot = indexedRoot
    ? indexedRoot.split("/").slice(-2).join("/")
    : "";

  return (
    <div className="bg-white/5 rounded-xl overflow-hidden">
      {/* Header row */}
      <div className="flex items-center justify-between px-3 py-2">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-1.5 text-xs font-medium text-white/60
            hover:text-white transition-colors"
        >
          <span>📁</span>
          <span>Project Context</span>
          {indexedFiles.length > 0 && (
            <span className="bg-blue-500/30 text-blue-300 px-1.5 py-0.5 rounded-full text-[9px]">
              {indexedFiles.length} files
            </span>
          )}
          {shortRoot && (
            <span className="text-[9px] text-white/30 font-mono">…/{shortRoot}</span>
          )}
        </button>

        <div className="flex gap-1">
          <button
            onClick={handleBrowse}
            disabled={loading}
            className="text-[10px] bg-white/10 hover:bg-white/20 px-2 py-1
              rounded transition-colors disabled:opacity-50"
          >
            {loading ? "⚙️ Indexing…" : "Browse"}
          </button>
          {indexedFiles.length > 0 && (
            <button
              onClick={() => { clearIndex(); setExpanded(false); }}
              className="text-[10px] bg-red-500/20 hover:bg-red-500/40 text-red-300
                px-2 py-1 rounded transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <p className="px-3 pb-2 text-[10px] text-red-400">{error}</p>
      )}

      {/* File list */}
      {expanded && indexedFiles.length > 0 && (
        <div className="px-3 pb-2 max-h-28 overflow-y-auto space-y-0.5">
          {indexedFiles.map((f) => (
            <div key={f.path} className="flex items-center gap-1.5 text-[10px] text-white/40">
              <span className="font-mono truncate flex-1">{f.path}</span>
              {f.truncated && (
                <span className="text-yellow-500/60 shrink-0" title="Content truncated">✂</span>
              )}
            </div>
          ))}
        </div>
      )}

      {expanded && indexedFiles.length === 0 && !loading && (
        <p className="px-3 pb-2 text-[10px] text-white/25">No supported files found.</p>
      )}
    </div>
  );
}
