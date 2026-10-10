import type { QuantId } from "./types";

// Effective bits per weight for common GGUF formats, INCLUDING block scales.
// Values are typical whole-file averages for llama.cpp quantizations; real files differ
// because some tensors (embeddings, output, norms, attention in MoE) are kept at higher
// precision. Treat every derived size as an estimate with the stated range.
export interface QuantInfo {
  id: QuantId;
  label: string;
  bitsPerWeight: number;
  /** Relative uncertainty of the whole-file estimate (±). */
  spread: number;
  family: "float" | "8bit" | "k-quant" | "legacy" | "mx";
  blurb: string;
}

export const QUANTS: QuantInfo[] = [
  { id: "F16", label: "FP16", bitsPerWeight: 16, spread: 0.03, family: "float", blurb: "Unquantized half precision. Largest, reference quality." },
  { id: "BF16", label: "BF16", bitsPerWeight: 16, spread: 0.03, family: "float", blurb: "Unquantized bfloat16. Same size as FP16." },
  { id: "FP8", label: "FP8", bitsPerWeight: 8.3, spread: 0.06, family: "float", blurb: "8-bit float (mostly in non-GGUF runtimes)." },
  { id: "Q8_0", label: "Q8", bitsPerWeight: 8.5, spread: 0.04, family: "8bit", blurb: "Near-lossless 8-bit. About half of FP16." },
  { id: "Q6_K", label: "Q6", bitsPerWeight: 6.56, spread: 0.06, family: "k-quant", blurb: "Very close to Q8 quality, smaller." },
  { id: "Q5_K_M", label: "Q5_K_M", bitsPerWeight: 5.7, spread: 0.07, family: "k-quant", blurb: "Good quality / size balance." },
  { id: "Q5_K_S", label: "Q5_K_S", bitsPerWeight: 5.54, spread: 0.07, family: "k-quant", blurb: "Slightly smaller Q5." },
  { id: "Q4_K_M", label: "Q4_K_M", bitsPerWeight: 4.85, spread: 0.1, family: "k-quant", blurb: "The usual Ollama default. Small with modest quality loss." },
  { id: "Q4_K_S", label: "Q4_K_S", bitsPerWeight: 4.58, spread: 0.1, family: "k-quant", blurb: "Slightly smaller Q4." },
  { id: "Q4_0", label: "Q4_0", bitsPerWeight: 4.55, spread: 0.1, family: "legacy", blurb: "Legacy 4-bit; used by some QAT releases." },
  { id: "Q3_K_M", label: "Q3", bitsPerWeight: 3.91, spread: 0.12, family: "k-quant", blurb: "Noticeable quality loss; use when memory is tight." },
  { id: "Q3_K_S", label: "Q3_K_S", bitsPerWeight: 3.5, spread: 0.12, family: "k-quant", blurb: "Smaller Q3; more quality loss." },
  { id: "Q2_K", label: "Q2", bitsPerWeight: 3.35, spread: 0.15, family: "k-quant", blurb: "Heavy quality loss. Last resort." },
  { id: "MXFP4", label: "MXFP4", bitsPerWeight: 5.0, spread: 0.15, family: "mx", blurb: "Native 4-bit microscaling for MoE experts (e.g. gpt-oss); other tensors stay higher precision." },
];

/** Selector order shown in the UI (largest to smallest). */
export const QUANT_SELECTOR: QuantId[] = ["F16", "BF16", "Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "Q4_K_S", "Q3_K_M", "Q2_K", "MXFP4"];

export const quantInfo = (id: QuantId): QuantInfo =>
  QUANTS.find((q) => q.id === id) ?? { id, label: id, bitsPerWeight: 4.85, spread: 0.25, family: "k-quant", blurb: "Unrecognized format." };

/** Normalise a free-form quantization label ("q4_K_M", "Q4_K_M", "mxfp4", "F16") to a QuantId. */
export function normalizeQuant(label: string | null | undefined): QuantId {
  if (!label) return "OTHER";
  const t = label.trim().toUpperCase().replace(/-/g, "_");
  const direct = QUANTS.find((q) => q.id === t);
  if (direct) return direct.id;
  if (t === "FP16") return "F16";
  if (t === "Q8") return "Q8_0";
  if (t === "Q6") return "Q6_K";
  if (t === "Q5_K" || t === "Q5") return "Q5_K_M";
  if (t === "Q4_K" || t === "Q4") return "Q4_K_M";
  if (t === "Q3_K" || t === "Q3_K_L" || t === "Q3") return "Q3_K_M";
  if (t === "Q2" || t === "Q2_K_S") return "Q2_K";
  if (t === "Q5_0" || t === "Q5_1") return "Q5_K_S";
  if (t === "Q4_1") return "Q4_0";
  if (t.startsWith("FP8") || t === "F8_E4M3") return "FP8";
  return "OTHER";
}

/** GGUF general.file_type enum → label (llama.cpp LLAMA_FTYPE). */
export const GGUF_FILE_TYPES: Record<number, string> = {
  0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1", 10: "Q2_K", 11: "Q3_K_S",
  12: "Q3_K_M", 13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M", 16: "Q5_K_S", 17: "Q5_K_M", 18: "Q6_K",
  32: "BF16", 38: "MXFP4",
};
