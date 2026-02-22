import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAssistantStore } from "../store/assistantStore";

/**
 * Wires up all Tauri backend event listeners for the lifetime of the app.
 * Call once at the top-level App component.
 */
export function useTauriEvents() {
  const { setClickThrough, triggerCapture } = useAssistantStore();

  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    // Overlay mode changes emitted by Rust
    listen<boolean>("click-through-changed", (e) => {
      setClickThrough(e.payload);
    }).then((fn) => unlisteners.push(fn));

    // Alt+Shift+S hotkey → instant capture
    listen("trigger-screenshot", () => {
      triggerCapture();
    }).then((fn) => unlisteners.push(fn));

    return () => unlisteners.forEach((fn) => fn());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
