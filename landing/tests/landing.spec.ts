import { test, expect } from "@playwright/test";

test("renders all sections and animates the score funnel", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("h1")).toContainText("AI orchestrator");

  for (const text of [
    "Parallel operators, one surface",
    "Hard blocklist",
    "Covenant Score",
    "brew install --cask karluiz/covenant/covenant",
    "Read the covenant",
    "Covenant ends the argument",
  ]) {
    await expect(page.getByText(text).first()).toBeVisible();
  }

  // Score funnel scrolls into view and animates SPC from "0" to "12"
  await page.locator("[data-score-funnel]").scrollIntoViewIfNeeded();
  await expect(page.locator('[data-stage="spc"]')).toHaveText("12", { timeout: 4_000 });
  await expect(page.locator('[data-stage="pr"]')).toHaveText("27");
});

test("renders the customization section", async ({ page }) => {
  await page.goto("/");
  await page.locator("#customization").scrollIntoViewIfNeeded();
  await expect(page.getByText("A terminal you stare at all day")).toBeVisible();
  // The gallery renders one figure per theme, straight from the app registry.
  await expect(page.locator("#customization figure")).toHaveCount(7);
});

test("serves the blog index", async ({ page }) => {
  const res = await page.goto("/blog");
  expect(res?.status()).toBe(200);
  await expect(page.locator("h1")).toContainText("Notes on building Covenant");
});

test("renders the worktrees before/after with real numbers", async ({ page }) => {
  await page.goto("/");
  const section = page.locator("#worktrees");
  await expect(section).toBeVisible();
  // The comparison is the section's whole argument — assert both halves, so a
  // refactor that drops one side fails here instead of shipping half a claim.
  await expect(section.getByText("26 worktrees · 5 conventions · 65 GB")).toBeVisible();
  await expect(
    section.getByText("10 worktrees · 1 convention · 44.4 GB reclaimed"),
  ).toBeVisible();
  await expect(section.getByText("<repo>/.covenant/worktrees/<agent>")).toBeVisible();
});

test("renders the Gravity section with its screenshots and download", async ({ page }) => {
  await page.goto("/");
  const section = page.locator("#gravity");
  await expect(section).toBeVisible();
  await expect(
    section.getByText("Control in the center, execution at the periphery."),
  ).toBeVisible();

  // The three pillars carry the whole argument — drop one and the section
  // stops explaining why agents in a repo beat agents in an app's database.
  for (const title of [
    "Your agents live in the repo",
    "They read each other's work",
    "Any CLI you already run",
  ]) {
    await expect(section.getByText(title)).toBeVisible();
  }

  // Screenshots are swapped by overwriting the PNGs, so assert they resolve:
  // a rename that misses this component would ship three broken images.
  const shots = section.locator("img");
  await expect(shots).toHaveCount(3);
  for (const src of ["plane.png", "contexts.png", "providers.png"]) {
    const res = await page.request.get(`/images/gravity/${src}`);
    expect(res.status()).toBe(200);
  }

  // Asset URLs carry the version, so a release bump that forgets this section
  // leaves dead download buttons. Assert the real installer, not a landing page.
  await expect(section.getByRole("link", { name: /macOS/ })).toHaveAttribute(
    "href",
    /releases\/download\/v\d+\.\d+\.\d+\/Covenant-Gravity-.*\.dmg$/,
  );
  await expect(section.getByRole("link", { name: /Windows/ })).toHaveAttribute(
    "href",
    /Covenant-Gravity-.*-setup-x64\.exe$/,
  );
  await expect(section.getByRole("link", { name: /Linux/ })).toHaveAttribute(
    "href",
    /Covenant-Gravity-.*\.AppImage$/,
  );
});
