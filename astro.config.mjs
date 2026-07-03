import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://vdiga.bg",
  base: process.env.GITHUB_PAGES === "true" ? "/vdiga-site" : "/",
  output: "static",
});
