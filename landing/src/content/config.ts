// Astro 4 reads this path. `src/content.config.ts` is the Astro 5 location
// and is ignored here without an error — the collection would just be empty.
import { defineCollection, z } from "astro:content";

const blog = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.date(),
    /// Drafts render in `astro dev` and are excluded from production
    /// builds — see landing/src/pages/blog/[slug].astro.
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
