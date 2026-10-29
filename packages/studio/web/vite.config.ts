import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  // Relative asset paths: local serves the UI at /, hosted at /studio/.
  base: "./",
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL("../dist/web", import.meta.url)), emptyOutDir: true },
  server: { port: 5190, proxy: { "/api": "http://localhost:4320" } },
});
