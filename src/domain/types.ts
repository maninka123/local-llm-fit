// Core domain types shared by the catalog, estimator and UI.
// Every model fact carries provenance so the UI never presents a guess as a measurement.

export type Provenance = "verified" | "derived" | "estimated" | "user_entered" | "unknown";

export interface Sourced<T> {
  value: T | null;
  provenance: Provenance;
  /** Human readable source, e.g. "Ollama registry manifest" or "Seed CSV (heuristic)". */
  source?: string;
  sourceUrl?: string;
  /** ISO timestamp of when the value was checked/recorded. */
  checkedAt?: string;
  note?: string;
}

export const unknownValue = <T>(note?: string): Sourced<T> => ({ value: null, provenance: "unknown", note });

// ---------------------------------------------------------------- capabilities

export type CapStatus = "verified_supported" | "verified_unsupported" | "family_suggests" | "unknown";
export type EvidenceScope = "ollama_tag" | "ollama_local" | "model_card" | "family" | "smoke_test" | "user";

export interface CapEvidence {
  status: CapStatus;
  scope: EvidenceScope;
  source: string;
  sourceUrl?: string;
  checkedAt?: string;
  note?: string;
}

export const INPUT_CAPS = ["text", "image", "audio", "video", "pdf"] as const;
export const OUTPUT_CAPS = ["text", "image", "audio", "embeddings", "json", "tools"] as const;
export type InputCap = (typeof INPUT_CAPS)[number];
export type OutputCap = (typeof OUTPUT_CAPS)[number];
export type CapKey = `in:${InputCap}` | `out:${OutputCap}` | "thinking";

/** All evidence collected for one capability, plus the resolved views. */
export interface CapRecord {
  evidence: CapEvidence[];
}

export interface Capabilities {
  inputs: Record<InputCap, CapRecord>;
  outputs: Record<OutputCap, CapRecord>;
  thinking: CapRecord;
}

// ---------------------------------------------------------------- quantization / artifacts

export type QuantId =
  | "F16"
  | "BF16"
  | "Q8_0"
  | "Q6_K"
  | "Q5_K_M"
  | "Q5_K_S"
  | "Q4_K_M"
  | "Q4_K_S"
  | "Q4_0"
  | "Q3_K_M"
  | "Q3_K_S"
  | "Q2_K"
  | "MXFP4"
  | "FP8"
  | "OTHER";

/** A published, downloadable model file (one Ollama tag or one GGUF file). */
export interface Artifact {
  quant: QuantId;
  /** Raw quantization label from the source (e.g. "Q4_K_M", "q4_K_M", "MXFP4"). */
  quantLabel: string;
  tag?: string;
  digest?: string;
  /** Main model weights blob in bytes. */
  weightBytes: number;
  /** Vision projector / encoder blob in bytes when published separately. */
  projectorBytes?: number;
  /** Bytes the user would download (all blobs). */
  downloadBytes?: number;
  provenance: Provenance;
  source: string;
  sourceUrl?: string;
  checkedAt?: string;
  isDefaultTag?: boolean;
}

/** Architecture metadata needed for a model-specific KV-cache estimate. */
export interface ArchMeta {
  archName?: string;
  layers?: number;
  kvHeads?: number;
  /** Per-head key dimension. */
  keyDim?: number;
  /** Per-head value dimension (defaults to keyDim). */
  valueDim?: number;
  embeddingLength?: number;
  contextLength?: number;
  slidingWindow?: number;
  expertCount?: number;
  expertUsedCount?: number;
  vocabSize?: number;
  /** Multi-head latent attention (DeepSeek style) compresses KV; formula differs. */
  kvLoraRank?: number;
  provenance: Provenance;
  source: string;
  sourceUrl?: string;
  checkedAt?: string;
}

export type ArchitectureKind = "dense" | "moe" | "unknown";
export type ModelOrigin = "seed_csv" | "ollama_library" | "ollama_local" | "huggingface" | "user";
export type UseCase = "general" | "coding" | "reasoning" | "embedding" | "vision" | "math" | "safety" | "ocr";

export interface InstalledInfo {
  name: string;
  digest: string;
  sizeBytes: number;
  quantLabel?: string;
  parameterSize?: string;
  modifiedAt?: string;
}

export interface ModelVariant {
  /** Stable key: origin-independent lookup key, e.g. "gemma3:4b". */
  id: string;
  family: string;
  variant: string;
  displayName: string;
  /** Ollama tag that was actually resolved against an official source (null when not verified). */
  resolvedTag: string | null;
  /** Candidate lookup string (seed CSV `suggested_lookup`); NOT a verified runnable command. */
  lookupCandidate: string;
  developer?: string;
  description?: string;
  origin: ModelOrigin;
  totalParamsB: Sourced<number>;
  activeParamsB: Sourced<number>;
  architecture: Sourced<ArchitectureKind>;
  contextMax: Sourced<number>;
  artifacts: Artifact[];
  arch: ArchMeta | null;
  capabilities: Capabilities;
  useCases: UseCase[];
  sourceUrls: string[];
  /** ISO timestamp of last verification against an official source; null = never. */
  lastVerified: string | null;
  /** Snapshot date of the seed data this record came from. */
  seedSnapshotDate?: string;
  cloudOnly?: boolean;
  installed?: InstalledInfo;
  /** Raw imported source fields, preserved verbatim. */
  raw?: Record<string, string>;
  notes: string[];
}

// ---------------------------------------------------------------- hardware

export type Confidence = "high" | "medium" | "low" | "none";

export interface Field<T> {
  value: T | null;
  source: string;
  confidence: Confidence;
  error?: string;
}

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "microsoft" | "other" | "unknown";
export type GpuKind = "discrete" | "integrated" | "unified" | "virtual" | "unknown";

export interface GpuDevice {
  id: string;
  name: string;
  vendor: GpuVendor;
  kind: GpuKind;
  /** True physical/dedicated VRAM. */
  dedicatedBytes: Field<number>;
  /** Currently free dedicated VRAM (live). */
  freeBytes: Field<number>;
  /** Windows "shared GPU memory" (system RAM the GPU may borrow). Informational ONLY. */
  sharedBytes: Field<number>;
  driverVersion?: string;
  backendHints: string[];
  external?: boolean;
}

export type FormFactor = "desktop" | "laptop" | "workstation" | "server" | "virtual_machine" | "unknown";
export type MemoryArchitecture = "discrete" | "unified" | "integrated_shared" | "cpu_only";

export interface HardwareReport {
  probeVersion: string;
  demo: boolean;
  detectedAt: string;
  os: { name: string; version: string; arch: string; kernel?: string };
  formFactor: Field<FormFactor>;
  formFactorEvidence: string[];
  hasBattery: Field<boolean>;
  isVirtualMachine: Field<boolean>;
  cpu: { brand: string; physicalCores: number | null; logicalCores: number | null };
  memory: { totalBytes: Field<number>; availableBytes: Field<number> };
  memoryArchitecture: Field<MemoryArchitecture>;
  /** Apple Silicon: Metal recommendedMaxWorkingSetSize, when exposed. */
  unifiedGpuWorkingSetBytes: Field<number>;
  gpus: GpuDevice[];
  errors: string[];
  notes: string[];
}

/** User overrides layered on top of detection. A null means "use detected". */
export interface HardwareOverrides {
  formFactor: FormFactor | null;
  memoryArchitecture: MemoryArchitecture | null;
  ramTotalGiB: number | null;
  ramFreeGiB: number | null;
  vramTotalGiB: number | null;
  vramFreeGiB: number | null;
  unifiedGpuLimitGiB: number | null;
  selectedGpuIds: string[] | null;
  /** Only when the user has verified their runtime actually splits a model across GPUs. */
  combineGpus: boolean;
}

export const EMPTY_OVERRIDES: HardwareOverrides = {
  formFactor: null,
  memoryArchitecture: null,
  ramTotalGiB: null,
  ramFreeGiB: null,
  vramTotalGiB: null,
  vramFreeGiB: null,
  unifiedGpuLimitGiB: null,
  selectedGpuIds: null,
  combineGpus: false,
};

// ---------------------------------------------------------------- benchmarks

export interface BenchmarkRecord {
  id: string;
  createdAt: string;
  model: string;
  digest?: string;
  quantLabel?: string;
  parameterSize?: string;
  contextTokens: number;
  temperature: number;
  ollamaVersion?: string;
  gpuName?: string;
  driverVersion?: string;
  osName?: string;
  backend?: string;
  powerSource?: string;
  kind: "cold" | "warm";
  promptEvalCount?: number;
  promptEvalDurationNs?: number;
  evalCount?: number;
  evalDurationNs?: number;
  loadDurationNs?: number;
  totalDurationNs?: number;
  /** Stream-measured: time from request start to first content chunk (includes load on cold runs). */
  ttftMs?: number;
  wallMs: number;
  generationTokPerSec?: number;
  promptTokPerSec?: number;
  peakRamUsedBytes?: number;
  baselineRamUsedBytes?: number;
  peakVramUsedBytes?: number;
  baselineVramUsedBytes?: number;
  /** From /api/ps: size_vram vs size. */
  residentBytes?: number;
  residentVramBytes?: number;
  placement?: "gpu_100" | "mixed" | "cpu_100" | "unknown";
  predictedClass?: string;
  predictedTotalBytes?: number;
  notes: string[];
}
