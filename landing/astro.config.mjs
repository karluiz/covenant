import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  site: "https://covenant.uno",
  integrations: [tailwind({ applyBaseStyles: false })],
  build: { inlineStylesheets: "auto" },
  compressHTML: true,
});
