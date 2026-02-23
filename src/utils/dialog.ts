/**
 * dialog.ts — helpers that wrap Tauri file/directory dialogs.
 *
 * Problem: the main window is always-on-top, transparent, and covers the full
 * screen. When a native OS file dialog opens, the overlay window sits on top
 * of it and intercepts all pointer events, making the dialog appear frozen.
 *
 * Fix: before opening any dialog we
 *   1. disable click-through (so the window doesn't swallow events silently)
 *   2. lower the window from always-on-top
 * After the dialog resolves (regardless of success/cancel/error) we restore
 * both properties.
 */

import { invoke }              from "@tauri-apps/api/tauri";
import { open as tauriOpen }   from "@tauri-apps/api/dialog";
import type { OpenDialogOptions, DialogFilter } from "@tauri-apps/api/dialog";

async function beforeDialog() {
  // set_dialog_open handles: lowers always-on-top, disables click-through,
  // and pauses the background cursor tracker so it can't re-enable it.
  await invoke("set_dialog_open", { open: true }).catch(() => {});
}

async function afterDialog() {
  await invoke("set_dialog_open", { open: false }).catch(() => {});
}

/** Open a file dialog safely (window steps aside before / after). */
export async function openFileSafe(
  opts: OpenDialogOptions & { filters?: DialogFilter[] }
): Promise<string | string[] | null> {
  await beforeDialog();
  try {
    return await tauriOpen(opts);
  } finally {
    await afterDialog();
  }
}

/** Open a directory dialog safely. */
export async function openDirSafe(title?: string): Promise<string | null> {
  await beforeDialog();
  try {
    const selected = await tauriOpen({
      title:     title ?? "Select folder",
      directory: true,
      multiple:  false,
    });
    return typeof selected === "string" ? selected : null;
  } finally {
    await afterDialog();
  }
}
