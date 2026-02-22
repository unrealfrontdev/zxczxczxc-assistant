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
        const { apiKey, provider, model, localUrl, prompt, capturedImage, indexedFiles } = get();
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
                prompt:        userMsg.text,
                image_base64:  capturedImage ?? null,
                context_files: contextFiles.length ? contextFiles : null,
                model,
              }
            : {
                api_key:       apiKey,
                prompt:        userMsg.text,
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
