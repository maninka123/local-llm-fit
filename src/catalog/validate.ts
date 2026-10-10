import { emptyCapabilities } from "../domain/capabilities";
import type { Artifact, Capabilities, CapRecord, ModelVariant, Sourced } from "../domain/types";

// Checks and repairs model records that come from outside (JSON import, saved data from older
// versions). Anything that can't be repaired is rejected, so one bad record can't break the app.

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown, d = ""): string => (typeof x === "string" ? x : d);
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
const finite = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

function sourced<T>(x: unknown, check: (v: unknown) => T | null): Sourced<T> {
  if (!isObj(x)) return { value: null, provenance: "unknown" };
  const value = check(x.value);
  return { ...(x as unknown as Sourced<T>), value, provenance: value == null ? "unknown" : ((x.provenance as Sourced<T>["provenance"]) ?? "user_entered") };
}

function capRecord(x: unknown): CapRecord {
  return isObj(x) && Array.isArray(x.evidence) ? { evidence: x.evidence.filter(isObj) as unknown as CapRecord["evidence"] } : { evidence: [] };
}

function capabilities(x: unknown): Capabilities {
  const c = emptyCapabilities();
  if (!isObj(x)) return c;
  for (const k of Object.keys(c.inputs) as (keyof Capabilities["inputs"])[]) c.inputs[k] = capRecord(isObj(x.inputs) ? x.inputs[k] : null);
  for (const k of Object.keys(c.outputs) as (keyof Capabilities["outputs"])[]) c.outputs[k] = capRecord(isObj(x.outputs) ? x.outputs[k] : null);
  c.thinking = capRecord(x.thinking);
  return c;
}

function artifact(x: unknown): Artifact | null {
  if (!isObj(x) || typeof x.quant !== "string") return null;
  const weight = finite(x.weightBytes);
  if (weight == null || weight < 0) return null;
  return { ...(x as unknown as Artifact), weightBytes: weight, quantLabel: str(x.quantLabel, x.quant) };
}

/** A usable model record, or null when the input can't be repaired. */
export function sanitizeModel(x: unknown): ModelVariant | null {
  if (!isObj(x) || typeof x.id !== "string" || !x.id.trim() || typeof x.displayName !== "string") return null;
  const total = sourced(x.totalParamsB, (v) => (finite(v) != null && (v as number) > 0 ? (v as number) : null));
  // Active parameters must be positive and no larger than the total.
  const active = sourced(x.activeParamsB, (v) => {
    const n = finite(v);
    return n != null && n > 0 && (total.value == null || n <= total.value) ? n : null;
  });
  return {
    ...(x as unknown as ModelVariant),
    id: x.id,
    family: str(x.family, x.id.split(":")[0]),
    variant: str(x.variant),
    displayName: x.displayName,
    resolvedTag: typeof x.resolvedTag === "string" ? x.resolvedTag : null,
    lookupCandidate: str(x.lookupCandidate, x.id),
    origin: (str(x.origin, "user") as ModelVariant["origin"]) || "user",
    totalParamsB: total,
    activeParamsB: active,
    architecture: sourced(x.architecture, (v) => (v === "dense" || v === "moe" ? v : null)),
    contextMax: sourced(x.contextMax, (v) => (finite(v) != null && (v as number) > 0 ? (v as number) : null)),
    artifacts: Array.isArray(x.artifacts) ? x.artifacts.map(artifact).filter((a): a is Artifact => !!a) : [],
    arch: isObj(x.arch) && finite(x.arch.layers) != null ? (x.arch as unknown as ModelVariant["arch"]) : null,
    capabilities: capabilities(x.capabilities),
    useCases: strs(x.useCases) as ModelVariant["useCases"],
    sourceUrls: strs(x.sourceUrls),
    lastVerified: typeof x.lastVerified === "string" ? x.lastVerified : null,
    notes: strs(x.notes),
  };
}
