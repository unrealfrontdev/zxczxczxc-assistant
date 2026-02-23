/**
 * PromptLibrary — collapsible panel with built-in and user-saved prompts.
 * Clicking a prompt appends its text to the current prompt textarea.
 * Users can create, rename, and delete their own prompts.
 */
import { useState } from "react";
import { useAssistantStore, BUILTIN_PROMPTS, SavedPrompt } from "../store/assistantStore";

const CATEGORIES = ["General", "Coding", "Writing", "Analysis", "Custom"] as const;

export default function PromptLibrary() {
  const { prompt, setPrompt, customPrompts, addPrompt, deletePrompt, updatePrompt } =
    useAssistantStore();

  const [expanded,    setExpanded]    = useState(false);
  const [activeTab,   setActiveTab]   = useState<"builtin" | "custom">("builtin");
  const [filterCat,   setFilterCat]   = useState<string>("All");

  // New-prompt form
  const [showForm,    setShowForm]    = useState(false);
  const [newTitle,    setNewTitle]    = useState("");
  const [newContent,  setNewContent]  = useState("");
  const [newCategory, setNewCategory] = useState("Custom");

  // Edit form
  const [editId,      setEditId]      = useState<string | null>(null);
  const [editTitle,   setEditTitle]   = useState("");
  const [editContent, setEditContent] = useState("");
  const [editCategory,setEditCategory]= useState("Custom");

  const allBuiltin  = BUILTIN_PROMPTS;
  const builtinCats = ["All", ...Array.from(new Set(allBuiltin.map((p) => p.category)))];
  const customCats  = ["All", ...Array.from(new Set(customPrompts.map((p) => p.category)))];

  const visibleBuiltin =
    filterCat === "All" ? allBuiltin : allBuiltin.filter((p) => p.category === filterCat);

  const visibleCustom =
    filterCat === "All" ? customPrompts : customPrompts.filter((p) => p.category === filterCat);

  const handleApply = (content: string) => {
    setPrompt(prompt ? `${prompt}\n\n${content}` : content);
  };

  const handleSave = () => {
    if (!newContent.trim()) return;
    addPrompt(newTitle.trim() || newContent.slice(0, 40), newContent, newCategory);
    setNewTitle(""); setNewContent(""); setNewCategory("Custom");
    setShowForm(false);
    setActiveTab("custom");
  };

  const handleEditSave = () => {
    if (!editId) return;
    updatePrompt(editId, { title: editTitle, content: editContent, category: editCategory });
    setEditId(null);
  };

  const startEdit = (p: SavedPrompt) => {
    setEditId(p.id); setEditTitle(p.title);
    setEditContent(p.content); setEditCategory(p.category);
  };

  const cats = activeTab === "builtin" ? builtinCats : customCats;

  return (
    <div className="bg-white/5 rounded-xl overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-2">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-1.5 text-xs font-medium text-white/60 hover:text-white transition-colors"
        >
          <span>📚</span>
          <span>Prompt Library</span>
          {customPrompts.length > 0 && (
            <span className="bg-purple-500/30 text-purple-300 px-1.5 py-0.5 rounded-full text-[9px]">
              {customPrompts.length} custom
            </span>
          )}
        </button>

        {expanded && (
          <button
            onClick={() => { setShowForm((v) => !v); setEditId(null); }}
            title="New prompt"
            className="text-[10px] bg-purple-500/20 hover:bg-purple-500/40 text-purple-300
              px-2 py-1 rounded transition-colors"
          >
            + New
          </button>
        )}
      </div>

      {/* ── Expanded body ──────────────────────────────────────────── */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {/* Tabs */}
          <div className="flex gap-1">
            {(["builtin", "custom"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => { setActiveTab(tab); setFilterCat("All"); }}
                className={[
                  "flex-1 py-1 rounded-lg text-[10px] font-semibold transition-colors",
                  activeTab === tab
                    ? "bg-white/15 text-white"
                    : "bg-white/5 text-white/40 hover:bg-white/10",
                ].join(" ")}
              >
                {tab === "builtin" ? "Built-in" : `My Prompts (${customPrompts.length})`}
              </button>
            ))}
          </div>

          {/* Category filter */}
          <div className="flex flex-wrap gap-1">
            {cats.map((cat) => (
              <button
                key={cat}
                onClick={() => setFilterCat(cat)}
                className={[
                  "px-2 py-0.5 rounded-full text-[9px] transition-colors",
                  filterCat === cat
                    ? "bg-blue-500/40 text-blue-200"
                    : "bg-white/8 text-white/40 hover:bg-white/15",
                ].join(" ")}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Prompt list */}
          <div className="max-h-48 overflow-y-auto space-y-1 scrollbar-thin scrollbar-thumb-white/10">
            {activeTab === "builtin" && visibleBuiltin.map((p) => (
              <PromptRow key={p.id} prompt={p} onApply={handleApply} />
            ))}

            {activeTab === "custom" && visibleCustom.length === 0 && (
              <p className="text-[10px] text-white/25 text-center py-3">
                No custom prompts yet. Click "+ New" to create one.
              </p>
            )}

            {activeTab === "custom" && visibleCustom.map((p) =>
              editId === p.id ? (
                <div key={p.id} className="bg-white/8 rounded-lg p-2 space-y-1.5">
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Title"
                    className="w-full bg-white/10 rounded px-2 py-1 text-[10px] text-white/80
                      placeholder-white/25 focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                  <select
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    className="w-full bg-white/10 rounded px-2 py-1 text-[10px] text-white/80
                      focus:outline-none focus:ring-1 focus:ring-purple-500"
                  >
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={3}
                    className="w-full bg-white/10 rounded px-2 py-1 text-[10px] text-white/80 resize-none
                      placeholder-white/25 focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                  <div className="flex gap-1">
                    <button
                      onClick={handleEditSave}
                      className="flex-1 bg-purple-600/60 hover:bg-purple-600 text-white text-[10px]
                        py-1 rounded transition-colors"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditId(null)}
                      className="flex-1 bg-white/10 hover:bg-white/20 text-white/60 text-[10px]
                        py-1 rounded transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <PromptRow
                  key={p.id} prompt={p} onApply={handleApply}
                  onEdit={() => startEdit(p)}
                  onDelete={() => deletePrompt(p.id)}
                />
              )
            )}
          </div>

          {/* Create form */}
          {showForm && (
            <div className="bg-white/5 rounded-lg p-2 space-y-1.5 border border-purple-500/20">
              <p className="text-[9px] text-purple-300/70 font-semibold uppercase tracking-wider">
                New Prompt
              </p>
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Title (optional)"
                className="w-full bg-white/10 rounded px-2 py-1 text-[10px] text-white/80
                  placeholder-white/25 focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                className="w-full bg-white/10 rounded px-2 py-1 text-[10px] text-white/80
                  focus:outline-none focus:ring-1 focus:ring-purple-500"
              >
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="Prompt text…"
                rows={3}
                className="w-full bg-white/10 rounded px-2 py-1 text-[10px] text-white/80 resize-none
                  placeholder-white/25 focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
              <div className="flex gap-1">
                <button
                  onClick={handleSave}
                  disabled={!newContent.trim()}
                  className="flex-1 bg-purple-600/60 hover:bg-purple-600 text-white text-[10px]
                    py-1 rounded transition-colors disabled:opacity-30"
                >
                  Save
                </button>
                <button
                  onClick={() => setShowForm(false)}
                  className="flex-1 bg-white/10 hover:bg-white/20 text-white/60 text-[10px]
                    py-1 rounded transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── PromptRow ──────────────────────────────────────────────────────────────

interface RowProps {
  prompt: SavedPrompt;
  onApply: (content: string) => void;
  onEdit?:   () => void;
  onDelete?: () => void;
}

function PromptRow({ prompt: p, onApply, onEdit, onDelete }: RowProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="flex items-start gap-1.5 group rounded-lg px-2 py-1.5 hover:bg-white/8 transition-colors"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Category dot */}
      <span className="mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 bg-blue-400/50" />

      {/* Content */}
      <button
        className="flex-1 text-left min-w-0"
        onClick={() => onApply(p.content)}
        title={p.content}
      >
        <p className="text-[10px] font-medium text-white/75 truncate">{p.title}</p>
        <p className="text-[9px] text-white/30 truncate">{p.content}</p>
      </button>

      {/* Edit / Delete (custom only) */}
      {(onEdit || onDelete) && hovered && (
        <div className="flex gap-0.5 shrink-0">
          {onEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="text-[9px] text-white/30 hover:text-white/70 px-1 py-0.5 rounded"
              title="Edit"
            >
              ✏️
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="text-[9px] text-white/30 hover:text-red-400 px-1 py-0.5 rounded"
              title="Delete"
            >
              🗑
            </button>
          )}
        </div>
      )}
    </div>
  );
}
