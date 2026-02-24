/**
 * FileTree — interactive file browser using list_dir / create_dir_cmd /
 * rename_path / delete_file / read_file_content / write_file Tauri commands.
 *
 * Features:
 *   - Expandable directories (lazy loaded)
 *   - Click file → load into editor textarea
 *   - Inline rename (double-click name)
 *   - ➕ create file / ➕ create folder
 *   - 🗑 delete with confirm
 *   - 💾 save edited file back to disk
 */

import { useState, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { open as openDialog } from "@tauri-apps/api/dialog";

interface DirEntry {
  name:       string;
  kind:       "file" | "dir";
  size_bytes: number;
  path:       string;
}

interface TreeNode extends DirEntry {
  children?: TreeNode[];
  loaded:    boolean;
  expanded:  boolean;
}

interface Props {
  /** Initial root directory. If not provided, shows a "choose folder" button. */
  rootPath?: string;
  onRootChange?: (path: string) => void;
  className?: string;
}

// ── helper ──────────────────────────────────────────────────────────────────
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ── main component ───────────────────────────────────────────────────────────
export default function FileTree({ rootPath: initialRoot, onRootChange, className = "" }: Props) {
  const [root, setRoot]     = useState<string>(initialRoot ?? "");
  const [nodes, setNodes]   = useState<TreeNode[]>([]);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editContent, setEditContent] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState<string | null>(null);

  // Inline rename state
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue,  setRenameValue]  = useState<string>("");
  const renameRef = useRef<HTMLInputElement>(null);

  // ── Load a directory into children ────────────────────────────────────────
  const loadDir = useCallback(async (dirPath: string): Promise<TreeNode[]> => {
    const entries = await invoke<DirEntry[]>("list_dir", { dirPath });
    return sortEntries(entries).map((e) => ({
      ...e,
      loaded:   false,
      expanded: false,
      children: e.kind === "dir" ? [] : undefined,
    }));
  }, []);

  // ── Choose root folder ────────────────────────────────────────────────────
  const chooseRoot = useCallback(async () => {
    const chosen = await openDialog({ directory: true, multiple: false });
    if (!chosen || Array.isArray(chosen)) return;
    const newRoot = chosen as string;
    const children = await loadDir(newRoot);
    setRoot(newRoot);
    setNodes(children);
    onRootChange?.(newRoot);
  }, [loadDir, onRootChange]);

  // ── Refresh from root ─────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    if (!root) return;
    const children = await loadDir(root);
    setNodes(children);
  }, [root, loadDir]);

  // ── Toggle expand/collapse of a directory node ────────────────────────────
  const toggleDir = useCallback(async (path: string) => {
    const update = async (list: TreeNode[]): Promise<TreeNode[]> => {
      return Promise.all(list.map(async (n) => {
        if (n.path === path && n.kind === "dir") {
          if (n.expanded) return { ...n, expanded: false };
          // load children lazily
          setLoadingPath(path);
          const kids = n.loaded ? n.children! : await loadDir(path);
          setLoadingPath(null);
          return { ...n, expanded: true, loaded: true, children: kids };
        }
        if (n.children) return { ...n, children: await update(n.children) };
        return n;
      }));
    };
    setNodes((prev) => { void update(prev).then(setNodes); return prev; });
  }, [loadDir]);

  // ── Open file in editor ───────────────────────────────────────────────────
  const openFile = useCallback(async (path: string) => {
    try {
      const content = await invoke<string>("read_file_content", { filePath: path });
      setEditingPath(path);
      setEditContent(content);
    } catch (e) {
      setMsg(`Read error: ${e}`);
    }
  }, []);

  // ── Save file ─────────────────────────────────────────────────────────────
  const saveFile = useCallback(async () => {
    if (!editingPath) return;
    setSaving(true);
    try {
      await invoke("write_file", { filePath: editingPath, content: editContent });
      setMsg("✓ Saved");
      setTimeout(() => setMsg(null), 1800);
    } catch (e) {
      setMsg(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  }, [editingPath, editContent]);

  // ── Create file ───────────────────────────────────────────────────────────
  const createFile = useCallback(async (parentDir: string) => {
    const name = prompt("New file name:");
    if (!name?.trim()) return;
    const filePath = `${parentDir}/${name.trim()}`;
    try {
      await invoke("write_file", { filePath, content: "" });
      await refresh();
      await openFile(filePath);
    } catch (e) {
      setMsg(`Create failed: ${e}`);
    }
  }, [refresh, openFile]);

  // ── Create directory ──────────────────────────────────────────────────────
  const createDir = useCallback(async (parentDir: string) => {
    const name = prompt("New folder name:");
    if (!name?.trim()) return;
    const dirPath = `${parentDir}/${name.trim()}`;
    try {
      await invoke("create_dir_cmd", { dirPath });
      await refresh();
    } catch (e) {
      setMsg(`Create dir failed: ${e}`);
    }
  }, [refresh]);

  // ── Delete ────────────────────────────────────────────────────────────────
  const deleteEntry = useCallback(async (node: TreeNode) => {
    if (!confirm(`Delete "${node.name}"?`)) return;
    try {
      if (node.kind === "file") {
        await invoke("delete_file", { filePath: node.path });
      } else {
        // For dirs, use shell-level rm via rename_path as workaround isn't available;
        // fall back to showing an error if not supported
        setMsg("Dir deletion not yet supported — delete manually.");
        return;
      }
      if (editingPath === node.path) { setEditingPath(null); setEditContent(""); }
      await refresh();
    } catch (e) {
      setMsg(`Delete failed: ${e}`);
    }
  }, [refresh, editingPath]);

  // ── Rename ────────────────────────────────────────────────────────────────
  const startRename = (node: TreeNode) => {
    setRenamingPath(node.path);
    setRenameValue(node.name);
    requestAnimationFrame(() => renameRef.current?.select());
  };

  const commitRename = useCallback(async (node: TreeNode) => {
    const newName = renameValue.trim();
    setRenamingPath(null);
    if (!newName || newName === node.name) return;
    const dir  = node.path.substring(0, node.path.lastIndexOf("/"));
    const dest = `${dir}/${newName}`;
    try {
      await invoke("rename_path", { fromPath: node.path, toPath: dest });
      if (editingPath === node.path) setEditingPath(dest);
      await refresh();
    } catch (e) {
      setMsg(`Rename failed: ${e}`);
    }
  }, [renameValue, refresh, editingPath]);

  // ── Render a single tree row ──────────────────────────────────────────────
  const renderNode = (node: TreeNode, depth: number): ReactNode => {
    const isEditing = editingPath === node.path;
    const isRenaming = renamingPath === node.path;
    const icon = node.kind === "dir"
      ? (node.expanded ? "▾" : "▸")
      : "·";

    return (
      <div key={node.path}>
        <div
          className={`group flex items-center gap-1 px-2 py-0.5 rounded cursor-pointer
            text-[12px] hover:bg-white/[0.07] transition-colors
            ${isEditing ? "bg-white/10 text-white" : "text-white/65"}
            ${node.kind === "dir" ? "font-medium" : ""}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() => node.kind === "dir" ? toggleDir(node.path) : openFile(node.path)}
        >
          {/* Icon */}
          <span className="w-3 text-white/30 text-[10px] shrink-0">{icon}</span>
          {loadingPath === node.path && <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse shrink-0"/>}

          {/* Name — or rename input */}
          {isRenaming ? (
            <input
              ref={renameRef}
              className="flex-1 bg-white/10 text-white text-xs px-1 rounded outline-none border border-blue-400/50"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => commitRename(node)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(node);
                if (e.key === "Escape") setRenamingPath(null);
              }}
              autoFocus
            />
          ) : (
            <span
              className="flex-1 truncate"
              onDoubleClick={(e) => { e.stopPropagation(); startRename(node); }}
            >
              {node.name}
            </span>
          )}

          {/* Size */}
          {node.kind === "file" && (
            <span className="text-[10px] text-white/25 shrink-0">{humanSize(node.size_bytes)}</span>
          )}

          {/* Action buttons (only visible on hover) */}
          <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
            {node.kind === "dir" && (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); createFile(node.path); }}
                  className="px-1 py-0.5 text-[9px] rounded hover:bg-white/10 text-white/40 hover:text-white/80"
                  title="New file"
                >+f</button>
                <button
                  onClick={(e) => { e.stopPropagation(); createDir(node.path); }}
                  className="px-1 py-0.5 text-[9px] rounded hover:bg-white/10 text-white/40 hover:text-white/80"
                  title="New folder"
                >+d</button>
              </>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); startRename(node); }}
              className="px-1 py-0.5 text-[9px] rounded hover:bg-white/10 text-white/40 hover:text-white/80"
              title="Rename"
            >✎</button>
            <button
              onClick={(e) => { e.stopPropagation(); deleteEntry(node); }}
              className="px-1 py-0.5 text-[9px] rounded hover:bg-red-500/20 text-white/30 hover:text-red-400"
              title="Delete"
            >✕</button>
          </span>
        </div>

        {/* Children */}
        {node.kind === "dir" && node.expanded && node.children && (
          <div>{node.children.map((child) => renderNode(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={`flex flex-col h-full overflow-hidden ${className}`}>
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-white/[0.07] shrink-0">
        <button
          onClick={chooseRoot}
          className="text-[10px] px-2 py-0.5 rounded bg-white/[0.07] hover:bg-white/[0.12]
            text-white/50 hover:text-white/90 transition-colors"
        >
          {root ? "📂 Change" : "📂 Open folder"}
        </button>
        {root && (
          <>
            <span className="flex-1 truncate text-[10px] text-white/30 ml-1" title={root}>
              {root.split("/").slice(-1)[0]}
            </span>
            <button
              onClick={refresh}
              className="text-[10px] px-1.5 py-0.5 rounded hover:bg-white/10 text-white/30 hover:text-white/70"
              title="Refresh"
            >↺</button>
            <button
              onClick={() => createFile(root)}
              className="text-[10px] px-1.5 py-0.5 rounded hover:bg-white/10 text-white/30 hover:text-white/70"
              title="New file in root"
            >+f</button>
            <button
              onClick={() => createDir(root)}
              className="text-[10px] px-1.5 py-0.5 rounded hover:bg-white/10 text-white/30 hover:text-white/70"
              title="New folder in root"
            >+d</button>
          </>
        )}
      </div>

      {/* Status message */}
      {msg && (
        <div className="px-2 py-1 text-[10px] bg-white/[0.06] text-white/60 shrink-0">
          {msg}
        </div>
      )}

      {/* Tree + Editor side by side */}
      <div className="flex flex-1 overflow-hidden">
        {/* Tree panel */}
        <div className={`overflow-y-auto py-1 ${editingPath ? "w-[45%] border-r border-white/[0.07]" : "w-full"}`}>
          {nodes.length === 0 && root === "" ? (
            <p className="text-[11px] text-white/25 text-center mt-8 px-4">
              Open a folder to browse and edit files.
            </p>
          ) : nodes.length === 0 ? (
            <p className="text-[11px] text-white/25 text-center mt-4">Empty folder</p>
          ) : (
            nodes.map((n) => renderNode(n, 0))
          )}
        </div>

        {/* Editor panel */}
        {editingPath && (
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* Editor header */}
            <div className="flex items-center gap-2 px-2 py-1 border-b border-white/[0.07] shrink-0">
              <span className="flex-1 truncate text-[11px] text-white/50" title={editingPath}>
                {editingPath.split("/").slice(-1)[0]}
              </span>
              <button
                onClick={saveFile}
                disabled={saving}
                className="text-[10px] px-2 py-0.5 rounded bg-blue-500/20 hover:bg-blue-500/40
                  text-blue-300 disabled:opacity-40 transition-colors"
              >
                {saving ? "…" : "💾 Save"}
              </button>
              <button
                onClick={() => { setEditingPath(null); setEditContent(""); }}
                className="text-[10px] px-1.5 py-0.5 rounded hover:bg-white/10 text-white/30 hover:text-white/70"
              >✕</button>
            </div>

            {/* Textarea editor */}
            <textarea
              className="flex-1 resize-none bg-transparent text-[11px] font-mono
                text-white/80 p-2 outline-none leading-relaxed"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              spellCheck={false}
              onKeyDown={(e) => {
                // Ctrl+S to save
                if (e.ctrlKey && e.key === "s") { e.preventDefault(); saveFile(); }
                // Tab → indent
                if (e.key === "Tab") {
                  e.preventDefault();
                  const ta = e.currentTarget;
                  const start = ta.selectionStart;
                  const end   = ta.selectionEnd;
                  const next  = editContent.substring(0, start) + "  " + editContent.substring(end);
                  setEditContent(next);
                  requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2; });
                }
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
