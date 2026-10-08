// Captures README screenshots from a running stack (CI uploads them as an artifact).
//   node e2e/screenshots.mjs [outDir]   with the app on :8080 and, optionally, Grafana on :3000
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const out = process.argv[2] ?? "screenshots";
const app = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const grafana = process.env.GRAFANA_BASE_URL ?? "http://localhost:3000";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch(
  process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
);

async function shot(url, file, { width = 1440, height = 1000, dark = false, wait = 3000, full = true } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: dark ? "dark" : "light" });
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(wait);
    await page.screenshot({ path: `${out}/${file}`, fullPage: full });
    console.log(`saved ${file}`);
  } catch (err) {
    console.warn(`skipped ${file}: ${err.message}`);
  } finally {
    await page.close();
  }
}

await shot(`${app}/`, "dashboard.png");
await shot(`${app}/?outcomes=missed&view=day`, "dashboard-mobile-dark.png", {
  width: 390,
  height: 844,
  dark: true,
});

const grafanaUp = await fetch(`${grafana}/api/health`)
  .then((r) => r.ok)
  .catch(() => false);
if (grafanaUp) {
  for (const uid of ["svc-health", "ai-insights", "data-correctness", "business"]) {
    const range = uid === "business" ? "now-7d" : "now-15m";
    await shot(`${grafana}/d/${uid}?kiosk&from=${range}&to=now`, `grafana-${uid}.png`, {
      height: 900,
      wait: 6000,
      full: false,
    });
  }
}
await browser.close();
