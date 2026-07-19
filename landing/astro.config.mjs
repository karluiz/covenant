import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import mdx from "@astrojs/mdx";

export default defineConfig({
  site: "https://www.covenant.uno",
  integrations: [tailwind({ applyBaseStyles: false }), mdx()],
  build: { inlineStylesheets: "auto" },
  compressHTML: true,
});
