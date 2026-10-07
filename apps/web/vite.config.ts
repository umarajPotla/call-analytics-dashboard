/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs on :8080; proxying keeps the browser on one origin, exactly like production,
// where the API serves the built SPA itself.
export default defineConfig({
  plugins: [react()],
  test: { include: ["src/**/*.test.ts"] },
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.API_URL ?? "http://localhost:8080", changeOrigin: true } },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // Charts are the heaviest dependency and change least often: separate chunks cache well across deploys.
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            {
              name: "charts",
              test: /node_modules[\\/](recharts|d3-|victory-vendor|es-toolkit|immer|@reduxjs|reselect|redux)/,
            },
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler|@tanstack)[\\/]/ },
          ],
        },
      },
    },
  },
});
