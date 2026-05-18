# Covenant landing

Static site for covenant.dev. Built with Astro + Tailwind.

## Develop

    pnpm install
    pnpm --filter @covenant/landing dev      # http://localhost:4321

## Build

    pnpm --filter @covenant/landing build    # → landing/dist/

## Test

    pnpm --filter @covenant/landing test     # Playwright smoke

## Deploy

Static output in `landing/dist/`. Target: Cloudflare Pages.
