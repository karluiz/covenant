import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  site: "https://covenant.dev",
  integrations: [tailwind({ applyBaseStyles: false })],
  build: { inlineStylesheets: "auto" },
  compressHTML: true,
});
