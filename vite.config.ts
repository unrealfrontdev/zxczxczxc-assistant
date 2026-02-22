import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  // Vite development server — Tauri expects port 5173
  server: {
    port: 5173,
    strictPort: true,
  },
  // Prevent vite from hiding Rust errors
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // Tauri uses Chromium, not a browser target
    target:     process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify:     !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap:  !!process.env.TAURI_DEBUG,
  },
});
