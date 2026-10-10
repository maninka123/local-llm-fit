import { addRanges, clamp, exact, fmtBytes, fmtRange, fmtSpeed, GiB, KiB, range, scaleRange, type Range } from "../lib/units";
import { resolveInput } from "./capabilities";
import { quantInfo } from "./quant";
import type { Artifact, MemoryArchitecture, ModelVariant, Provenance, QuantId } from "./types";

// =====================================================================================
// Pure memory estimator. No I/O, no globals: (model, settings, machine) → Estimate.
//
//   W      quantized weights resident in memory (all experts for MoE, + vision encoder)
//   A      active weights per token (idealised compute footprint; NOT a residency claim)
//   KV     KV cache: 2 × layers × kv_heads × head_dim × ctx × bytes/elem × parallel
//   H_gpu  GPU runtime: KV + compute scratch + vision activations + backend context
//   H_ram  host runtime buffers (runner process, tokenizer, staging)
//   V/R/U  usable dedicated VRAM / host RAM / unified pool after reserves
//
// Every quantity is a Range {low, mid, high}. Classification is evaluated at all three
// levels; disagreement lowers confidence instead of hiding the uncertainty.
// =====================================================================================

export type FitClass =
  | "full_gpu"
  | "promising_moe"
  | "hybrid_slow"
  | "cpu_only"
  | "memory_constrained"
  | "cannot_fit"
  | "unknown";

export type Responsiveness = "likely_fast" | "reasonable" | "potentially_slow" | "unknown";
export type EstConfidence = "high" | "medium" | "low";
export type KvCacheType = "f16" | "q8_0" | "q4_0";

export interface ReservePolicy {
  /** Offline planning mode (no live free-memory reading): % of dedicated VRAM kept free. */
  planningVramReservePct: number;
  /** Offline planning mode: % of host RAM kept for OS + apps. */
  planningRamReservePct: number;
  /** Live mode: safety margin subtracted from measured free VRAM. */
  liveVramSafetyGiB: number;
  /** Live mode: RAM kept for OS + apps, subtracted from measured available RAM. */
  liveRamReserveGiB: number;
}

export const DEFAULT_RESERVES: ReservePolicy = {
  planningVramReservePct: 10,
  planningRamReservePct: 20,
  liveVramSafetyGiB: 0.5,
  liveRamReserveGiB: 2,
};

export interface EstimatorSettings {
  quant: QuantId;
  contextTokens: number;
  /** Concurrent sequences (Ollama OLLAMA_NUM_PARALLEL). Each gets its own KV cache. */
  parallel: number;
  kvCacheType: KvCacheType;
  imageCount: number;
  /** Longest side in pixels of input images. */
  imageResolution: number;
  reserves: ReservePolicy;
  /** User override of effective bits/weight for hypothetical quantizations. */
  customBitsPerWeight: number | null;
  /** Extra file-format overhead applied to parameter-derived weight estimates (%). */
  formatOverheadPct: number;
  /** User override of compute scratch allowance in GiB (null = heuristic). */
  scratchOverrideGiB: number | null;
  /**
   * "live": plan against memory that is free right now.
   * "planning": plan against total memory as if other apps were closed (reserve % kept).
   */
  memoryBasis: "live" | "planning";
}

export const DEFAULT_SETTINGS: EstimatorSettings = {
  quant: "Q4_K_M",
  contextTokens: 8192,
  parallel: 1,
  kvCacheType: "f16",
  imageCount: 0,
  imageResolution: 896,
  reserves: DEFAULT_RESERVES,
  customBitsPerWeight: null,
  formatOverheadPct: 2,
  scratchOverrideGiB: null,
  memoryBasis: "live",
};

export interface MachineGpu {
  id: string;
  name: string;
  vramTotal: number | null;
  vramFree: number | null;
}

export interface MachineProfile {
  arch: MemoryArchitecture;
  /** Selected GPU(s). With combineGpus=false only the first is used. */
  gpus: MachineGpu[];
  combineGpus: boolean;
  ramTotal: number | null;
  ramFree: number | null;
  /** Unified memory: max GPU working set (Metal recommendedMaxWorkingSetSize on Macs) when known. */
  unifiedGpuLimit: number | null;
  unifiedGpuLimitSource: "detected" | "user" | "assumed";
  /** Whether the GPU vendor has an Ollama GPU backend (null = unknown). */
  gpuBackendSupported: boolean | null;
  /** Published peak memory bandwidth of the GPU / Apple chip in GB/s (null = unknown). Speed guesses only. */
  gpuBandwidthGBs?: number | null;
  /** System RAM bandwidth in GB/s when known (single-board computers). null = typical PC RAM. */
  ramBandwidthGBs?: number | null;
  label: string;
}

export interface Pools {
  arch: MemoryArchitecture;
  /** "live" only when every pool used comes from a live free-memory reading. */
  mode: "live" | "planning";
  /** Basis of each pool separately (a live RAM reading can sit next to a planned VRAM figure). */
  ramMode: "live" | "planning";
  vramMode: "live" | "planning" | null;
  vramPhysical: number | null;
  vramFree: number | null;
  vramUsable: number | null;
  ramPhysical: number | null;
  ramFree: number | null;
  ramUsable: number | null;
  /** Absolute ceiling before the OS must swap (physical minus a minimal OS floor). */
  ramCeiling: number | null;
  unifiedGpuLimit: number | null;
  notes: string[];
}

export interface Placement {
  gpuWeights: number;
  cpuWeights: number;
  gpuKv: number;
  cpuKv: number;
  gpuOther: number;
  hostOther: number;
  /** Fraction of layers/weights planned on GPU (simulation, not observed). */
  gpuFraction: number;
}

export interface Line {
  label: string;
  value: string;
  detail?: string;
  provenance?: Provenance | "heuristic" | "measured" | "setting";
}

export interface Warning {
  level: "info" | "warn" | "danger";
  text: string;
}

export interface Estimate {
  modelId: string;
  quant: QuantId;
  quantSource: "published" | "derived_from_artifact" | "hypothetical" | "unknown";
  artifact: Artifact | null;
  weights: Range | null;
  weightsProvenance: Provenance;
  visionEncoder: Range | null;
  visionEncoderKnown: boolean;
  active: Range | null;
  activeProvenance: Provenance;
  kv: Range;
  kvMethod: "metadata" | "heuristic";
  kvPerToken: Range;
  scratch: Range;
  visionActivations: Range;
  backend: Range;
  hostRuntime: Range;
  gpuRuntime: Range;
  totalNeed: Range | null;
  pools: Pools;
  placement: Placement | null;
  classification: FitClass;
  classAtLevels: { low: FitClass; mid: FitClass; high: FitClass };
  confidence: EstConfidence;
  responsiveness: Responsiveness;
  headline: string;
  summary: string;
  gpuMargin: number | null;
  memoryMargin: number | null;
  warnings: Warning[];
  equations: Line[];
  assumptions: string[];
  imageTokens: number;
  isMoE: boolean;
  /** Rough generation-speed guess in tokens/second (null when it can't run or bandwidth is unknown). */
  speed: SpeedGuess | null;
}

export interface SpeedGuess {
  /** tokens per second */
  range: Range;
  /** GB read from memory per generated token */
  gbPerToken: number;
  gpuBandwidthGBs: number | null;
  cpuShare: number;
  /** Share of each word's time spent on the GPU part (mid estimate). */
  gpuTimeShare: number;
}

/**
 * Decode speed is mostly memory-bandwidth bound: every token reads the active weights plus
 * the KV cache. time/token = GPU bytes ÷ GPU bandwidth + CPU bytes ÷ RAM bandwidth + overhead.
 * Real software reaches ~50–80% of peak bandwidth, hence a range. Never shown as exact.
 */
export function guessSpeed(
  cls: FitClass,
  placement: Placement | null,
  activeBytes: number,
  kvPerTokenBytes: number,
  settings: EstimatorSettings,
  machine: MachineProfile,
): SpeedGuess | null {
  if (!placement || cls === "cannot_fit" || cls === "unknown") return null;
  // Each word re-reads the conversation so far (KV cache), so speed falls as a chat grows.
  // Slow end: the whole context window is filled. Typical: ~4K tokens in. Fast end: a fresh chat.
  const filled = [settings.contextTokens, Math.min(settings.contextTokens, 4096), Math.min(settings.contextTokens, 1024)];
  const perTokenAt = (i: number) => activeBytes + kvPerTokenBytes * filled[i];
  const perToken = perTokenAt(1);
  const cpuOnly = machine.arch === "cpu_only" || machine.arch === "integrated_shared" || machine.gpuBackendSupported === false;
  const f = cpuOnly ? 0 : placement.gpuFraction;
  const bw = machine.gpuBandwidthGBs ?? null;
  if (f > 0 && bw == null) return null;
  const unified = machine.arch === "unified";
  const gpuEff = unified ? [0.55, 0.68, 0.8] : [0.5, 0.65, 0.8];
  // CPU side: unified machines read the same pool (CPU reaches less of it); PCs read system RAM
  // (typical desktop DDR4/DDR5 unless the board's RAM speed is known, e.g. a Raspberry Pi).
  const rb = machine.ramBandwidthGBs ?? null;
  const cpuBw = unified && bw ? [bw * 0.35, bw * 0.45, bw * 0.55] : rb ? [rb * 0.45, rb * 0.58, rb * 0.7] : [45 * 0.45, 65 * 0.58, 90 * 0.7];
  const overhead = f >= 0.999 ? 0.0015 : f <= 0.001 ? 0.004 : 0.006;
  const at = (i: number) => {
    const gpuTime = f > 0 && bw ? (f * perTokenAt(i)) / (bw * gpuEff[i] * 1e9) : 0;
    const cpuTime = ((1 - f) * perTokenAt(i)) / (cpuBw[i] * 1e9);
    return 1 / (gpuTime + cpuTime + overhead);
  };
  const gpuT = f > 0 && bw ? (f * perToken) / (bw * gpuEff[1] * 1e9) : 0;
  const cpuT = ((1 - f) * perToken) / (cpuBw[1] * 1e9);
  return { range: { low: at(0), mid: at(1), high: at(2) }, gbPerToken: perToken / 1e9, gpuBandwidthGBs: bw, cpuShare: 1 - f, gpuTimeShare: gpuT + cpuT > 0 ? gpuT / (gpuT + cpuT) : 0 };
}

// ------------------------------------------------------------------ helpers

const CACHE_BYTES: Record<KvCacheType, number> = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 };
const OS_FLOOR = 1.5 * GiB;

export function pickArtifact(model: ModelVariant, quant: QuantId): Artifact | null {
  // A file without a known weight size (0 bytes) is not a usable published size.
  const matches = model.artifacts.filter((a) => a.quant === quant && a.weightBytes > 0);
  if (!matches.length) return null;
  return matches.find((a) => a.isDefaultTag) ?? [...matches].sort((a, b) => (b.checkedAt ?? "").localeCompare(a.checkedAt ?? ""))[0];
}

/** Quantizations that actually have a published artifact for this model. */
export function publishedQuants(model: ModelVariant): QuantId[] {
  return [...new Set(model.artifacts.filter((a) => a.weightBytes > 0).map((a) => a.quant))];
}

export function isMoE(model: ModelVariant): boolean {
  return model.architecture.value === "moe" || (model.arch?.expertCount ?? 0) > 1;
}

function bitsFor(quant: QuantId, settings: EstimatorSettings) {
  return settings.customBitsPerWeight && settings.customBitsPerWeight > 0 ? settings.customBitsPerWeight : quantInfo(quant).bitsPerWeight;
}

interface WeightEstimate {
  text: Range | null;
  vision: Range | null;
  visionKnown: boolean;
  provenance: Provenance;
  source: "published" | "derived_from_artifact" | "hypothetical" | "unknown";
  artifact: Artifact | null;
  detail: string;
}

export function estimateWeights(model: ModelVariant, settings: EstimatorSettings): WeightEstimate {
  const quant = settings.quant;
  const art = pickArtifact(model, quant);
  if (art) {
    const vision = art.projectorBytes ? exact(art.projectorBytes) : null;
    return {
      text: exact(art.weightBytes),
      vision,
      visionKnown: art.projectorBytes != null,
      provenance: art.provenance,
      source: "published",
      artifact: art,
      detail: `Published ${art.quantLabel} file${art.tag ? ` (${art.tag})` : ""}: ${fmtBytes(art.weightBytes, "GB", 2)} from ${art.source}`,
    };
  }

  const bpw = bitsFor(quant, settings);
  const spread = settings.customBitsPerWeight ? 0.05 : quantInfo(quant).spread;
  const visionLikely = ["verified_supported", "family_suggests"].includes(resolveInput(model.capabilities, "image").status);

  // Prefer scaling a real artifact of a different quantization (same tensors, different precision).
  const ref = model.artifacts.find((a) => a.quant !== "OTHER" && a.weightBytes > 0);
  if (ref) {
    const k = bpw / quantInfo(ref.quant).bitsPerWeight;
    const mid = ref.weightBytes * k;
    return {
      text: range(mid * (1 - spread), mid, mid * (1 + spread)),
      vision: ref.projectorBytes ? exact(ref.projectorBytes) : null,
      visionKnown: ref.projectorBytes != null,
      provenance: "derived",
      source: "derived_from_artifact",
      artifact: null,
      detail: `Scaled from the published ${ref.quantLabel} file (${fmtBytes(ref.weightBytes, "GB", 2)}) by ${bpw.toFixed(2)}/${quantInfo(ref.quant).bitsPerWeight.toFixed(2)} bits per weight`,
    };
  }

  const p = model.totalParamsB.value;
  if (p == null) {
    return { text: null, vision: null, visionKnown: false, provenance: "unknown", source: "unknown", artifact: null, detail: "Total parameters unknown and no published file size" };
  }
  const mid = ((p * 1e9 * bpw) / 8) * (1 + settings.formatOverheadPct / 100);
  const vision = visionLikely ? range(0.3 * GiB, 0.6 * GiB, 1.0 * GiB) : null;
  return {
    text: range(mid * (1 - spread), mid, mid * (1 + spread)),
    vision,
    visionKnown: false,
    provenance: "estimated",
    source: "hypothetical",
    artifact: null,
    detail: `${p}B params × ${bpw.toFixed(2)} bits ÷ 8 × (1 + ${settings.formatOverheadPct}% format overhead), ±${Math.round(spread * 100)}%`,
  };
}

export function estimateActive(model: ModelVariant, settings: EstimatorSettings, textWeights: Range | null): { active: Range | null; provenance: Provenance; detail: string } {
  const a = model.activeParamsB.value;
  const total = model.totalParamsB.value;
  if (a != null && textWeights) {
    // Active share of the actual weights (keeps the published file's real bytes/param).
    if (total) {
      const share = clamp(a / total, 0, 1);
      return {
        active: scaleRange(textWeights, share),
        provenance: model.activeParamsB.provenance === "verified" ? "derived" : "estimated",
        detail: `${a}B active of ${total}B total = ${(share * 100).toFixed(1)}% of weights`,
      };
    }
    const bpw = bitsFor(settings.quant, settings);
    const mid = (a * 1e9 * bpw) / 8;
    return { active: range(mid * 0.9, mid, mid * 1.15), provenance: "estimated", detail: `${a}B active × ${bpw.toFixed(2)} bits ÷ 8` };
  }
  if (model.architecture.value === "dense" && textWeights) {
    return { active: textWeights, provenance: "derived", detail: "Dense model: essentially all transformer weights are used for every token" };
  }
  return { active: null, provenance: "unknown", detail: "Active parameters unknown" };
}

/** KV cache bytes per token for ONE sequence (before multiplying by context × parallel). */
export function kvPerToken(model: ModelVariant, kvType: KvCacheType): { perToken: Range; method: "metadata" | "heuristic"; detail: string; windowed?: { window: number } } {
  const b = CACHE_BYTES[kvType];
  const m = model.arch;
  if (m?.layers && m.kvLoraRank) {
    // MLA: cache stores the compressed latent (+ a rope key part, ~64 dims).
    const per = m.layers * (m.kvLoraRank + 64) * b;
    return {
      perToken: range(per, per, per * 4),
      method: "metadata",
      detail: `MLA: ${m.layers} layers × (${m.kvLoraRank} latent + 64 rope) × ${b.toFixed(2)} B (high bound: runtimes that expand the latent)`,
    };
  }
  if (m?.layers && m.kvHeads && m.keyDim) {
    const vd = m.valueDim ?? m.keyDim;
    const per = m.layers * m.kvHeads * (m.keyDim + vd) * b;
    return {
      perToken: exact(per),
      method: "metadata",
      detail: `${m.layers} layers × ${m.kvHeads} KV heads × (${m.keyDim}+${vd}) dims × ${b.toFixed(2)} B`,
      windowed: m.slidingWindow ? { window: m.slidingWindow } : undefined,
    };
  }
  // Fallback: wide range scaled by an effective size. Labelled heuristic everywhere.
  const total = model.totalParamsB.value;
  const active = model.activeParamsB.value;
  const pEff = total && active ? Math.sqrt(total * active) : total ?? 8;
  const mid = 128 * KiB * Math.sqrt(Math.max(pEff, 0.1) / 8) * (b / 2);
  return {
    perToken: range(mid * 0.3, mid, mid * 2.5),
    method: "heuristic",
    detail: `No layer/head metadata: heuristic ≈ 128 KiB × √(${pEff.toFixed(1)}B ÷ 8) per token at f16, range ×0.3–×2.5`,
  };
}

export function estimateKv(model: ModelVariant, settings: EstimatorSettings) {
  const per = kvPerToken(model, settings.kvCacheType);
  const tokens = settings.contextTokens * Math.max(1, settings.parallel);
  let kv = scaleRange(per.perToken, tokens);
  let detail = per.detail;
  if (per.windowed && per.windowed.window < settings.contextTokens) {
    // Sliding-window layers only cache `window` tokens. The local/global layer split is not
    // in the metadata we read, so bound it: high = no savings, low = 5/6 of layers windowed.
    const ratio = per.windowed.window / settings.contextTokens;
    const full = kv.mid;
    kv = range(full * (1 / 6 + (5 / 6) * ratio), full * (0.5 + 0.5 * ratio), full);
    detail += `; sliding window ${per.windowed.window} tokens (layer split unknown → range)`;
  }
  return { kv, perToken: per.perToken, method: per.method, detail };
}

export function imageTokensPerImage(resolution: number): Range {
  const patches = Math.ceil(resolution / 14) ** 2;
  return range(256, Math.max(256, Math.round(patches / 4)), Math.max(256, patches));
}

// ------------------------------------------------------------------ pools

export function computePools(machine: MachineProfile, settings: EstimatorSettings): Pools {
  const r = settings.reserves;
  const notes: string[] = [];
  const planning = settings.memoryBasis === "planning";
  if (planning) notes.push("Planning for a fresh start: other apps assumed closed; fixed reserves kept for the OS.");
  const ramPhysical = machine.ramTotal;
  const ramFree = planning || machine.ramFree == null ? null : ramPhysical != null ? Math.min(machine.ramFree, ramPhysical) : machine.ramFree;
  let ramUsable: number | null = null;
  let mode: "live" | "planning" = "planning";
  if (ramFree != null) {
    // Small devices (4 GB boards) can't spare the default 2 GiB: cap it at a quarter of physical
    // RAM. A reserve the user set themselves is used as is.
    const userSet = r.liveRamReserveGiB !== DEFAULT_RESERVES.liveRamReserveGiB;
    const reserve = !userSet && ramPhysical != null ? Math.min(r.liveRamReserveGiB * GiB, ramPhysical / 4) : r.liveRamReserveGiB * GiB;
    ramUsable = Math.max(0, ramFree - reserve);
    mode = "live";
    notes.push(`RAM: measured ${fmtBytes(ramFree)} available − ${fmtBytes(reserve)} reserve for OS and apps`);
  } else if (ramPhysical != null) {
    ramUsable = ramPhysical * (1 - r.planningRamReservePct / 100);
    notes.push(`RAM (planning mode): ${fmtBytes(ramPhysical)} × (1 − ${r.planningRamReservePct}% reserve)`);
  }
  const ramCeiling = ramPhysical != null ? Math.max(0, ramPhysical - OS_FLOOR) : null;

  const base: Pools = {
    arch: machine.arch,
    mode,
    ramMode: mode,
    vramMode: null,
    vramPhysical: null,
    vramFree: null,
    vramUsable: null,
    ramPhysical,
    ramFree,
    ramUsable,
    ramCeiling,
    unifiedGpuLimit: null,
    notes,
  };

  if (machine.arch === "discrete" && machine.gpus.length) {
    const used = machine.combineGpus ? machine.gpus : machine.gpus.slice(0, 1);
    if (!machine.combineGpus && machine.gpus.length > 1) notes.push("Multiple GPUs selected but not combined: only the first GPU's memory is counted.");
    const sum = (xs: (number | null)[]) => (xs.some((x) => x == null) ? null : xs.reduce<number>((a, x) => a + (x as number), 0));
    const physical = sum(used.map((g) => g.vramTotal));
    const free = planning ? null : sum(used.map((g) => (g.vramFree != null && g.vramTotal != null ? Math.min(g.vramFree, g.vramTotal) : g.vramFree)));
    base.vramPhysical = physical;
    base.vramFree = free;
    if (free != null) {
      base.vramUsable = Math.max(0, free - r.liveVramSafetyGiB * GiB * used.length);
      base.vramMode = "live";
      notes.push(`VRAM: measured ${fmtBytes(free)} free − ${r.liveVramSafetyGiB} GiB safety margin`);
    } else if (physical != null) {
      base.vramUsable = physical * (1 - r.planningVramReservePct / 100);
      base.mode = "planning";
      base.vramMode = "planning";
      notes.push(`VRAM (planning mode): ${fmtBytes(physical)} × (1 − ${r.planningVramReservePct}% reserve)`);
    } else {
      notes.push("VRAM unknown: enter it in Your Machine to get a GPU estimate.");
    }
  }

  if (machine.arch === "unified" && ramPhysical != null) {
    let limit = machine.unifiedGpuLimit;
    if (limit == null) {
      limit = ramPhysical * (ramPhysical <= 36 * GiB ? 2 / 3 : 0.75);
      notes.push(`GPU working-set limit not exposed; assumed ${fmtBytes(limit)} (≈${ramPhysical <= 36 * GiB ? "⅔" : "¾"} of unified memory). Editable.`);
    } else {
      notes.push(`GPU working-set limit ${fmtBytes(limit)} (${machine.unifiedGpuLimitSource})`);
    }
    base.unifiedGpuLimit = limit;
    notes.push("Unified memory is ONE pool shared by CPU and GPU; it is never counted twice.");
  }
  return base;
}

// ------------------------------------------------------------------ classification core

interface Needs {
  W: number;
  A: number | null;
  KV: number;
  scratch: number;
  vision: number;
  backend: number;
  host: number;
}

interface Solved {
  cls: FitClass;
  placement: Placement | null;
  gpuMargin: number | null;
  memoryMargin: number | null;
}

function solve(n: Needs, pools: Pools, machine: MachineProfile, moe: boolean): Solved {
  const ramUsable = pools.ramUsable;
  const ramCeiling = pools.ramCeiling;
  if (ramUsable == null) return { cls: "unknown", placement: null, gpuMargin: null, memoryMargin: null };

  const cpuOnly = (): Solved => {
    const total = n.W + n.KV + n.scratch + n.vision + n.host;
    const placement: Placement = { gpuWeights: 0, cpuWeights: n.W, gpuKv: 0, cpuKv: n.KV, gpuOther: 0, hostOther: n.scratch + n.vision + n.host, gpuFraction: 0 };
    const margin = ramUsable - total;
    if (total <= ramUsable) return { cls: "cpu_only", placement, gpuMargin: null, memoryMargin: margin };
    if (ramCeiling != null && total <= ramCeiling) return { cls: "memory_constrained", placement, gpuMargin: null, memoryMargin: margin };
    return { cls: "cannot_fit", placement, gpuMargin: null, memoryMargin: margin };
  };

  if (machine.arch === "cpu_only" || machine.arch === "integrated_shared" || machine.gpuBackendSupported === false) return cpuOnly();

  if (machine.arch === "unified") {
    const limit = pools.unifiedGpuLimit ?? 0;
    const gpuNeed = n.W + n.KV + n.scratch + n.vision;
    const total = gpuNeed + n.host;
    const memoryMargin = ramUsable - total;
    const fixed = n.scratch + n.vision;
    const f = gpuNeed <= limit ? 1 : clamp((limit - fixed) / (n.W + n.KV), 0, 1);
    const placement: Placement = {
      gpuWeights: f * n.W,
      cpuWeights: (1 - f) * n.W,
      gpuKv: f * n.KV,
      cpuKv: (1 - f) * n.KV,
      gpuOther: fixed,
      hostOther: n.host,
      gpuFraction: f,
    };
    const gpuMargin = limit - gpuNeed;
    if (total > ramUsable) {
      if (ramCeiling != null && total <= ramCeiling) return { cls: "memory_constrained", placement, gpuMargin, memoryMargin };
      return { cls: "cannot_fit", placement, gpuMargin, memoryMargin };
    }
    if (gpuNeed <= limit) return { cls: "full_gpu", placement, gpuMargin, memoryMargin };
    if (moe && n.A != null && n.A + n.KV + fixed <= limit) return { cls: "promising_moe", placement, gpuMargin, memoryMargin };
    return { cls: "hybrid_slow", placement, gpuMargin, memoryMargin };
  }

  // Discrete GPU
  const V = pools.vramUsable;
  if (V == null) return { cls: "unknown", placement: null, gpuMargin: null, memoryMargin: null };
  const fixed = n.scratch + n.vision + n.backend;
  const layered = n.W + n.KV;
  const fullNeed = layered + fixed;
  const gpuMargin = V - fullNeed;
  if (fullNeed <= V) {
    const placement: Placement = { gpuWeights: n.W, cpuWeights: 0, gpuKv: n.KV, cpuKv: 0, gpuOther: fixed, hostOther: n.host, gpuFraction: 1 };
    const memoryMargin = ramUsable - n.host;
    if (n.host > ramUsable) {
      if (ramCeiling != null && n.host <= ramCeiling) return { cls: "memory_constrained", placement, gpuMargin, memoryMargin };
      return { cls: "cannot_fit", placement, gpuMargin, memoryMargin };
    }
    return { cls: "full_gpu", placement, gpuMargin, memoryMargin };
  }
  if (V <= fixed) return cpuOnly();
  const f = clamp((V - fixed) / layered, 0, 1);
  const placement: Placement = {
    gpuWeights: f * n.W,
    cpuWeights: (1 - f) * n.W,
    gpuKv: f * n.KV,
    cpuKv: (1 - f) * n.KV,
    gpuOther: fixed,
    hostOther: n.host,
    gpuFraction: f,
  };
  const ramNeed = placement.cpuWeights + placement.cpuKv + n.host;
  const memoryMargin = ramUsable - ramNeed;
  if (ramNeed > ramUsable) {
    if (ramCeiling != null && ramNeed <= ramCeiling) return { cls: "memory_constrained", placement, gpuMargin, memoryMargin };
    return { cls: "cannot_fit", placement, gpuMargin, memoryMargin };
  }
  if (moe && n.A != null && n.A + n.KV + fixed <= V) return { cls: "promising_moe", placement, gpuMargin, memoryMargin };
  return { cls: "hybrid_slow", placement, gpuMargin, memoryMargin };
}

const CLASS_ORDER: FitClass[] = ["full_gpu", "promising_moe", "cpu_only", "hybrid_slow", "memory_constrained", "cannot_fit", "unknown"];

export const CLASS_META: Record<FitClass, { title: string; short: string; tone: "good" | "ok" | "warn" | "bad" | "neutral" }> = {
  full_gpu: { title: "Fully GPU", short: "Fits in GPU", tone: "good" },
  promising_moe: { title: "Promising hybrid MoE", short: "Hybrid MoE", tone: "ok" },
  hybrid_slow: { title: "Hybrid likely slow", short: "Hybrid · slow", tone: "warn" },
  cpu_only: { title: "CPU only", short: "CPU only", tone: "warn" },
  memory_constrained: { title: "Memory constrained", short: "Tight", tone: "warn" },
  cannot_fit: { title: "Cannot fit", short: "Won't fit", tone: "bad" },
  unknown: { title: "Unknown", short: "Needs verification", tone: "neutral" },
};

export const RESPONSIVENESS_TEXT: Record<Responsiveness, string> = {
  likely_fast: "Likely fast",
  reasonable: "Reasonable",
  potentially_slow: "Potentially slow",
  unknown: "Unknown",
};

// ------------------------------------------------------------------ main entry

export function estimate(model: ModelVariant, settings: EstimatorSettings, machine: MachineProfile): Estimate {
  const warnings: Warning[] = [];
  const assumptions: string[] = [];
  const equations: Line[] = [];

  const w = estimateWeights(model, settings);
  const weights = w.text ? (w.vision ? addRanges(w.text, w.vision) : w.text) : null;
  const act = estimateActive(model, settings, w.text);
  const kv = estimateKv(model, settings);
  const moe = isMoE(model);

  // Compute scratch (llama.cpp/ggml compute graphs grow with context and batch).
  const ctxPar = settings.contextTokens * Math.max(1, settings.parallel);
  const scratchMid = settings.scratchOverrideGiB != null ? settings.scratchOverrideGiB * GiB : 0.3 * GiB + ctxPar * 6 * KiB;
  const scratch = settings.scratchOverrideGiB != null ? exact(scratchMid) : range(scratchMid * 0.6, scratchMid, scratchMid * 1.8);

  // Vision input.
  const imageStatus = resolveInput(model.capabilities, "image").status;
  let visionActivations = exact(0);
  let imageTokens = 0;
  if (settings.imageCount > 0) {
    if (imageStatus === "verified_unsupported" || imageStatus === "unknown") {
      warnings.push({
        level: "danger",
        text:
          imageStatus === "verified_unsupported"
            ? "This model cannot read images. Use a vision model, or extract text with OCR first and send the text."
            : "Image input is not confirmed for this model. Do not assume it can read images; verify the exact tag first, or use an OCR → text pipeline.",
      });
    } else {
      const perImg = clamp(0.1 * GiB * (settings.imageResolution / 896) ** 2, 0.03 * GiB, 0.6 * GiB);
      const mid = perImg * settings.imageCount;
      visionActivations = range(mid * 0.5, mid, mid * 2);
      const t = imageTokensPerImage(settings.imageResolution);
      imageTokens = t.mid * settings.imageCount;
      if (imageTokens > settings.contextTokens * 0.5)
        warnings.push({ level: "warn", text: `${settings.imageCount} image(s) may use ~${imageTokens.toLocaleString()} context tokens, over half of the ${settings.contextTokens.toLocaleString()} context.` });
      if (imageStatus === "family_suggests")
        warnings.push({ level: "warn", text: "Image support is only suggested by the model family. Verify this exact tag before relying on it." });
    }
  }

  const hasGpu = machine.arch === "discrete" && machine.gpuBackendSupported !== false;
  const backend = hasGpu ? range(0.3 * GiB, 0.45 * GiB, 0.7 * GiB) : exact(0);
  const hostRuntime = range(0.3 * GiB, 0.5 * GiB, 0.9 * GiB);
  const gpuRuntime = addRanges(kv.kv, scratch, visionActivations, backend);
  const pools = computePools(machine, settings);

  let classification: FitClass = "unknown";
  let classAtLevels = { low: "unknown" as FitClass, mid: "unknown" as FitClass, high: "unknown" as FitClass };
  let placement: Placement | null = null;
  let gpuMargin: number | null = null;
  let memoryMargin: number | null = null;
  const totalNeed = weights ? addRanges(weights, gpuRuntime, hostRuntime) : null;

  if (weights) {
    const at = (lvl: "low" | "mid" | "high"): Solved =>
      solve(
        {
          W: weights[lvl],
          A: act.active ? act.active[lvl] : null,
          KV: kv.kv[lvl],
          scratch: scratch[lvl],
          vision: visionActivations[lvl],
          backend: backend[lvl],
          host: hostRuntime[lvl],
        },
        pools,
        machine,
        moe,
      );
    const lo = at("low");
    const mi = at("mid");
    const hi = at("high");
    classAtLevels = { low: lo.cls, mid: mi.cls, high: hi.cls };
    classification = mi.cls;
    placement = mi.placement;
    gpuMargin = mi.gpuMargin;
    memoryMargin = mi.memoryMargin;
  } else {
    warnings.push({ level: "warn", text: "Estimate only: the size of this model is unknown. Check the actual tagged file size (Verify from Ollama)." });
  }

  // ---- confidence
  let confidence: EstConfidence = "high";
  const downgrade = () => (confidence = confidence === "high" ? "medium" : "low");
  if (w.provenance !== "verified") downgrade();
  if (kv.method === "heuristic") downgrade();
  if (pools.mode === "planning") assumptions.push("Planning mode: no live free-memory reading, so fixed reserve percentages are used.");
  if (classification === "promising_moe" && confidence === "high") confidence = "medium";
  if (act.provenance === "estimated" && classification === "promising_moe") confidence = "low";
  const spread = new Set([classAtLevels.low, classAtLevels.mid, classAtLevels.high]);
  if (spread.size > 1) {
    confidence = "low";
    const best = CLASS_ORDER.find((c) => spread.has(c))!;
    const worst = [...CLASS_ORDER].reverse().find((c) => spread.has(c))!;
    warnings.push({ level: "warn", text: `Borderline: within the uncertainty range the result could be anywhere from "${CLASS_META[best].title}" to "${CLASS_META[worst].title}".` });
  }
  // Every uncertainty bound agrees and there is lots of headroom: the answer is robust
  // even though some inputs are estimates.
  const capRef = classification === "full_gpu" ? (machine.arch === "unified" ? pools.unifiedGpuLimit : pools.vramUsable) : pools.ramUsable;
  const headroom = classification === "full_gpu" ? gpuMargin : memoryMargin;
  if (spread.size === 1 && confidence === "low" && headroom != null && capRef && headroom / capRef > 0.3 && classification !== "promising_moe") confidence = "medium";
  if (classification === "unknown") confidence = "low";
  // GPU results on a GPU whose Ollama support isn't confirmed (AMD, Intel, unrecognised) are never "high".
  if (machine.arch === "discrete" && machine.gpuBackendSupported == null && (placement?.gpuFraction ?? 0) > 0 && confidence === "high") confidence = "medium";

  // ---- responsiveness (qualitative only — no tok/s claims)
  const speedBytes = act.active?.mid ?? weights?.mid ?? null;
  let responsiveness: Responsiveness = "unknown";
  if (speedBytes != null) {
    switch (classification) {
      case "full_gpu":
        responsiveness = machine.arch === "unified" ? (speedBytes <= 6e9 ? "likely_fast" : speedBytes <= 20e9 ? "reasonable" : "potentially_slow") : speedBytes <= 12e9 ? "likely_fast" : "reasonable";
        break;
      case "promising_moe":
        responsiveness = "reasonable";
        break;
      case "cpu_only":
        responsiveness = speedBytes <= 2.5e9 ? "reasonable" : "potentially_slow";
        break;
      case "hybrid_slow":
      case "memory_constrained":
        responsiveness = "potentially_slow";
        break;
      default:
        responsiveness = "unknown";
    }
  }
  if (!act.active && weights) assumptions.push("Active parameters unknown: speed hints conservatively assume every weight is read for each token.");

  const textWeights = weights && w.text ? w.text.mid : 0;
  const speed = weights ? guessSpeed(classification, placement, act.active?.mid ?? textWeights, kv.perToken.mid, settings, machine) : null;
  if (speed) {
    responsiveness = speed.range.mid >= 25 ? "likely_fast" : speed.range.mid >= 8 ? "reasonable" : "potentially_slow";
    equations.push({
      label: "Speed guess",
      value: fmtSpeed(speed.range),
      detail: `≈ ${speed.gbPerToken.toFixed(2)} GB read per token${speed.gpuBandwidthGBs ? ` · GPU ${speed.gpuBandwidthGBs} GB/s` : ""}${speed.cpuShare > 0.001 ? ` · ${Math.round(speed.cpuShare * 100)}% from RAM` : ""} · 50–80% of peak bandwidth · slow end = full context, fast end = new chat`,
      provenance: "heuristic",
    });
  }

  // ---- context checks
  const ctxMax = model.contextMax.value ?? model.arch?.contextLength ?? null;
  if (ctxMax && settings.contextTokens > ctxMax)
    warnings.push({ level: "danger", text: `Selected context (${settings.contextTokens.toLocaleString()}) exceeds this model's maximum (${ctxMax.toLocaleString()}).` });
  if (!ctxMax) assumptions.push("Model's maximum context is unknown; the selected context may not be supported.");
  if (settings.kvCacheType !== "f16") assumptions.push(`${settings.kvCacheType} KV cache requires flash attention to be enabled in Ollama (OLLAMA_FLASH_ATTENTION=1).`);

  // ---- quantization honesty
  if (w.source === "hypothetical" || w.source === "derived_from_artifact") {
    warnings.push({
      level: "info",
      text: `No published ${quantInfo(settings.quant).label} file is known for this model. This is a hypothetical size, not a download that exists.`,
    });
  }
  if (moe) {
    assumptions.push("MoE: all experts are counted in the weights (W). Active weights change token by token and are a compute footprint, not a statement of which experts are on the GPU.");
  }
  if (classification === "promising_moe") {
    warnings.push({
      level: "info",
      text: "Only a subset of experts is used per token, so CPU-side experts cost less than dense layers. Real speed depends on how the runtime places experts (Ollama splits by layers by default) and must be measured.",
    });
  }
  if (classification === "hybrid_slow" || classification === "promising_moe") {
    warnings.push({ level: "info", text: "Planned offload is a simulation. Ollama decides real layer placement at load time; check `ollama ps` or run a test." });
  }
  if (machine.arch === "discrete" && machine.gpuBackendSupported == null) {
    warnings.push({ level: "warn", text: "Ollama GPU support for this GPU is not confirmed; it may run on the CPU instead." });
  }
  if (classification === "memory_constrained") {
    warnings.push({ level: "warn", text: "It only fits by using memory reserved for your OS and apps. Expect swapping to disk, which is far slower. Disk/NVMe swap is not RAM." });
  }

  // ---- equations ("Why this result?")
  if (weights)
    equations.push({ label: "Weights (W)", value: fmtRange(weights, "GB") + " / " + fmtRange(weights), detail: w.detail, provenance: w.provenance });
  else equations.push({ label: "Weights (W)", value: "Unknown", detail: w.detail, provenance: "unknown" });
  if (w.vision) equations.push({ label: "  incl. vision encoder", value: fmtRange(w.vision), detail: w.visionKnown ? "Projector blob from the published manifest" : "Not published separately: heuristic range", provenance: w.visionKnown ? w.provenance : "heuristic" });
  equations.push({ label: "Active per token (A)", value: act.active ? fmtRange(act.active) : "Unknown", detail: act.detail, provenance: act.provenance });
  equations.push({ label: "KV cache", value: fmtRange(kv.kv), detail: `${kv.detail} × ${settings.contextTokens.toLocaleString()} ctx × ${settings.parallel} parallel`, provenance: kv.method === "metadata" ? "derived" : "heuristic" });
  equations.push({ label: "Compute scratch", value: fmtRange(scratch), detail: settings.scratchOverrideGiB != null ? "User-set allowance" : "0.3 GiB + 6 KiB × ctx × parallel, range ×0.6–×1.8", provenance: settings.scratchOverrideGiB != null ? "setting" : "heuristic" });
  if (settings.imageCount > 0) equations.push({ label: "Image activations", value: fmtRange(visionActivations), detail: `${settings.imageCount} × ~0.1 GiB × (${settings.imageResolution}px ÷ 896)²`, provenance: "heuristic" });
  if (hasGpu) equations.push({ label: "GPU backend context", value: fmtRange(backend), detail: "CUDA/ROCm/Vulkan context and engine allocations", provenance: "heuristic" });
  equations.push({ label: "Host runtime", value: fmtRange(hostRuntime), detail: "Runner process, tokenizer, staging buffers", provenance: "heuristic" });
  if (totalNeed) equations.push({ label: "Total need", value: fmtRange(totalNeed), detail: "W + KV + scratch + images + backend + host", provenance: "derived" });
  for (const n of pools.notes) assumptions.push(n);
  if (pools.vramUsable != null) equations.push({ label: "Usable VRAM (V)", value: fmtBytes(pools.vramUsable), detail: pools.vramMode === "live" ? "Live free VRAM − safety" : "Planning reserve", provenance: pools.mode === "live" ? "measured" : "setting" });
  if (machine.arch === "unified" && pools.unifiedGpuLimit != null) equations.push({ label: "GPU working-set limit", value: fmtBytes(pools.unifiedGpuLimit), detail: machine.unifiedGpuLimitSource, provenance: machine.unifiedGpuLimitSource === "detected" ? "measured" : "setting" });
  if (pools.ramUsable != null) equations.push({ label: machine.arch === "unified" ? "Usable unified memory (U)" : "Usable RAM (R)", value: fmtBytes(pools.ramUsable), detail: pools.ramFree != null ? "Live available − reserve" : "Planning reserve", provenance: pools.ramFree != null ? "measured" : "setting" });

  const { headline, summary } = describe(classification, machine, placement, responsiveness, weights == null);

  return {
    modelId: model.id,
    quant: settings.quant,
    quantSource: w.source,
    artifact: w.artifact,
    weights,
    weightsProvenance: w.provenance,
    visionEncoder: w.vision,
    visionEncoderKnown: w.visionKnown,
    active: act.active,
    activeProvenance: act.provenance,
    kv: kv.kv,
    kvMethod: kv.method,
    kvPerToken: kv.perToken,
    scratch,
    visionActivations,
    backend,
    hostRuntime,
    gpuRuntime,
    totalNeed,
    pools,
    placement,
    classification,
    classAtLevels,
    confidence,
    responsiveness,
    headline,
    summary,
    gpuMargin,
    memoryMargin,
    warnings,
    equations,
    assumptions,
    imageTokens,
    isMoE: moe,
    speed,
  };
}

function describe(cls: FitClass, machine: MachineProfile, p: Placement | null, resp: Responsiveness, sizeUnknown: boolean) {
  const pct = p ? Math.round(p.gpuFraction * 100) : 0;
  const unified = machine.arch === "unified";
  switch (cls) {
    case "full_gpu":
      return {
        headline: unified ? "Fits in GPU-usable unified memory" : "Weights likely fit in GPU",
        summary: `Fits entirely in ${unified ? "the memory your GPU can use" : "your graphics card's memory"}.${resp === "likely_fast" ? " Expect quick replies." : " Bigger models reply a little slower."}`,
      };
    case "promising_moe":
      return {
        headline: "Needs RAM offload, but MoE may stay usable",
        summary: `About ${pct}% fits on the GPU, the rest goes to RAM. Only a few experts work per word, so it may still run well. A quick test will tell.`,
      };
    case "hybrid_slow":
      return {
        headline: "Needs RAM offload; generation may slow down",
        summary: `Only about ${pct}% fits on the GPU. The rest runs on the CPU from RAM, which is much slower.`,
      };
    case "cpu_only":
      return {
        headline: "Runs on the CPU from system RAM",
        summary: machine.arch === "integrated_shared" ? "Fits in RAM and runs on the CPU (integrated graphics isn't used). Expect slower replies." : "No usable GPU, but it fits in RAM. Expect slower replies.",
      };
    case "memory_constrained":
      return { headline: "Only fits if you free up memory", summary: "Fits only if you close other apps; otherwise it may swap to disk and crawl." };
    case "cannot_fit":
      return { headline: "Too large for this computer", summary: "Needs more memory than this computer has, even with offloading. Try a smaller model or lower precision." };
    default:
      return {
        headline: "Needs verification",
        summary: sizeUnknown ? "Model size unknown. Check the actual tagged file size (Verify from Ollama) to get an estimate." : "Some hardware details are missing. Add them to get an estimate.",
      };
  }
}
