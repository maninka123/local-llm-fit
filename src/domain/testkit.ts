// Shared builders for unit tests.
import { emptyCapabilities, addEvidence } from "./capabilities";
import { DEFAULT_SETTINGS, type EstimatorSettings, type MachineProfile } from "./estimator";
import type { Artifact, ArchMeta, ModelVariant } from "./types";
import { GiB } from "../lib/units";

export function model(p: Partial<ModelVariant> & { total?: number | null; active?: number | null; moe?: boolean; dense?: boolean } = {}): ModelVariant {
  const { total = 8, active = null, moe = false, dense = false, ...rest } = p;
  const caps = emptyCapabilities();
  caps.inputs.text = addEvidence(caps.inputs.text, { status: "verified_supported", scope: "ollama_tag", source: "test" });
  return {
    id: "test:model",
    family: "test",
    variant: "x",
    displayName: "test:x",
    resolvedTag: null,
    lookupCandidate: "test:x",
    origin: "seed_csv",
    totalParamsB: total != null ? { value: total, provenance: "verified" } : { value: null, provenance: "unknown" },
    activeParamsB: active != null ? { value: active, provenance: "verified" } : { value: null, provenance: "unknown" },
    architecture: moe ? { value: "moe", provenance: "verified" } : dense ? { value: "dense", provenance: "verified" } : { value: null, provenance: "unknown" },
    contextMax: { value: 131072, provenance: "verified" },
    artifacts: [],
    arch: null,
    capabilities: caps,
    useCases: ["general"],
    sourceUrls: [],
    lastVerified: null,
    notes: [],
    ...rest,
  };
}

export function artifact(quant: Artifact["quant"], weightBytes: number, extra: Partial<Artifact> = {}): Artifact {
  return { quant, quantLabel: quant, weightBytes, downloadBytes: weightBytes, provenance: "verified", source: "test", isDefaultTag: true, ...extra };
}

export const ARCH_8B: ArchMeta = { layers: 32, kvHeads: 8, keyDim: 128, valueDim: 128, provenance: "verified", source: "test" };

export function discrete(vramTotalGiB: number, vramFreeGiB: number | null, ramTotalGiB: number, ramFreeGiB: number | null, more: Partial<MachineProfile> = {}): MachineProfile {
  return {
    arch: "discrete",
    gpus: [{ id: "g0", name: "GPU", vramTotal: vramTotalGiB * GiB, vramFree: vramFreeGiB != null ? vramFreeGiB * GiB : null }],
    combineGpus: false,
    ramTotal: ramTotalGiB * GiB,
    ramFree: ramFreeGiB != null ? ramFreeGiB * GiB : null,
    unifiedGpuLimit: null,
    unifiedGpuLimitSource: "assumed",
    gpuBackendSupported: true,
    label: "test",
    ...more,
  };
}

export function unified(totalGiB: number, freeGiB: number | null, limitGiB: number | null): MachineProfile {
  return {
    arch: "unified",
    gpus: [],
    combineGpus: false,
    ramTotal: totalGiB * GiB,
    ramFree: freeGiB != null ? freeGiB * GiB : null,
    unifiedGpuLimit: limitGiB != null ? limitGiB * GiB : null,
    unifiedGpuLimitSource: limitGiB != null ? "detected" : "assumed",
    gpuBackendSupported: true,
    label: "unified",
  };
}

export const settings = (p: Partial<EstimatorSettings> = {}): EstimatorSettings => ({ ...DEFAULT_SETTINGS, ...p });
