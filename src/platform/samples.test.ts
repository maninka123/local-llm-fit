import { describe, expect, it } from "vitest";
import { buildSample, chipsFor, MAC_MODELS, presetConfig, sampleOverrides, vramOptionsFor, type SampleConfig } from "./samples";
import { BOARD_MACHINES } from "./demoHardware";
import { DESKTOP_GPU_NAMES, LAPTOP_GPU_NAMES, bandwidthFor, lookupGpu } from "./gpuSpecs";
import { buildMachineProfile } from "../domain/hardware";
import { estimate } from "../domain/estimator";
import { EMPTY_OVERRIDES } from "../domain/types";
import { ARCH_8B, model, settings } from "../domain/testkit";
import { GiB } from "../lib/units";

// Every option the sample picker offers must produce a coherent machine.
const profile = (cfg: SampleConfig) => buildMachineProfile(buildSample(cfg).report, { ...EMPTY_OVERRIDES, ...sampleOverrides(cfg) });
const small = model({ total: 1, dense: true, arch: { ...ARCH_8B, layers: 16 } });

describe("graphics card data", () => {
  for (const [kind, names] of [["desktop", DESKTOP_GPU_NAMES], ["laptop", LAPTOP_GPU_NAMES]] as const) {
    it(`every ${kind} GPU resolves to itself, with memory sizes and bandwidth`, () => {
      for (const n of names) {
        expect(lookupGpu(n)?.name, n).toBe(n);
        expect(vramOptionsFor(n).length, n).toBeGreaterThan(0);
        expect(bandwidthFor(n), n).toBeGreaterThan(0);
      }
    });
  }
});

describe("desktop / workstation samples", () => {
  for (const gpu of DESKTOP_GPU_NAMES) {
    it(gpu, () => {
      for (const vramGiB of vramOptionsFor(gpu)) {
        for (const gpuCount of [1, 2] as const) {
          const cfg: SampleConfig = { kind: "desktop", gpu, vramGiB, gpuCount, ramGiB: 32 };
          const p = profile(cfg);
          expect(p.arch).toBe("discrete");
          expect(p.gpus).toHaveLength(gpuCount);
          expect(p.combineGpus).toBe(gpuCount === 2);
          expect(p.gpus[0].vramTotal).toBe(vramGiB * GiB);
          expect(p.gpuBandwidthGBs).toBeGreaterThan(0);
          const vendor = lookupGpu(gpu)!.vendor;
          // NVIDIA: CUDA is supported. AMD/Intel: support varies, so it's flagged, never assumed false.
          expect(p.gpuBackendSupported).toBe(vendor === "nvidia" ? true : null);
          const e = estimate(small, settings(), p);
          expect(e.pools.vramPhysical).toBe(vramGiB * GiB * gpuCount);
          // A 1B model at 8K context needs ~2.5 GB of GPU memory with buffers; 3–4 GB cards can't hold it all.
          if (vramGiB * gpuCount >= 6) expect(e.classification).toBe("full_gpu");
          else expect(["full_gpu", "hybrid_slow"]).toContain(e.classification);
          if (vendor !== "nvidia") expect(e.warnings.some((w) => /not confirmed/.test(w.text))).toBe(true);
        }
      }
    });
  }
  it("two cards or 96 GB+ RAM is called a workstation; one card a desktop PC", () => {
    expect(buildSample({ kind: "desktop", gpu: "GeForce RTX 4090", vramGiB: 24, gpuCount: 1, ramGiB: 64 }).name).toMatch(/^Desktop PC · RTX 4090 · 64 GB RAM$/);
    expect(buildSample({ kind: "desktop", gpu: "GeForce RTX 4090", vramGiB: 24, gpuCount: 2, ramGiB: 64 }).name).toMatch(/^Workstation · 2 × RTX 4090/);
  });
  it("a faster card guesses faster replies for the same model", () => {
    const mid = model({ total: 8, dense: true, arch: ARCH_8B });
    const speed = (gpu: string, v: number) => estimate(mid, settings(), profile({ kind: "desktop", gpu, vramGiB: v, gpuCount: 1, ramGiB: 32 })).speed!.range.mid;
    expect(speed("GeForce RTX 4090", 24)).toBeGreaterThan(speed("GeForce RTX 4060", 8) * 2);
  });
});

describe("gaming laptop samples", () => {
  for (const gpu of LAPTOP_GPU_NAMES) {
    it(gpu, () => {
      for (const vramGiB of vramOptionsFor(gpu)) {
        const p = profile({ kind: "laptop", gpu, vramGiB, ramGiB: 16 });
        // The CPU's built-in graphics are present but only the NVIDIA GPU is used.
        expect(p.arch).toBe("discrete");
        expect(p.gpus).toHaveLength(1);
        expect(p.gpus[0].name).toBe(`NVIDIA ${gpu}`);
        expect(p.gpuBackendSupported).toBe(true);
        expect(estimate(small, settings(), p).classification).toBe("full_gpu");
      }
    });
  }
});

describe("Mac samples", () => {
  for (const m of MAC_MODELS) {
    it(m, () => {
      const chips = chipsFor(m);
      expect(chips.length).toBeGreaterThan(0);
      for (const chip of chips) {
        for (const ramGiB of chip.options) {
          const p = profile({ kind: "mac", model: m, chip: chip.name, ramGiB });
          expect(p.arch).toBe("unified");
          expect(p.gpuBackendSupported).toBe(true);
          expect(p.gpuBandwidthGBs, chip.name).toBeGreaterThan(0);
          expect(p.unifiedGpuLimit!).toBeLessThan(ramGiB * GiB);
          expect(p.unifiedGpuLimit! / (ramGiB * GiB)).toBeGreaterThan(0.65);
          expect(estimate(small, settings(), p).classification).toBe("full_gpu");
        }
      }
    });
  }
  it("chips match the Mac: Ultra only in Mac Studio, no Pro/Max in a MacBook Air", () => {
    expect(chipsFor("MacBook Air").every((c) => !/Pro|Max|Ultra/.test(c.name))).toBe(true);
    expect(chipsFor("MacBook Pro").some((c) => /Ultra/.test(c.name))).toBe(false);
    expect(chipsFor("Mac Studio").every((c) => /Max|Ultra/.test(c.name))).toBe(true);
  });
});

describe("office laptop and boards", () => {
  it("office laptop: built-in graphics, models run on the CPU", () => {
    for (const ramGiB of [8, 16, 32]) {
      const p = profile({ kind: "office", ramGiB });
      expect(p.arch).toBe("integrated_shared");
      expect(estimate(small, settings(), p).classification).toBe("cpu_only");
    }
  });
  for (const b of BOARD_MACHINES) {
    it(b.id, () => {
      const base = presetConfig(b.id) as Extract<SampleConfig, { kind: "board" }>;
      for (const ramGiB of [base.ramGiB, base.ramGiB * 2]) {
        const s = buildSample({ ...base, ramGiB });
        const p = buildMachineProfile(s.report, EMPTY_OVERRIDES);
        expect(p.ramTotal).toBe(ramGiB * GiB);
        expect(s.name).toContain(`${ramGiB} GB`);
        const e = estimate(small, settings({ contextTokens: 2048 }), p);
        if (b.report.memoryArchitecture.value === "unified") {
          expect(p.gpuBackendSupported).toBe(true);
          expect(p.unifiedGpuLimit!).toBeLessThan(ramGiB * GiB);
          expect(e.classification).toBe("full_gpu");
        } else {
          expect(p.ramBandwidthGBs).toBeGreaterThan(0);
          expect(e.classification).toBe("cpu_only");
        }
      }
    });
  }
});

describe("saved samples from older versions", () => {
  it("every old sample id still builds", () => {
    for (const id of ["desktop-16g", "workstation-2x24", "laptop-8g", "mac-m3pro-36", "office-igpu", ...BOARD_MACHINES.map((b) => b.id)]) {
      expect(buildSample(presetConfig(id)).report.memory.totalBytes.value, id).toBeGreaterThan(0);
    }
  });
});
