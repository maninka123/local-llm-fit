import { describe, expect, it } from "vitest";
import { estimate } from "./estimator";
import { buildMachineProfile } from "./hardware";
import { EMPTY_OVERRIDES } from "./types";
import { ARCH_8B, artifact, model, settings } from "./testkit";
import { GB, GiB } from "../lib/units";
import { BOARD_MACHINES, DEMO_MACHINES } from "../platform/demoHardware";

const profile = (id: string) => buildMachineProfile(DEMO_MACHINES.find((d) => d.id === id)!.report, EMPTY_OVERRIDES);
const small = model({ total: 3, dense: true, artifacts: [artifact("Q4_K_M", 2 * GB)], arch: { ...ARCH_8B, layers: 28 } });

describe("single-board & edge samples", () => {
  it("there are 10 board templates with unique ids", () => {
    expect(BOARD_MACHINES).toHaveLength(10);
    expect(new Set(DEMO_MACHINES.map((d) => d.id)).size).toBe(DEMO_MACHINES.length);
  });

  it("every board has known memory speed, so speed guesses use it", () => {
    for (const d of BOARD_MACHINES) {
      const p = buildMachineProfile(d.report, EMPTY_OVERRIDES);
      expect(p.arch === "unified" ? p.gpuBandwidthGBs : p.ramBandwidthGBs, d.id).toBeGreaterThan(0);
    }
  });

  it("Jetson Orin and DGX Spark run on the CUDA GPU from shared memory", () => {
    for (const id of ["jetson-orin-nano-8", "jetson-agx-orin-64", "dgx-spark-128"]) {
      const p = profile(id);
      expect(p.arch).toBe("unified");
      expect(p.gpuBackendSupported).toBe(true);
      expect(estimate(small, settings(), p).classification).toBe("full_gpu");
    }
  });

  it("Raspberry Pi and the original Jetson Nano are CPU only", () => {
    for (const id of ["rpi5-8", "rpi4-8", "opi5plus-16"]) expect(estimate(small, settings(), profile(id)).classification).toBe("cpu_only");
    const tiny = model({ total: 1, dense: true, artifacts: [artifact("Q4_K_M", 0.8 * GB)], arch: { ...ARCH_8B, layers: 16 } });
    expect(estimate(tiny, settings({ contextTokens: 4096 }), profile("jetson-nano-4")).classification).toBe("cpu_only");
  });

  it("a 4 GB board keeps a smaller live reserve than the 2 GiB PC default", () => {
    const pools = estimate(small, settings(), profile("jetson-nano-4")).pools;
    expect(pools.ramUsable! / GiB).toBeCloseTo(3.2 - 1, 5);
  });

  it("a Raspberry Pi is much slower than a PC and an Orin Nano", () => {
    const pi = estimate(small, settings(), profile("rpi5-8")).speed!.range.mid;
    const office = estimate(small, settings(), profile("office-igpu")).speed!.range.mid;
    const orin = estimate(small, settings(), profile("jetson-orin-nano-8")).speed!.range.mid;
    expect(pi).toBeGreaterThan(2);
    expect(pi).toBeLessThan(10);
    expect(office).toBeGreaterThan(pi * 2);
    expect(orin).toBeGreaterThan(pi * 3);
  });
});
