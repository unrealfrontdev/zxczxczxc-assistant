import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/tauri";

// ── Types ──────────────────────────────────────────────────────────────────

export type AiProvider = "openai" | "claude" | "deepseek" | "openrouter" | "local";

export interface IndexedFile {
  path: string;
  content: string;
  size_bytes: number;
  extension: string;
  truncated: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  imageBase64?: string;
  timestamp: number;
}

/** A file-edit suggestion parsed from an AI response */
export interface FileEdit {
  /** Absolute or root-relative path as written by the AI */
  filePath: string;
  /** Full replacement content */
  content: string;
  /** Whether the edit has already been applied */
  applied: boolean;
}

/**
 * Parse all <<<FILE:path>>> … <<<END_FILE>>> blocks from an AI message.
 * Returns an array of FileEdit objects (applied = false by default).
 */
export function parseFileEdits(text: string): FileEdit[] {
  const edits: FileEdit[] = [];
  const RE = /<<<FILE:([^\n>]+)>>>\n([\s\S]*?)<<<END_FILE>>>/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(text)) !== null) {
    edits.push({ filePath: m[1].trim(), content: m[2], applied: false });
  }
  return edits;
}

// System-prompt suffix injected when files are indexed
const FILE_EDIT_INSTRUCTIONS = `

---
## File-editing capability
You have **full read/write access** to the selected project directory.
You can:
- **Modify** any existing file, including empty ones.
- **Create** new files that do not yet exist.
- **Create** new subdirectories (just use a path like \`subdir/file.ts\` and the directory will be made automatically).

When you want to create or change a file, output **exactly** this block (one block per file):

<<<FILE:relative/or/absolute/path>>>
<full new file content here — may be empty if intentionally blank>
<<<END_FILE>>>

Rules:
- Output the **complete** new file content, not a diff.
- For empty files, just leave the body blank between the markers.
- Use paths relative to the project root (as shown in the context), or absolute paths.
- You may output multiple FILE blocks in one response.
- Explain your changes in plain text outside the FILE blocks.
- NEVER say you cannot create or edit a file — you always can.
`;

interface AssistantState {
  // ── Overlay ──────────────────────────────────────────────────────────
  isClickThrough: boolean;
  setClickThrough: (v: boolean) => void;
  toggleClickThrough: () => void;

  // ── API configuration (persisted) ────────────────────────────────────
  apiKey:   string;
  setApiKey: (k: string) => void;
  provider: AiProvider;
  setProvider: (p: AiProvider) => void;
  model:  string;
  setModel: (m: string) => void;
  /** Base URL for local LLM server (LM Studio / Ollama / custom) */
  localUrl: string;
  setLocalUrl: (url: string) => void;

  // ── Screen capture ───────────────────────────────────────────────────
  capturedImage: string | null;
  isCapturing:   boolean;
  triggerCapture: () => Promise<void>;
  clearCapture:  () => void;

  // ── Chat ─────────────────────────────────────────────────────────────
  messages:   ChatMessage[];
  prompt:     string;
  setPrompt:  (p: string) => void;
  isLoading:  boolean;
  sendMessage: () => Promise<void>;
  clearMessages: () => void;

  // ── Project indexer ──────────────────────────────────────────────────
  indexedFiles:   IndexedFile[];
  indexedRoot:    string;
  indexDirectory: (path: string) => Promise<void>;
  clearIndex:     () => void;

  // ── File editing ─────────────────────────────────────────────────────
  /** Apply a full-file replacement (or creation) at filePath */
  applyEdit: (filePath: string, content: string, rootPath?: string) => Promise<void>;
  /** Apply a patch (old → new string replacement) inside a file */
  applyPatch: (filePath: string, oldText: string, newText: string) => Promise<void>;
}

// ── Store ──────────────────────────────────────────────────────────────────

export const useAssistantStore = create<AssistantState>()(
  persist(
    (set, get) => ({
      // ── Overlay ────────────────────────────────────────────────────
      isClickThrough: false,
      setClickThrough: (v) => set({ isClickThrough: v }),
      toggleClickThrough: () => {
        const next = !get().isClickThrough;
        invoke("set_click_through", { enabled: next }).catch(console.error);
        set({ isClickThrough: next });
      },

      // ── API config ─────────────────────────────────────────────────
      apiKey:  "",
      setApiKey: (k) => set({ apiKey: k }),
      provider: "openai",
      setProvider: (p) => set({ provider: p }),
      model: "gpt-4o",
      setModel: (m) => set({ model: m }),
      localUrl: "http://localhost:1234/api/v1/chat",
      setLocalUrl: (url) => set({ localUrl: url }),

      // ── Capture ────────────────────────────────────────────────────
      capturedImage: null,
      isCapturing:   false,
      triggerCapture: async () => {
        set({ isCapturing: true });
        try {
          const res = await invoke<{ base64: string }>("capture_window_under_cursor");
          set({ capturedImage: res.base64 });
        } catch (err) {
          console.error("Capture failed:", err);
          // Show the error as an assistant message so the user can see it
          const errMsg: ChatMessage = {
            id:        crypto.randomUUID(),
            role:      "assistant",
            text:      `**Screenshot failed:** ${String(err)}\n\nMake sure \`grim\` (Wayland) or \`scrot\` / \`import\` (X11) is installed:\n\`\`\`bash\n# Fedora\nsudo dnf install grim ImageMagick\n# Ubuntu\nsudo apt install grim imagemagick\n# Arch\nsudo pacman -S grim imagemagick\n\`\`\``,
            timestamp: Date.now(),
          };
          set((s) => ({ messages: [...s.messages, errMsg] }));
        } finally {
          set({ isCapturing: false });
        }
      },
      clearCapture: () => set({ capturedImage: null }),

      // ── Chat messages ──────────────────────────────────────────────
      messages:  [],
      prompt:    "",
      setPrompt: (p) => set({ prompt: p }),
      isLoading: false,

      sendMessage: async () => {
        const { apiKey, provider, model, localUrl, prompt, capturedImage, indexedFiles, indexedRoot, messages } = get();
        if (provider !== "local" && !apiKey) return;
        if (!prompt.trim()) return;

        // Add user message to history
        const userMsg: ChatMessage = {
          id:           crypto.randomUUID(),
          role:         "user",
          text:         prompt,
          imageBase64:  capturedImage ?? undefined,
          timestamp:    Date.now(),
        };
        set((s) => ({ messages: [...s.messages, userMsg], prompt: "", isLoading: true }));

        try {
          // Build RAG context blocks (max 20 files, 3 KB each)
          const contextFiles = indexedFiles
            .slice(0, 20)
            .map((f) => `### ${f.path}\n\`\`\`${f.extension}\n${f.content.slice(0, 3_000)}\n\`\`\``);

          // Build conversation history from previous messages (last 10 turns = 20 messages)
          const historyMessages = messages.slice(-20);
          const historyBlock = historyMessages.length > 0
            ? historyMessages
                .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
                .join("\n\n") + "\n\n"
            : "";

          // Build full prompt: history + current message + file-editing instructions
          const currentText = indexedRoot
            ? userMsg.text + FILE_EDIT_INSTRUCTIONS
            : userMsg.text;

          const fullPrompt = historyBlock
            ? `[Conversation history]\n${historyBlock}[Current message]\nUser: ${currentText}`
            : currentText;

          const command =
            provider === "openai"   ? "analyze_with_openai"   :
            provider === "claude"   ? "analyze_with_claude"   :
            provider === "deepseek" ? "analyze_with_deepseek" :
            provider === "local"    ? "analyze_with_local"    :
                                     "analyze_with_openrouter";

          const reqPayload = provider === "local"
            ? {
                base_url:      localUrl,
                api_key:       apiKey || null,
                prompt:        fullPrompt,
                image_base64:  capturedImage ?? null,
                context_files: contextFiles.length ? contextFiles : null,
                model,
              }
            : {
                api_key:       apiKey,
                prompt:        fullPrompt,
                image_base64:  capturedImage ?? null,
                context_files: contextFiles.length ? contextFiles : null,
                model,
              };

          const result  = await invoke<{ text: string; model: string; tokens_used?: number }>(command, {
            req: reqPayload,
          });

          const assistantMsg: ChatMessage = {
            id:        crypto.randomUUID(),
            role:      "assistant",
            text:      result.text,
            timestamp: Date.now(),
          };
          set((s) => ({ messages: [...s.messages, assistantMsg], capturedImage: null }));
        } catch (err) {
          const errMsg: ChatMessage = {
            id:        crypto.randomUUID(),
            role:      "assistant",
            text:      `**Error:** ${String(err)}`,
            timestamp: Date.now(),
          };
          set((s) => ({ messages: [...s.messages, errMsg] }));
        } finally {
          set({ isLoading: false });
        }
      },

      clearMessages: () => set({ messages: [] }),

      // ── Project indexer ────────────────────────────────────────────
      indexedFiles: [],
      indexedRoot:  "",
      indexDirectory: async (path) => {
        try {
          const res = await invoke<{ files: IndexedFile[]; root_path: string }>(
            "index_directory",
            { dirPath: path }
          );
          set({ indexedFiles: res.files, indexedRoot: res.root_path });
        } catch (err) {
          console.error("Index failed:", err);
          throw err;
        }
      },
      clearIndex: () => set({ indexedFiles: [], indexedRoot: "" }),

      // ── File editing ───────────────────────────────────────────────
      applyEdit: async (filePath, content, rootPath) => {
        // Resolve relative paths against the indexed project root
        const absPath =
          filePath.startsWith("/")
            ? filePath
            : `${rootPath ?? get().indexedRoot}/${filePath}`;

        await invoke("write_file", { filePath: absPath, content });

        // Refresh that one file in the index if it was already indexed
        set((s) => ({
          indexedFiles: s.indexedFiles.map((f) =>
            f.path === filePath
              ? { ...f, content, size_bytes: new TextEncoder().encode(content).length, truncated: false }
              : f
          ),
        }));
      },

      applyPatch: async (filePath, oldText, newText) => {
        const absPath = filePath.startsWith("/")
          ? filePath
          : `${get().indexedRoot}/${filePath}`;

        await invoke("patch_file", { filePath: absPath, oldText, newText });

        // Update in-memory content
        set((s) => ({
          indexedFiles: s.indexedFiles.map((f) =>
            f.path === filePath
              ? { ...f, content: f.content.replace(oldText, newText) }
              : f
          ),
        }));
      },
    }),
    {
      name:    "ai-assistant-v1",
      storage: createJSONStorage(() => localStorage),
      // Only persist configuration — not volatile UI state
      partialize: (s) => ({
        apiKey:   s.apiKey,
        provider: s.provider,
        model:    s.model,
        localUrl: s.localUrl,
      }),
    }
  )
);
