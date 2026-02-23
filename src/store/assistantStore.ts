import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/tauri";

// Module-level cancel hook — not stored in Zustand state (not serialisable)
let _cancelFn: (() => void) | null = null;

// ── Types ──────────────────────────────────────────────────────────────────

export type AiProvider = "openai" | "claude" | "deepseek" | "openrouter" | "local";

// ── Prompt Library ─────────────────────────────────────────────────────────

export interface SavedPrompt {
  id: string;
  title: string;
  content: string;
  category: string;
  isBuiltin: boolean;
  createdAt: number;
}

export const BUILTIN_PROMPTS: SavedPrompt[] = [
  // General
  { id: "bp-explain", title: "Explain simply", category: "General", isBuiltin: true, createdAt: 0,
    content: "Explain the following in simple terms, as if to a beginner:" },
  { id: "bp-tldr", title: "TL;DR", category: "General", isBuiltin: true, createdAt: 0,
    content: "Give me a concise TL;DR summary of the following:" },
  { id: "bp-pros-cons", title: "Pros & Cons", category: "General", isBuiltin: true, createdAt: 0,
    content: "List the pros and cons of the following:" },
  // Coding
  { id: "bp-review", title: "Code review", category: "Coding", isBuiltin: true, createdAt: 0,
    content: "Review this code for bugs, performance issues, and best-practice violations. Be concise:" },
  { id: "bp-refactor", title: "Refactor", category: "Coding", isBuiltin: true, createdAt: 0,
    content: "Refactor the following code to be cleaner and more idiomatic. Preserve all behaviour:" },
  { id: "bp-tests", title: "Write tests", category: "Coding", isBuiltin: true, createdAt: 0,
    content: "Write comprehensive unit tests for this code:" },
  { id: "bp-optimize", title: "Optimize", category: "Coding", isBuiltin: true, createdAt: 0,
    content: "Optimize the following code for speed and memory. Explain what you changed and why:" },
  { id: "bp-document", title: "Add docs", category: "Coding", isBuiltin: true, createdAt: 0,
    content: "Add thorough documentation comments to the following code:" },
  { id: "bp-debug", title: "Debug", category: "Coding", isBuiltin: true, createdAt: 0,
    content: "Find and fix the bug in this code. Explain the root cause:" },
  // Writing
  { id: "bp-improve", title: "Improve writing", category: "Writing", isBuiltin: true, createdAt: 0,
    content: "Improve the clarity, grammar and flow of this text while keeping the original meaning:" },
  { id: "bp-formal", title: "Make formal", category: "Writing", isBuiltin: true, createdAt: 0,
    content: "Rewrite the following text in a formal, professional tone:" },
  { id: "bp-casual", title: "Make casual", category: "Writing", isBuiltin: true, createdAt: 0,
    content: "Rewrite the following text in a friendly, casual tone:" },
  // Analysis
  { id: "bp-analyse-image", title: "Analyse image", category: "Analysis", isBuiltin: true, createdAt: 0,
    content: "Analyse this screenshot in detail. Describe what you see, any issues visible, and potential improvements:" },
  { id: "bp-compare", title: "Compare options", category: "Analysis", isBuiltin: true, createdAt: 0,
    content: "Compare and contrast the following options. Present a structured analysis:" },
];

// ── Chat Sessions ─────────────────────────────────────────────────────────

export interface ChatSession {
  id:        string;
  title:     string;
  messages:  ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

// ── Character Cards (chub.ai / SillyTavern V2 format) ─────────────────────

export interface CharacterCard {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  system_prompt: string;
  avatarBase64?: string;
  importedAt: number;
}

/** Parse a V2 character card JSON object (from chub.ai / SillyTavern PNG) */
export function parseCharacterCardJson(raw: unknown): Omit<CharacterCard, "id" | "importedAt" | "avatarBase64"> {
  const obj = raw as Record<string, unknown>;
  // V2: { data: { ... }, spec: "chara_card_v2" }
  const data = (obj.spec === "chara_card_v2" ? obj.data : obj) as Record<string, unknown>;
  return {
    name:          String(data.name          ?? "Unknown"),
    description:   String(data.description   ?? ""),
    personality:   String(data.personality   ?? ""),
    scenario:      String(data.scenario      ?? ""),
    first_mes:     String(data.first_mes     ?? ""),
    mes_example:   String(data.mes_example   ?? ""),
    system_prompt: String(data.system_prompt ?? ""),
  };
}

/** Extract "chara" tEXt chunk from a PNG ArrayBuffer (browser-side, no Rust) */
export function extractCharaFromPng(buffer: ArrayBuffer): string | null {
  const view = new DataView(buffer);
  // PNG signature is 8 bytes
  let offset = 8;
  while (offset < buffer.byteLength - 12) {
    const length = view.getUint32(offset, false);
    const typeBytes = new Uint8Array(buffer, offset + 4, 4);
    const type = String.fromCharCode(...typeBytes);
    if (type === "tEXt") {
      const chunkData = new Uint8Array(buffer, offset + 8, length);
      // keyword ends at first null byte
      let nullIdx = chunkData.indexOf(0);
      if (nullIdx < 0) nullIdx = chunkData.length;
      const keyword = new TextDecoder().decode(chunkData.slice(0, nullIdx));
      if (keyword === "chara") {
        const value = new TextDecoder("latin1").decode(chunkData.slice(nullIdx + 1));
        return value;
      }
    }
    offset += 12 + length; // length + type(4) + data + crc(4)
  }
  return null;
}

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

To **delete** a file, output exactly this line (no body needed):
\`<<<DELETE_FILE:relative/or/absolute/path>>>\`

- Use this only when a file should be permanently removed.
- You may mix FILE and DELETE_FILE blocks in one response.
`;

// ── Response-language map ─────────────────────────────────────────────────
export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ru: "Russian (Русский)",
  de: "German (Deutsch)",
  fr: "French (Français)",
  es: "Spanish (Español)",
  zh: "Chinese (中文)",
  ja: "Japanese (日本語)",
  pt: "Portuguese (Português)",
  it: "Italian (Italiano)",
  pl: "Polish (Polski)",
  uk: "Ukrainian (Українська)",
  ar: "Arabic (العربية)",
  ko: "Korean (한국어)",
};

interface AssistantState {
  // ── Overlay ──────────────────────────────────────────────────────────
  isClickThrough: boolean;
  setClickThrough: (v: boolean) => void;
  toggleClickThrough: () => void;  /** Ghost mode = Alt+M: fully transparent, fully click-through, minimal UI */
  isGhostMode: boolean;
  setGhostMode: (v: boolean) => void;
  toggleGhostMode: () => void;
  /** Window mode: 'overlay' = fullscreen transparent, 'windowed' = floating panel */
  windowMode: "overlay" | "windowed";
  setWindowMode: (mode: "overlay" | "windowed") => void;
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
  /** Set a captured image directly (e.g. pasted from clipboard) */
  setCapturedImage: (base64: string) => void;

  // ── Chat ─────────────────────────────────────────────────────────────
  messages:   ChatMessage[];
  prompt:     string;
  setPrompt:  (p: string) => void;
  isLoading:  boolean;
  sendMessage: () => Promise<void>;
  cancelMessage: () => void;
  clearMessages: () => void;

  // ── Chat history / sessions ───────────────────────────────────────────
  archivedChats:   ChatSession[];
  activeSessionId: string | null;
  /** Archive current messages as a new session and start fresh */
  archiveCurrentChat: (customTitle?: string) => void;
  /** Load an archived session into the active chat (auto-archives current if non-empty) */
  loadSession: (id: string) => void;
  deleteArchivedChat: (id: string) => void;
  renameArchivedChat: (id: string, title: string) => void;

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
  /** Delete a file from disk and remove it from the index */
  deleteFile: (filePath: string, rootPath?: string) => Promise<void>;
  // ── Web Search ───────────────────────────────────────────────────────────
  webSearchEnabled: boolean;
  setWebSearchEnabled: (v: boolean) => void;
  searchBackend: "brave" | "searxng" | "duckduckgo";
  setSearchBackend: (b: "brave" | "searxng" | "duckduckgo") => void;
  searchApiKey: string;
  setSearchApiKey: (k: string) => void;
  searxngUrl: string;
  setSearxngUrl: (url: string) => void;
  /** Fetch full page content for top search results (slower but much better context) */
  fetchPageContent: boolean;
  setFetchPageContent: (v: boolean) => void;
  /** Max search results to retrieve */
  searchMaxResults: number;
  setSearchMaxResults: (n: number) => void;

  // ── Prompt Library ───────────────────────────────────────────────────────
  /** User-saved custom prompts (built-in prompts are not stored here) */
  customPrompts: SavedPrompt[];
  addPrompt: (title: string, content: string, category: string) => void;
  deletePrompt: (id: string) => void;
  updatePrompt: (id: string, patch: Partial<Pick<SavedPrompt, "title" | "content" | "category">>) => void;

  // ── Character Cards ───────────────────────────────────────────────────────
  characters: CharacterCard[];
  activeCharacterId: string | null;
  addCharacter: (card: CharacterCard) => void;
  deleteCharacter: (id: string) => void;
  setActiveCharacter: (id: string | null) => void;

  // ── Response language ────────────────────────────────────────────────────
  /** "auto" = follow user's language; otherwise force a specific language */
  responseLanguage: string;
  setResponseLanguage: (lang: string) => void;
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
      },      isGhostMode: false,
      setGhostMode: (v) => set({ isGhostMode: v, isClickThrough: v }),
      toggleGhostMode: () => {
        const next = !get().isGhostMode;
        // Optimistic update — instant UI response
        set({ isGhostMode: next, isClickThrough: next });
        // Tell Rust the EXACT target value (not toggle) to avoid double-flip
        // when both JS keydown and Rust global shortcut fire simultaneously
        invoke("set_ghost_mode", { value: next }).catch(console.error);
      },
      // ── Window mode ────────────────────────────────────────────────
      windowMode: "overlay",
      setWindowMode: (mode) => {
        set({ windowMode: mode });
        invoke("set_window_mode", { windowed: mode === "windowed", onTop: null }).catch(console.error);
      },
      // ── API config ─────────────────────────────────────────────────
      apiKey:  "",
      setApiKey: (k) => set({ apiKey: k }),
      provider: "openai",
      setProvider: (p) => set({ provider: p }),
      model: "gpt-4o",
      setModel: (m) => set({ model: m }),
      localUrl: "http://127.0.0.1:1234/api/v1/chat",
      setLocalUrl: (url) => set({ localUrl: url }),

      // ── Capture ────────────────────────────────────────────────────
      capturedImage: null,
      isCapturing:   false,
      setCapturedImage: (base64) => set({ capturedImage: base64 }),
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
        const { apiKey, provider, model, localUrl, prompt, capturedImage, indexedFiles, indexedRoot, messages,
                webSearchEnabled, searchBackend, searchApiKey, searxngUrl,
                characters, activeCharacterId, responseLanguage } = get();
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

          // ── Web search (if enabled) ──────────────────────────────
          let webSearchContext = "";
          if (webSearchEnabled && prompt.trim()) {
            try {
              const { fetchPageContent, searchMaxResults } = get();
              const command = fetchPageContent ? "search_and_fetch" : "web_search";
              const searchReq = {
                query:         userMsg.text.slice(0, 300).trim(),
                backend:       searchBackend,
                api_key:       searchBackend === "brave" ? searchApiKey : null,
                base_url:      searchBackend === "searxng" ? searxngUrl : null,
                max_results:   searchMaxResults,
                fetch_content: fetchPageContent,
              };
              const searchRes = await invoke<{
                results: Array<{ title: string; url: string; snippet: string; content?: string }>;
                backend: string;
              }>(command, { req: searchReq });

              if (searchRes.results.length > 0) {
                webSearchContext = `\n\n---\n🌐 **WEB SEARCH RESULTS** (via ${searchRes.backend}, ${searchRes.results.length} results)\n`;
                searchRes.results.forEach((r, i) => {
                  webSearchContext += `\n### ${i + 1}. ${r.title}\n🔗 ${r.url}\n${r.snippet}`;
                  if (r.content) {
                    webSearchContext += `\n\n**Page content:**\n${r.content}`;
                  }
                  webSearchContext += "\n";
                });
                webSearchContext += "\n---\nAnswer using the search results above. Cite source URLs when relevant. Prefer information from fetched page content over snippets.\n";
              }
            } catch (err) {
              console.warn("Web search failed:", err);
              webSearchContext = `\n\n⚠️ Web search failed: ${String(err)}\n`;
            }
          }

          const fullPrompt = historyBlock
            ? `[Conversation history]\n${historyBlock}[Current message]\nUser: ${currentText}${webSearchContext}`
            : `${currentText}${webSearchContext}`;

          // Prepend active character system prompt
          const activeChar = activeCharacterId ? characters.find((c) => c.id === activeCharacterId) : null;
          const charPrefix = activeChar
            ? `[Character: ${activeChar.name}]\n${[
                activeChar.system_prompt,
                activeChar.description && `Description: ${activeChar.description}`,
                activeChar.personality && `Personality: ${activeChar.personality}`,
                activeChar.scenario    && `Scenario: ${activeChar.scenario}`,
              ].filter(Boolean).join("\n")}\n\n`
            : "";

          // Prepend language instruction when a specific language is selected
          const langInstruction = responseLanguage !== "auto"
            ? `[IMPORTANT: You must ALWAYS respond exclusively in ${LANGUAGE_NAMES[responseLanguage] ?? responseLanguage}. Do not switch to any other language regardless of the language the user writes in.]\n\n`
            : "";

          const finalPrompt = langInstruction + charPrefix + fullPrompt;

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
                prompt:        finalPrompt,
                image_base64:  capturedImage ?? null,
                context_files: contextFiles.length ? contextFiles : null,
                model,
              }
            : {
                api_key:       apiKey,
                prompt:        finalPrompt,
                image_base64:  capturedImage ?? null,
                context_files: contextFiles.length ? contextFiles : null,
                model,
              };

          const invokePromise = invoke<{ text: string; model: string; tokens_used?: number }>(command, {
            req: reqPayload,
          });

          // Build a cancel promise that rejects when _cancelFn is called
          const cancelPromise = new Promise<never>((_, reject) => {
            _cancelFn = () => reject(new Error("__CANCELLED__"));
          });

          const result = await Promise.race([invokePromise, cancelPromise]);

          const assistantMsg: ChatMessage = {
            id:        crypto.randomUUID(),
            role:      "assistant",
            text:      result.text,
            timestamp: Date.now(),
          };
          set((s) => ({ messages: [...s.messages, assistantMsg], capturedImage: null }));
        } catch (err) {
          if (String(err).includes("__CANCELLED__")) {
            // User cancelled — no error message needed
          } else {
            const errMsg: ChatMessage = {
              id:        crypto.randomUUID(),
              role:      "assistant",
              text:      `**Error:** ${String(err)}`,
              timestamp: Date.now(),
            };
            set((s) => ({ messages: [...s.messages, errMsg] }));
          }
        } finally {
          _cancelFn = null;
          set({ isLoading: false });
        }
      },

      cancelMessage: () => {
        // Cancel the in-flight HTTP request on the Rust side first
        invoke("cancel_ai_request").catch(console.error);
        // Then reject the JS-side promise immediately
        if (_cancelFn) { _cancelFn(); _cancelFn = null; }
      },

      clearMessages: () => set({ messages: [], activeSessionId: null }),

      // ── Chat sessions ──────────────────────────────────────────────
      archivedChats: [],
      activeSessionId: null,

      archiveCurrentChat: (customTitle) => {
        const { messages, activeSessionId } = get();
        if (messages.length === 0) return;
        const now   = Date.now();
        const title = customTitle
          ?? messages.find((m) => m.role === "user")?.text.slice(0, 60)
          ?? "Chat";

        set((s) => {
          // If we're editing an existing session, update it in place
          if (activeSessionId) {
            return {
              archivedChats: s.archivedChats.map((c) =>
                c.id === activeSessionId
                  ? { ...c, title, messages: s.messages, updatedAt: now }
                  : c
              ),
              messages: [],
              activeSessionId: null,
            };
          }
          // Otherwise create a new session
          const session: ChatSession = {
            id: crypto.randomUUID(), title,
            messages: s.messages, createdAt: now, updatedAt: now,
          };
          return {
            archivedChats: [session, ...s.archivedChats],
            messages: [],
            activeSessionId: null,
          };
        });
      },

      loadSession: (id) => {
        const { messages, activeSessionId } = get();
        // Auto-archive non-empty current chat first
        if (messages.length > 0) get().archiveCurrentChat();

        set((s) => {
          const session = s.archivedChats.find((c) => c.id === id);
          if (!session) return {};
          return {
            messages:        [...session.messages],
            activeSessionId: id,
          };
        });
      },

      deleteArchivedChat: (id) =>
        set((s) => ({
          archivedChats:   s.archivedChats.filter((c) => c.id !== id),
          activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
        })),

      renameArchivedChat: (id, title) =>
        set((s) => ({
          archivedChats: s.archivedChats.map((c) =>
            c.id === id ? { ...c, title } : c
          ),
        })),
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

      // ── Web Search ────────────────────────────────────────────────
      webSearchEnabled: false,
      setWebSearchEnabled: (v) => set({ webSearchEnabled: v }),
      searchBackend: "duckduckgo",
      setSearchBackend: (b) => set({ searchBackend: b }),
      searchApiKey: "",
      setSearchApiKey: (k) => set({ searchApiKey: k }),
      searxngUrl: "http://localhost:8080",
      setSearxngUrl: (url) => set({ searxngUrl: url }),      fetchPageContent: false,
      setFetchPageContent: (v) => set({ fetchPageContent: v }),
      searchMaxResults: 5,
      setSearchMaxResults: (n) => set({ searchMaxResults: n }),

      // ── Prompt library ─────────────────────────────────────────────
      customPrompts: [],
      addPrompt: (title, content, category) => {
        const p: SavedPrompt = {
          id: crypto.randomUUID(), title, content, category,
          isBuiltin: false, createdAt: Date.now(),
        };
        set((s) => ({ customPrompts: [...s.customPrompts, p] }));
      },
      deletePrompt: (id) =>
        set((s) => ({ customPrompts: s.customPrompts.filter((p) => p.id !== id) })),
      updatePrompt: (id, patch) =>
        set((s) => ({
          customPrompts: s.customPrompts.map((p) => p.id === id ? { ...p, ...patch } : p),
        })),

      // ── Characters ─────────────────────────────────────────────────
      characters: [],
      activeCharacterId: null,
      addCharacter: (card) =>
        set((s) => ({ characters: [...s.characters.filter((c) => c.id !== card.id), card] })),
      deleteCharacter: (id) =>
        set((s) => ({
          characters: s.characters.filter((c) => c.id !== id),
          activeCharacterId: s.activeCharacterId === id ? null : s.activeCharacterId,
        })),
      setActiveCharacter: (id) => set({ activeCharacterId: id }),

      // ── Response language ───────────────────────────────────────────
      responseLanguage:    "auto",
      setResponseLanguage: (lang) => set({ responseLanguage: lang }),

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

      deleteFile: async (filePath, rootPath) => {
        const absPath = filePath.startsWith("/")
          ? filePath
          : `${rootPath ?? get().indexedRoot}/${filePath}`;

        await invoke("delete_file", { filePath: absPath });

        // Remove from in-memory index
        set((s) => ({
          indexedFiles: s.indexedFiles.filter((f) => f.path !== filePath),
        }));
      },
    }),
    {
      name:    "ai-assistant-v1",
      storage: createJSONStorage(() => localStorage),
      // Only persist configuration — not volatile UI state
      partialize: (s) => ({
        apiKey:            s.apiKey,
        provider:          s.provider,
        model:             s.model,
        localUrl:          s.localUrl,
        webSearchEnabled:  s.webSearchEnabled,
        searchBackend:     s.searchBackend,
        searchApiKey:      s.searchApiKey,
        searxngUrl:        s.searxngUrl,
        fetchPageContent:  s.fetchPageContent,
        searchMaxResults:  s.searchMaxResults,
        customPrompts:     s.customPrompts,
        characters:        s.characters,
        activeCharacterId: s.activeCharacterId,
        responseLanguage:  s.responseLanguage,
        windowMode:        s.windowMode,
        archivedChats:     s.archivedChats,
        activeSessionId:   s.activeSessionId,
        messages:          s.messages,
      }),
    }
  )
);
