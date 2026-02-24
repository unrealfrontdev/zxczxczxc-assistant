import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";

// Module-level cancel hook — not stored in Zustand state (not serialisable)
let _cancelFn: (() => void) | null = null;

// ── Fault-tolerant localStorage wrapper ───────────────────────────────────
// Catches QuotaExceededError on write so it never crashes the store.
// On quota failure it removes the key entirely (better than a stuck state).
const safeStorage = createJSONStorage(() => ({
  getItem:    (key: string) => localStorage.getItem(key),
  removeItem: (key: string) => localStorage.removeItem(key),
  setItem:    (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      // QuotaExceededError: clear only our key and retry once
      try {
        localStorage.removeItem(key);
        localStorage.setItem(key, value);
      } catch {
        // Still failing — silently skip; in-memory state is authoritative
        console.warn("[store] localStorage write failed (quota), state not persisted:", e);
      }
    }
  },
}));

// Clean up the old v1 key so it stops wasting localStorage space
try { localStorage.removeItem("ai-assistant-v1"); } catch { /* ignore */ }

// ── Types ──────────────────────────────────────────────────────────────────

export type AiProvider = "openai" | "claude" | "deepseek" | "openrouter" | "local";
export type ImageGenProvider = "dalle" | "stability" | "together" | "local_sd" | "openrouter" | "native_sd";
export type NativeSdGpuBackend = "cpu" | "cuda" | "vulkan";

export interface GeneratedImage {
  base64: string;
  format: string;
  prompt: string;
  revisedPrompt?: string;
  timestamp: number;
}

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
  /** True while tokens are streaming via SSE */
  isStreaming:     boolean;
  /** Accumulated streaming text (live preview, not yet in messages[]) */
  streamingText:   string;
  /** Whether to use SSE streaming (default true; falls back to one-shot on error) */
  useStreaming:    boolean;
  setUseStreaming: (v: boolean) => void;
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

  // ── UI preferences ───────────────────────────────────────────────────────
  /** Chat text size in px (10–22). Default 14. */
  fontSize: number;
  setFontSize: (n: number) => void;
  /** Max output tokens sent to the AI (null = provider default ~2048). */
  maxTokens: number | null;
  setMaxTokens: (n: number | null) => void;

  // ── Image generation ────────────────────────────────────────────────────
  imageGenProvider: ImageGenProvider;
  setImageGenProvider: (p: ImageGenProvider) => void;
  /** API key for the image generation provider (not needed for local_sd) */
  imageGenApiKey: string;
  setImageGenApiKey: (k: string) => void;
  /** Model override (leave empty to use provider default) */
  imageGenModel: string;
  setImageGenModel: (m: string) => void;
  /** Base URL override – required for local_sd, optional for others */
  imageGenUrl: string;
  setImageGenUrl: (url: string) => void;
  /** Output dimensions */
  imageGenWidth: number;
  setImageGenWidth: (n: number) => void;
  imageGenHeight: number;
  setImageGenHeight: (n: number) => void;
  /** Native SD step-by-step progress (null when not running) */
  sdGenProgress: { line: string; step: number; total: number } | null;
  /** Is an image currently being generated? */
  isGeneratingImage: boolean;
  /** Last successfully generated image, ready to display */
  lastGeneratedImage: GeneratedImage | null;
  clearGeneratedImage: () => void;
  /** Gallery of all generated images (max 50, newest first) */
  imageGallery: GeneratedImage[];
  removeGalleryImage: (timestamp: number) => void;
  clearGallery: () => void;
  /** Optional prompt override — if set, skips the auto-generation step */
  imageGenCustomPrompt: string;
  setImageGenCustomPrompt: (p: string) => void;
  // ── Native SD (stable-diffusion.cpp) settings ──────────────────
  nativeSdModelPath: string;
  setNativeSdModelPath: (p: string) => void;
  nativeSdModelsDir: string;
  setNativeSdModelsDir: (d: string) => void;
  nativeSdSteps: number;
  setNativeSdSteps: (n: number) => void;
  nativeSdCfg: number;
  setNativeSdCfg: (n: number) => void;
  nativeSdNegPrompt: string;
  setNativeSdNegPrompt: (p: string) => void;
  nativeSdSampler: string;
  setNativeSdSampler: (s: string) => void;
  nativeSdSeed: number;
  setNativeSdSeed: (n: number) => void;
  /** GPU backend for stable-diffusion.cpp: "cpu" | "cuda" | "vulkan" */
  nativeSdGpuBackend: NativeSdGpuBackend;
  setNativeSdGpuBackend: (b: NativeSdGpuBackend) => void;
  /** CPU thread count for stable-diffusion.cpp (0 = auto) */
  nativeSdThreads: number;
  setNativeSdThreads: (n: number) => void;
  /** Prepend quality booster tags (score_9, masterpiece…) to the generated prompt */
  nativeSdQualityTags: boolean;
  setNativeSdQualityTags: (v: boolean) => void;
  /** Include NSFW tags in the generated prompt */
  nativeSdNsfw: boolean;
  setNativeSdNsfw: (v: boolean) => void;
  /** Pass --vae-on-cpu: offloads VAE decode to RAM, prevents VRAM OOM on SDXL */
  nativeSdVaeOnCpu: boolean;
  setNativeSdVaeOnCpu: (v: boolean) => void;
  /** Pass --vae-tiling: tiles the VAE decode to reduce VRAM usage */
  nativeSdVaeTiling: boolean;
  setNativeSdVaeTiling: (v: boolean) => void;
  /** Pass --offload-to-cpu: model weights stored in RAM, loaded to VRAM on demand (prevents OOM on load) */
  nativeSdOffloadToCpu: boolean;
  setNativeSdOffloadToCpu: (v: boolean) => void;
  /** Generate an image that represents the current chat context */
  generateImage: () => Promise<void>;
}

// ── Sentence-boundary trimmer ─────────────────────────────────────────────
/**
 * When a max-token limit is active and the AI response appears to have been
 * cut short, trim back to the last complete sentence so the text does not
 * end mid-word. Appends a note when truncation is detected.
 */
function trimToSentenceBoundary(text: string, maxTokens: number | null): string {
  if (!maxTokens || !text) return text;

  // Heuristic: 1 token ≈ 4 chars.  If the text is clearly shorter than the
  // limit it was not truncated — return as-is.
  const charLimit = maxTokens * 4;
  if (text.length < charLimit * 0.85) return text;

  // Check whether the response already ends cleanly.
  // A "clean" ending is any sentence-terminating punctuation optionally
  // followed by closing fences / quotes / whitespace.
  if (/[.!?。！？]["'`»\)\]]*\s*$/.test(text)) return text;
  // Also accept responses that end with a closing code fence
  if (/```\s*$/.test(text)) return text;

  // Find the last sentence boundary (. ! ? followed by whitespace or newline)
  const sentenceEnd = Math.max(
    text.lastIndexOf('. '),
    text.lastIndexOf('.\n'),
    text.lastIndexOf('! '),
    text.lastIndexOf('!\n'),
    text.lastIndexOf('? '),
    text.lastIndexOf('?\n'),
  );

  if (sentenceEnd > text.length * 0.4) {
    // +1 to keep the punctuation character itself
    return text.slice(0, sentenceEnd + 1).trimEnd()
      + '\n\n*— ответ обрезан по лимиту токенов —*';
  }

  // Couldn't find a good boundary — return as-is (better than losing content)
  return text;
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
      // ── UI preferences ──────────────────────────────────────────────
      fontSize: 14,
      setFontSize: (n) => set({ fontSize: Math.max(10, Math.min(22, n)) }),
      maxTokens: null,
      setMaxTokens: (n) => set({ maxTokens: n }),

      // ── Image generation ────────────────────────────────────────────
      imageGenProvider: "dalle",
      setImageGenProvider: (p) => set({ imageGenProvider: p }),
      imageGenApiKey: "",
      setImageGenApiKey: (k) => set({ imageGenApiKey: k }),
      imageGenModel: "",
      setImageGenModel: (m) => set({ imageGenModel: m }),
      imageGenUrl: "http://127.0.0.1:7860",
      setImageGenUrl: (url) => set({ imageGenUrl: url }),
      imageGenWidth: 512,
      setImageGenWidth: (n) => set({ imageGenWidth: n }),
      imageGenHeight: 512,
      setImageGenHeight: (n) => set({ imageGenHeight: n }),
      sdGenProgress: null,
      isGeneratingImage: false,
      lastGeneratedImage: null,
      clearGeneratedImage: () => set({ lastGeneratedImage: null }),
      imageGallery: [],
      removeGalleryImage: (ts) => set((s) => ({ imageGallery: s.imageGallery.filter((i) => i.timestamp !== ts) })),
      clearGallery: () => set({ imageGallery: [] }),
      imageGenCustomPrompt: "",
      setImageGenCustomPrompt: (p) => set({ imageGenCustomPrompt: p }),

      // ── Native SD state ──────────────────────────────────────────
      nativeSdModelPath: "",
      setNativeSdModelPath: (p) => set({ nativeSdModelPath: p }),
      nativeSdModelsDir: "",
      setNativeSdModelsDir: (d) => set({ nativeSdModelsDir: d }),
      nativeSdSteps: 15,
      setNativeSdSteps: (n) => set({ nativeSdSteps: n }),
      nativeSdCfg: 7,
      setNativeSdCfg: (n) => set({ nativeSdCfg: n }),
      nativeSdNegPrompt: "blurry, low quality, distorted, deformed, watermark",
      setNativeSdNegPrompt: (p) => set({ nativeSdNegPrompt: p }),
      nativeSdSampler: "euler_a",
      setNativeSdSampler: (s) => set({ nativeSdSampler: s }),
      nativeSdSeed: -1,
      setNativeSdSeed: (n) => set({ nativeSdSeed: n }),
      nativeSdGpuBackend: "cpu" as NativeSdGpuBackend,
      setNativeSdGpuBackend: (b) => set({ nativeSdGpuBackend: b }),
      nativeSdThreads: 0,
      setNativeSdThreads: (n) => set({ nativeSdThreads: n }),
      nativeSdQualityTags: true,
      setNativeSdQualityTags: (v) => set({ nativeSdQualityTags: v }),
      nativeSdNsfw: false,
      setNativeSdNsfw: (v) => set({ nativeSdNsfw: v }),
      nativeSdVaeOnCpu: false,
      setNativeSdVaeOnCpu: (v) => set({ nativeSdVaeOnCpu: v }),
      nativeSdVaeTiling: true,
      setNativeSdVaeTiling: (v) => set({ nativeSdVaeTiling: v }),
      nativeSdOffloadToCpu: true,
      setNativeSdOffloadToCpu: (v) => set({ nativeSdOffloadToCpu: v }),

      generateImage: async () => {
        const {
          messages, apiKey, provider, model, localUrl,
          imageGenProvider, imageGenApiKey, imageGenModel, imageGenUrl,
          imageGenWidth, imageGenHeight, imageGenCustomPrompt,
        } = get();

        if (messages.length === 0 && !imageGenCustomPrompt.trim()) {
          const errMsg: ChatMessage = {
            id: crypto.randomUUID(), role: "assistant", timestamp: Date.now(),
            text: "**Image generation:** нет сообщений в чате. Начните разговор или введите свой промпт в настройках генерации.",
          };
          set((s) => ({ messages: [...s.messages, errMsg] }));
          return;
        }

        set({ isGeneratingImage: true });
        console.group("%c[IMG] generateImage started", "color:#f59e0b;font-weight:bold");
        console.log("provider:", imageGenProvider);
        console.log("customPrompt:", imageGenCustomPrompt || "(none — will use chat context)");
        console.groupEnd();

        try {
          let visualPrompt: string;

          if (imageGenCustomPrompt.trim()) {
            // Use the user-supplied custom prompt as-is
            visualPrompt = imageGenCustomPrompt.trim();
          } else {
          // ── Ask the LLM to produce a complete SD tag prompt ───────────────────
          // The LLM receives character description as INPUT to translate into tags,
          // plus the current scene to extract action/pose/environment tags from.
          const { characters, activeCharacterId, nativeSdQualityTags, nativeSdNsfw } = get();
          const activeChar = activeCharacterId
            ? characters.find((c) => c.id === activeCharacterId) ?? null
            : null;

          // ── Fixed prefix assembled in code (always present in the final prompt) ──
          const prefixParts: string[] = [];
          if (nativeSdQualityTags) prefixParts.push("score_9, score_8_up, score_7_up, masterpiece, best quality");
          if (nativeSdNsfw)        prefixParts.push("explicit, nsfw");
          else                     prefixParts.push("sfw");
          if (activeChar)          prefixParts.push(`${activeChar.name}, 1girl, solo`);
          else                     prefixParts.push("1girl, solo");
          const fixedPrefix = prefixParts.join(", ");

          // ── Context blocks passed to LLM ──
          const charDescBlock = activeChar ? [
            `--- CHARACTER DESCRIPTION (translate ALL visual details into SHORT appearance tags) ---`,
            `Name: ${activeChar.name}`,
            activeChar.description && `Description: ${activeChar.description.slice(0, 700)}`,
            activeChar.personality && `Personality: ${activeChar.personality.slice(0, 200)}`,
          ].filter(Boolean).join("\n") : "";

          // Take the last 8 messages (4 exchanges) for scene context — enough to capture
          // recent events, current action, location and emotional tone.
          const recentMsgs = messages.slice(-8);
          const chatLines = recentMsgs.map((m) => {
            const role = m.role === "user" ? "User" : "AI";
            // Strip only ** markers (not the content inside them — that's often the action text)
            return `${role}: ${m.text.replace(/\*\*/g, "").replace(/\n+/g, " ").trim().slice(0, 500)}`;
          });

          const sceneBlock = [
            `--- RECENT CHAT EVENTS (extract pose, action, clothing, facial expression, emotion, environment, lighting, camera angle${nativeSdNsfw ? ", sexual acts, body parts involved" : ""}) ---`,
            ...chatLines,
          ].join("\n");

          // ── LLM is ONLY responsible for appearance + scene tags (not quality, not subject) ──
          const nsfwInstruction = nativeSdNsfw
            ? `- NSFW mode ON: you MUST include explicit sexual act tags (e.g. fellatio, on knees, penis in mouth, eye contact) when the scene contains sexual content. Do NOT censor or omit them.\n`
            : `- SFW mode: do not include explicit sexual tags.\n`;

          const promptRequest =
            `You are a Stable Diffusion prompt engineer.\n` +
            `Your ONLY job: output a single line of comma-separated SD tags consisting of TWO groups:\n` +
            `GROUP A — appearance tags: translate the CHARACTER DESCRIPTION below into SHORT visual tags ` +
              `(hair color, hair length, eye color, body type, skin tone, notable features, accessories).\n` +
            `GROUP B — scene tags: based on the RECENT CHAT EVENTS below, extract the current pose, action, ` +
              `clothing worn, facial expression, emotion, setting/location, lighting, camera angle` +
              (nativeSdNsfw ? ", and ALL sexual acts/body positions described in the scene" : "") + `. ` +
              `Use what is happening RIGHT NOW in the most recent messages.\n\n` +
            `RULES:\n` +
            `- Output ONLY the tags. No sentences. No explanations. No headers. No brackets.\n` +
            `- Do NOT output quality tags. Do NOT output subject/character name tags.\n` +
            nsfwInstruction +
            `- Output Group A first, then Group B, all on one line separated by commas.\n\n` +
            (charDescBlock ? charDescBlock + "\n\n" : "") +
            sceneBlock + "\n\n" +
            `Example output: long pink hair, small red horns, light blue eyes, curvy figure, red eyeliner, ` +
            (nativeSdNsfw
              ? `naked, on knees, fellatio, penis in mouth, looking up, teary eyes, indoors, dim lighting, close-up`
              : `pilot suit, sitting in cockpit, leaning forward, smirking, warm orange lighting, upper body shot`);

          const imgPromptCommand =
            provider === "openai"     ? "analyze_with_openai"     :
            provider === "claude"     ? "analyze_with_claude"     :
            provider === "deepseek"   ? "analyze_with_deepseek"   :
            provider === "local"      ? "analyze_with_local"      :
                                        "analyze_with_openrouter";

          const imgPromptPayload = provider === "local"
            ? { base_url: localUrl, api_key: apiKey || null, prompt: promptRequest,
                system_prompt: null, image_base64: null, context_files: null, model, max_tokens: 400 }
            : { api_key: apiKey, prompt: promptRequest,
                system_prompt: null, image_base64: null, context_files: null, model, max_tokens: 400 };

          const result = await invoke<{ text: string }>(imgPromptCommand, { req: imgPromptPayload });
          // Strip any accidental leading non-tag text (e.g. "Here are the tags: ")
          const llmTags = result.text.trim().replace(/^[^a-zA-Z0-9]+/, "").replace(/,\s*,/g, ",");
          // Prepend the code-guaranteed prefix (quality, NSFW, character name) — always present
          visualPrompt = fixedPrefix + ", " + llmTags;
          } // end else (custom prompt was empty)

          // ── Step 2: generate the image ────────────────────────────────
          let imageBase64: string;
          let revisedPrompt: string | undefined;
          let imageFormat = "png";

          if (imageGenProvider === "native_sd") {
            // Route to the local stable-diffusion.cpp binary
            const {
              nativeSdModelPath, nativeSdSteps, nativeSdCfg,
              nativeSdNegPrompt, nativeSdSampler, nativeSdSeed,
              nativeSdGpuBackend, nativeSdThreads,
              nativeSdVaeOnCpu, nativeSdVaeTiling, nativeSdOffloadToCpu,
              imageGenWidth: w, imageGenHeight: h,
            } = get();
            if (!nativeSdModelPath) throw new Error("Native SD: no model selected. Go to Settings → Image Generation → Native SD.");

            console.group("%c[SD] run_local_sd request", "color:#34d399;font-weight:bold");
            console.log("provider  :", "native_sd (stable-diffusion.cpp)");
            console.log("gpu       :", nativeSdGpuBackend);
            console.log("model     :", nativeSdModelPath);
            console.log("size      :", `${w}×${h}`);
            console.log("steps     :", nativeSdSteps, "  cfg:", nativeSdCfg, "  seed:", nativeSdSeed);
            console.log("sampler   :", nativeSdSampler);
            console.log("prompt    :", visualPrompt.slice(0, 200));
            console.log("neg_prompt:", nativeSdNegPrompt || "(none)");
            console.groupEnd();

            // Subscribe to step-by-step progress events from sd binary
            const unlistenSdProg = await listen<{ line: string }>("sd-progress", (ev) => {
              const line = ev.payload.line;
              const m = line.match(/(\d+)\s*\/\s*(\d+)/);
              set({
                sdGenProgress: {
                  line,
                  step:  m ? parseInt(m[1]) : 0,
                  total: m ? parseInt(m[2]) : 0,
                },
              });
            });

            const sdStart = Date.now();
            try {
              imageBase64 = await invoke<string>("run_local_sd", {
                req: {
                  model_path:      nativeSdModelPath,
                  prompt:          visualPrompt,
                  negative_prompt: nativeSdNegPrompt || null,
                  width:           w,
                  height:          h,
                  steps:           nativeSdSteps,
                  cfg_scale:       nativeSdCfg,
                  seed:            nativeSdSeed,
                  sampler:         nativeSdSampler,
                  vae_path:        null,
                  threads:         nativeSdThreads,
                  extra_args:      null,
                  gpu_backend:     nativeSdGpuBackend,
                  vae_on_cpu:      nativeSdVaeOnCpu,
                  vae_tiling:      nativeSdVaeTiling,
                  offload_to_cpu:  nativeSdOffloadToCpu,
                },
              });
              console.log(`%c[SD] ✓ generation complete (${((Date.now()-sdStart)/1000).toFixed(1)}s)`,
                "color:#34d399;font-weight:bold");
            } catch (sdErr) {
              console.error("[SD] generation failed:", sdErr);
              throw sdErr;
            } finally {
              unlistenSdProg();
              set({ sdGenProgress: null });
            }
          } else {
            // Cloud / local WebUI providers
            const resolvedKey = imageGenApiKey ||
              ((imageGenProvider === "dalle" || imageGenProvider === "openrouter") && provider === imageGenProvider
                ? apiKey : "");

            console.group("%c[IMG] generate_image request", "color:#60a5fa;font-weight:bold");
            console.log("provider:", imageGenProvider);
            console.log("model   :", imageGenModel || "(default)");
            console.log("url     :", imageGenUrl || "(default)");
            console.log("size    :", `${imageGenWidth}×${imageGenHeight}`);
            console.log("api_key :", resolvedKey ? `${resolvedKey.slice(0,8)}…` : "(none)");
            console.log("prompt  :", visualPrompt.slice(0, 200));
            console.groupEnd();

            const cloudStart = Date.now();
            const result = await invoke<{ image_base64: string; revised_prompt?: string; format: string }>(
              "generate_image",
              {
                req: {
                  prompt:    visualPrompt,
                  provider:  imageGenProvider,
                  api_key:   resolvedKey || null,
                  model:     imageGenModel || null,
                  url:       imageGenUrl || null,
                  width:     imageGenWidth,
                  height:    imageGenHeight,
                },
              }
            );
            console.log(`%c[IMG] ✓ received (${((Date.now()-cloudStart)/1000).toFixed(1)}s) format=${result.format}`,
              "color:#60a5fa;font-weight:bold");
            imageBase64    = result.image_base64;
            revisedPrompt  = result.revised_prompt;
            imageFormat    = result.format;
          }

          const newImage: GeneratedImage = {
            base64:        imageBase64,
            format:        imageFormat,
            prompt:        visualPrompt,
            revisedPrompt: revisedPrompt,
            timestamp:     Date.now(),
          };
          set((s) => ({
            lastGeneratedImage: newImage,
            imageGallery: [newImage, ...s.imageGallery].slice(0, 50),
          }));
        } catch (err) {
          const errMsg: ChatMessage = {
            id: crypto.randomUUID(), role: "assistant", timestamp: Date.now(),
            text: `**Image generation failed:** ${String(err)}`,
          };
          set((s) => ({ messages: [...s.messages, errMsg] }));
        } finally {
          set({ isGeneratingImage: false });
        }
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
      localUrl: "http://127.0.0.1:1234/v1/chat/completions",
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
      isLoading:    false,
      isStreaming:  false,
      streamingText: "",
      useStreaming:  true,
      setUseStreaming: (v) => set({ useStreaming: v }),

      sendMessage: async () => {
        const { apiKey, provider, model, localUrl, prompt, capturedImage, indexedFiles, indexedRoot, messages,
                webSearchEnabled, searchBackend, searchApiKey, searxngUrl,
                characters, activeCharacterId, responseLanguage, maxTokens } = get();

        if (!prompt.trim() && !capturedImage) return;

        if (provider !== "local" && !apiKey) {
          const errMsg: ChatMessage = {
            id:        crypto.randomUUID(),
            role:      "assistant",
            text:      "**No API key configured.**\n\nOpen ⚙ Settings and enter your API key for the selected provider.",
            timestamp: Date.now(),
          };
          set((s) => ({ messages: [...s.messages, errMsg] }));
          return;
        }

        // Add user message to history
        const userMsg: ChatMessage = {
          id:           crypto.randomUUID(),
          role:         "user",
          text:         prompt,
          imageBase64:  capturedImage ?? undefined,
          timestamp:    Date.now(),
        };
        // Guard: ensure isLoading is always reset even if persist throws
        try {
          set((s) => ({ messages: [...s.messages, userMsg], prompt: "", isLoading: true }));
        } catch {
          set({ isLoading: false });
          throw new Error("Failed to update state before sending. Try again.");
        }

        // ── Cancellation token — set before any await so Stop always works ──
        let _masterReject: ((e: Error) => void) | null = null;
        const masterCancel = new Promise<never>((_, reject) => { _masterReject = reject; });
        void masterCancel.catch(() => {}); // prevent unhandled-rejection if request finishes first
        _cancelFn = () => { _masterReject?.(new Error("__CANCELLED__")); };

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
              const searchRes = await Promise.race([
                invoke<{
                  results: Array<{ title: string; url: string; snippet: string; content?: string }>;
                  backend: string;
                }>(command, { req: searchReq }),
                masterCancel,
              ]);

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
              if (String(err).includes("__CANCELLED__")) throw err; // propagate stop
              console.warn("Web search failed:", err);
              webSearchContext = `\n\n⚠️ Web search failed: ${String(err)}\n`;
            }
          }

          const langSuffix = responseLanguage !== "auto"
            ? `\n[Отвечай исключительно на ${LANGUAGE_NAMES[responseLanguage] ?? responseLanguage}]`
            : "";

          const fullPrompt = historyBlock
            ? `[Conversation history]\n${historyBlock}[Current message]\nUser: ${currentText}${webSearchContext}${langSuffix}`
            : `${currentText}${webSearchContext}${langSuffix}`;

          // ── Build character system prompt (sent as a real system message) ──
          const activeChar = activeCharacterId ? characters.find((c) => c.id === activeCharacterId) : null;
          const langPrefix = responseLanguage !== "auto"
            ? `[SYSTEM LANGUAGE OVERRIDE — HIGHEST PRIORITY RULE: You MUST respond EXCLUSIVELY in ${LANGUAGE_NAMES[responseLanguage] ?? responseLanguage}. This rule overrides EVERYTHING, including: the language of previous messages in conversation history, the language the user wrote in, any language patterns you observe in the dialogue. Every single word of your response — dialogue, narration, actions, thoughts, descriptions, inner monologue — must be in ${LANGUAGE_NAMES[responseLanguage] ?? responseLanguage}. DO NOT write even a single word in any other language. This applies to your CURRENT response and ALL future responses in this conversation.]\n\n`
            : "";
          const charSystemPrompt: string | null = activeChar
            ? langPrefix + [
                `You are ${activeChar.name}.`,
                activeChar.system_prompt,
                activeChar.description && `Description: ${activeChar.description}`,
                activeChar.personality && `Personality: ${activeChar.personality}`,
                activeChar.scenario    && `Scenario: ${activeChar.scenario}`,
                activeChar.mes_example && `Example dialogue:\n${activeChar.mes_example}`,
              ].filter(Boolean).join("\n")
            : (langPrefix || null);

          const finalPrompt = fullPrompt;

          // ── Shared request payload ────────────────────────────────
          const streamPayload = {
            provider,
            api_key:       apiKey || null,
            prompt:        finalPrompt,
            system_prompt: charSystemPrompt,
            image_base64:  capturedImage ?? null,
            context_files: contextFiles.length ? contextFiles : null,
            model,
            max_tokens:    maxTokens ?? null,
            local_url:     localUrl || null,
          };

          // Decide whether to stream or use the old one-shot commands
          const { useStreaming } = get();

          if (useStreaming) {
            // ── Streaming path via SSE ──────────────────────────────
            set({ isStreaming: true, streamingText: "" });

            let unlistenToken: (() => void) | null = null;
            let unlistenDone:  (() => void) | null = null;

            try {
              const cleanup = () => {
                const t = unlistenToken; const d = unlistenDone;
                unlistenToken = null; unlistenDone = null;
                t && (t as () => void)();
                d && (d as () => void)();
              };

              // Promise that resolves when the stream is finished
              const streamDone = new Promise<string>((resolve, reject) => {
                // Register listeners first, then invoke
                Promise.all([
                  listen<string>("ai-stream-token", (event) => {
                    set((s) => ({ streamingText: s.streamingText + event.payload }));
                  }),
                  listen<{ text?: string; model?: string; cancelled?: boolean }>("ai-stream-done", (event) => {
                    if (event.payload.cancelled) {
                      reject(new Error("__CANCELLED__"));
                    } else {
                      resolve(event.payload.text ?? get().streamingText);
                    }
                  }),
                ]).then(([ulToken, ulDone]) => {
                  unlistenToken = ulToken;
                  unlistenDone  = ulDone;
                  // Now invoke after listeners are registered
                  invoke("analyze_stream", { req: streamPayload }).catch(reject);
                }).catch(reject);
              });

              const finalText = await Promise.race([streamDone, masterCancel]);
              cleanup();

              const assistantMsg: ChatMessage = {
                id:        crypto.randomUUID(),
                role:      "assistant",
                text:      trimToSentenceBoundary(finalText, maxTokens),
                timestamp: Date.now(),
              };
              set((s) => ({
                messages:     [...s.messages, assistantMsg],
                capturedImage: null,
                isStreaming:  false,
                streamingText: "",
              }));
            } catch (err) {
              const t = unlistenToken; const d = unlistenDone;
              // TypeScript narrowing guard for captured mutable references
              t && (t as () => void)();
              d && (d as () => void)();
              set({ isStreaming: false, streamingText: "" });
              throw err; // re-throw so outer catch handles it
            }
          } else {
            // ── Non-streaming (legacy) path ─────────────────────────
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
                  system_prompt: charSystemPrompt,
                  image_base64:  capturedImage ?? null,
                  context_files: contextFiles.length ? contextFiles : null,
                  model,
                  max_tokens:    maxTokens ?? null,
                }
              : {
                  api_key:       apiKey,
                  prompt:        finalPrompt,
                  system_prompt: charSystemPrompt,
                  image_base64:  capturedImage ?? null,
                  context_files: contextFiles.length ? contextFiles : null,
                  model,
                  max_tokens:    maxTokens ?? null,
                };

            const result = await Promise.race([
              invoke<{ text: string; model: string; tokens_used?: number }>(command, { req: reqPayload }),
              masterCancel,
            ]);

            const assistantMsg: ChatMessage = {
              id:        crypto.randomUUID(),
              role:      "assistant",
              text:      trimToSentenceBoundary(result.text, maxTokens),
              timestamp: Date.now(),
            };
            set((s) => ({ messages: [...s.messages, assistantMsg], capturedImage: null }));
          }
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
        // Always reset loading — guards against stuck state from hot-reload /
        // previous crashed requests where the finally block never ran.
        set({ isLoading: false, isStreaming: false, streamingText: "" });
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
      responseLanguage:    "ru",
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
      // v3: default response language changed from "auto" to "ru"
      name:    "ai-assistant-v2",
      storage: safeStorage,
      version: 3,
      migrate: (persisted: unknown, fromVersion: number) => {
        // Carry over settings from v1 / unknown versions, drop heavy blobs
        const old = (persisted ?? {}) as Record<string, unknown>;
        if (fromVersion < 2) {
          // Remove any avatarBase64 blobs from characters
          const chars = (old.characters as Array<Record<string, unknown>> ?? []).map(
            ({ avatarBase64: _, ...c }) => c
          );
          // Fix the old wrong LM Studio URL that was previously the default
          const localUrl = old.localUrl === "http://127.0.0.1:1234/api/v1/chat"
            ? "http://127.0.0.1:1234/v1/chat/completions"
            : old.localUrl;
          return { ...old, localUrl, characters: chars, messages: [], archivedChats: [] };
        }
        if (fromVersion < 3) {
          // v3: force Russian as the default language if user still had "auto"
          const responseLanguage = old.responseLanguage === "auto" ? "ru" : old.responseLanguage;
          return { ...old, responseLanguage };
        }
        return old;
      },
      partialize: (s) => {
        // Strip all binary blobs before writing
        const stripImages = (msgs: ChatMessage[]) =>
          msgs.map(({ imageBase64: _img, ...m }) => m as ChatMessage);

        return {
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
          // Strip avatar blobs — they're displayed from in-memory state only
          characters: s.characters.map(({ avatarBase64: _av, ...c }) => c as CharacterCard),
          activeCharacterId: s.activeCharacterId,
          responseLanguage:  s.responseLanguage,
          windowMode:        s.windowMode,
          fontSize:          s.fontSize,
          maxTokens:         s.maxTokens,
          // Keep only the 50 most recent messages (no images)
          messages:          stripImages(s.messages.slice(-50)),
          activeSessionId:   s.activeSessionId,
          // Keep last 50 sessions, strip images from their messages
          archivedChats: s.archivedChats.slice(0, 50).map((chat) => ({
            ...chat,
            messages: stripImages(chat.messages.slice(-50)),
          })),
          // Image generation settings
          imageGenProvider:  s.imageGenProvider,
          imageGenApiKey:    s.imageGenApiKey,
          imageGenModel:     s.imageGenModel,
          imageGenUrl:       s.imageGenUrl,
          imageGenWidth:     s.imageGenWidth,
          imageGenHeight:    s.imageGenHeight,
          // Native SD settings
          nativeSdModelPath: s.nativeSdModelPath,
          nativeSdModelsDir: s.nativeSdModelsDir,
          nativeSdSteps:     s.nativeSdSteps,
          nativeSdCfg:       s.nativeSdCfg,
          nativeSdNegPrompt: s.nativeSdNegPrompt,
          nativeSdSampler:    s.nativeSdSampler,
          nativeSdSeed:       s.nativeSdSeed,
          nativeSdGpuBackend: s.nativeSdGpuBackend,
          nativeSdVaeOnCpu:     s.nativeSdVaeOnCpu,
          nativeSdVaeTiling:    s.nativeSdVaeTiling,
          nativeSdOffloadToCpu: s.nativeSdOffloadToCpu,
        };
      },
    }
  )
);
