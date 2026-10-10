import { describe, expect, it } from "vitest";
import { estimate, estimateKv, computePools, kvPerToken } from "./estimator";
import { buildMachineProfile } from "./hardware";
import { addEvidence } from "./capabilities";
import { EMPTY_OVERRIDES, type HardwareReport } from "./types";
import { ARCH_8B, artifact, discrete, model, settings, unified } from "./testkit";
import { GB, GiB } from "../lib/units";
import { DEMO_MACHINES } from "../platform/demoHardware";

describe("required fit scenarios", () => {
  it("12 GB Q4 dense model on a 16 GB GPU → Fully GPU when runtime fits", () => {
    const m = model({ total: 20, dense: true, artifacts: [artifact("Q4_K_M", 12 * GB)], arch: { ...ARCH_8B, layers: 40 } });
    const e = estimate(m, settings({ contextTokens: 8192 }), discrete(16, 15.5, 32, 24));
    expect(e.quantSource).toBe("published");
    expect(e.classification).toBe("full_gpu");
    expect(e.placement?.gpuFraction).toBe(1);
    expect(e.gpuMargin!).toBeGreaterThan(0);
  });

  it("26B total / 3.8B active MoE on 16 GB GPU → Promising hybrid MoE only (never guaranteed GPU execution)", () => {
    const m = model({ total: 26, active: 3.8, moe: true, arch: { ...ARCH_8B, layers: 30, expertCount: 128, expertUsedCount: 8 } });
    const e = estimate(m, settings({ quant: "Q4_K_M" }), discrete(16, 15.5, 32, 24));
    expect(e.weights!.mid + e.gpuRuntime.mid).toBeGreaterThan(e.pools.vramUsable!); // total model footprint > VRAM
    expect(e.active!.mid).toBeLessThan(e.pools.vramUsable!); // A < V
    expect(e.classification).toBe("promising_moe");
    expect(e.confidence).not.toBe("high");
    expect(e.warnings.some((w) => /placement|places experts|must be measured/i.test(w.text))).toBe(true);
    expect(e.summary).toMatch(/Only a real test can confirm/);
  });

  it("27B dense Q4 partially offloaded → Hybrid likely slow", () => {
    const m = model({ total: 27, dense: true, arch: { ...ARCH_8B, layers: 62, kvHeads: 16 } });
    const e = estimate(m, settings({ quant: "Q4_K_M" }), discrete(16, 15.5, 32, 24));
    expect(e.active!.mid).toBeGreaterThan(e.pools.vramUsable!);
    expect(e.classification).toBe("hybrid_slow");
    expect(e.responsiveness).toBe("potentially_slow");
    expect(e.placement!.cpuWeights).toBeGreaterThan(0);
  });

  it("Total model exceeds free combined memory → Cannot fit", () => {
    const m = model({ total: 405, dense: true });
    const e = estimate(m, settings(), discrete(16, 15.5, 32, 24));
    expect(e.classification).toBe("cannot_fit");
    expect(e.headline).toMatch(/Too large/);
  });

  it("Apple 64 GB unified memory uses one pool (no double counting)", () => {
    const mac = unified(64, 50, 48);
    const pools = computePools(mac, settings());
    expect(pools.vramUsable).toBeNull();
    expect(pools.ramUsable).toBeCloseTo(48 * GiB, -6); // 50 free − 2 reserve
    const fits = estimate(model({ total: 32, dense: true, arch: ARCH_8B }), settings(), mac);
    expect(fits.classification).toBe("full_gpu");
    // 70 GiB of weights would "fit" if 64 VRAM + 64 RAM were wrongly added; it must not.
    const big = estimate(model({ total: 110, dense: true }), settings(), mac);
    expect(["cannot_fit", "memory_constrained"]).toContain(big.classification);
    expect(big.classification).toBe("cannot_fit");
  });

  it("Unified memory: beyond the GPU working-set limit → hybrid on CPU, same pool", () => {
    const e = estimate(model({ total: 70, dense: true, arch: { ...ARCH_8B, layers: 80 } }), settings(), unified(64, 60, 40));
    expect(e.classification).toBe("hybrid_slow");
    expect(e.placement!.gpuFraction).toBeLessThan(1);
  });

  it("Windows shared graphics memory is never added to dedicated VRAM", () => {
    const desk = DEMO_MACHINES.find((d) => d.id === "desktop-16g")!.report;
    const gpu = desk.gpus[0];
    const report: HardwareReport = {
      ...desk,
      gpus: [{ ...gpu, dedicatedBytes: { value: 8 * GiB, source: "DXGI", confidence: "high" }, freeBytes: { value: 7.5 * GiB, source: "NVML", confidence: "high" }, sharedBytes: { value: 16 * GiB, source: "DXGI shared", confidence: "high" } }],
    };
    const p = buildMachineProfile(report, EMPTY_OVERRIDES);
    expect(p.gpus[0].vramTotal).toBe(8 * GiB);
    const e = estimate(model({ total: 14, dense: true, arch: ARCH_8B }), settings(), p);
    expect(e.pools.vramPhysical).toBe(8 * GiB);
    expect(e.classification).not.toBe("full_gpu");
  });

  it("Unknown active parameters are not fabricated", () => {
    const m = model({ total: 30, moe: true, active: null });
    const e = estimate(m, settings(), discrete(16, 15.5, 64, 50));
    expect(e.active).toBeNull();
    expect(e.classification).not.toBe("promising_moe");
    expect(e.equations.find((l) => l.label.startsWith("Active"))!.value).toBe("Unknown");
  });

  it("Missing quantization tag → hypothetical, not a download that exists", () => {
    const m = model({ total: 8, dense: true, artifacts: [artifact("Q4_K_M", 4.9 * GB)] });
    const q8 = estimate(m, settings({ quant: "Q8_0" }), discrete(16, 15, 32, 24));
    expect(q8.quantSource).toBe("derived_from_artifact");
    expect(q8.artifact).toBeNull();
    expect(q8.warnings.some((w) => /hypothetical size, not a download/.test(w.text))).toBe(true);
    // Q8 scaled from the real Q4 file, not from a generic table
    expect(q8.weights!.mid).toBeCloseTo(4.9 * GB * (8.5 / 4.85), -6);
    const none = estimate(model({ total: 8 }), settings({ quant: "Q6_K" }), discrete(16, 15, 32, 24));
    expect(none.quantSource).toBe("hypothetical");
  });

  it("Larger context increases the KV budget and can change the classification", () => {
    const m = model({ total: 12, dense: true, artifacts: [artifact("Q4_K_M", 7.5 * GB)], arch: { ...ARCH_8B, layers: 48 } });
    const small = estimate(m, settings({ contextTokens: 8192 }), discrete(12, 11.5, 32, 24));
    const big = estimate(m, settings({ contextTokens: 131072 }), discrete(12, 11.5, 32, 24));
    expect(big.kv.mid).toBeCloseTo(small.kv.mid * 16, -3);
    expect(small.classification).toBe("full_gpu");
    expect(big.classification).not.toBe("full_gpu");
  });

  it("Multiple images increase the budget and can change the classification", () => {
    let m = model({ total: 12, dense: true, artifacts: [artifact("Q4_K_M", 8.4 * GB, { projectorBytes: 0.8 * GB })], arch: ARCH_8B });
    m = { ...m, capabilities: { ...m.capabilities, inputs: { ...m.capabilities.inputs, image: addEvidence(m.capabilities.inputs.image, { status: "verified_supported", scope: "ollama_tag", source: "test" }) } } };
    const none = estimate(m, settings({ imageCount: 0 }), discrete(12, 11.5, 32, 24));
    const many = estimate(m, settings({ imageCount: 8, imageResolution: 2048 }), discrete(12, 11.5, 32, 24));
    expect(many.visionActivations.mid).toBeGreaterThan(none.visionActivations.mid);
    expect(none.classification).toBe("full_gpu");
    expect(many.classification).not.toBe("full_gpu");
  });

  it("Image input on a text-only model warns and suggests OCR instead of pretending", () => {
    let m = model({ total: 8, dense: true });
    m = { ...m, capabilities: { ...m.capabilities, inputs: { ...m.capabilities.inputs, image: addEvidence(m.capabilities.inputs.image, { status: "verified_unsupported", scope: "ollama_tag", source: "test" }) } } };
    const e = estimate(m, settings({ imageCount: 2 }), discrete(16, 15, 32, 24));
    expect(e.visionActivations.mid).toBe(0);
    expect(e.warnings.find((w) => w.level === "danger")!.text).toMatch(/cannot read images.*OCR/);
  });

  it("Two GPUs without configured sharding are not aggregated", () => {
    const ws = DEMO_MACHINES.find((d) => d.id === "workstation-2x24")!.report;
    const p = buildMachineProfile(ws, { ...EMPTY_OVERRIDES, selectedGpuIds: ["gpu0", "gpu1"] });
    const m = model({ total: 70, dense: true, arch: { ...ARCH_8B, layers: 80 } });
    const sep = estimate(m, settings(), p);
    expect(sep.pools.vramPhysical).toBe(24 * GiB);
    expect(sep.classification).not.toBe("full_gpu");
    const combined = estimate(m, settings(), buildMachineProfile(ws, { ...EMPTY_OVERRIDES, selectedGpuIds: ["gpu0", "gpu1"], combineGpus: true }));
    expect(combined.pools.vramPhysical).toBe(48 * GiB);
    expect(combined.classification).toBe("full_gpu");
  });

  it("GPU occupied by another process: live free VRAM drives the fit", () => {
    const m = model({ total: 8, dense: true, artifacts: [artifact("Q4_K_M", 4.9 * GB)], arch: ARCH_8B });
    expect(estimate(m, settings(), discrete(16, 15.5, 32, 24)).classification).toBe("full_gpu");
    const busy = estimate(m, settings(), discrete(16, 3, 32, 24));
    expect(busy.pools.mode).toBe("live");
    expect(busy.classification).toBe("hybrid_slow");
  });

  it("Planning mode (no live readings) uses 10% VRAM / 20% RAM reserves", () => {
    const p = computePools(discrete(16, null, 32, null), settings());
    expect(p.mode).toBe("planning");
    expect(p.vramUsable).toBeCloseTo(16 * GiB * 0.9, -3);
    expect(p.ramUsable).toBeCloseTo(32 * GiB * 0.8, -3);
  });

  it("Unknown model size → Unknown / needs verification, never an optimistic yes", () => {
    const e = estimate(model({ total: null }), settings(), discrete(24, 23, 64, 50));
    expect(e.classification).toBe("unknown");
    expect(e.summary).toMatch(/check the actual tagged file size/i);
  });

  it("GPU VRAM unknown (NVML unavailable) → Unknown with a reason, app keeps working", () => {
    const e = estimate(model({ total: 8 }), settings(), discrete(0, null, 32, 24, { gpus: [{ id: "g", name: "NVIDIA", vramTotal: null, vramFree: null }] }));
    expect(e.classification).toBe("unknown");
    expect(e.pools.notes.join(" ")).toMatch(/VRAM unknown/);
  });

  it("No GPU: CPU-only classification from RAM", () => {
    const cpu = { ...discrete(0, null, 16, 12), arch: "cpu_only" as const, gpus: [] };
    expect(estimate(model({ total: 3, dense: true }), settings(), cpu).classification).toBe("cpu_only");
    expect(estimate(model({ total: 70, dense: true }), settings(), cpu).classification).toBe("cannot_fit");
  });

  it("Borderline results lower confidence instead of hiding uncertainty", () => {
    // heuristic KV + estimated weights near the VRAM edge
    const m = model({ total: 13.5 });
    const e = estimate(m, settings({ contextTokens: 16384 }), discrete(12, 11.6, 32, 24));
    if (new Set(Object.values(e.classAtLevels)).size > 1) {
      expect(e.confidence).toBe("low");
      expect(e.warnings.some((w) => /Borderline/.test(w.text))).toBe(true);
    }
  });
});

describe("KV cache formula", () => {
  it("matches 2 × layers × kv_heads × head_dim × ctx × bytes × parallel", () => {
    const m = model({ arch: ARCH_8B });
    const kv = estimateKv(m, settings({ contextTokens: 8192, parallel: 2 }));
    expect(kv.kv.mid).toBe(2 * 32 * 8 * 128 * 8192 * 2 * 2);
    expect(kv.method).toBe("metadata");
  });
  it("q8_0 cache roughly halves f16", () => {
    const m = model({ arch: ARCH_8B });
    expect(kvPerToken(m, "q8_0").perToken.mid / kvPerToken(m, "f16").perToken.mid).toBeCloseTo(0.53, 2);
  });
  it("falls back to a labelled heuristic range without metadata", () => {
    const kv = kvPerToken(model({ total: 8 }), "f16");
    expect(kv.method).toBe("heuristic");
    expect(kv.perToken.high).toBeGreaterThan(kv.perToken.low * 5);
  });
  it("sliding-window metadata narrows KV into a bounded range", () => {
    const m = model({ arch: { ...ARCH_8B, slidingWindow: 1024 } });
    const kv = estimateKv(m, settings({ contextTokens: 32768 }));
    expect(kv.kv.high).toBe(2 * 32 * 8 * 128 * 32768 * 2);
    expect(kv.kv.low).toBeLessThan(kv.kv.high / 3);
  });
});
