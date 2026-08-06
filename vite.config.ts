import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    // Avoid Windows localhost resolving to the unavailable IPv6 loopback (::1).
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      // Workspace runtime data changes frequently and must not reload the app in dev.
      ignored: ["**/.gouan/**"],
    },
  },
});