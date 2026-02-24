import { useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { useAssistantStore, AiProvider } from "../store/assistantStore";

const MODELS: Record<AiProvider, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1-preview"],
  claude: [
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
    "claude-3-haiku-20240307",
  ],
  deepseek: [
    "deepseek-chat",
    "deepseek-reasoner",
  ],
  openrouter: [
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "anthropic/claude-3.5-sonnet",
    "anthropic/claude-3.5-haiku",
    "deepseek/deepseek-chat",
    "deepseek/deepseek-r1",
    "google/gemini-2.0-flash-001",
    "meta-llama/llama-3.3-70b-instruct",
    "mistralai/mistral-large",
    "x-ai/grok-2-1212",
  ],
  local: [
    "local-model",
    "llama-3.2-3b-instruct",
    "llama-3.3-70b-instruct",
    "mistral-7b-instruct",
    "phi-4",
    "qwen2.5-coder-7b-instruct",
    "gemma-3-12b-it",
    "deepseek-r1-distill-qwen-14b",
  ],
};

const LOCAL_PRESETS = [
  { label: "LM Studio", url: "http://localhost:1234/v1/chat/completions" },
  { label: "Ollama",    url: "http://localhost:11434" },
];

export default function ApiKeyInput() {
  const {
    apiKey, setApiKey, provider, setProvider, model, setModel,
    localUrl, setLocalUrl,
  } = useAssistantStore();

  const [open,         setOpen]         = useState(!apiKey && provider !== "local");
  const [visible,      setVisible]      = useState(false);
  const [detecting,    setDetecting]    = useState(false);
  const [detectedModels, setDetectedModels] = useState<string[]>([]);

  const isLocal   = provider === "local";
  const hasConfig = isLocal ? !!localUrl : !!apiKey;

  return (
    <div className="bg-white/5 rounded-xl overflow-hidden">
      {/* Accordion header */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2
          text-xs font-medium text-white/60 hover:text-white transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <span>⚙️</span>
          <span>API Configuration</span>
          {hasConfig && (
            <span className="bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded text-[9px]">
              {isLocal ? "● local" : "● key set"}
            </span>
          )}
        </span>
        <span className="text-[10px]">{open ? "▲" : "▼"}</span>
      </button>

      {/* Accordion body */}
      {open && (
        <div className="px-3 pb-3 space-y-2.5">
          {/* Provider toggle — row 1: cloud providers */}
          <div className="flex gap-1.5">
            {(["openai", "claude", "deepseek", "openrouter"] as AiProvider[]).map((p) => (
              <button
                key={p}
                onClick={() => { setProvider(p); setModel(MODELS[p][0]); }}
                className={[
                  "flex-1 py-1.5 rounded-lg text-[11px] font-semibold transition-colors",
                  provider === p
                    ? "bg-blue-600 text-white"
                    : "bg-white/10 text-white/50 hover:bg-white/20",
                ].join(" ")}
              >
                {p === "openai" ? "OpenAI" : p === "claude" ? "Claude" : p === "deepseek" ? "DeepSeek" : "OpenRouter"}
              </button>
            ))}
          </div>

          {/* Row 2: local LLM button */}
          <button
            onClick={() => { setProvider("local"); setModel(MODELS.local[0]); }}
            className={[
              "w-full py-1.5 rounded-lg text-[11px] font-semibold transition-colors",
              provider === "local"
                ? "bg-purple-600 text-white"
                : "bg-white/10 text-white/50 hover:bg-white/20",
            ].join(" ")}
          >
            🖥 Local LLM (LM Studio / Ollama / custom)
          </button>

          {/* ── Local LLM controls ── */}
          {isLocal && (
            <>
              {/* Preset buttons */}
              <div className="flex gap-1.5">
                {LOCAL_PRESETS.map(({ label, url }) => (
                  <button
                    key={label}
                    onClick={() => setLocalUrl(url)}
                    className={[
                      "flex-1 py-1 rounded-lg text-[10px] font-medium transition-colors",
                      localUrl === url
                        ? "bg-purple-500/40 text-purple-200 ring-1 ring-purple-400/50"
                        : "bg-white/10 text-white/50 hover:bg-white/20",
                    ].join(" ")}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Base URL input */}
              <input
                type="text"
                value={localUrl}
                onChange={(e) => setLocalUrl(e.target.value)}
                placeholder="http://localhost:1234/api/v1/chat"
                spellCheck={false}
                className="w-full bg-white/10 rounded-lg px-2.5 py-1.5 text-[11px]
                  placeholder-white/25 focus:outline-none focus:ring-1 focus:ring-purple-500
                  font-mono"
              />
              <p className="text-[9px] text-white/30 font-mono -mt-1">
                LM Studio: <span className="text-purple-300/70">…:1234/api/v1/chat</span>
                {"  ·  "}
                Ollama: <span className="text-purple-300/70">…:11434</span>
              </p>

              {/* Detect models from local server */}
              <div className="flex gap-1.5 items-center">
                <button
                  onClick={async () => {
                    setDetecting(true);
                    setDetectedModels([]);
                    try {
                      // Try LM Studio endpoint first
                      const lmUrl = localUrl.includes("/v1/chat/completions")
                        ? localUrl.replace("/v1/chat/completions", "")
                        : localUrl;
                      let models: string[] = [];
                      try {
                        models = await invoke<string[]>("list_lmstudio_models", { baseUrl: lmUrl });
                      } catch {
                        // Try Ollama
                        const ollamaBase = localUrl.includes("1234") ? "http://localhost:11434" : localUrl;
                        models = await invoke<string[]>("list_ollama_models", { baseUrl: ollamaBase });
                      }
                      setDetectedModels(models);
                      if (models.length > 0 && !models.includes(model)) {
                        setModel(models[0]);
                      }
                    } catch (e) {
                      setDetectedModels([`Error: ${e}`]);
                    } finally {
                      setDetecting(false);
                    }
                  }}
                  disabled={detecting}
                  className="flex-1 py-1 rounded-lg text-[10px] font-medium transition-colors
                    bg-purple-500/20 hover:bg-purple-500/40 text-purple-300 disabled:opacity-40"
                >
                  {detecting ? "Scanning…" : "🔍 Detect models"}
                </button>
              </div>

              {/* Detected model list */}
              {detectedModels.length > 0 && (
                <div className="bg-white/[0.04] rounded-lg p-1.5 space-y-0.5">
                  {detectedModels.map((m) => (
                    <button
                      key={m}
                      onClick={() => setModel(m)}
                      className={[
                        "w-full text-left px-2 py-1 rounded text-[10px] truncate transition-colors",
                        model === m
                          ? "bg-purple-500/30 text-purple-200"
                          : "hover:bg-white/10 text-white/60 hover:text-white",
                      ].join(" ")}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}

              {/* Model — free-text or from suggestions */}
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                list="local-model-suggestions"
                placeholder="model name (e.g. llama-3.2-3b-instruct)"
                spellCheck={false}
                className="w-full bg-white/10 rounded-lg px-2.5 py-1.5 text-[11px]
                  placeholder-white/25 focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
              <datalist id="local-model-suggestions">
                {MODELS.local.map((m) => <option key={m} value={m} />)}
              </datalist>

              {/* Optional API key (e.g. LM Studio with auth enabled) */}
              <div className="relative">
                <input
                  type={visible ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Bearer token (optional)"
                  spellCheck={false}
                  className="w-full bg-white/10 rounded-lg px-2.5 py-1.5 text-[11px] pr-8
                    placeholder-white/25 focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
                <button
                  type="button"
                  onClick={() => setVisible((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2
                    text-white/35 hover:text-white/70 text-xs transition-colors"
                  tabIndex={-1}
                >
                  {visible ? "🙈" : "👁"}
                </button>
              </div>

              <p className="text-[9px] text-white/25">
                Connects to a local server — no data leaves your machine.
              </p>
            </>
          )}

          {/* ── Cloud API controls ── */}
          {!isLocal && (
            <>
              {/* Model selector */}
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full bg-white/10 rounded-lg px-2 py-1.5 text-[11px]
                  focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {MODELS[provider].map((m) => (
                  <option key={m} value={m} className="bg-gray-800 text-white">
                    {m}
                  </option>
                ))}
              </select>

              {/* API Key */}
              <div className="relative">
                <input
                  type={visible ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    provider === "openai"     ? "sk-…"     :
                    provider === "claude"     ? "sk-ant-…" :
                    provider === "openrouter" ? "sk-or-…"  :
                                               "sk-…"
                  }
                  spellCheck={false}
                  className="w-full bg-white/10 rounded-lg px-2.5 py-1.5 text-[11px] pr-8
                    placeholder-white/25 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={() => setVisible((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2
                    text-white/35 hover:text-white/70 text-xs transition-colors"
                  tabIndex={-1}
                >
                  {visible ? "🙈" : "👁"}
                </button>
              </div>

              <p className="text-[9px] text-white/25">
                Key is stored locally in localStorage — never sent anywhere except the selected API.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
