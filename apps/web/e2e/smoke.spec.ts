import { expect, test } from "@playwright/test";

test("dashboard loads, streams live calls, and keeps filters in the URL", async ({ page }) => {
  await page.goto("/");

  // KPI tiles render real numbers.
  const total = page.getByRole("region", { name: "Total calls" });
  await expect(total.locator(".value")).toHaveText(/\d/);

  // The live feed connects over SSE and shows calls.
  const feed = page.getByRole("region", { name: "Live calls" });
  await expect(feed.getByRole("status")).toHaveText("Live", { timeout: 15_000 });
  await expect(feed.locator("tbody tr").first()).toBeVisible();

  // Demo control: a traffic spike makes new calls arrive within seconds.
  const firstCall = await feed.locator("tbody tr").first().textContent();
  await page.getByRole("button", { name: /spike/i }).click();
  await expect(page.getByText(/Traffic spike started/)).toBeVisible();
  await expect
    .poll(async () => feed.locator("tbody tr").first().textContent(), { timeout: 30_000 })
    .not.toBe(firstCall);

  // Filters are reflected in the URL and applied to the feed.
  await page.getByRole("button", { name: "Missed" }).click();
  await expect(page).toHaveURL(/outcomes=missed/);
  await expect(feed.locator("tbody tr").first()).toContainText("Missed");

  // The insights panel answers, with sources.
  const insights = page.getByRole("region", { name: "What changed" });
  await expect(insights.locator("article").first()).toBeVisible();

  // Reloading the URL restores the same view.
  await page.reload();
  await expect(page.getByRole("button", { name: "Missed" })).toHaveAttribute("aria-pressed", "true");
});

test("API docs are served", async ({ page }) => {
  await page.goto("/api/docs");
  await expect(page.getByText("Call Analytics API").first()).toBeVisible();
});
