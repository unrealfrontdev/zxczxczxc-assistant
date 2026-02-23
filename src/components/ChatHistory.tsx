/**
 * ChatHistory — slide-down panel for managing saved chat sessions.
 *
 * Features:
 *  - Save current chat with auto-generated or custom title
 *  - List archived sessions sorted by updatedAt (newest first)
 *  - Load any archived session (auto-saves current if non-empty)
 *  - Rename sessions inline
 *  - Delete sessions
 *  - Search / filter chats
 */
import { useState, useRef, useEffect } from "react";
import { useAssistantStore, ChatSession } from "../store/assistantStore";

interface Props {
  onClose: () => void;
}

export default function ChatHistory({ onClose }: Props) {
  const {
    messages,
    activeSessionId,
    archivedChats,
    archiveCurrentChat,
    loadSession,
    deleteArchivedChat,
    renameArchivedChat,
    clearMessages,
  } = useAssistantStore();

  const [search,       setSearch]       = useState("");
  const [renamingId,   setRenamingId]   = useState<string | null>(null);
  const [renameValue,  setRenameValue]  = useState("");
  const [customTitle,  setCustomTitle]  = useState("");
  const [confirmId,    setConfirmId]    = useState<string | null>(null);

  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId) renameRef.current?.focus();
  }, [renamingId]);

  const filtered = archivedChats
    .filter((c) =>
      !search.trim() ||
      c.title.toLowerCase().includes(search.toLowerCase()) ||
      c.messages.some((m) => m.text.toLowerCase().includes(search.toLowerCase()))
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const hasCurrentMessages = messages.length > 0;

  // ── Save current ─────────────────────────────────────────────────────
  const handleSave = () => {
    archiveCurrentChat(customTitle.trim() || undefined);
    setCustomTitle("");
  };

  // ── Rename ───────────────────────────────────────────────────────────
  const startRename = (chat: ChatSession) => {
    setRenamingId(chat.id);
    setRenameValue(chat.title);
  };
  const commitRename = () => {
    if (renamingId && renameValue.trim()) {
      renameArchivedChat(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };

  // ── Delete with confirm ───────────────────────────────────────────────
  const handleDelete = (id: string) => {
    if (confirmId === id) {
      deleteArchivedChat(id);
      setConfirmId(null);
    } else {
      setConfirmId(id);
      setTimeout(() => setConfirmId(null), 3000);
    }
  };

  return (
    <div className="shrink-0 border-b border-white/[0.07] bg-gray-950/40">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
        <span className="text-[11px] font-semibold text-white/70 flex items-center gap-1.5">
          🗂 Chat History
          {archivedChats.length > 0 && (
            <span className="bg-white/10 text-white/40 px-1.5 py-0.5 rounded-full text-[9px]">
              {archivedChats.length}
            </span>
          )}
        </span>
        <button
          onClick={onClose}
          className="text-[11px] text-white/30 hover:text-white/70 px-1.5 py-0.5 rounded
            transition-colors"
        >
          ✕
        </button>
      </div>

      {/* ── Save current chat ─────────────────────────────────────── */}
      {hasCurrentMessages && (
        <div className="px-3 pb-2 flex gap-1.5">
          <input
            value={customTitle}
            onChange={(e) => setCustomTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            placeholder="Title (optional)…"
            className="flex-1 bg-white/[0.06] rounded-lg px-2.5 py-1.5 text-[10px]
              text-white/75 placeholder-white/20 focus:outline-none
              focus:ring-1 focus:ring-amber-500/50 min-w-0"
          />
          <button
            onClick={handleSave}
            className="shrink-0 text-[10px] bg-amber-500/25 hover:bg-amber-500/45
              text-amber-300 px-3 py-1.5 rounded-lg transition-colors font-semibold"
          >
            💾 Save
          </button>
          <button
            onClick={() => { archiveCurrentChat(); onClose(); }}
            title="Save and start new chat"
            className="shrink-0 text-[10px] bg-white/8 hover:bg-white/15
              text-white/50 px-2 py-1.5 rounded-lg transition-colors"
          >
            + New
          </button>
        </div>
      )}

      {/* ── New chat (no current messages) ──────────────────────────── */}
      {!hasCurrentMessages && activeSessionId && (
        <div className="px-3 pb-2">
          <button
            onClick={() => { clearMessages(); onClose(); }}
            className="w-full text-[10px] bg-white/5 hover:bg-white/10 text-white/40
              hover:text-white/70 py-1.5 rounded-lg transition-colors"
          >
            ✚ Start a new empty chat
          </button>
        </div>
      )}

      {/* ── Search ──────────────────────────────────────────────────── */}
      {archivedChats.length > 2 && (
        <div className="px-3 pb-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats…"
            className="w-full bg-white/[0.05] rounded-lg px-2.5 py-1.5 text-[10px]
              text-white/70 placeholder-white/20 focus:outline-none
              focus:ring-1 focus:ring-white/20"
          />
        </div>
      )}

      {/* ── Session list ─────────────────────────────────────────────── */}
      <div className="max-h-64 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 px-2 pb-2 space-y-0.5">
        {filtered.length === 0 && (
          <p className="text-[10px] text-white/20 text-center py-4">
            {archivedChats.length === 0
              ? "No saved chats yet."
              : "No results."}
          </p>
        )}

        {filtered.map((chat) => {
          const isActive  = chat.id === activeSessionId;
          const isRenaming = renamingId === chat.id;
          const isConfirm  = confirmId  === chat.id;

          return (
            <div
              key={chat.id}
              className={[
                "group flex items-start gap-1.5 rounded-lg px-2 py-1.5 transition-colors",
                isActive
                  ? "bg-amber-500/15 border border-amber-500/20"
                  : "hover:bg-white/[0.05] border border-transparent",
              ].join(" ")}
            >
              {/* Active indicator */}
              <span className={[
                "mt-0.5 shrink-0 w-1.5 h-1.5 rounded-full",
                isActive ? "bg-amber-400" : "bg-white/15",
              ].join(" ")} />

              {/* Main content — load on click */}
              <button
                className="flex-1 text-left min-w-0"
                onClick={() => { loadSession(chat.id); onClose(); }}
                disabled={isActive}
              >
                {isRenaming ? (
                  <input
                    ref={renameRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    className="w-full bg-white/10 rounded px-1.5 py-0.5 text-[10px]
                      text-white/85 focus:outline-none focus:ring-1 focus:ring-amber-500"
                  />
                ) : (
                  <>
                    <p className={[
                      "text-[10px] font-medium truncate leading-snug",
                      isActive ? "text-amber-300" : "text-white/70",
                    ].join(" ")}>
                      {chat.title}
                    </p>
                    <p className="text-[9px] text-white/25 mt-0.5">
                      {chat.messages.length} msg
                      {" · "}
                      {formatDate(chat.updatedAt)}
                    </p>
                  </>
                )}
              </button>

              {/* Action buttons — visible on hover */}
              {!isRenaming && (
                <div className="flex gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => { e.stopPropagation(); startRename(chat); }}
                    title="Rename"
                    className="text-[9px] text-white/30 hover:text-white/70 px-1 py-0.5 rounded"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(chat.id); }}
                    title={isConfirm ? "Click again to confirm" : "Delete"}
                    className={[
                      "text-[9px] px-1 py-0.5 rounded transition-colors",
                      isConfirm
                        ? "text-red-400 bg-red-500/20 animate-pulse"
                        : "text-white/30 hover:text-red-400",
                    ].join(" ")}
                  >
                    {isConfirm ? "sure?" : "🗑"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  const d   = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffDays === 0) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7)  return `${diffDays}d ago`;
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}
