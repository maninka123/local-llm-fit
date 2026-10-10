import { describe, expect, it } from "vitest";
import { cleanRenderer, lookupGpu } from "./gpuSpecs";
import { buildBrowserReport, osFromUserAgent, suggestSetup, type BrowserSignals } from "./browserDetect";
import { buildMachineProfile } from "../domain/hardware";
import { EMPTY_OVERRIDES } from "../domain/types";
import { estimate, DEFAULT_SETTINGS } from "../domain/estimator";
import { model } from "../domain/testkit";
import { GiB } from "../lib/units";

const sig = (gpuName: string | null, extra: Partial<BrowserSignals> = {}): BrowserSignals => ({
  renderer: gpuName,
  gpuName,
  webgpu: null,
  cores: 16,
  deviceMemoryGB: 8,
  os: { name: "Windows", version: "11", arch: "x86" },
  mobile: false,
  battery: "unknown",
  ...extra,
});

describe("renderer strings", () => {
  it("cleans ANGLE renderer strings from each platform", () => {
    expect(cleanRenderer("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti SUPER (0x00002705) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("NVIDIA GeForce RTX 4070 Ti SUPER");
    expect(cleanRenderer("ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)")).toBe("Apple M3 Pro");
    expect(cleanRenderer("ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3080/PCIe/SSE2, OpenGL 4.5.0)")).toBe("NVIDIA GeForce RTX 3080");
    expect(cleanRenderer("ANGLE (AMD, AMD Radeon RX 7900 XTX (radeonsi, navi31, LLVM 17.0.6, DRM 3.54), OpenGL 4.6)")).toBe("AMD Radeon RX 7900 XTX");
    expect(cleanRenderer("ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("Intel UHD Graphics 620");
  });
});

describe("GPU spec table", () => {
  it("matches the most specific model first", () => {
    expect(lookupGpu("NVIDIA GeForce RTX 4070 Ti SUPER")?.vramGiB).toEqual([16]);
    expect(lookupGpu("NVIDIA GeForce RTX 4070 Ti")?.vramGiB).toEqual([12]);
    expect(lookupGpu("NVIDIA GeForce RTX 4070")?.vramGiB).toEqual([12]);
    expect(lookupGpu("NVIDIA GeForce RTX 4060 Laptop GPU")?.vramGiB).toEqual([8]);
    expect(lookupGpu("NVIDIA GeForce RTX 4090 Laptop GPU")?.vramGiB).toEqual([16]); // not the desktop 24 GB
  });
  it("lists every memory variant when a model ships in several sizes", () => {
    expect(lookupGpu("NVIDIA GeForce RTX 3060")?.vramGiB).toEqual([12, 8]);
    expect(lookupGpu("NVIDIA GeForce RTX 4060 Ti")?.vramGiB).toEqual([8, 16]);
  });
  it("recognises Apple Silicon as unified memory with chip-specific options", () => {
    const s = lookupGpu("Apple M3 Pro")!;
    expect(s.kind).toBe("unified");
    expect(s.unifiedOptionsGB).toEqual([18, 36]);
    expect(lookupGpu("Apple GPU")?.kind).toBe("unified");
  });
  it("treats integrated graphics as shared memory", () => {
    expect(lookupGpu("Intel UHD Graphics 620")?.kind).toBe("integrated");
    expect(lookupGpu("AMD Radeon Graphics")?.kind).toBe("integrated");
    expect(lookupGpu("AMD Radeon RX 7900 XTX")?.vramGiB).toEqual([24]);
  });
  it("unknown names don't get invented specs", () => {
    expect(lookupGpu("NVIDIA Mystery 9999")?.vramGiB).toBeUndefined();
    expect(lookupGpu("Some Unknown Adapter")).toBeNull();
  });
});

describe("browser report", () => {
  it("builds a discrete-GPU machine from detection + known spec (planning mode, labelled)", () => {
    const s = sig("NVIDIA GeForce RTX 4070 Ti SUPER");
    const setup = { ...suggestSetup(s), ramGiB: 32, confirmed: true };
    const r = buildBrowserReport(s, setup);
    expect(r.mode).toBe("browser");
    expect(r.gpus[0].dedicatedBytes.value).toBe(16 * GiB);
    expect(r.gpus[0].dedicatedBytes.source).toMatch(/known spec/);
    expect(r.gpus[0].freeBytes.value).toBeNull();
    const p = buildMachineProfile(r, EMPTY_OVERRIDES);
    const e = estimate(model({ total: 8, dense: true }), DEFAULT_SETTINGS, p);
    expect(e.pools.mode).toBe("planning");
    expect(e.classification).toBe("full_gpu");
  });
  it("Apple Silicon from the browser is a single unified pool", () => {
    const s = sig("Apple M3", { os: { name: "macOS", version: "15", arch: "arm" } });
    const r = buildBrowserReport(s, { ...suggestSetup(s), ramGiB: 16, confirmed: true });
    expect(r.memoryArchitecture.value).toBe("unified");
    expect(r.memory.totalBytes.value).toBe(16 * GiB);
  });
  it("hidden GPU name → CPU-only estimate until the user says otherwise", () => {
    const s = sig(null, { deviceMemoryGB: 4 });
    const setup = suggestSetup(s);
    expect(setup.ramGiB).toBe(4); // deviceMemory below the 8 GB cap is usable
    expect(buildBrowserReport(s, setup).memoryArchitecture.value).toBe("cpu_only");
  });
  it("unconfirmed RAM is flagged as an assumption", () => {
    const r = buildBrowserReport(sig("NVIDIA GeForce RTX 3080"), suggestSetup(sig("NVIDIA GeForce RTX 3080")));
    expect(r.memory.totalBytes.source).toMatch(/Assumed/);
    expect(r.browserConfirmed).toBe(false);
  });
  it("parses OS from user agents", () => {
    expect(osFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)").name).toBe("Windows");
    expect(osFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)").name).toBe("macOS");
    expect(osFromUserAgent("Mozilla/5.0 (X11; Linux x86_64)").name).toBe("Linux");
  });
});

describe("software rendering", () => {
  it("SwiftShader / llvmpipe mean the GPU is hidden, not a real device", () => {
    expect(cleanRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)")).toBeNull();
    expect(cleanRenderer("llvmpipe (LLVM 15.0.7, 256 bits)")).toBeNull();
  });
});

describe("update notes", () => {
  it("shows only the short What's new bullets, never the download table", async () => {
    const { parseReleaseNotes } = await import("../components/Updater");
    const body = "Model Fit Explorer 1.0.11.\n\n## What's new\n\n- Clearer **tight fit**\n- Speed in `tok/s`\n\n## Which file should I download?\n\n| a | b |\n| --- | --- |\n- **`.sig` files**: signatures";
    expect(parseReleaseNotes(body)).toEqual(["Clearer tight fit", "Speed in tok/s"]);
    expect(parseReleaseNotes("• One\n• Two")).toEqual(["One", "Two"]);
  });
});

describe('"No graphics card" answer', () => {
  const none = { confirmed: true, gpuName: null, vramGiB: null, ramGiB: 16, formFactor: "laptop" as const };
  it("wins over a detected Apple, NVIDIA or Intel GPU: models run on the CPU", () => {
    for (const name of ["Apple M3", "NVIDIA GeForce RTX 4070", "Intel(R) Iris(R) Xe Graphics"]) {
      const r = buildBrowserReport(sig(name, name.startsWith("Apple") ? { os: { name: "macOS", version: "15", arch: "arm" } } : {}), none);
      expect(r.memoryArchitecture.value, name).toBe("integrated_shared");
      const m = buildMachineProfile(r, EMPTY_OVERRIDES);
      const e = estimate(model({ total: 3, dense: true }), DEFAULT_SETTINGS, m);
      expect(e.classification, name).toBe("cpu_only");
      expect(`${e.headline} ${e.summary}`).not.toMatch(/fits? (entirely |fully )?in (the )?GPU|GPU-usable/i);
    }
  });
});
