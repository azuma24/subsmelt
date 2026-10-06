import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  root: ".",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist/client",
    // jschardet's detection model is a 1.1 MB chunk that only a non-UTF-8
    // subtitle ever loads; the default 500 kB warning would fire on it alone.
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      output: {
        // The framework changes once per release and the app code on every
        // one; splitting them keeps the framework chunk cached across
        // releases. Locale bundles and the converter's libraries already split
        // through dynamic import.
        advancedChunks: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/ },
            { name: "vendor", test: /node_modules[\\/](@tanstack|i18next|react-i18next|i18next-browser-languagedetector)[\\/]/ },
          ],
        },
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
