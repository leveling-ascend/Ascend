import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves a project repo at https://<user>.github.io/<repo-name>/,
// so every asset URL needs that "/<repo-name>/" prefix baked in at build time.
// Replace REPO_NAME below with your actual GitHub repo name.
// If you're instead deploying to a custom domain, or to a repo literally named
// "<your-username>.github.io", leave this as "/".
export default defineConfig({
  plugins: [react()],
  base: "/Ascend/",
});
