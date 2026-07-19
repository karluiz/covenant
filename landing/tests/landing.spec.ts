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
  ]) {
    await expect(page.getByText(text).first()).toBeVisible();
  }

  // Score funnel scrolls into view and animates SPC from "0" to "12"
  await page.locator("[data-score-funnel]").scrollIntoViewIfNeeded();
  await expect(page.locator('[data-stage="spc"]')).toHaveText("12", { timeout: 4_000 });
  await expect(page.locator('[data-stage="pr"]')).toHaveText("27");
});
