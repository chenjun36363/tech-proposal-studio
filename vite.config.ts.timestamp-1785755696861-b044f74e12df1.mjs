// vite.config.ts
import { defineConfig } from "file:///E:/opencode/tech-proposal-studio/node_modules/.pnpm/vite@6.4.3_@types+node@25.9.5_jiti@2.7.0_lightningcss@1.32.0/node_modules/vite/dist/node/index.js";
import react from "file:///E:/opencode/tech-proposal-studio/node_modules/.pnpm/@vitejs+plugin-react@4.7.0__a1830ef489b87f77c1060bd56f50d54e/node_modules/@vitejs/plugin-react/dist/index.js";
var vite_config_default = defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Workspace runtime data changes frequently and must not reload the app in dev.
      ignored: ["**/.gouan/**"]
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJFOlxcXFxvcGVuY29kZVxcXFx0ZWNoLXByb3Bvc2FsLXN0dWRpb1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiRTpcXFxcb3BlbmNvZGVcXFxcdGVjaC1wcm9wb3NhbC1zdHVkaW9cXFxcdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL0U6L29wZW5jb2RlL3RlY2gtcHJvcG9zYWwtc3R1ZGlvL3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSBcInZpdGVcIjtcbmltcG9ydCByZWFjdCBmcm9tIFwiQHZpdGVqcy9wbHVnaW4tcmVhY3RcIjtcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgcGx1Z2luczogW3JlYWN0KCldLFxuICBjbGVhclNjcmVlbjogZmFsc2UsXG4gIHNlcnZlcjoge1xuICAgIHBvcnQ6IDE0MjAsXG4gICAgc3RyaWN0UG9ydDogdHJ1ZSxcbiAgICB3YXRjaDoge1xuICAgICAgLy8gV29ya3NwYWNlIHJ1bnRpbWUgZGF0YSBjaGFuZ2VzIGZyZXF1ZW50bHkgYW5kIG11c3Qgbm90IHJlbG9hZCB0aGUgYXBwIGluIGRldi5cbiAgICAgIGlnbm9yZWQ6IFtcIioqLy5nb3Vhbi8qKlwiXSxcbiAgICB9LFxuICB9LFxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQXdSLFNBQVMsb0JBQW9CO0FBQ3JULE9BQU8sV0FBVztBQUVsQixJQUFPLHNCQUFRLGFBQWE7QUFBQSxFQUMxQixTQUFTLENBQUMsTUFBTSxDQUFDO0FBQUEsRUFDakIsYUFBYTtBQUFBLEVBQ2IsUUFBUTtBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sWUFBWTtBQUFBLElBQ1osT0FBTztBQUFBO0FBQUEsTUFFTCxTQUFTLENBQUMsY0FBYztBQUFBLElBQzFCO0FBQUEsRUFDRjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
