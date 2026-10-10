import type { ArchMeta } from "../domain/types";
import { GGUF_FILE_TYPES } from "../domain/quant";

// Minimal GGUF header reader. Parses the key/value metadata section from a (possibly
// truncated) prefix of a GGUF file so we can read layer/KV-head counts without
// downloading weights. Arrays are skipped; truncation ends parsing gracefully.

export type GgufValue = number | bigint | string | boolean | GgufValue[] | { arrayLength: number; elemType: number };

export interface GgufHeader {
  version: number;
  tensorCount: number;
  kvCount: number;
  kv: Record<string, GgufValue>;
  truncated: boolean;
}

class Reader {
  off = 0;
  view: DataView;
  constructor(private b: Uint8Array) {
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  need(n: number) {
    if (this.off + n > this.b.length) throw new RangeError("truncated");
  }
  u8() { this.need(1); return this.view.getUint8(this.off++); }
  i8() { this.need(1); return this.view.getInt8(this.off++); }
  u16() { this.need(2); const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  i16() { this.need(2); const v = this.view.getInt16(this.off, true); this.off += 2; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  i32() { this.need(4); const v = this.view.getInt32(this.off, true); this.off += 4; return v; }
  f32() { this.need(4); const v = this.view.getFloat32(this.off, true); this.off += 4; return v; }
  f64() { this.need(8); const v = this.view.getFloat64(this.off, true); this.off += 8; return v; }
  u64() { this.need(8); const v = this.view.getBigUint64(this.off, true); this.off += 8; return v; }
  i64() { this.need(8); const v = this.view.getBigInt64(this.off, true); this.off += 8; return v; }
  str() {
    const len = Number(this.u64());
    if (len > 1 << 24) throw new Error("string too long");
    this.need(len);
    const s = new TextDecoder().decode(this.b.subarray(this.off, this.off + len));
    this.off += len;
    return s;
  }
}

const SCALAR_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

function readValue(r: Reader, type: number): GgufValue {
  switch (type) {
    case 0: return r.u8();
    case 1: return r.i8();
    case 2: return r.u16();
    case 3: return r.i16();
    case 4: return r.u32();
    case 5: return r.i32();
    case 6: return r.f32();
    case 7: return r.u8() !== 0;
    case 8: return r.str();
    case 10: return r.u64();
    case 11: return r.i64();
    case 12: return r.f64();
    case 9: {
      const elemType = r.u32();
      const len = Number(r.u64());
      // Keep small numeric arrays (e.g. per-layer head counts); skip large ones.
      if (elemType !== 8 && elemType !== 9 && len <= 4096) {
        const arr: GgufValue[] = [];
        for (let i = 0; i < len; i++) arr.push(readValue(r, elemType));
        return arr;
      }
      if (elemType === 8) {
        for (let i = 0; i < len; i++) {
          const l = Number(r.u64());
          r.need(l);
          r.off += l;
        }
      } else if (SCALAR_SIZE[elemType]) {
        r.need(SCALAR_SIZE[elemType] * len);
        r.off += SCALAR_SIZE[elemType] * len;
      } else throw new Error("nested arrays unsupported");
      return { arrayLength: len, elemType };
    }
    default:
      throw new Error(`unknown GGUF type ${type}`);
  }
}

export function parseGgufHeader(bytes: Uint8Array): GgufHeader {
  const r = new Reader(bytes);
  const magic = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8());
  if (magic !== "GGUF") throw new Error("Not a GGUF file");
  const version = r.u32();
  if (version < 2) throw new Error(`Unsupported GGUF version ${version}`);
  const tensorCount = Number(r.u64());
  const kvCount = Number(r.u64());
  const kv: Record<string, GgufValue> = {};
  let truncated = false;
  for (let i = 0; i < kvCount; i++) {
    try {
      const key = r.str();
      const type = r.u32();
      kv[key] = readValue(r, type);
    } catch (e) {
      if (e instanceof RangeError) {
        truncated = true;
        break;
      }
      throw e;
    }
  }
  return { version, tensorCount, kvCount, kv, truncated };
}

const num = (v: GgufValue | undefined): number | undefined => {
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) {
    const ns = v.map((x) => (typeof x === "bigint" ? Number(x) : typeof x === "number" ? x : NaN)).filter(Number.isFinite);
    return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : undefined; // mean → layers×mean = exact sum
  }
  return undefined;
};

export interface GgufSummary {
  arch: ArchMeta;
  fileType?: string;
  parameterCount?: number;
  sizeLabel?: string;
  hasVisionInHeader: boolean;
}

export function summarizeGguf(h: GgufHeader, source: string, sourceUrl?: string, checkedAt?: string): GgufSummary {
  const a = String(h.kv["general.architecture"] ?? "");
  const k = (s: string) => h.kv[`${a}.${s}`];
  const headCount = num(k("attention.head_count"));
  const embed = num(k("embedding_length"));
  const keyDim = num(k("attention.key_length")) ?? (embed && headCount ? embed / headCount : undefined);
  const arr = h.kv["tokenizer.ggml.tokens"];
  const vocab = arr && typeof arr === "object" && !Array.isArray(arr) && "arrayLength" in arr ? arr.arrayLength : undefined;
  const ft = num(h.kv["general.file_type"]);
  return {
    arch: {
      archName: a || undefined,
      layers: num(k("block_count")),
      kvHeads: num(k("attention.head_count_kv")) ?? headCount,
      keyDim,
      valueDim: num(k("attention.value_length")) ?? keyDim,
      embeddingLength: embed,
      contextLength: num(k("context_length")),
      slidingWindow: num(k("attention.sliding_window")),
      expertCount: num(k("expert_count")),
      expertUsedCount: num(k("expert_used_count")),
      kvLoraRank: num(k("attention.kv_lora_rank")),
      vocabSize: vocab,
      provenance: "verified",
      source,
      sourceUrl,
      checkedAt,
    },
    fileType: ft != null ? GGUF_FILE_TYPES[ft] ?? `type ${ft}` : undefined,
    parameterCount: num(h.kv["general.parameter_count"]),
    sizeLabel: typeof h.kv["general.size_label"] === "string" ? (h.kv["general.size_label"] as string) : undefined,
    hasVisionInHeader: Object.keys(h.kv).some((x) => x.startsWith("clip.") || x.includes(".vision.")),
  };
}
