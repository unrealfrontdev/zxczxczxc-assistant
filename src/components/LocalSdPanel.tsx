/**
 * LocalSdPanel — UI for running Stable Diffusion locally via stable-diffusion.cpp.
 * No external WebUI required — manages binary download and model selection.
 */

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { useAssistantStore, NativeSdGpuBackend } from "../store/assistantStore";
import { openDirSafe, openFileSafe } from "../utils/dialog";

// ── Types ──────────────────────────────────────────────────────────────────

interface BinaryStatus {
  installed: boolean;
  path: string;
}

interface DownloadProgress {
  status: string;
  progress: number;
}

const SAMPLERS = [
  { id: "euler",    label: "Euler" },
  { id: "euler_a",  label: "Euler A" },
  { id: "heun",     label: "Heun" },
  { id: "dpm2",     label: "DPM2" },
  { id: "dpm++2s_a",label: "DPM++ 2S a" },
  { id: "dpm++2m",  label: "DPM++ 2M" },
  { id: "dpm++2mv2",label: "DPM++ 2M v2" },
  { id: "lcm",      label: "LCM" },
  { id: "ipndm",    label: "iPNDM" },
];

// ── Component ──────────────────────────────────────────────────────────────

export default function LocalSdPanel() {
  const {
    nativeSdModelPath,  setNativeSdModelPath,
    nativeSdModelsDir,  setNativeSdModelsDir,
    nativeSdSteps,      setNativeSdSteps,
    nativeSdCfg,        setNativeSdCfg,
    nativeSdNegPrompt,  setNativeSdNegPrompt,
    nativeSdSampler,    setNativeSdSampler,
    nativeSdSeed,       setNativeSdSeed,
    nativeSdGpuBackend,   setNativeSdGpuBackend,
    nativeSdThreads,      setNativeSdThreads,
    nativeSdQualityTags,  setNativeSdQualityTags,
    nativeSdNsfw,         setNativeSdNsfw,
    nativeSdVaeOnCpu,     setNativeSdVaeOnCpu,
    nativeSdVaeTiling,    setNativeSdVaeTiling,
    nativeSdOffloadToCpu, setNativeSdOffloadToCpu,
    imageGenWidth,        setImageGenWidth,
    imageGenHeight,       setImageGenHeight,
  } = useAssistantStore();

  const [binStatus,   setBinStatus]   = useState<BinaryStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [dlProgress,  setDlProgress]  = useState<DownloadProgress | null>(null);
  const [modelFiles,  setModelFiles]  = useState<string[]>([]);
  const [scanning,    setScanning]    = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [cudaLibsOk,  setCudaLibsOk]  = useState<null | { found: boolean; path: string | null; suggestion: string | null }>(null);

  // ── Init: check binary status ────────────────────────────────────────────
  useEffect(() => {
    invoke<BinaryStatus>("get_sd_binary_status", { backendPref: nativeSdGpuBackend })
      .then(setBinStatus)
      .catch(() => setBinStatus({ installed: false, path: "" }));
  }, [nativeSdGpuBackend]);
  // ↑ Re-runs whenever the backend selector changes so the UI correctly
  //   reflects whether *that specific* backend binary is already downloaded.

  // ── Check CUDA system libs when CUDA backend is selected ─────────────────
  useEffect(() => {
    if (nativeSdGpuBackend !== "cuda") { setCudaLibsOk(null); return; }
    invoke<{ found: boolean; path: string | null; suggestion: string | null }>("check_cuda_libs")
      .then(setCudaLibsOk)
      .catch(() => setCudaLibsOk(null));
  }, [nativeSdGpuBackend]);

  // ── Scan models when dir changes ─────────────────────────────────────────
  useEffect(() => {
    if (!nativeSdModelsDir) return;
    setScanning(true);
    invoke<string[]>("list_local_sd_models", { modelsDir: nativeSdModelsDir })
      .then((files) => { setModelFiles(files); setScanning(false); })
      .catch(() => setScanning(false));
  }, [nativeSdModelsDir]);

  // ── Download binary ───────────────────────────────────────────────────────
  const downloadBinary = async () => {
    setDownloading(true);
    setError(null);
    setDlProgress({ status: "Starting…", progress: 0 });

    const unlisten = await listen<DownloadProgress>("sd-download-progress", (ev) => {
      setDlProgress(ev.payload);
    });

    try {
      await invoke("download_sd_binary", { backendPref: nativeSdGpuBackend });
      const status = await invoke<BinaryStatus>("get_sd_binary_status", { backendPref: nativeSdGpuBackend });
      setBinStatus(status);
      setDlProgress(null); // clear progress only on success
    } catch (e) {
      // Keep dlProgress visible so user sees where it stopped; show error text.
      setDlProgress((prev) => prev
        ? { ...prev, status: `❌ Failed: ${String(e).slice(0, 120)}` }
        : { status: `❌ ${String(e).slice(0, 120)}`, progress: 0 }
      );
      setError(String(e));
    } finally {
      unlisten();
      setDownloading(false);
    }
  };

  // ── Browse models directory ───────────────────────────────────────────────
  const browseModelsDir = async () => {
    const selected = await openDirSafe("Select models folder");
    if (selected) setNativeSdModelsDir(selected);
  };

  // ── Browse single model file ──────────────────────────────────────────────
  const browseModelFile = async () => {
    const selected = await openFileSafe({
      multiple: false,
      filters: [{ name: "SD Models", extensions: ["safetensors", "ckpt", "gguf", "bin"] }],
    });
    if (typeof selected === "string") setNativeSdModelPath(selected);
  };

  const shortPath = (p: string) => p.split(/[\\/]/).slice(-1)[0] ?? p;
  // ── Delete binary ─────────────────────────────────────────────────────────
  const deleteBinary = async () => {
    try {
      await invoke("delete_sd_binary", { backendPref: nativeSdGpuBackend });
      setBinStatus({ installed: false, path: "" });
      setDlProgress(null);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className="space-y-3">
      {/* ── GPU backend selector ── */}
      <div className="bg-white/[0.04] rounded-xl p-3 space-y-2">
        <p className="text-[9px] uppercase tracking-wider text-white/30 font-medium">
          GPU / compute backend
        </p>
        <div className="grid grid-cols-3 gap-1">
          {([
            ["cpu",    "CPU",    "Universal, no GPU needed"],
            ["cuda",   "CUDA",   "NVIDIA GPU — fastest"],
            ["vulkan", "Vulkan", "AMD / Intel / NVIDIA"],
          ] as [NativeSdGpuBackend, string, string][]).map(([id, label, desc]) => (
            <button
              key={id}
              onClick={() => setNativeSdGpuBackend(id)}
              title={desc}
              className={[
                "py-1.5 rounded-lg text-[10px] font-medium transition-colors",
                nativeSdGpuBackend === id
                  ? "bg-emerald-500/40 text-emerald-200 ring-1 ring-emerald-500/60"
                  : "bg-white/[0.06] text-white/50 hover:bg-white/10 hover:text-white/80",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-[9px] text-white/20">
          {nativeSdGpuBackend === "cuda"
            ? "⚡ On Linux, selects the Vulkan build (no native Linux CUDA release exists). Works on NVIDIA, AMD, Intel via Vulkan API."
            : nativeSdGpuBackend === "vulkan"
            ? "⚡ Vulkan build: works on AMD, Intel & NVIDIA GPUs. Recommended for NVIDIA on Linux."
            : "💻 CPU build: universal, no GPU required. Slowest option."
          }
        </p>

        {/* Linux CUDA → Vulkan info box */}
        {nativeSdGpuBackend === "cuda" && (
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-2">
            <p className="text-[9px] text-amber-300/80 font-medium">ℹ Linux: no native CUDA binary available</p>
            <p className="text-[9px] text-white/40 mt-0.5">
              stable-diffusion.cpp does not publish a Linux CUDA release.
              The <span className="text-white/60">Vulkan</span> binary will be downloaded instead —
              it uses your NVIDIA GPU via Vulkan API and performs similarly.
            </p>
          </div>
        )}

        {binStatus?.installed && (
          <div className="flex items-center justify-between">
            <p className="text-[9px] text-emerald-400/60">
              ✓ {nativeSdGpuBackend.toUpperCase()} binary installed.
            </p>
            <button
              onClick={deleteBinary}
              title="Delete this binary to re-download (useful if you downloaded wrong backend)"
              className="text-[9px] text-red-400/60 hover:text-red-400 transition-colors"
            >
              🗑 Delete
            </button>
          </div>
        )}
      </div>

      {/* ── Binary status ── */}
      <div className="bg-white/[0.04] rounded-xl p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[9px] uppercase tracking-wider text-white/30 font-medium">
            stable-diffusion.cpp binary
          </span>
          {binStatus?.installed ? (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">
              ✓ installed
            </span>
          ) : (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400">
              not installed
            </span>
          )}
        </div>

        {!binStatus?.installed && (
          <>
            <p className="text-[9px] text-white/30">
              Downloads the{" "}
              <span className="text-white/50">
                {nativeSdGpuBackend === "cuda"
                  ? "Vulkan (NVIDIA/AMD/Intel GPU on Linux)"
                  : nativeSdGpuBackend === "vulkan" ? "Vulkan (GPU)" : "CPU"}
              </span>{" "}
              binary from{" "}
              <span className="text-white/50">leejet/stable-diffusion.cpp</span> releases
              (~30–200 MB). Only needed once.
            </p>
            <button
              onClick={downloadBinary}
              disabled={downloading}
              className="w-full py-1.5 rounded-lg text-[11px] font-medium transition-colors
                bg-blue-500/30 hover:bg-blue-500/50 text-blue-200 disabled:opacity-40"
            >
              {downloading ? "⟳ Downloading…" : "⬇ Download binary"}
            </button>
            {dlProgress && (
              <div className="space-y-1">
                <div className="flex justify-between text-[9px] text-white/40">
                  <span>{dlProgress.status}</span>
                  <span>{dlProgress.progress}%</span>
                </div>
                <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500/70 rounded-full transition-all duration-300"
                    style={{ width: `${dlProgress.progress}%` }}
                  />
                </div>
              </div>
            )}
          </>
        )}

        {binStatus?.installed && (
          <p className="text-[9px] text-white/20 font-mono truncate" title={binStatus.path}>
            {binStatus.path}
          </p>
        )}
      </div>

      {/* ── Models directory ── */}
      <div className="space-y-1.5">
        <p className="text-[9px] text-white/30 uppercase tracking-wider">Models folder</p>
        <div className="flex gap-1">
          <div
            className="flex-1 bg-white/[0.06] rounded-lg px-2 py-1.5 text-[10px]
              text-white/60 truncate cursor-pointer hover:bg-white/10"
            title={nativeSdModelsDir}
            onClick={browseModelsDir}
          >
            {nativeSdModelsDir || <span className="text-white/20">Click to select folder…</span>}
          </div>
          <button
            onClick={browseModelsDir}
            className="px-2 py-1 bg-white/[0.06] rounded-lg text-[11px]
              text-white/40 hover:text-white/70 transition-colors"
          >
            📂
          </button>
        </div>
        <p className="text-[9px] text-white/20">
          Folder containing .safetensors / .gguf / .ckpt model files — searched recursively.
        </p>
      </div>

      {/* ── Model list ── */}
      {(modelFiles.length > 0 || scanning) && (
        <div className="space-y-1">
          <p className="text-[9px] text-white/30 uppercase tracking-wider">
            Select model {scanning && <span className="text-white/20">scanning…</span>}
          </p>
          <div className="bg-white/[0.04] rounded-lg p-1.5 max-h-36 overflow-y-auto space-y-0.5">
            {modelFiles.map((f) => (
              <button
                key={f}
                onClick={() => setNativeSdModelPath(f)}
                title={f}
                className={[
                  "w-full text-left px-2 py-0.5 rounded text-[10px] truncate transition-colors",
                  nativeSdModelPath === f
                    ? "bg-emerald-500/30 text-emerald-200"
                    : "hover:bg-white/10 text-white/60 hover:text-white",
                ].join(" ")}
              >
                {shortPath(f)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Direct model path ── */}
      <div className="space-y-1.5">
        <p className="text-[9px] text-white/30 uppercase tracking-wider">
          Model path (or pick from list above)
        </p>
        <div className="flex gap-1">
          <input
            type="text"
            value={nativeSdModelPath}
            onChange={(e) => setNativeSdModelPath(e.target.value)}
            placeholder="/path/to/model.safetensors"
            className="flex-1 bg-white/[0.06] rounded-lg px-2 py-1.5 text-[10px]
              text-white/80 placeholder-white/20
              focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
          />
          <button
            onClick={browseModelFile}
            className="px-2 py-1 bg-white/[0.06] rounded-lg text-[11px]
              text-white/40 hover:text-white/70 transition-colors"
          >
            📄
          </button>
        </div>
        {nativeSdModelPath && (
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-emerald-400">✓</span>
            <span className="text-[9px] text-white/30 font-mono truncate">
              {shortPath(nativeSdModelPath)}
            </span>
          </div>
        )}
      </div>

      {/* ── Inference settings ── */}
      <div className="grid grid-cols-2 gap-2">
        {/* Steps */}
        <div className="space-y-1">
          <p className="text-[9px] text-white/30 uppercase tracking-wider">Steps</p>
          <input
            type="number"
            value={nativeSdSteps}
            min={1} max={150}
            onChange={(e) => setNativeSdSteps(Math.max(1, parseInt(e.target.value) || 20))}
            className="w-full bg-white/[0.06] rounded-lg px-2 py-1.5 text-[11px]
              text-white/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
          />
        </div>
        {/* CFG Scale */}
        <div className="space-y-1">
          <p className="text-[9px] text-white/30 uppercase tracking-wider">CFG Scale</p>
          <input
            type="number"
            value={nativeSdCfg}
            min={1} max={30} step={0.5}
            onChange={(e) => setNativeSdCfg(parseFloat(e.target.value) || 7)}
            className="w-full bg-white/[0.06] rounded-lg px-2 py-1.5 text-[11px]
              text-white/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
          />
        </div>
        {/* Seed */}
        <div className="space-y-1">
          <p className="text-[9px] text-white/30 uppercase tracking-wider">Seed (-1 = random)</p>
          <input
            type="number"
            value={nativeSdSeed}
            onChange={(e) => setNativeSdSeed(parseInt(e.target.value) || -1)}
            className="w-full bg-white/[0.06] rounded-lg px-2 py-1.5 text-[11px]
              text-white/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
          />
        </div>
        {/* Sampler */}
        <div className="space-y-1">
          <p className="text-[9px] text-white/30 uppercase tracking-wider">Sampler</p>
          <select
            value={nativeSdSampler}
            onChange={(e) => setNativeSdSampler(e.target.value)}
            className="w-full bg-white/[0.06] rounded-lg px-2 py-1.5 text-[11px]
              text-white/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
          >
            {SAMPLERS.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
        {/* Width */}
        <div className="space-y-1">
          <p className="text-[9px] text-white/30 uppercase tracking-wider">Width (px)</p>
          <input
            type="number"
            value={imageGenWidth}
            min={64} max={2048} step={64}
            onChange={(e) => setImageGenWidth(Math.max(64, parseInt(e.target.value) || 512))}
            className="w-full bg-white/[0.06] rounded-lg px-2 py-1.5 text-[11px]
              text-white/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
          />
        </div>
        {/* Height */}
        <div className="space-y-1">
          <p className="text-[9px] text-white/30 uppercase tracking-wider">Height (px)</p>
          <input
            type="number"
            value={imageGenHeight}
            min={64} max={2048} step={64}
            onChange={(e) => setImageGenHeight(Math.max(64, parseInt(e.target.value) || 512))}
            className="w-full bg-white/[0.06] rounded-lg px-2 py-1.5 text-[11px]
              text-white/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
          />
        </div>
        {/* Quality tags toggle */}
        <div className="col-span-2 flex items-center justify-between">
          <div>
            <p className="text-[9px] text-white/30 uppercase tracking-wider">Quality tags</p>
            <p className="text-[9px] text-white/20">score_9, masterpiece, best quality…</p>
          </div>
          <button
            onClick={() => setNativeSdQualityTags(!nativeSdQualityTags)}
            className={[
              "relative w-8 h-4 rounded-full transition-colors",
              nativeSdQualityTags ? "bg-emerald-500/60" : "bg-white/10",
            ].join(" ")}
          >
            <span className={[
              "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform",
              nativeSdQualityTags ? "translate-x-4" : "translate-x-0.5",
            ].join(" ")} />
          </button>
        </div>
        {/* NSFW toggle */}
        <div className="col-span-2 flex items-center justify-between">
          <div>
            <p className={["text-[9px] uppercase tracking-wider font-semibold", nativeSdNsfw ? "text-red-400" : "text-white/30"].join(" ")}>NSFW</p>
            <p className="text-[9px] text-white/20">explicit, nude content</p>
          </div>
          <button
            onClick={() => setNativeSdNsfw(!nativeSdNsfw)}
            className={[
              "relative w-8 h-4 rounded-full transition-colors",
              nativeSdNsfw ? "bg-red-500/70" : "bg-white/10",
            ].join(" ")}
          >
            <span className={[
              "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform",
              nativeSdNsfw ? "translate-x-4" : "translate-x-0.5",
            ].join(" ")} />
          </button>
        </div>
        {/* VAE tiling toggle */}
        <div className="col-span-2 flex items-center justify-between">
          <div>
            <p className="text-[9px] text-white/30 uppercase tracking-wider">VAE tiling</p>
            <p className="text-[9px] text-white/20">--vae-tiling · reduces VRAM for decode</p>
          </div>
          <button
            onClick={() => setNativeSdVaeTiling(!nativeSdVaeTiling)}
            className={[
              "relative w-8 h-4 rounded-full transition-colors",
              nativeSdVaeTiling ? "bg-emerald-500/60" : "bg-white/10",
            ].join(" ")}
          >
            <span className={[
              "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform",
              nativeSdVaeTiling ? "translate-x-4" : "translate-x-0.5",
            ].join(" ")} />
          </button>
        </div>
        {/* VAE on CPU toggle */}
        <div className="col-span-2 flex items-center justify-between">
          <div>
            <p className={["text-[9px] uppercase tracking-wider font-semibold", nativeSdVaeOnCpu ? "text-amber-400" : "text-white/30"].join(" ")}>VAE on CPU</p>
            <p className="text-[9px] text-white/20">--vae-on-cpu · prevents VRAM OOM on SDXL</p>
          </div>
          <button
            onClick={() => setNativeSdVaeOnCpu(!nativeSdVaeOnCpu)}
            className={[
              "relative w-8 h-4 rounded-full transition-colors",
              nativeSdVaeOnCpu ? "bg-amber-500/60" : "bg-white/10",
            ].join(" ")}
          >
            <span className={[
              "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform",
              nativeSdVaeOnCpu ? "translate-x-4" : "translate-x-0.5",
            ].join(" ")} />
          </button>
        </div>
        {/* Offload to CPU toggle */}
        <div className="col-span-2 flex items-center justify-between">
          <div>
            <p className={["text-[9px] uppercase tracking-wider font-semibold", nativeSdOffloadToCpu ? "text-amber-400" : "text-white/30"].join(" ")}>Offload to CPU</p>
            <p className="text-[9px] text-white/20">--offload-to-cpu · stores weights in RAM, prevents load OOM</p>
          </div>
          <button
            onClick={() => setNativeSdOffloadToCpu(!nativeSdOffloadToCpu)}
            className={[
              "relative w-8 h-4 rounded-full transition-colors",
              nativeSdOffloadToCpu ? "bg-amber-500/60" : "bg-white/10",
            ].join(" ")}
          >
            <span className={[
              "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform",
              nativeSdOffloadToCpu ? "translate-x-4" : "translate-x-0.5",
            ].join(" ")} />
          </button>
        </div>
        {/* Threads */}
        <div className="space-y-1 col-span-2">
          <p className="text-[9px] text-white/30 uppercase tracking-wider">CPU Threads (0 = auto)</p>
          <input
            type="number"
            value={nativeSdThreads}
            min={0} max={64}
            onChange={(e) => setNativeSdThreads(Math.max(0, parseInt(e.target.value) || 0))}
            className="w-full bg-white/[0.06] rounded-lg px-2 py-1.5 text-[11px]
              text-white/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
          />
        </div>
      </div>

      {/* ── Size presets ── */}
      <div className="space-y-1">
        <p className="text-[9px] text-white/30 uppercase tracking-wider">Size presets</p>
        <div className="flex flex-wrap gap-1">
          {/* Fast preset */}
          <button
            onClick={() => { setImageGenWidth(512); setImageGenHeight(512); setNativeSdSteps(12); setNativeSdSampler("euler_a"); }}
            className="px-2 py-0.5 rounded text-[9px] font-mono bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 transition-colors"
          >
            ⚡ Fast
          </button>
          {([
            [512,  512,  "512²"],
            [512,  768,  "512×768"],
            [768,  512,  "768×512"],
            [768,  768,  "768²"],
            [1024, 1024, "1024²"],
            [1024, 1280, "4:5"],
          ] as [number, number, string][]).map(([w, h, label]) => (
            <button
              key={label}
              onClick={() => { setImageGenWidth(w); setImageGenHeight(h); }}
              className={[
                "px-2 py-0.5 rounded text-[9px] font-mono transition-colors",
                imageGenWidth === w && imageGenHeight === h
                  ? "bg-emerald-500/40 text-emerald-200"
                  : "bg-white/[0.06] hover:bg-white/10 text-white/50 hover:text-white/80",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Negative prompt */}
      <div className="space-y-1.5">
        <p className="text-[9px] text-white/30 uppercase tracking-wider">Negative prompt</p>
        <textarea
          value={nativeSdNegPrompt}
          onChange={(e) => setNativeSdNegPrompt(e.target.value)}
          placeholder="blurry, low quality, deformed, watermark…"
          rows={2}
          className="w-full bg-white/[0.06] rounded-lg px-2 py-1.5 text-[10px]
            text-white/80 placeholder-white/20 resize-none
            focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
        />
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2">
          <p className="text-[10px] text-red-300 break-all">{error}</p>
        </div>
      )}
    </div>
  );
}
