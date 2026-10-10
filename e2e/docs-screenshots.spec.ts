import { test } from "@playwright/test";

// Generates README screenshots: `npm run docs:screenshots`
// Captured at 2× pixel density on a 1280px-wide window so text stays sharp on GitHub.
test.skip(!process.env.DOCS_SCREENSHOTS, "set DOCS_SCREENSHOTS=1 to regenerate docs images");
test.use({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });

interface Shot {
  name: string;
  hash: string;
  state: Record<string, unknown>;
  /** CSS selector to crop to (a card), or undefined for the viewport. */
  clip?: string;
  scrollTo?: string;
}

const shots: Shot[] = [
  { name: "playground", hash: "#/overview", state: { demoId: "desktop-16g", webHardware: "demo", theme: "light" }, clip: ".playground" },
  { name: "overview", hash: "#/run", state: { demoId: "desktop-16g", webHardware: "demo", theme: "light" } },
  { name: "dark", hash: "#/run", state: { demoId: "desktop-16g", webHardware: "demo", theme: "dark" } },
  { name: "what-can-i-run", hash: "#/run", state: { demoId: "desktop-16g", webHardware: "demo", theme: "light" }, clip: "section[aria-labelledby='run-title']" },
  { name: "explorer", hash: "#/explore", state: { demoId: "desktop-16g", webHardware: "demo", theme: "light" } },
  { name: "detail-verdict", hash: "#/model/gemma4%3A26b", state: { demoId: "desktop-16g", webHardware: "demo", theme: "light" }, clip: ".verdict" },
  { name: "detail-moe", hash: "#/model/gemma4%3A26b", state: { demoId: "desktop-16g", webHardware: "demo", theme: "light" }, clip: "section[aria-labelledby='viz-title']" },
  { name: "detail-unified", hash: "#/model/qwen3%3A30b", state: { demoId: "mac-m3pro-36", webHardware: "demo", theme: "light" }, clip: "section[aria-labelledby='viz-title']" },
  { name: "capabilities", hash: "#/model/gemma3%3A12b", state: { demoId: "desktop-16g", webHardware: "demo", theme: "light" }, clip: "section[aria-labelledby='caps-title']" },
  { name: "compare", hash: "#/compare", state: { demoId: "mac-m3pro-36", webHardware: "demo", theme: "light", compare: ["gemma4:26b", "qwen3:30b", "gemma3:27b", "llama3.1:8b"] }, clip: "section[aria-labelledby='pressure-title']" },
  ];

for (const s of shots) {
  test(`docs: ${s.name}`, async ({ page }) => {
    await page.addInitScript((st) => localStorage.setItem("model-fit-explorer", JSON.stringify({ state: { motion: "reduce", ...st }, version: 2 })), s.state);
    await page.route("**/__proxy/ollama-local/**", (r) => r.abort());
    await page.goto("/" + s.hash);
    await page.addStyleTag({ content: ".machine-bar{position:static!important}" });
    await page.waitForTimeout(1500);
    if (s.clip) {
      const el = page.locator(s.clip).first();
      await el.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await el.screenshot({ path: `docs/screenshots/${s.name}.png` });
    } else {
      await page.screenshot({ path: `docs/screenshots/${s.name}.png` });
    }
  });
}
