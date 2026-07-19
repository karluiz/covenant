// Copies the desktop app's Special Theme wallpapers into landing/public/themes/
// so ThemeGallery.astro can reference them as plain static URLs.
//
// Why this exists: `ui/src/theme/special.ts`'s `art` field is a Vite-resolved
// URL string when imported by plain Vite (the app, and this file's own
// vitest run) — but Astro's build pipeline auto-transforms imports of
// recognized image extensions (.webp included) into an `ImageMetadata`
// object instead of a string. Under `astro build`, `t.art` is therefore an
// object, not a URL, and the emitted <img src> becomes the literal string
// "[object Object]". The numbers (ground, accent, scrim, id, name) still
// come from the live registry via the import in ThemeGallery.astro — only
// the artwork is duplicated here, and by this script rather than by hand.
//
// Run automatically via the `prebuild` npm script before every `astro build`.
import { readdir, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "ui", "assets", "themes");
const destDir = join(here, "..", "public", "themes");

// Clear the destination first so a theme removed from the registry doesn't
// leave a stale .webp behind on a developer machine that already ran this.
await rm(destDir, { recursive: true, force: true });
await mkdir(destDir, { recursive: true });

const files = (await readdir(srcDir)).filter((f) => f.endsWith(".webp"));
if (files.length === 0) {
  throw new Error(`copy-theme-art: no .webp files found under ${srcDir}`);
}

await Promise.all(
  files.map((f) => copyFile(join(srcDir, f), join(destDir, f)))
);

console.log(`copy-theme-art: copied ${files.length} .webp file(s) to ${destDir}`);
