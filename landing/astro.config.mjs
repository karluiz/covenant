import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://www.covenant.uno",
  // ponytail: filter excludes the remote dashboard, not a content page
  integrations: [tailwind({ applyBaseStyles: false }), mdx(), sitemap({ filter: (p) => !p.includes("/remote") })],
  build: { inlineStylesheets: "auto" },
  compressHTML: true,
});
