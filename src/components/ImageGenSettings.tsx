/**
 * ImageGenSettings — configuration accordion for the image generation subsystem.
 *
 * Supported providers:
 *   dalle       — OpenAI DALL-E 3 (uses OpenAI API key or a dedicated key)
 *   stability   — Stability AI stable-image-core (requires Stability API key)
 *   together    — Together AI FLUX/SDXL (requires Together AI API key; free tier available)
 *   openrouter  — OpenRouter FLUX.1.1-Pro (uses OpenRouter key)
 *   local_sd    — Local Automatic1111 / FORGE WebUI (no key needed)
 */

import { useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { useAssistantStore, type ImageGenProvider } from "../store/assistantStore";
import LocalSdPanel from "./LocalSdPanel";

const PROVIDERS: { id: ImageGenProvider; label: string; desc: string }[] = [
  { id: "dalle",      label: "DALL-E 3",      desc: "OpenAI — high quality" },
  { id: "stability",  label: "Stability AI",   desc: "Stable Image Core" },
  { id: "together",   label: "Together AI",    desc: "FLUX free tier" },
  { id: "openrouter", label: "OpenRouter",     desc: "FLUX.1.1-Pro" },
  { id: "local_sd",   label: "Local SD",       desc: "A1111 / FORGE API" },
  { id: "native_sd",  label: "Native SD",      desc: "stable-diffusion.cpp (★ no WebUI needed)" },
];

const DEFAULT_MODELS: Record<ImageGenProvider, string[]> = {
  dalle:      ["dall-e-3", "dall-e-2"],
  stability:  ["core"],
  together:   [
    "black-forest-labs/FLUX.1-schnell-Free",
    "black-forest-labs/FLUX.1-schnell",
    "black-forest-labs/FLUX.1.1-pro",
    "stabilityai/stable-diffusion-xl-base-1.0",
  ],
  openrouter: [
    "black-forest-labs/flux-1.1-pro",
    "black-forest-labs/flux-schnell",
    "stability-ai/sdxl",
  ],
  local_sd:   [],
  native_sd:  [],
};

const SIZE_PRESETS = [
  { label: "512²",    w: 512,  h: 512  },
  { label: "768²",    w: 768,  h: 768  },
  { label: "1024²",   w: 1024, h: 1024 },
  { label: "16:9",    w: 1280, h: 720  },
  { label: "9:16",    w: 720,  h: 1280 },
];

export default function ImageGenSettings() {
  const {
    imageGenProvider,   setImageGenProvider,
    imageGenApiKey,     setImageGenApiKey,
    imageGenModel,      setImageGenModel,
    imageGenUrl,        setImageGenUrl,
    imageGenWidth,      setImageGenWidth,
    imageGenHeight,     setImageGenHeight,
    imageGenCustomPrompt, setImageGenCustomPrompt,
  } = useAssistantStore();

  const [open,     setOpen]     = useState(false);
  const [showKey,  setShowKey]  = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [sdModels, setSdModels] = useState<string[]>([]);

  const loadSdModels = async () => {
    setLoadingModels(true);
    try {
      type SdModel = { title: string; model_name: string };
      const models = await invoke<SdModel[]>("list_sd_models", { baseUrl: imageGenUrl || "http://127.0.0.1:7860" });
      setSdModels(models.map((m) => m.title));
    } catch {
      setSdModels(["Error loading models"]);
    } finally {
      setLoadingModels(false);
    }
  };

  const models    = DEFAULT_MODELS[imageGenProvider] ?? [];
  const needsKey  = imageGenProvider !== "local_sd" && imageGenProvider !== "native_sd";
  const needsUrl  = imageGenProvider === "local_sd";
  const isNative  = imageGenProvider === "native_sd";
  const hasConfig = isNative ? true : (needsKey ? !!imageGenApiKey : !!imageGenUrl);

  return (
    <div className="bg-white/5 rounded-xl overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2
          text-xs font-medium text-white/60 hover:text-white transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <span>🎨</span>
          <span>Image Generation</span>
          {hasConfig && (
            <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/20
              text-emerald-400 font-mono">
              {PROVIDERS.find((p) => p.id === imageGenProvider)?.label ?? imageGenProvider}
            </span>
          )}
        </span>
        <span className="text-[10px] text-white/30">{open ? "▲" : "▽"}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2.5">
          {/* Provider selector */}
          <div>
            <p className="text-[9px] text-white/30 mb-1 uppercase tracking-wider">Provider</p>
            <div className="flex flex-wrap gap-1">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setImageGenProvider(p.id)}
                  title={p.desc}
                  className={[
                    "text-[10px] px-2 py-1 rounded transition-colors font-mono",
                    imageGenProvider === p.id
                      ? "bg-emerald-500/30 text-emerald-200"
                      : "bg-white/10 text-white/50 hover:bg-white/20 hover:text-white",
                  ].join(" ")}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="text-[9px] text-white/20 mt-1">
              {PROVIDERS.find((p) => p.id === imageGenProvider)?.desc}
            </p>
          </div>

          {/* API key (cloud providers) */}
          {needsKey && (
            <div>
              <p className="text-[9px] text-white/30 mb-1 uppercase tracking-wider">
                {imageGenProvider === "dalle"      ? "OpenAI API Key"     :
                 imageGenProvider === "stability"  ? "Stability AI Key"   :
                 imageGenProvider === "together"   ? "Together AI Key"    :
                                                     "OpenRouter API Key"}
              </p>
              <div className="flex gap-1">
                <input
                  type={showKey ? "text" : "password"}
                  value={imageGenApiKey}
                  onChange={(e) => setImageGenApiKey(e.target.value)}
                  placeholder={
                    imageGenProvider === "dalle"    ? "sk-…"    :
                    imageGenProvider === "stability"? "sk-…"    :
                    imageGenProvider === "together" ? "…"       :
                                                     "sk-or-…"
                  }
                  className="flex-1 bg-white/[0.06] rounded-lg px-2 py-1.5 text-[11px]
                    text-white/80 placeholder-white/20
                    focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
                />
                <button
                  onClick={() => setShowKey((v) => !v)}
                  className="px-2 py-1 bg-white/[0.06] rounded-lg text-[11px]
                    text-white/40 hover:text-white/70 transition-colors"
                >
                  {showKey ? "🙈" : "👁"}
                </button>
              </div>
              {imageGenProvider === "together" && (
                <p className="text-[9px] text-white/20 mt-1">
                  Free tier available at <span className="text-white/40">together.ai</span>.
                  Default model: FLUX.1-schnell (free).
                </p>
              )}
            </div>
          )}

          {/* Base URL (local SD) */}
          {needsUrl && (
            <div className="space-y-1.5">
              <p className="text-[9px] text-white/30 uppercase tracking-wider">
                A1111 / FORGE URL
              </p>
              <input
                type="text"
                value={imageGenUrl}
                onChange={(e) => setImageGenUrl(e.target.value)}
                placeholder="http://127.0.0.1:7860"
                className="w-full bg-white/[0.06] rounded-lg px-2 py-1.5 text-[11px]
                  text-white/80 placeholder-white/20
                  focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
              />
              <p className="text-[9px] text-white/20">
                Start A1111/FORGE with <span className="font-mono text-white/40">--api</span> flag.
              </p>

              {/* Load models from SD server */}
              <button
                onClick={loadSdModels}
                disabled={loadingModels}
                className="w-full py-1 rounded-lg text-[10px] font-medium transition-colors
                  bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-300 disabled:opacity-40"
              >
                {loadingModels ? "Loading…" : "📋 Load models from server"}
              </button>

              {sdModels.length > 0 && (
                <div className="bg-white/[0.04] rounded-lg p-1.5 max-h-32 overflow-y-auto space-y-0.5">
                  {sdModels.map((m) => (
                    <button
                      key={m}
                      onClick={() => setImageGenModel(m)}
                      className={[
                        "w-full text-left px-2 py-0.5 rounded text-[10px] truncate transition-colors",
                        imageGenModel === m
                          ? "bg-emerald-500/30 text-emerald-200"
                          : "hover:bg-white/10 text-white/60 hover:text-white",
                      ].join(" ")}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Native SD (stable-diffusion.cpp) full panel */}
          {isNative && <LocalSdPanel />}

          {/* Custom image prompt override */}
          <div>
            <p className="text-[9px] text-white/30 mb-1 uppercase tracking-wider">
              Custom prompt override <span className="normal-case text-white/20 ml-1">(leave empty = auto-generate from chat)</span>
            </p>
            <textarea
              value={imageGenCustomPrompt}
              onChange={(e) => setImageGenCustomPrompt(e.target.value)}
              placeholder="Optional: override the auto-generated image prompt…"
              rows={2}
              className="w-full bg-white/[0.06] rounded-lg px-2 py-1.5 text-[11px]
                text-white/80 placeholder-white/20 resize-none
                focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
            />
            <p className="text-[9px] text-white/20 mt-0.5">
              Stored locally — not sent until you click 🎨 Generate.
            </p>
          </div>

          {/* Model (optional, hide for stability/local_sd/native_sd which have one model) */}
          {models.length > 0 && !isNative && (
            <div>
              <p className="text-[9px] text-white/30 mb-1 uppercase tracking-wider">Model</p>
              <div className="flex flex-wrap gap-1">
                {models.map((m) => {
                  const shortName = m.split("/").pop() ?? m;
                  return (
                    <button
                      key={m}
                      onClick={() => setImageGenModel(m)}
                      title={m}
                      className={[
                        "text-[9px] px-2 py-0.5 rounded font-mono transition-colors",
                        (imageGenModel === m || (!imageGenModel && m === models[0]))
                          ? "bg-emerald-500/30 text-emerald-200"
                          : "bg-white/10 text-white/50 hover:bg-white/20 hover:text-white",
                      ].join(" ")}
                    >
                      {shortName}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Size presets — hidden for native_sd (sizes set per run inside LocalSdPanel) */}
          {!isNative && (
          <div>
            <p className="text-[9px] text-white/30 mb-1 uppercase tracking-wider">Output size</p>
            <div className="flex gap-1">
              {SIZE_PRESETS.map((s) => {
                const active = imageGenWidth === s.w && imageGenHeight === s.h;
                return (
                  <button
                    key={s.label}
                    onClick={() => { setImageGenWidth(s.w); setImageGenHeight(s.h); }}
                    className={[
                      "text-[9px] px-2 py-0.5 rounded font-mono transition-colors",
                      active
                        ? "bg-emerald-500/30 text-emerald-200"
                        : "bg-white/10 text-white/50 hover:bg-white/20 hover:text-white",
                    ].join(" ")}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[9px] text-white/20 mt-1">
              {imageGenWidth}×{imageGenHeight} px
            </p>
          </div>
          )} {/* end !isNative size presets */}
        </div>
      )}
    </div>
  );
}
