import { expect, test, type Page } from "@playwright/test";

// The browser preview runs on labelled demo hardware. Seed a deterministic machine.
async function boot(page: Page, state: Record<string, unknown> = {}, hash = "#/run") {
  await page.addInitScript((s) => {
    localStorage.setItem("model-fit-explorer", JSON.stringify({ state: { demoId: "desktop-16g", webHardware: "demo", theme: "dark", ...s }, version: 2 }));
  }, state);
  // Ollama is not part of these tests: make the local API unreachable quickly.
  await page.route("**/__proxy/ollama-local/**", (r) => r.abort());
  await page.goto("/" + hash);
  await expect(page.getByText("Sample machine").first()).toBeVisible();
}

test("overview shows the machine, memory and recommendations", async ({ page }) => {
  await boot(page);
  await expect(page.getByRole("heading", { name: "What can this computer run?" })).toBeVisible();
  await expect(page.getByText("NVIDIA GeForce RTX 4070 Ti SUPER").first()).toBeVisible();
  await expect(page.getByText(/Windows 'shared GPU memory' is system RAM/)).toBeVisible();
  await expect(page.getByText("Runs well · best picks")).toBeVisible();
  await expect(page).toHaveScreenshot("overview.png", { fullPage: false, mask: [page.locator(".hero .muted")] });
});

test("input picker: text is always on; adding images narrows to vision models", async ({ page }) => {
  await boot(page);
  const text = page.getByRole("button", { name: /^Text/ }).first();
  await expect(text).toHaveAttribute("aria-disabled", "true");
  const summary = page.locator("#run-title + p");
  const count = async () => Number((await summary.innerText()).match(/(\d+) chat models/)![1]);
  await expect.poll(count).toBeGreaterThan(100);
  const before = await count();
  await page.getByRole("button", { name: "Images" }).first().click();
  await expect(summary).not.toHaveText(new RegExp(`^.*${before} chat models`));
  const after = Number((await summary.innerText()).match(/(\d+) chat models/)![1]);
  expect(after).toBeLessThan(before);
  await page.getByRole("switch").first().check();
  const verified = Number((await summary.innerText()).match(/(\d+) chat models/)![1]);
  expect(verified).toBeLessThanOrEqual(after);
});

test("explorer search, filter and keyboard navigation to a model", async ({ page }) => {
  await boot(page, {}, "#/explore");
  await page.getByLabel("Search models").fill("gpt-oss 20b");
  const card = page.locator(".mcard", { hasText: "gpt-oss:20b" }).first();
  await expect(card).toBeVisible();
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/model\/gpt-oss%3A20b/);
  await expect(page.getByRole("heading", { level: 1, name: "gpt-oss:20b" })).toBeVisible();
});

test("detail: quantization and context changes update the estimate", async ({ page }) => {
  await boot(page, {}, "#/model/llama3.1%3A8b");
  const total = page.locator(".verdict").getByText(/GiB/).first();
  const q4 = await total.innerText();
  await page.getByRole("group", { name: "Quantization" }).getByRole("button", { name: "Q8" }).click();
  await expect(page.getByText(/hypothetical size, not a download that exists|Hypothetical/).first()).toBeVisible();
  await expect.poll(async () => total.innerText()).not.toBe(q4);
  await page.getByRole("group", { name: "Context length" }).getByRole("button", { name: "128K" }).click();
  await page.getByText("Why this result?").click();
  await expect(page.locator(".eq-table")).toContainText("131,072 ctx");
});

test("detail: image input on a text-only model warns and suggests OCR", async ({ page }) => {
  await boot(page, {}, "#/model/llama3.1%3A8b");
  await page.getByRole("group", { name: "Input type" }).getByRole("button", { name: "Text + images" }).click();
  await expect(page.getByText(/cannot read images.*OCR|not confirmed for this model/)).toBeVisible();
});

test("MoE explainer distinguishes total, active, placement and execution", async ({ page }) => {
  await boot(page, {}, "#/model/qwen3%3A30b");
  await expect(page.getByText("Active per token", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: /Why MoE is special/ }).click();
  const dlg = page.getByRole("dialog");
  for (const t of ["Total weights", "Active weights", "Weight placement", "Execution location"]) await expect(dlg.getByText(t)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
});

test("detail screenshot (memory visualization)", async ({ page }) => {
  await boot(page, {}, "#/model/gemma4%3A26b");
  await expect(page.locator(".memviz")).toBeVisible();
  await expect(page.locator(".memviz")).toHaveScreenshot("memviz-gemma4-26b.png");
});

test("Apple Silicon demo uses one unified pool", async ({ page }) => {
  await boot(page, { demoId: "mac-m3pro-36" }, "#/model/gemma3%3A27b");
  await expect(page.locator(".lane-label", { hasText: "Unified memory" })).toBeVisible();
  await expect(page.locator(".lane-label", { hasText: "GPU memory (VRAM)" })).toHaveCount(0);
});

test("compare holds up to four models", async ({ page }) => {
  await boot(page, { compare: ["gemma4:26b", "qwen3:30b", "gemma3:27b", "llama3.1:8b"] }, "#/explore");
  await page.getByLabel("Search models").fill("gpt-oss 20b");
  await page.locator(".mcard", { hasText: "gpt-oss:20b" }).first().getByRole("button", { name: /Compare/ }).click();
  await expect(page.getByRole("status")).toContainText("up to 4");
  await page.getByRole("button", { name: /^Compare/ }).first().click();
  await expect(page.getByRole("heading", { name: "4 models side by side" })).toBeVisible();
  await page.getByRole("button", { name: "Remove gemma3:27b from compare" }).click();
  await expect(page.getByRole("heading", { name: "3 models side by side" })).toBeVisible();
});

test("try a specific model: offline manual entry shows compatibility and requires confirmation", async ({ page }) => {
  await boot(page, {}, "#/run");
  await page.route("https://huggingface.co/**", (r) => r.abort());
  await page.route("**/__proxy/ollama-com/**", (r) => r.abort());
  await page.getByRole("button", { name: "Try a specific model" }).click();
  await page.getByLabel("Model to look up").fill("Mystery 14B A2B");
  await page.getByRole("button", { name: "Search online" }).click();
  await expect(page.getByText("Can't reach the online sources.")).toBeVisible();
  await page.getByRole("button", { name: "Enter manually" }).first().click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByRole("heading", { name: "Is it a good fit?" })).toBeVisible();
  await expect(dlg.locator(".compat .pill")).toBeVisible(); // live compatibility verdict
  const save = dlg.getByRole("button", { name: "Save to my catalog" });
  await expect(save).toBeDisabled();
  await dlg.getByRole("checkbox").check();
  await save.click();
  await expect(page.getByRole("heading", { level: 1, name: "Mystery 14B A2B" })).toBeVisible();
  await expect(page.getByText("Never verified")).toBeVisible();
});

test("settings: overrides are labelled and the seed import report is visible", async ({ page }) => {
  await boot(page, {}, "#/settings");
  await expect(page.getByText(/233 rows → 233 variants from 87 families/)).toBeVisible();
  await page.getByLabel(/VRAM free now/).fill("4");
  await expect(page.getByText("Manually entered").first()).toBeVisible();
  await page.getByRole("button", { name: "Reset overrides" }).click();
});

test("reduced motion is respected", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  await boot(page);
  await expect(page.locator("html")).toHaveClass(/reduce-motion/);
  await ctx.close();
});

test("keyboard: skip link and sidebar navigation", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.getByRole("button", { name: "Settings & Diagnostics" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Hardware, data and privacy" })).toBeVisible();
});

test("browser mode: confirm your machine, then estimates use it", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("model-fit-explorer", JSON.stringify({ state: { theme: "light" }, version: 2 })));
  await page.route("**/__proxy/ollama-local/**", (r) => r.abort());
  await page.goto("/#/run");
  await expect(page.getByRole("heading", { name: "Confirm your machine" })).toBeVisible();
  await page.locator(".setup-card").getByLabel("No separate graphics card / not sure").uncheck();
  await page.locator(".setup-card").getByPlaceholder("e.g. GeForce RTX 4070").fill("GeForce RTX 4070 Ti SUPER");
  await expect(page.getByText("Known spec: 16 GB of graphics memory.")).toBeVisible();
  await page.getByRole("group", { name: "Memory size" }).getByRole("button", { name: "32 GB" }).click();
  await page.getByRole("button", { name: "Use these values" }).click();
  await expect(page.getByRole("heading", { name: "Confirm your machine" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Browser estimate · edit" }).first()).toBeVisible();
  await expect(page.locator(".machine-bar")).toContainText("16.0 GiB");
});

test("theme can be chosen: light, dark or system", async ({ page }) => {
  await boot(page);
  const group = page.getByRole("radiogroup", { name: "Theme" }).first();
  await group.getByRole("radio", { name: "Light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await group.getByRole("radio", { name: "Dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("capability icons show a label on hover", async ({ page }) => {
  await boot(page, {}, "#/explore");
  const tools = page.locator(".mcard .cap", { hasText: "Tools" }).first();
  await expect(tools).toHaveAttribute("data-tip", /Tool calling/);
});

test("playground: presets resize the model and the verdict updates", async ({ page }) => {
  await boot(page, {}, "#/overview");
  await expect(page.getByRole("heading", { name: "Build a model. See where it fits." })).toBeVisible();
  const before = await page.locator(".isoviz .vox").count();
  await page.getByRole("button", { name: "Huge 70B" }).click();
  await expect.poll(async () => page.locator(".isoviz .vox").count()).toBeGreaterThan(before);
  await page.getByRole("button", { name: "MoE 30B · 3B active" }).click();
  await expect(page.locator(".control-label", { hasText: "Active per word" })).toBeVisible();
  await expect(page.locator(".vox.lit").first()).toBeVisible();
});
