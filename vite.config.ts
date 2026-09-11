import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Ports 3900/3901 belong to an unrelated app on this machine (OmniVoice Studio).
const WEB_PORT = 5310;
const SERVER_PORT = Number(process.env.CUTLINE_PORT ?? 5311);

/**
 * Writes the per-run server token into every page Vite serves.
 *
 * Dev only (`apply: "serve"`). At build time there is no token yet — the
 * server injects its own when it serves `dist/index.html` — and baking an empty
 * one into the build would leave two meta tags, with the empty one first.
 */
function cutlineToken(): Plugin {
  const token = process.env.CUTLINE_TOKEN ?? "";
  return {
    name: "cutline-token",
    apply: "serve",
    transformIndexHtml(html) {
      return html.replace("</head>", `  <meta name="cutline-token" content="${token}" />\n  </head>`);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cutlineToken()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    port: WEB_PORT,
    strictPort: true,
    // changeOrigin stays false so the server sees the browser's real Host and
    // Origin and can check them. Vite's own host check already refuses a
    // rebound hostname for the page itself, which is what protects the token.
    proxy: { "/api": { target: `http://127.0.0.1:${SERVER_PORT}`, changeOrigin: false } },
  },
});
