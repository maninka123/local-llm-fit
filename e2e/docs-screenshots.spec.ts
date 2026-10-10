import { test } from "@playwright/test";

// Generates README screenshots: `npx playwright test e2e/docs-screenshots.spec.ts`
test.skip(!process.env.DOCS_SCREENSHOTS, "set DOCS_SCREENSHOTS=1 to regenerate docs images");

const shots: [string, string, Record<string, unknown>, boolean][] = [
  ["overview", "#/overview", { demoId: "desktop-16g" }, false],
  ["explorer", "#/explore", { demoId: "desktop-16g" }, false],
  ["detail-moe", "#/model/gemma4%3A26b", { demoId: "desktop-16g" }, false],
  ["detail-unified", "#/model/qwen3%3A30b", { demoId: "mac-m3pro-36" }, false],
  ["compare", "#/compare", { demoId: "mac-m3pro-36", compare: ["gemma4:26b", "qwen3:30b", "gemma3:27b", "llama3.1:8b"] }, false],
  ["light", "#/overview", { demoId: "mac-m3pro-36", theme: "light" }, false],
];

for (const [name, hash, state, full] of shots) {
  test(`docs: ${name}`, async ({ page }) => {
    await page.addInitScript((s) => localStorage.setItem("model-fit-explorer", JSON.stringify({ state: s, version: 1 })), state);
    await page.route("**/__proxy/ollama-local/**", (r) => r.abort());
    await page.goto("/" + hash);
    await page.waitForTimeout(1500);
    if (name.startsWith("detail")) await page.evaluate(() => window.scrollTo(0, 120));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage: full });
  });
}
