/**
 * ImageGallery — displays the history of AI-generated images.
 * Features:
 *   - Thumbnail grid (newest first)
 *   - Click → fullscreen lightbox
 *   - Download button
 *   - Copy prompt to clipboard
 *   - Delete individual image or clear all
 */

import { useState } from "react";
import { useAssistantStore } from "../store/assistantStore";
import type { GeneratedImage } from "../store/assistantStore";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function downloadImage(img: GeneratedImage) {
  const a = document.createElement("a");
  a.href = `data:image/${img.format};base64,${img.base64}`;
  a.download = `ai-image-${img.timestamp}.${img.format}`;
  a.click();
}

// ── Lightbox ──────────────────────────────────────────────────────────────
function Lightbox({ img, onClose }: { img: GeneratedImage; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-w-[90vw] max-h-[90vh] flex flex-col gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Image */}
        <img
          src={`data:image/${img.format};base64,${img.base64}`}
          alt={img.prompt}
          className="rounded-xl max-w-full max-h-[80vh] object-contain shadow-2xl"
        />

        {/* Controls */}
        <div className="flex items-start gap-2 px-1">
          <p className="flex-1 text-xs text-white/55 leading-relaxed line-clamp-3">
            {img.revisedPrompt ?? img.prompt}
          </p>
          <div className="flex gap-1 shrink-0">
            <button
              onClick={() => navigator.clipboard.writeText(img.revisedPrompt ?? img.prompt)}
              className="text-[10px] px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white/50 hover:text-white transition-colors"
              title="Copy prompt"
            >
              📋 Copy prompt
            </button>
            <button
              onClick={() => downloadImage(img)}
              className="text-[10px] px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white/50 hover:text-white transition-colors"
              title="Download"
            >
              ⬇ Download
            </button>
            <button
              onClick={onClose}
              className="text-[10px] px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white/50 hover:text-white transition-colors"
            >
              ✕ Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Thumbnail card ────────────────────────────────────────────────────────
function Thumb({
  img,
  onSelect,
  onDelete,
}: {
  img: GeneratedImage;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="relative group cursor-pointer rounded-xl overflow-hidden border border-white/[0.07]
      hover:border-white/20 transition-all bg-white/[0.03]"
      onClick={onSelect}
    >
      <img
        src={`data:image/${img.format};base64,${img.base64}`}
        alt={img.prompt.slice(0, 60)}
        className="w-full aspect-square object-cover"
        loading="lazy"
      />
      {/* Overlay on hover */}
      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100
        transition-opacity flex flex-col justify-between p-1.5">
        <div className="flex justify-end">
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="w-5 h-5 rounded-full bg-red-500/60 hover:bg-red-500 flex items-center justify-center
              text-white text-[10px] transition-colors"
            title="Delete"
          >✕</button>
        </div>
        <div>
          <p className="text-white text-[9px] leading-tight line-clamp-2">{img.prompt.slice(0, 80)}</p>
          <p className="text-white/40 text-[8px] mt-0.5">{formatTime(img.timestamp)}</p>
        </div>
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────
export default function ImageGallery({ className = "" }: { className?: string }) {
  const { imageGallery, removeGalleryImage, clearGallery, isGeneratingImage, generateImage } =
    useAssistantStore();
  const [lightbox, setLightbox] = useState<GeneratedImage | null>(null);

  return (
    <div className={`flex flex-col h-full overflow-hidden ${className}`}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.07] shrink-0">
        <span className="text-[11px] text-white/40 flex-1">
          {imageGallery.length > 0 ? `${imageGallery.length} image${imageGallery.length !== 1 ? "s" : ""}` : "No images yet"}
        </span>
        <button
          onClick={() => generateImage()}
          disabled={isGeneratingImage}
          className="text-[10px] px-2 py-0.5 rounded bg-purple-500/20 hover:bg-purple-500/40
            text-purple-300 disabled:opacity-40 transition-colors"
        >
          {isGeneratingImage ? "Generating…" : "🎨 Generate"}
        </button>
        {imageGallery.length > 0 && (
          <button
            onClick={() => { if (confirm("Clear all generated images?")) clearGallery(); }}
            className="text-[10px] px-2 py-0.5 rounded hover:bg-red-500/20 text-white/30 hover:text-red-400 transition-colors"
          >
            🗑 Clear all
          </button>
        )}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-2">
        {imageGallery.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
            <span className="text-4xl opacity-20">🖼</span>
            <p className="text-[11px] text-white/30">
              No images generated yet.<br/>
              Press <strong className="text-white/50">🎨 Generate</strong> to create an image based on the current chat.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {imageGallery.map((img) => (
              <Thumb
                key={img.timestamp}
                img={img}
                onSelect={() => setLightbox(img)}
                onDelete={() => removeGalleryImage(img.timestamp)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightbox && <Lightbox img={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
