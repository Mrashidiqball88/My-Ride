import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { mockupPreviewPlugin } from "./mockupPreviewPlugin";

export default defineConfig({
  base: "/__mockup/",
  plugins: [react(), mockupPreviewPlugin()],
  server: {
    host: "0.0.0.0",
    port: 8081,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
