import { useTauriEvents } from "./hooks/useTauriEvents";
import AssistantPanel from "./components/AssistantPanel";
import { useAssistantStore } from "./store/assistantStore";

export default function App() {
  useTauriEvents();

  const isClickThrough = useAssistantStore((s) => s.isClickThrough);

  return (
    <div
      className={[
        "h-screen w-screen overflow-hidden transition-opacity duration-200",
        isClickThrough ? "pointer-events-none opacity-30" : "pointer-events-auto opacity-100",
      ].join(" ")}
    >
      {/* Passthrough indicator */}
      {isClickThrough && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50
          bg-yellow-400/90 text-black text-[10px] font-bold px-3 py-0.5
          rounded-full shadow-lg select-none pointer-events-none">
          PASSTHROUGH MODE — press Alt+Space to interact
        </div>
      )}

      <AssistantPanel />
    </div>
  );
}
