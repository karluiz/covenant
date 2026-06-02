import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  site: "https://www.covenant.uno",
  integrations: [tailwind({ applyBaseStyles: false })],
  build: { inlineStylesheets: "auto" },
  compressHTML: true,
});
