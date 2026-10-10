import {
  INPUT_CAPS,
  OUTPUT_CAPS,
  type Capabilities,
  type CapEvidence,
  type CapRecord,
  type CapStatus,
  type InputCap,
  type OutputCap,
} from "./types";

// Capability evidence model.
//
// Each capability keeps ALL evidence. Two views are resolved separately:
//  - runtime: what the installed/official Ollama tag actually accepts (tag page, /api/show, smoke test)
//  - model:   what the model architecture can do according to its model card
// A family-level hint never becomes "verified" and never renders as a checkmark.

const RUNTIME_SCOPES = new Set(["smoke_test", "ollama_local", "ollama_tag"]);
const SCOPE_PRIORITY: Record<string, number> = { smoke_test: 5, ollama_local: 4, ollama_tag: 3, model_card: 2, user: 1, family: 0 };

export function emptyCapabilities(): Capabilities {
  const rec = (): CapRecord => ({ evidence: [] });
  return {
    inputs: Object.fromEntries(INPUT_CAPS.map((k) => [k, rec()])) as Record<InputCap, CapRecord>,
    outputs: Object.fromEntries(OUTPUT_CAPS.map((k) => [k, rec()])) as Record<OutputCap, CapRecord>,
    thinking: rec(),
  };
}

export function cloneCapabilities(c: Capabilities): Capabilities {
  return JSON.parse(JSON.stringify(c)) as Capabilities;
}

/** Add evidence, replacing older evidence from the same scope+source. */
export function addEvidence(rec: CapRecord, ev: CapEvidence): CapRecord {
  const rest = rec.evidence.filter((e) => !(e.scope === ev.scope && e.source === ev.source));
  return { evidence: [...rest, ev] };
}

export interface ResolvedCap {
  /** Status to display. */
  status: CapStatus;
  /** Ollama runtime / exact-tag view. */
  runtime: CapStatus;
  /** Model architecture (model card) view. */
  model: CapStatus;
  /** True when the strongest evidence came only from the user. */
  userEntered: boolean;
  /** Same-scope sources disagree (e.g. two runtime sources). */
  conflict: boolean;
  /** Runtime and model-card views disagree (capable in theory, not in this runtime, or vice versa). */
  runtimeModelMismatch: boolean;
  best: CapEvidence | null;
  evidence: CapEvidence[];
}

function verdict(evs: CapEvidence[]): { status: CapStatus; conflict: boolean; best: CapEvidence | null } {
  const verified = evs.filter((e) => e.status === "verified_supported" || e.status === "verified_unsupported");
  if (verified.length === 0) return { status: "unknown", conflict: false, best: null };
  const sorted = [...verified].sort(
    (a, b) => (SCOPE_PRIORITY[b.scope] ?? 0) - (SCOPE_PRIORITY[a.scope] ?? 0) || (b.checkedAt ?? "").localeCompare(a.checkedAt ?? ""),
  );
  const conflict = new Set(verified.map((e) => e.status)).size > 1;
  return { status: sorted[0].status, conflict, best: sorted[0] };
}

export function resolveCap(rec: CapRecord | undefined): ResolvedCap {
  const evidence = rec?.evidence ?? [];
  const runtimeV = verdict(evidence.filter((e) => RUNTIME_SCOPES.has(e.scope)));
  const modelV = verdict(evidence.filter((e) => e.scope === "model_card"));
  const userV = verdict(evidence.filter((e) => e.scope === "user"));
  const familySupport = evidence.some((e) => e.scope === "family" && (e.status === "family_suggests" || e.status === "verified_supported"));

  let status: CapStatus = "unknown";
  let best: CapEvidence | null = null;
  let userEntered = false;
  if (runtimeV.status !== "unknown") {
    status = runtimeV.status;
    best = runtimeV.best;
  } else if (modelV.status !== "unknown") {
    status = modelV.status;
    best = modelV.best;
  } else if (userV.status !== "unknown") {
    status = userV.status;
    best = userV.best;
    userEntered = true;
  } else if (familySupport) {
    status = "family_suggests";
    best = evidence.find((e) => e.scope === "family") ?? null;
  }

  const runtimeModelMismatch =
    runtimeV.status !== "unknown" && modelV.status !== "unknown" && runtimeV.status !== modelV.status;

  return {
    status,
    runtime: runtimeV.status,
    model: modelV.status,
    userEntered,
    conflict: runtimeV.conflict || modelV.conflict,
    runtimeModelMismatch,
    best,
    evidence,
  };
}

export const resolveInput = (c: Capabilities, k: InputCap) => resolveCap(c.inputs[k]);
export const resolveOutput = (c: Capabilities, k: OutputCap) => resolveCap(c.outputs[k]);

export const isSupported = (s: CapStatus, allowFamily: boolean) =>
  s === "verified_supported" || (allowFamily && s === "family_suggests");

export const STATUS_TEXT: Record<CapStatus, string> = {
  verified_supported: "Verified supported",
  verified_unsupported: "Verified unsupported",
  family_suggests: "Family suggests support / unverified",
  unknown: "Unknown",
};

export interface ModalityLabel {
  label: string;
  /** True when every part of the label is backed by verified (non-family) evidence. */
  verified: boolean;
}

/** User-friendly one-line summary of what a model accepts and produces. */
export function modalityLabel(c: Capabilities): ModalityLabel {
  const st = (k: InputCap) => resolveInput(c, k).status;
  const out = (k: OutputCap) => resolveOutput(c, k).status;
  const supported = (s: CapStatus) => s === "verified_supported" || s === "family_suggests";

  const emb = out("embeddings");
  const textOut = out("text");
  if (emb === "verified_supported" && textOut !== "verified_supported") return { label: "Embeddings only", verified: true };
  if (emb === "family_suggests" && !supported(textOut)) return { label: "Embeddings only", verified: false };

  const text = st("text");
  if (text === "unknown" && textOut === "unknown") return { label: "Unknown", verified: false };

  const extras = (["image", "audio", "video"] as InputCap[]).filter((k) => supported(st(k)));
  const verified = [text, ...extras.map(st)].every((s) => s === "verified_supported");
  if (extras.length === 0) {
    // "Text only" needs the other inputs to be known-unsupported to be verified.
    const othersKnownNo = (["image", "audio", "video"] as InputCap[]).every((k) => st(k) === "verified_unsupported");
    return { label: "Text only", verified: verified && othersKnownNo };
  }
  if (extras.length >= 2 && extras.includes("audio")) return { label: "Multimodal", verified };
  const names: Record<string, string> = { image: "Images", audio: "Audio", video: "Video" };
  return { label: ["Text", ...extras.map((k) => names[k])].join(" + "), verified };
}

export type InputSelection = Partial<Record<InputCap, boolean>>;

/**
 * Does the model accept every selected input?
 * Text is always on. "pdf" is satisfied by text extraction (app-mediated) unless the user
 * also asks for page images, which then require image understanding.
 */
export function acceptsInputs(c: Capabilities, sel: InputSelection, verifiedOnly: boolean): boolean {
  const allowFamily = !verifiedOnly;
  // With "only verified", capabilities you entered yourself don't count as verified.
  const st = (k: InputCap) => {
    const r = resolveInput(c, k);
    return verifiedOnly && r.userEntered ? "unknown" : r.status;
  };
  const textOk = st("text");
  if (resolveInput(c, "text").status === "verified_unsupported") return false;
  if (verifiedOnly && textOk !== "verified_supported") return false;
  for (const k of ["image", "audio", "video"] as InputCap[]) {
    if (sel[k] && !isSupported(st(k), allowFamily)) return false;
  }
  return true;
}

export type CapFilter =
  | "text_only"
  | "image"
  | "audio"
  | "video"
  | "multimodal"
  | "tools"
  | "json"
  | "embeddings"
  | "thinking";

export function matchesCapFilter(c: Capabilities, f: CapFilter, verifiedOnly: boolean): boolean {
  // "Only verified" ignores capabilities you entered yourself.
  const ok = (r: ResolvedCap) => isSupported(verifiedOnly && r.userEntered ? "unknown" : r.status, !verifiedOnly);
  switch (f) {
    case "text_only":
      return modalityLabel(c).label === "Text only" && (!verifiedOnly || modalityLabel(c).verified);
    case "image":
    case "audio":
    case "video":
      return ok(resolveInput(c, f));
    case "multimodal":
      return (["image", "audio", "video"] as InputCap[]).filter((k) => ok(resolveInput(c, k))).length >= 1 &&
        ok(resolveInput(c, "text"));
    case "tools":
      return ok(resolveOutput(c, "tools"));
    case "json":
      return ok(resolveOutput(c, "json"));
    case "embeddings":
      return ok(resolveOutput(c, "embeddings"));
    case "thinking":
      return ok(resolveCap(c.thinking));
  }
}

/** Ollama /api/show "capabilities" values → evidence. */
export function capabilitiesFromOllamaList(
  caps: string[],
  scope: "ollama_local" | "ollama_tag",
  source: string,
  checkedAt: string,
  sourceUrl?: string,
): Capabilities {
  const c = emptyCapabilities();
  const set = new Set(caps.map((x) => x.toLowerCase()));
  const ev = (status: CapStatus, note?: string): CapEvidence => ({ status, scope, source, checkedAt, sourceUrl, note });
  const isEmbedding = set.has("embedding");
  c.inputs.text = addEvidence(c.inputs.text, ev(set.has("completion") || isEmbedding || set.size === 0 ? "verified_supported" : "unknown"));
  c.inputs.image = addEvidence(c.inputs.image, ev(set.has("vision") ? "verified_supported" : "verified_unsupported"));
  // Ollama exposes "audio" for some models; absence is NOT proof for audio/video in older runtimes.
  c.inputs.audio = addEvidence(c.inputs.audio, ev(set.has("audio") ? "verified_supported" : "unknown"));
  c.inputs.video = addEvidence(c.inputs.video, ev(set.has("video") ? "verified_supported" : "unknown"));
  c.outputs.text = addEvidence(c.outputs.text, ev(set.has("completion") ? "verified_supported" : isEmbedding ? "verified_unsupported" : "unknown"));
  c.outputs.embeddings = addEvidence(c.outputs.embeddings, ev(isEmbedding ? "verified_supported" : "unknown"));
  c.outputs.tools = addEvidence(c.outputs.tools, ev(set.has("tools") ? "verified_supported" : "unknown"));
  if (set.has("thinking")) c.thinking = addEvidence(c.thinking, ev("verified_supported"));
  return c;
}

/** Merge evidence from b into a (no evidence is dropped). */
export function mergeCapabilities(a: Capabilities, b: Capabilities): Capabilities {
  const out = cloneCapabilities(a);
  for (const k of INPUT_CAPS) for (const e of b.inputs[k].evidence) out.inputs[k] = addEvidence(out.inputs[k], e);
  for (const k of OUTPUT_CAPS) for (const e of b.outputs[k].evidence) out.outputs[k] = addEvidence(out.outputs[k], e);
  for (const e of b.thinking.evidence) out.thinking = addEvidence(out.thinking, e);
  return out;
}
