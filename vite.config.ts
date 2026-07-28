import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Workspace runtime data changes frequently and must not reload the app in dev.
      ignored: ["**/.gouan/**"],
    },
  },
});
