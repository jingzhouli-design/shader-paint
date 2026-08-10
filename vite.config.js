import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    watch: {
      // Texture changes are delivered to the desktop renderer through Electron IPC.
      // Watching them here would reload the document and interrupt an active stroke.
      ignored: ["**/release/**", "**/Texture/**"],
    },
  },
});
