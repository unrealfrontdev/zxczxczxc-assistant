import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAssistantStore } from "../store/assistantStore";

/**
 * Wires up all Tauri backend event listeners for the lifetime of the app.
 * Call once at the top-level App component.
 */
export function useTauriEvents() {
  const { setClickThrough, setGhostMode, triggerCapture } = useAssistantStore();

  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    // Rust emits these events immediately (before the slow GTK call)
    listen<boolean>("click-through-changed", (e) => {
      setClickThrough(e.payload);
    }).then((fn) => unlisteners.push(fn));

    listen<boolean>("ghost-mode-changed", (e) => {
      setGhostMode(e.payload);
    }).then((fn) => unlisteners.push(fn));

    listen("trigger-screenshot", () => {
      triggerCapture();
    }).then((fn) => unlisteners.push(fn));

    return () => unlisteners.forEach((fn) => fn());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
