import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/tauri";
import { useAssistantStore } from "../store/assistantStore";

/**
 * Wires up all Tauri backend event listeners for the lifetime of the app.
 * Call once at the top-level App component.
 */
export function useTauriEvents() {
  const { setClickThrough, setGhostMode, triggerCapture, windowMode } = useAssistantStore();

  // ── Restore last-used window mode on startup ────────────────────────────
  useEffect(() => {
    invoke("set_window_mode", {
      windowed: windowMode === "windowed",
      onTop: windowMode === "windowed" ? false : true,
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run once on mount with the persisted value

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
