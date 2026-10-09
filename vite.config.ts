import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { chordsApiPlugin } from "./server/chords.ts";
import { lyricsApiPlugin } from "./server/lyrics.ts";
import { youtubeApiPlugin } from "./server/youtube.ts";

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react(), youtubeApiPlugin(), lyricsApiPlugin(), chordsApiPlugin()],
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
});
