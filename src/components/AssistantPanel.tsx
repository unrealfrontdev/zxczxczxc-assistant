import { useRef, useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { useAssistantStore, LANGUAGE_NAMES } from "../store/assistantStore";
import ApiKeyInput from "./ApiKeyInput";
import ScreenshotPreview from "./ScreenshotPreview";
import FileIndexer from "./FileIndexer";
import FileEditBlock from "./FileEditBlock";
import WebSearchToggle from "./WebSearchToggle";
import PromptLibrary from "./PromptLibrary";
import CharacterImport from "./CharacterImport";
import ChatHistory from "./ChatHistory";
import StFormatText, { ST_FORMAT_EXAMPLES } from "./StFormatText";

const PANEL_WIDTH = 420;

export default function AssistantPanel() {
  const {
    messages, isLoading, clearMessages,
    prompt, setPrompt, sendMessage, cancelMessage,
    capturedImage, triggerCapture, clearCapture, setCapturedImage, isCapturing,
    isGhostMode, toggleGhostMode,
    archivedChats, archiveCurrentChat, activeSessionId,
    windowMode, setWindowMode,
    responseLanguage, setResponseLanguage,
    activeCharacterId,
  } = useAssistantStore();

  const scrollRef      = useRef<HTMLDivElement>(null);
  const [confirmClear,  setConfirmClear]  = useState(false);
  const [cfgOpen,       setCfgOpen]       = useState(false);
  const [promptsOpen,   setPromptsOpen]   = useState(false);
  const [historyOpen,   setHistoryOpen]   = useState(false);
  const [charsOpen,     setCharsOpen]     = useState(false);
  const [langOpen,      setLangOpen]      = useState(false);

  const togglePanel = (name: "cfg" | "history" | "prompts" | "chars") => {
    setCfgOpen(name === "cfg" ? (o) => !o : false);
    setHistoryOpen(name === "history" ? (o) => !o : false);
    setPromptsOpen(name === "prompts" ? (o) => !o : false);
    setCharsOpen(name === "chars" ? (o) => !o : false);
    setLangOpen(false);
  };

  // ── Report panel left-X to Rust so cursor tracker can use it ──────────
  useEffect(() => {
    const report = () => {
      const x = window.innerWidth - PANEL_WIDTH;
      invoke("set_panel_x", { x }).catch(() => {});
    };
    report();
    window.addEventListener("resize", report);
    return () => window.removeEventListener("resize", report);
  }, []);

  // ── Auto-scroll ────────────────────────────────────────────────────────
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isLoading]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ── Clipboard paste (via Rust — works on Wayland/X11) ─────────────────
  const pasteFromClipboard = useCallback(async () => {
    try {
      const base64 = await invoke<string>("get_clipboard_image");
      setCapturedImage(base64);
    } catch { /* no image in clipboard */ }
  }, [setCapturedImage]);

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const img = items.find((i) => i.type.startsWith("image/"));
    if (img) {
      const file = img.getAsFile();
      if (file) {
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = () => {
          const b64 = (reader.result as string).split(",")[1];
          if (b64) setCapturedImage(b64);
        };
        reader.readAsDataURL(file);
        return;
      }
    }
    pasteFromClipboard();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "v") pasteFromClipboard();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pasteFromClipboard]);

  // ── Session clear ──────────────────────────────────────────────────────
  const handleClearSession = () => {
    if (messages.length === 0) { clearMessages(); return; }
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    // Archive and start fresh
    archiveCurrentChat();
    setConfirmClear(false);
  };

  // ══════════════════════════════════════════════════════════════════════
  // Single render tree — ghost mode hides panel via CSS (no unmount/remount)
  // ══════════════════════════════════════════════════════════════════════
  return (
    <div className={windowMode === "windowed" ? "" : "fixed inset-0 pointer-events-none select-none overflow-hidden"}>

      {/* Ghost indicator — visible only in ghost mode */}
      {isGhostMode && (
        <div className="fixed top-3 right-4 flex items-center gap-1.5 pointer-events-none">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-400/70 animate-pulse" />
          <span className="text-[9px] font-mono tracking-widest text-white/20 uppercase">
            ghost · Alt+M
          </span>
        </div>
      )}

      {/* ══ Right panel ═══════════════════════════════════════════════ */}
      <div
        className={[
          "flex flex-col bg-gray-950/90 border-l border-white/[0.07] shadow-[-24px_0_60px_rgba(0,0,0,0.6)]",
          windowMode === "windowed"
            ? "w-full h-screen"
            : "fixed right-0 top-0 h-screen",
        ].join(" ")}
        style={{
          ...(windowMode !== "windowed" && { width: PANEL_WIDTH }),
          display: isGhostMode ? "none" : "flex",
          pointerEvents: isGhostMode ? "none" : "auto",
        }}
      >
        {/* ── Header ───────────────────────────────────────────────────── */}
        <header
          data-tauri-drag-region
          className="shrink-0 flex items-center justify-between px-4 py-2.5
            border-b border-white/[0.07] cursor-grab active:cursor-grabbing"
        >
          {/* Identity */}
          <div className="flex items-center gap-2 pointer-events-none select-none">
            <span className="text-sm">🤖</span>
            <span className="text-xs font-semibold text-white/70 tracking-wide">AI Assistant</span>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-1 pointer-events-auto">
            {/* Config toggle */}
            <button
              onClick={() => togglePanel("cfg")}
              title="Settings"
              className={[
                "text-[10px] px-2 py-1 rounded transition-colors font-mono",
                cfgOpen ? "bg-white/15 text-white" : "bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70",
              ].join(" ")}
            >
              ⚙
            </button>

            {/* Chat history */}
            <button
              onClick={() => togglePanel("history")}
              title="Chat history"
              className={[
                "text-[10px] px-2 py-1 rounded transition-colors font-mono relative",
                historyOpen ? "bg-amber-500/30 text-amber-200" : "bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70",
              ].join(" ")}
            >
              🗂
              {archivedChats.length > 0 && !historyOpen && (
                <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full
                  bg-amber-400 pointer-events-none" />
              )}
            </button>

            {/* Prompts quick-access */}
            <button
              onClick={() => togglePanel("prompts")}
              title="Prompt library"
              className={[
                "text-[10px] px-2 py-1 rounded transition-colors font-mono",
                promptsOpen ? "bg-purple-500/30 text-purple-200" : "bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70",
              ].join(" ")}
            >
              📚
            </button>

            {/* Characters */}
            <button
              onClick={() => togglePanel("chars")}
              title="Characters"
              className={[
                "text-[10px] px-2 py-1 rounded transition-colors font-mono relative",
                charsOpen ? "bg-pink-500/30 text-pink-200" : "bg-white/5 text-white/40 hover:bg-white/10 hover:text-pink-300",
              ].join(" ")}
            >
              🎭
              {activeCharacterId && (
                <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full
                  bg-pink-400 pointer-events-none" />
              )}
            </button>

            {/* Language switcher */}
            <div className="relative">
              <button
                onClick={() => { setLangOpen((o) => !o); }}
                title={"Response language: " + (responseLanguage === "auto" ? "Auto" : (LANGUAGE_NAMES[responseLanguage] ?? responseLanguage))}
                className={[
                  "text-[10px] px-2 py-1 rounded transition-colors font-mono",
                  langOpen || responseLanguage !== "auto"
                    ? "bg-sky-500/30 text-sky-200"
                    : "bg-white/5 text-white/40 hover:bg-white/10 hover:text-sky-300",
                ].join(" ")}
              >
                🌐{responseLanguage !== "auto" ? <span className="ml-0.5 text-[9px] uppercase">{responseLanguage}</span> : null}
              </button>
              {langOpen && (
                <div
                  className="absolute right-0 top-full mt-1 z-50 w-52
                    bg-gray-900 border border-white/10 rounded-xl shadow-2xl
                    py-1 overflow-hidden"
                >
                  {/* Auto option */}
                  <button
                    onClick={() => { setResponseLanguage("auto"); setLangOpen(false); }}
                    className={[
                      "w-full text-left px-3 py-1.5 text-[11px] transition-colors",
                      responseLanguage === "auto"
                        ? "bg-sky-500/20 text-sky-300"
                        : "text-white/60 hover:bg-white/5 hover:text-white",
                    ].join(" ")}
                  >
                    🔁 Auto (match user)
                  </button>
                  <div className="my-1 border-t border-white/[0.06]" />
                  {Object.entries(LANGUAGE_NAMES).map(([code, label]) => (
                    <button
                      key={code}
                      onClick={() => { setResponseLanguage(code); setLangOpen(false); }}
                      className={[
                        "w-full text-left px-3 py-1.5 text-[11px] transition-colors",
                        responseLanguage === code
                          ? "bg-sky-500/20 text-sky-300"
                          : "text-white/60 hover:bg-white/5 hover:text-white",
                      ].join(" ")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Clear / archive session */}
            <button
              onClick={handleClearSession}
              title={confirmClear ? "Confirm archive & clear" : messages.length > 0 ? "Archive & new chat" : "New chat"}
              className={[
                "text-[10px] px-2 py-1 rounded transition-all font-mono",
                confirmClear
                  ? "bg-amber-500/70 text-white animate-pulse"
                  : messages.length > 0
                  ? "bg-white/5 text-white/40 hover:bg-amber-500/20 hover:text-amber-300"
                  : "bg-white/5 text-white/20",
              ].join(" ")}
            >
              {confirmClear ? "save?" : "🔄"}
            </button>

            {/* Ghost mode toggle */}
            <button
              onClick={toggleGhostMode}
              title="Ghost mode — fully transparent (Alt+M)"
              className="text-[10px] px-2.5 py-1 rounded font-mono transition-colors
                bg-white/5 text-white/40 hover:bg-yellow-500/20 hover:text-yellow-300"
            >
              👻
            </button>

            {/* Window mode toggle */}
            <button
              onClick={() => setWindowMode(windowMode === "windowed" ? "overlay" : "windowed")}
              title={windowMode === "windowed" ? "Switch to overlay mode" : "Switch to windowed mode"}
              className={[
                "text-[10px] px-2.5 py-1 rounded font-mono transition-colors",
                windowMode === "windowed"
                  ? "bg-teal-500/30 text-teal-200 hover:bg-teal-500/50"
                  : "bg-white/5 text-white/40 hover:bg-teal-500/20 hover:text-teal-300",
              ].join(" ")}
            >
              {windowMode === "windowed" ? "⛶" : "⦃"}
            </button>
          </div>
        </header>

        {/* ── Chat history panel ────────────────────────────────────────── */}
        {historyOpen && <ChatHistory onClose={() => setHistoryOpen(false)} />}

        {/* ── Config panel (collapsible) ────────────────────────────────── */}
        {cfgOpen && (
          <div className="shrink-0 px-3 pt-3 pb-2 space-y-2
            border-b border-white/[0.07]">
            <ApiKeyInput />
            <FileIndexer />
            <WebSearchToggle />
          </div>
        )}

        {/* ── Characters panel ─────────────────────────────────────────── */}
        {charsOpen && (
          <div className="shrink-0 px-3 pt-3 pb-2 border-b border-white/[0.07]">
            <CharacterImport />
          </div>
        )}

        {/* ── Prompt library quick-panel ──────────────────────────────── */}
        {promptsOpen && (
          <div className="shrink-0 px-3 pt-2 pb-2 border-b border-white/[0.07]">
            <PromptLibrary />
          </div>
        )}

        {/* ── Message thread ────────────────────────────────────────────── */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-3 py-3 space-y-3
            scrollbar-thin scrollbar-thumb-white/10"
        >
          {messages.length === 0 && !isLoading && (
            <div className="flex flex-col items-center justify-center h-full
              text-white/20 text-center gap-2 select-none">
              <span className="text-3xl opacity-40">🤖</span>
              <p className="text-xs">Screenshot or ask anything.</p>
              <p className="text-[10px] text-white/15">
                Ctrl+Enter send · Ctrl+V paste · Alt+M ghost · Alt+Shift+S capture
              </p>
              {archivedChats.length > 0 && (
                <button
                  onClick={() => setHistoryOpen(true)}
                  className="mt-1 text-[9px] text-amber-400/50 hover:text-amber-400/80
                    transition-colors underline underline-offset-2"
                >
                  {archivedChats.length} saved chat{archivedChats.length !== 1 ? "s" : ""} →
                </button>
              )}
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={[
                "rounded-xl px-3 py-2.5 text-sm",
                msg.role === "user"
                  ? "bg-blue-600/25 border border-blue-500/20 ml-4"
                  : "bg-white/[0.04] border border-white/[0.06]",
              ].join(" ")}
            >
              {msg.imageBase64 && (
                <img
                  src={`data:image/png;base64,${msg.imageBase64}`}
                  alt="screenshot"
                  className="mb-2 rounded-lg max-h-36 object-cover border border-white/10 w-full"
                />
              )}
              {msg.role === "assistant" ? (
                <FileEditBlock text={msg.text} />
              ) : (
                <p className="whitespace-pre-wrap break-words text-white/85">
                  <StFormatText text={msg.text} />
                </p>
              )}
              <p className="text-[9px] text-white/20 mt-1 text-right">
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
          ))}

          {isLoading && (
            <div className="flex items-center gap-2 text-xs text-white/30">
              <span className="animate-spin">⚙️</span>
              <span>Thinking…</span>
            </div>
          )}
        </div>

        {/* ── Screenshot preview ────────────────────────────────────────── */}
        {capturedImage && (
          <div className="shrink-0 px-3">
            <ScreenshotPreview />
          </div>
        )}

        {/* ── Input area ───────────────────────────────────────────────── */}
        <div className="shrink-0 border-t border-white/[0.07] p-3 space-y-2">
          {capturedImage && (
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-green-400/80">📸 attached</span>
              <button onClick={clearCapture} className="text-red-400/70 hover:text-red-300">✕</button>
            </div>
          )}

          {/* ── ST format quick-insert (visible when a character is active) ── */}
          {activeCharacterId && (
            <div className="flex gap-1 flex-wrap">
              <span className="text-[9px] text-white/20 self-center mr-0.5">insert:</span>
              {ST_FORMAT_EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  title={ex.description}
                  onClick={() => {
                    const ins = ex.syntax;
                    const ta  = document.querySelector<HTMLTextAreaElement>("textarea[data-st]");
                    if (ta) {
                      const s = ta.selectionStart;
                      const e = ta.selectionEnd;
                      const before = prompt.slice(0, s);
                      const after  = prompt.slice(e);
                      const selected = prompt.slice(s, e);
                      // If text is selected, wrap it; else insert template
                      let insert: string;
                      if (ex.label === '"Dialogue"') {
                        insert = selected ? `"${selected}"` : '"your dialogue here"';
                      } else if (ex.label === '*Action*') {
                        insert = selected ? `*${selected}*` : '*does something*';
                      } else {
                        insert = selected ? `((${selected}))` : '((your note))';
                      }
                      const next = before + insert + after;
                      setPrompt(next);
                      // Restore selection after React re-render
                      setTimeout(() => {
                        ta.focus();
                        ta.setSelectionRange(s + insert.length, s + insert.length);
                      }, 0);
                    } else {
                      setPrompt((p) => p + ins);
                    }
                  }}
                  className={[
                    "text-[9px] px-1.5 py-0.5 rounded font-mono transition-colors",
                    "bg-white/5 hover:bg-white/10",
                    ex.color,
                  ].join(" ")}
                >
                  {ex.label}
                </button>
              ))}
            </div>
          )}

          <textarea
            data-st
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Ask… (Ctrl+Enter · Ctrl+V image)"
            rows={3}
            className="w-full bg-white/[0.06] rounded-xl px-3 py-2 text-sm resize-none
              text-white/85 placeholder-white/20
              focus:outline-none focus:ring-1 focus:ring-white/20
              transition-colors"
          />

          <div className="flex gap-1.5">
            {/* Capture */}
            <button
              onClick={() => triggerCapture()}
              disabled={isCapturing}
              title="Capture screen (Alt+Shift+S)"
              className="flex-none flex items-center justify-center gap-1
                bg-white/[0.06] hover:bg-white/[0.12] rounded-xl px-3 py-2 text-[11px]
                text-white/50 hover:text-white/80 transition-colors disabled:opacity-40"
            >
              {isCapturing ? <span className="animate-spin text-xs">⚙️</span> : "📸"}
            </button>

            {/* Paste image */}
            <button
              onClick={pasteFromClipboard}
              title="Paste image from clipboard"
              className="flex-none flex items-center justify-center gap-1
                bg-white/[0.06] hover:bg-white/[0.12] rounded-xl px-3 py-2 text-[11px]
                text-white/50 hover:text-white/80 transition-colors"
            >
              📋
            </button>

            {/* Send / Stop */}
            <button
              onClick={isLoading ? cancelMessage : sendMessage}
              disabled={!isLoading && !prompt.trim() && !capturedImage}
              className={[
                "flex-1 rounded-xl py-2 text-xs font-semibold transition-colors",
                isLoading
                  ? "bg-red-600/70 hover:bg-red-600 text-white"
                  : "bg-blue-600/70 hover:bg-blue-600 text-white disabled:opacity-30",
              ].join(" ")}
            >
              {isLoading ? "■ Stop" : "Send  ⌘↩"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
