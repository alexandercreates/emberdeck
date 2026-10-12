import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Development: run `emberdeck studio --port 4321 --no-open` in a project,
// then `pnpm dev:dashboard` and open http://localhost:5173/#token=<token from studio>.
const api = process.env.EMBERDECK_API ?? "http://127.0.0.1:4321";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    proxy: {
      "/api": {
        target: api,
        changeOrigin: true,
        configure: (proxy) => {
          // The studio rejects foreign origins; the dev proxy is trusted.
          proxy.on("proxyReq", (req) => req.removeHeader("origin"));
        },
      },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
