import { emptyCapabilities } from "../domain/capabilities";
import { INPUT_CAPS, type ArchMeta, type Artifact, type BenchmarkRecord, type Capabilities, type CapEvidence, type CapRecord, type InputCap, type ModelVariant, type Provenance, type Sourced } from "../domain/types";
import { normalizeQuant } from "../domain/quant";
import type { OllamaVerification } from "./ollamaOfficial";

// Checks and repairs data that comes from outside (JSON import, saved data from older
// versions). Every field the app reads is type-checked; anything that can't be repaired is
// dropped, so one bad record can't break rendering or the catalog.

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown, d = ""): string => (typeof x === "string" ? x : d);
const optStr = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
const finite = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const pos = (x: unknown): number | null => {
  const n = finite(x);
  return n != null && n > 0 ? n : null;
};
const optNum = (x: unknown): number | undefined => finite(x) ?? undefined;
const optPos = (x: unknown): number | undefined => pos(x) ?? undefined;
/** ISO-like date strings only (compared with localeCompare / Date.parse elsewhere). */
const date = (x: unknown): string | undefined => (typeof x === "string" && !Number.isNaN(Date.parse(x)) ? x : undefined);

const PROVENANCE: Provenance[] = ["verified", "derived", "estimated", "user_entered", "unknown"];
const provenance = (x: unknown, d: Provenance = "unknown"): Provenance => (PROVENANCE.includes(x as Provenance) ? (x as Provenance) : d);
const STATUS = ["verified_supported", "verified_unsupported", "family_suggests", "unknown"] as const;
const SCOPE = ["ollama_tag", "ollama_local", "model_card", "family", "smoke_test", "user"] as const;

export function sanitizeEvidence(x: unknown): CapEvidence | null {
  if (!isObj(x) || !STATUS.includes(x.status as never) || !SCOPE.includes(x.scope as never)) return null;
  return {
    status: x.status as CapEvidence["status"],
    scope: x.scope as CapEvidence["scope"],
    source: str(x.source, "Imported"),
    sourceUrl: optStr(x.sourceUrl),
    checkedAt: date(x.checkedAt),
    note: optStr(x.note),
  };
}

function capRecord(x: unknown): CapRecord {
  return { evidence: isObj(x) && Array.isArray(x.evidence) ? x.evidence.map(sanitizeEvidence).filter((e): e is CapEvidence => !!e) : [] };
}

export function sanitizeCapabilities(x: unknown): Capabilities {
  const c = emptyCapabilities();
  if (!isObj(x)) return c;
  for (const k of Object.keys(c.inputs) as (keyof Capabilities["inputs"])[]) c.inputs[k] = capRecord(isObj(x.inputs) ? x.inputs[k] : null);
  for (const k of Object.keys(c.outputs) as (keyof Capabilities["outputs"])[]) c.outputs[k] = capRecord(isObj(x.outputs) ? x.outputs[k] : null);
  c.thinking = capRecord(x.thinking);
  return c;
}

export function sanitizeArtifact(x: unknown): Artifact | null {
  if (!isObj(x) || typeof x.quant !== "string") return null;
  const weight = finite(x.weightBytes);
  if (weight == null || weight < 0) return null;
  const label = str(x.quantLabel, x.quant);
  return {
    quant: normalizeQuant(label),
    quantLabel: label,
    tag: optStr(x.tag),
    digest: optStr(x.digest),
    weightBytes: weight,
    projectorBytes: optPos(x.projectorBytes),
    downloadBytes: optPos(x.downloadBytes),
    provenance: provenance(x.provenance, "user_entered"),
    source: str(x.source, "Imported"),
    sourceUrl: optStr(x.sourceUrl),
    checkedAt: date(x.checkedAt),
    isDefaultTag: x.isDefaultTag === true,
  };
}

export function sanitizeArch(x: unknown): ArchMeta | null {
  if (!isObj(x) || pos(x.layers) == null) return null;
  return {
    archName: optStr(x.archName),
    layers: optPos(x.layers),
    kvHeads: optPos(x.kvHeads),
    keyDim: optPos(x.keyDim),
    valueDim: optPos(x.valueDim),
    embeddingLength: optPos(x.embeddingLength),
    contextLength: optPos(x.contextLength),
    slidingWindow: optPos(x.slidingWindow),
    expertCount: optPos(x.expertCount),
    expertUsedCount: optPos(x.expertUsedCount),
    vocabSize: optPos(x.vocabSize),
    kvLoraRank: optPos(x.kvLoraRank),
    provenance: provenance(x.provenance, "user_entered"),
    source: str(x.source, "Imported"),
    sourceUrl: optStr(x.sourceUrl),
    checkedAt: date(x.checkedAt),
  };
}

function sourced<T>(x: unknown, check: (v: unknown) => T | null): Sourced<T> {
  if (!isObj(x)) return { value: null, provenance: "unknown" };
  const value = check(x.value);
  return {
    value,
    provenance: value == null ? "unknown" : provenance(x.provenance, "user_entered"),
    source: optStr(x.source),
    sourceUrl: optStr(x.sourceUrl),
    checkedAt: date(x.checkedAt),
    note: optStr(x.note),
  };
}

/** A usable model record, or null when the input can't be repaired. */
export function sanitizeModel(x: unknown): ModelVariant | null {
  if (!isObj(x) || typeof x.id !== "string" || !x.id.trim() || typeof x.displayName !== "string") return null;
  const total = sourced(x.totalParamsB, pos);
  // Active parameters must be positive and no larger than the total.
  const active = sourced(x.activeParamsB, (v) => {
    const n = pos(v);
    return n != null && (total.value == null || n <= total.value) ? n : null;
  });
  const ORIGINS = ["seed_csv", "ollama_library", "ollama_local", "huggingface", "user"];
  const USE_CASES = ["general", "coding", "reasoning", "embedding", "vision", "math", "safety", "ocr"];
  return {
    id: x.id,
    family: str(x.family, x.id.split(":")[0]),
    variant: str(x.variant),
    displayName: x.displayName,
    resolvedTag: typeof x.resolvedTag === "string" ? x.resolvedTag : null,
    lookupCandidate: str(x.lookupCandidate, x.id),
    developer: optStr(x.developer),
    description: optStr(x.description),
    origin: (ORIGINS.includes(x.origin as string) ? x.origin : "user") as ModelVariant["origin"],
    totalParamsB: total,
    activeParamsB: active,
    architecture: sourced(x.architecture, (v) => (v === "dense" || v === "moe" ? v : null)),
    contextMax: sourced(x.contextMax, pos),
    artifacts: Array.isArray(x.artifacts) ? x.artifacts.map(sanitizeArtifact).filter((a): a is Artifact => !!a) : [],
    arch: sanitizeArch(x.arch),
    capabilities: sanitizeCapabilities(x.capabilities),
    useCases: strs(x.useCases).filter((u) => USE_CASES.includes(u)) as ModelVariant["useCases"],
    sourceUrls: strs(x.sourceUrls),
    lastVerified: date(x.lastVerified) ?? null,
    seedSnapshotDate: date(x.seedSnapshotDate),
    cloudOnly: x.cloudOnly === true,
    notes: strs(x.notes),
    // installed info is local to the machine it came from: never imported
  };
}

/** A usable live verification, or null. */
export function sanitizeVerification(x: unknown): OllamaVerification | null {
  if (!isObj(x) || typeof x.family !== "string" || typeof x.variant !== "string" || !Array.isArray(x.artifacts)) return null;
  const checkedAt = date(x.checkedAt);
  if (!checkedAt) return null;
  return {
    family: x.family,
    variant: x.variant,
    defaultTag: isObj(x.defaultTag) && typeof x.defaultTag.name === "string" ? (x.defaultTag as unknown as OllamaVerification["defaultTag"]) : null,
    artifacts: x.artifacts.map(sanitizeArtifact).filter((a): a is Artifact => !!a),
    arch: sanitizeArch(x.arch),
    totalParamsB: pos(x.totalParamsB),
    contextTokens: pos(x.contextTokens),
    capabilities: sanitizeCapabilities(x.capabilities),
    summary: str(x.summary),
    cloudOnly: x.cloudOnly === true,
    checkedAt,
    errors: strs(x.errors),
  };
}

/** A usable benchmark, or null. */
export function sanitizeBenchmark(x: unknown): BenchmarkRecord | null {
  if (!isObj(x) || typeof x.id !== "string" || typeof x.model !== "string" || (x.kind !== "cold" && x.kind !== "warm")) return null;
  const createdAt = date(x.createdAt);
  const ctx = pos(x.contextTokens);
  if (!createdAt || ctx == null) return null;
  const PLACEMENTS = ["gpu_100", "mixed", "cpu_100", "unknown"];
  return {
    id: x.id,
    createdAt,
    model: x.model,
    digest: optStr(x.digest),
    quantLabel: optStr(x.quantLabel),
    parameterSize: optStr(x.parameterSize),
    contextTokens: ctx,
    temperature: finite(x.temperature) ?? 0,
    ollamaVersion: optStr(x.ollamaVersion),
    gpuName: optStr(x.gpuName),
    driverVersion: optStr(x.driverVersion),
    osName: optStr(x.osName),
    backend: optStr(x.backend),
    powerSource: optStr(x.powerSource),
    kind: x.kind,
    promptEvalCount: optNum(x.promptEvalCount),
    promptEvalDurationNs: optNum(x.promptEvalDurationNs),
    evalCount: optNum(x.evalCount),
    evalDurationNs: optNum(x.evalDurationNs),
    loadDurationNs: optNum(x.loadDurationNs),
    totalDurationNs: optNum(x.totalDurationNs),
    ttftMs: optNum(x.ttftMs),
    wallMs: finite(x.wallMs) ?? 0,
    generationTokPerSec: optPos(x.generationTokPerSec),
    promptTokPerSec: optPos(x.promptTokPerSec),
    peakRamUsedBytes: optNum(x.peakRamUsedBytes),
    baselineRamUsedBytes: optNum(x.baselineRamUsedBytes),
    peakVramUsedBytes: optNum(x.peakVramUsedBytes),
    baselineVramUsedBytes: optNum(x.baselineVramUsedBytes),
    residentBytes: optNum(x.residentBytes),
    residentVramBytes: optNum(x.residentVramBytes),
    placement: PLACEMENTS.includes(x.placement as string) ? (x.placement as BenchmarkRecord["placement"]) : undefined,
    predictedClass: optStr(x.predictedClass),
    predictedTotalBytes: optNum(x.predictedTotalBytes),
    notes: strs(x.notes),
    importedFrom: optStr(x.importedFrom),
  };
}

/** Capability notes per model id: only known capability keys with valid evidence. */
export function sanitizeCapabilityEvidence(x: unknown): Record<string, { key: InputCap; ev: CapEvidence }[]> {
  const out: Record<string, { key: InputCap; ev: CapEvidence }[]> = {};
  if (!isObj(x)) return out;
  for (const [id, list] of Object.entries(x)) {
    if (!Array.isArray(list)) continue;
    const ok = list
      .map((item) => (isObj(item) && INPUT_CAPS.includes(item.key as InputCap) ? { key: item.key as InputCap, ev: sanitizeEvidence(item.ev) } : null))
      .filter((v): v is { key: InputCap; ev: CapEvidence } => !!v && !!v.ev);
    if (ok.length) out[id] = ok;
  }
  return out;
}

/** Applies a sanitizer to every value of a record, dropping the ones it rejects. */
export function sanitizeMap<T>(x: unknown, fn: (v: unknown) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isObj(x)) return out;
  for (const [k, v] of Object.entries(x)) {
    const s = fn(v);
    if (s) out[k] = s;
  }
  return out;
}
