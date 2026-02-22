import { useAssistantStore } from "../store/assistantStore";

export default function ScreenshotPreview() {
  const { capturedImage, clearCapture } = useAssistantStore();
  if (!capturedImage) return null;

  return (
    <div className="relative group rounded-xl overflow-hidden
      border border-white/10 mb-2 shadow-lg">
      <img
        src={`data:image/png;base64,${capturedImage}`}
        alt="Captured screenshot"
        className="w-full object-cover max-h-44"
      />

      {/* Dismiss button — fades in on hover */}
      <button
        onClick={clearCapture}
        className="absolute top-1.5 right-1.5 bg-black/60 hover:bg-red-600
          rounded-full w-5 h-5 flex items-center justify-center text-[10px]
          opacity-0 group-hover:opacity-100 transition-opacity shadow"
      >
        ✕
      </button>

      {/* Label */}
      <div className="absolute bottom-1.5 left-1.5 bg-black/60 text-[9px]
        text-white/60 px-1.5 py-0.5 rounded font-mono">
        screenshot
      </div>
    </div>
  );
}
