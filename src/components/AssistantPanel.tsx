import { useRef, useEffect, useState } from "react";
import { useAssistantStore } from "../store/assistantStore";
import ApiKeyInput from "./ApiKeyInput";
import ScreenshotPreview from "./ScreenshotPreview";
import FileIndexer from "./FileIndexer";
import FileEditBlock from "./FileEditBlock";

export default function AssistantPanel() {
  const {
    messages, isLoading, clearMessages,
    prompt, setPrompt, sendMessage,
    capturedImage, triggerCapture, clearCapture, isCapturing,
    isClickThrough, toggleClickThrough,
  } = useAssistantStore();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const handleClearSession = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    clearMessages();
    setConfirmClear(false);
  };

  // Auto-scroll to latest message
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isLoading]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col h-screen
      bg-gray-900/90 backdrop-blur-2xl text-white
      rounded-2xl border border-white/10 shadow-2xl overflow-hidden">

      {/* ── Header (drag region) ──────────────────────────────────── */}
      <header
        data-tauri-drag-region
        className="flex items-center justify-between px-4 py-2.5
          border-b border-white/10 shrink-0 cursor-grab active:cursor-grabbing"
      >
        {/* Left: identity */}
        <div className="flex items-center gap-2 pointer-events-none select-none">
          <span className="text-base">🤖</span>
          <span className="font-semibold text-sm tracking-wide">AI Assistant</span>
        </div>

        {/* Right: controls */}
        <div className="flex items-center gap-1.5 pointer-events-auto">
          <button
            onClick={handleClearSession}
            title={confirmClear ? "Click again to confirm — this clears AI memory!" : "New session (clears AI memory)"}
            className={[
              "text-[10px] px-2 py-1 rounded transition-all font-mono",
              confirmClear
                ? "bg-red-500/80 text-white animate-pulse"
                : messages.length > 0
                ? "bg-white/10 hover:bg-red-500/40 hover:text-red-200"
                : "bg-white/5 text-white/30 cursor-default",
            ].join(" ")}
            disabled={messages.length === 0 && !confirmClear}
          >
            {confirmClear ? "⚠ Sure?" : "🔄 New"}
          </button>
          <button
            onClick={toggleClickThrough}
            title="Toggle passthrough (Alt+M)"
            className={[
              "text-[10px] px-2 py-1 rounded font-mono transition-colors",
              isClickThrough
                ? "bg-yellow-400 text-black"
                : "bg-white/10 hover:bg-white/20",
            ].join(" ")}
          >
            {isClickThrough ? "⬜ PASS" : "🖱 ACT"}
          </button>
        </div>
      </header>

      {/* ── Config section ────────────────────────────────────────── */}
      <div className="shrink-0 px-3 pt-3 space-y-2">
        <ApiKeyInput />
        <FileIndexer />
      </div>

      {/* ── Message thread ────────────────────────────────────────── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center h-full
            text-white/20 text-sm text-center gap-2 select-none">
            <span className="text-4xl">🤖</span>
            <p>Take a screenshot or ask anything.</p>
            <p className="text-[11px]">Ctrl+Enter to send · Alt+M passthrough · Alt+Shift+S capture</p>
            <p className="text-[10px] mt-1">🔄 New — clears AI memory &amp; starts fresh session</p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={[
              "rounded-xl px-3 py-2.5 text-sm",
              msg.role === "user"
                ? "bg-blue-600/40 ml-6 self-end"
                : "bg-white/5 mr-6",
            ].join(" ")}
          >
            {msg.imageBase64 && (
              <img
                src={`data:image/png;base64,${msg.imageBase64}`}
                alt="screenshot"
                className="mb-2 rounded-lg max-h-36 object-cover border border-white/10"
              />
            )}
            {msg.role === "assistant" ? (
              <FileEditBlock text={msg.text} />
            ) : (
              <p className="whitespace-pre-wrap break-words">{msg.text}</p>
            )}
            <p className="text-[9px] text-white/25 mt-1 text-right">
              {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>
        ))}

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-white/40 mr-6">
            <span className="animate-spin text-base">⚙️</span>
            <span>Thinking…</span>
          </div>
        )}
      </div>

      {/* ── Screenshot preview ────────────────────────────────────── */}
      {capturedImage && (
        <div className="shrink-0 px-3">
          <ScreenshotPreview />
        </div>
      )}

      {/* ── Prompt input area ─────────────────────────────────────── */}
      <div className="shrink-0 border-t border-white/10 p-3 space-y-2">
        {capturedImage && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-green-400">📸 Screenshot attached</span>
            <button onClick={clearCapture} className="text-red-400 hover:text-red-300">
              ✕ remove
            </button>
          </div>
        )}

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything… (Ctrl+Enter to send)"
          rows={3}
          className="w-full bg-white/10 rounded-xl px-3 py-2 text-sm resize-none
            placeholder-white/25 focus:outline-none focus:ring-1 focus:ring-blue-500
            transition-colors"
        />

        <div className="flex gap-2">
          <button
            onClick={() => triggerCapture()}
            disabled={isCapturing}
            className="flex-1 flex items-center justify-center gap-1.5
              bg-white/10 hover:bg-white/20 rounded-xl py-2 text-xs
              font-medium transition-colors disabled:opacity-50"
          >
            {isCapturing ? (
              <><span className="animate-spin">⚙️</span> Capturing…</>
            ) : (
              <><span>📸</span> Capture Screen</>
            )}
          </button>

          <button
            onClick={sendMessage}
            disabled={isLoading || !prompt.trim()}
            className="flex-1 bg-blue-600 hover:bg-blue-500 rounded-xl py-2 text-xs
              font-bold transition-colors disabled:opacity-50"
          >
            Send ⌘↩
          </button>
        </div>
      </div>
    </div>
  );
}
