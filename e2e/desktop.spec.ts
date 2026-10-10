import { expect, test } from "@playwright/test";
import { DEMO_MACHINES } from "../src/platform/demoHardware";

// Simulates the desktop app: a fake Tauri bridge whose hardware probe returns a laptop.
const detected = { ...DEMO_MACHINES.find((d) => d.id === "laptop-8g")!.report, demo: false, probeVersion: "1.0.0", notes: [] };

test.beforeEach(async ({ page }) => {
  await page.addInitScript((report) => {
    localStorage.setItem("model-fit-explorer", JSON.stringify({ state: { theme: "light", autoUpdate: false }, version: 2 }));
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      metadata: {},
      transformCallback: () => 1,
      invoke: async (cmd: string) => {
        if (cmd === "probe_hardware") return report;
        if (cmd === "sample_memory") return { ramUsedBytes: null, vramUsedBytes: null };
        throw new Error(`${cmd} not available in tests`);
      },
    };
  }, detected);
});

test("desktop: edit detected values, try a sample machine, switch back", async ({ page }) => {
  await page.goto("/#/run");
  const bar = page.locator(".machine-bar");
  await expect(bar).toContainText("8.0 GiB"); // detected RTX 4060 Laptop (8 GB)
  await page.getByRole("button", { name: "My computer · edit" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByText("Detected on this computer")).toBeVisible();
  await dlg.getByRole("button", { name: "More Graphics memory (VRAM)" }).click();
  await expect(dlg.getByText("Changed")).toBeVisible();
  await dlg.getByRole("button", { name: "Use my computer" }).click();
  await expect(dlg).toBeHidden();
  await expect(bar).toContainText("9.0 GiB");

  await page.getByRole("button", { name: "My computer · edit" }).click();
  await page.getByRole("dialog").getByRole("radio", { name: /Sample machine/ }).click();
  await page.getByRole("dialog").getByRole("radio", { name: /Workstation/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Show this machine" }).click();
  await expect(bar).toContainText("Sample: Workstation");

  await page.getByRole("button", { name: /Sample: Workstation/ }).click();
  await page.getByRole("dialog").getByRole("radio", { name: /My computer/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Use my computer" }).click();
  await expect(page.getByRole("button", { name: "My computer · edit" })).toBeVisible();
  await expect(bar).toContainText("8.0 GiB");
});
