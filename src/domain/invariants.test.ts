import { describe, expect, it } from "vitest";
import { estimate, type Estimate, type MachineProfile } from "./estimator";
import { buildMachineProfile, gpuSummary } from "./hardware";
import { bucketFor } from "./recommend";
import { EMPTY_OVERRIDES, type HardwareOverrides } from "./types";
import { ARCH_8B, artifact, model, settings } from "./testkit";
import { GB, GiB } from "../lib/units";
import { BOARD_MACHINES } from "../platform/demoHardware";
import { DESKTOP_GPU_NAMES, LAPTOP_GPU_NAMES } from "../platform/gpuSpecs";
import { buildSample, chipsFor, MAC_MODELS, presetConfig, sampleOverrides, vramOptionsFor, type SampleConfig } from "../platform/samples";

// Rules that must hold on every machine the app can show, so what's displayed always agrees
// with what the estimate uses: totals match, free ≤ total, usable ≤ free, bars ≤ 100%,
// placements add up.

const configs: SampleConfig[] = [
  ...DESKTOP_GPU_NAMES.flatMap((gpu) => vramOptionsFor(gpu).flatMap((v) => ([1, 2] as const).map((gpuCount): SampleConfig => ({ kind: "desktop", gpu, vramGiB: v, gpuCount, ramGiB: 32 })))),
  ...LAPTOP_GPU_NAMES.flatMap((gpu) => vramOptionsFor(gpu).map((v): SampleConfig => ({ kind: "laptop", gpu, vramGiB: v, ramGiB: 16 }))),
  ...MAC_MODELS.flatMap((m) => chipsFor(m).flatMap((c) => c.options.map((r): SampleConfig => ({ kind: "mac", model: m, chip: c.name, ramGiB: r })))),
  ...[8, 16, 32].map((r): SampleConfig => ({ kind: "office", ramGiB: r })),
  ...BOARD_MACHINES.map((b) => presetConfig(b.id)),
];

const models = [
  model({ total: 1, dense: true, artifacts: [artifact("Q4_K_M", 0.8 * GB)], arch: { ...ARCH_8B, layers: 16 } }),
  model({ total: 8, dense: true, artifacts: [artifact("Q4_K_M", 4.9 * GB)], arch: ARCH_8B }),
  model({ total: 30, active: 3, moe: true, arch: { ...ARCH_8B, layers: 48, expertCount: 128, expertUsedCount: 8 } }),
  model({ total: 70, dense: true, arch: { ...ARCH_8B, layers: 80 } }),
  model({ total: 400, dense: true, arch: { ...ARCH_8B, layers: 120 } }),
];

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 1e-9);

function checkMachine(label: string, m: MachineProfile) {
  // Shown memory never contradicts itself.
  if (m.ramFree != null && m.ramTotal != null) expect(m.ramFree, `${label} RAM free ≤ total`).toBeLessThanOrEqual(m.ramTotal);
  const g = gpuSummary(m);
  if (g?.vramFree != null && g.vramTotal != null) expect(g.vramFree, `${label} VRAM free ≤ total`).toBeLessThanOrEqual(g.vramTotal);
  if (m.arch === "unified" && m.unifiedGpuLimit != null && m.ramTotal != null) expect(m.unifiedGpuLimit, `${label} GPU limit ≤ memory`).toBeLessThanOrEqual(m.ramTotal);
}

function checkEstimate(label: string, m: MachineProfile, e: Estimate) {
  const p = e.pools;
  const g = gpuSummary(m);
  // The bar's total is the same memory the estimate uses.
  if (m.arch === "discrete" && g) expect(p.vramPhysical, `${label} VRAM shown = used`).toBe(g.vramTotal);
  // Usable ≤ free ≤ total (so "in use" + "usable" never exceeds 100% of a bar).
  if (p.vramUsable != null && p.vramPhysical != null) expect(p.vramUsable, `${label} VRAM usable ≤ total`).toBeLessThanOrEqual(p.vramPhysical);
  if (p.vramUsable != null && p.vramFree != null) expect(p.vramUsable, `${label} VRAM usable ≤ free`).toBeLessThanOrEqual(p.vramFree);
  if (p.ramUsable != null && p.ramPhysical != null) expect(p.ramUsable, `${label} RAM usable ≤ total`).toBeLessThanOrEqual(p.ramPhysical);
  if (p.ramUsable != null && p.ramFree != null) expect(p.ramUsable, `${label} RAM usable ≤ free`).toBeLessThanOrEqual(p.ramFree);
  for (const v of [p.vramUsable, p.ramUsable, p.unifiedGpuLimit]) if (v != null) expect(v, `${label} no negative pools`).toBeGreaterThanOrEqual(0);
  // Placement adds up to the model, and a "fits in GPU" result really fits.
  const pl = e.placement;
  if (pl && e.weights) {
    expect(near(pl.gpuWeights + pl.cpuWeights, e.weights.mid), `${label} weights placed = weights`).toBe(true);
    expect(pl.gpuFraction, `${label} fraction in [0,1]`).toBeGreaterThanOrEqual(0);
    expect(pl.gpuFraction).toBeLessThanOrEqual(1);
    if (e.classification === "full_gpu" && m.arch === "discrete") expect(pl.gpuWeights + pl.gpuKv + pl.gpuOther, `${label} full GPU fits`).toBeLessThanOrEqual(p.vramUsable! + 1);
    if (e.classification === "full_gpu" && m.arch === "unified") expect(pl.gpuWeights + pl.gpuKv + pl.gpuOther, `${label} full GPU fits limit`).toBeLessThanOrEqual(p.unifiedGpuLimit! + 1);
  }
  // Speed and groups are coherent.
  if (e.speed) {
    for (const v of [e.speed.range.low, e.speed.range.mid, e.speed.range.high]) expect(Number.isFinite(v) && v > 0, `${label} speed finite`).toBe(true);
    expect(e.speed.range.low).toBeLessThanOrEqual(e.speed.range.mid + 1e-9);
    expect(e.speed.range.mid).toBeLessThanOrEqual(e.speed.range.high + 1e-9);
  }
  if (e.classification === "cannot_fit") expect(bucketFor(e)).toBe("wont_run");
  for (const t of [e.headline, e.summary]) expect(t, `${label} text`).not.toMatch(/NaN|undefined|Infinity/);
}

describe("every sample machine is self-consistent", () => {
  it(`covers ${configs.length} machines`, () => expect(configs.length).toBeGreaterThan(200));
  for (const cfg of configs) {
    const s = buildSample(cfg);
    const label = s.name;
    it(label, () => {
      for (const memoryBasis of ["live", "planning"] as const) {
        const m = buildMachineProfile(s.report, { ...EMPTY_OVERRIDES, ...sampleOverrides(cfg) });
        checkMachine(label, m);
        for (const md of models) checkEstimate(`${label} [${memoryBasis}]`, m, estimate(md, settings({ memoryBasis }), m));
      }
    });
  }
});

describe("edits and overrides stay consistent", () => {
  const two: SampleConfig = { kind: "desktop", gpu: "GeForce RTX 3090 / 3090 Ti", vramGiB: 24, gpuCount: 2, ramGiB: 64 };
  const cases: [string, SampleConfig, Partial<HardwareOverrides>][] = [
    ["RAM total lowered below free", DESKTOP(), { ramTotalGiB: 8 }],
    ["RAM free above total", DESKTOP(), { ramFreeGiB: 100 }],
    ["VRAM free above total", DESKTOP(), { vramFreeGiB: 40 }],
    ["VRAM total lowered", DESKTOP(), { vramTotalGiB: 4 }],
    ["two cards, VRAM total edited", two, { vramTotalGiB: 12 }],
    ["two cards, not combined", two, { combineGpus: false }],
    ["Mac, RAM lowered under GPU limit", { kind: "mac", model: "Mac Studio", chip: "Apple M2 Ultra", ramGiB: 192 }, { ramTotalGiB: 32 }],
    ["Mac, GPU limit above RAM", { kind: "mac", model: "MacBook Air", chip: "Apple M3", ramGiB: 16 }, { unifiedGpuLimitGiB: 40 }],
    ["board, RAM zeroed", presetConfig("rpi5-8"), { ramTotalGiB: 0.5, ramFreeGiB: 0.2 }],
  ];
  function DESKTOP(): SampleConfig {
    return { kind: "desktop", gpu: "GeForce RTX 4070 Ti SUPER", vramGiB: 16, gpuCount: 1, ramGiB: 32 };
  }
  for (const [name, cfg, o] of cases) {
    it(name, () => {
      const m = buildMachineProfile(buildSample(cfg).report, { ...EMPTY_OVERRIDES, ...sampleOverrides(cfg), ...o });
      checkMachine(name, m);
      for (const md of models) checkEstimate(name, m, estimate(md, settings(), m));
    });
  }
  it("two combined cards show their combined total", () => {
    const m = buildMachineProfile(buildSample(two).report, { ...EMPTY_OVERRIDES, ...sampleOverrides(two) });
    const g = gpuSummary(m)!;
    expect(g.count).toBe(2);
    expect(g.vramTotal).toBe(48 * GiB);
    expect(g.name).toMatch(/^2 × /);
  });
});
