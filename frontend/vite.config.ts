import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // In local dev, forward /api/* to the local FastAPI server so the
    // frontend can use the same relative URLs as in production on Vercel.
    // Start it with:  uvicorn api.index:app --reload --port 8000
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
});
