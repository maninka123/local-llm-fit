import type { GpuKind, GpuVendor } from "../domain/types";

// Published memory configurations for common GPUs, used ONLY when the real value cannot be
// measured (the browser preview). These are manufacturer specs, not measurements: the UI
// labels them "Known spec" and asks the user to confirm. Where a model ships in more than
// one memory size, every option is listed and the user picks.

export interface GpuSpec {
  /** Canonical display name. */
  name: string;
  vendor: GpuVendor;
  kind: GpuKind;
  /** Dedicated VRAM options in GiB (discrete) — first is the most common. */
  vramGiB?: number[];
  /** Unified memory configurations in GB (Apple Silicon). */
  unifiedOptionsGB?: number[];
}

type Row = [RegExp, Omit<GpuSpec, "vendor" | "kind"> & Partial<Pick<GpuSpec, "kind">>];

const n = (name: string, vram: number[]) => ({ name, vramGiB: vram });

// Order matters: more specific patterns first (e.g. "4070 Ti SUPER" before "4070 Ti" before "4070").
const NVIDIA_LAPTOP: Row[] = [
  [/rtx\s*5090\b.*laptop/, n("GeForce RTX 5090 Laptop GPU", [24])],
  [/rtx\s*5080\b.*laptop/, n("GeForce RTX 5080 Laptop GPU", [16])],
  [/rtx\s*5070\s*ti\b.*laptop/, n("GeForce RTX 5070 Ti Laptop GPU", [12])],
  [/rtx\s*5070\b.*laptop/, n("GeForce RTX 5070 Laptop GPU", [8])],
  [/rtx\s*5060\b.*laptop/, n("GeForce RTX 5060 Laptop GPU", [8])],
  [/rtx\s*4090\b.*laptop/, n("GeForce RTX 4090 Laptop GPU", [16])],
  [/rtx\s*4080\b.*laptop/, n("GeForce RTX 4080 Laptop GPU", [12])],
  [/rtx\s*4070\b.*laptop/, n("GeForce RTX 4070 Laptop GPU", [8])],
  [/rtx\s*4060\b.*laptop/, n("GeForce RTX 4060 Laptop GPU", [8])],
  [/rtx\s*4050\b.*laptop/, n("GeForce RTX 4050 Laptop GPU", [6])],
  [/rtx\s*3080\s*ti\b.*laptop/, n("GeForce RTX 3080 Ti Laptop GPU", [16])],
  [/rtx\s*3080\b.*laptop/, n("GeForce RTX 3080 Laptop GPU", [8, 16])],
  [/rtx\s*3070\s*ti\b.*laptop/, n("GeForce RTX 3070 Ti Laptop GPU", [8])],
  [/rtx\s*3070\b.*laptop/, n("GeForce RTX 3070 Laptop GPU", [8])],
  [/rtx\s*3060\b.*laptop/, n("GeForce RTX 3060 Laptop GPU", [6])],
  [/rtx\s*3050\s*ti\b.*laptop/, n("GeForce RTX 3050 Ti Laptop GPU", [4])],
  [/rtx\s*3050\b.*laptop/, n("GeForce RTX 3050 Laptop GPU", [4, 6])],
  [/rtx\s*2080\b.*(max-q|laptop|mobile)/, n("GeForce RTX 2080 (laptop)", [8])],
  [/rtx\s*2070\b.*(max-q|laptop|mobile)/, n("GeForce RTX 2070 (laptop)", [8])],
  [/rtx\s*2060\b.*(max-q|laptop|mobile)/, n("GeForce RTX 2060 (laptop)", [6])],
];

const NVIDIA: Row[] = [
  [/rtx\s*pro\s*6000/, n("RTX PRO 6000 Blackwell", [96])],
  [/rtx\s*6000\s*ada/, n("RTX 6000 Ada", [48])],
  [/rtx\s*5000\s*ada/, n("RTX 5000 Ada", [32])],
  [/rtx\s*4500\s*ada/, n("RTX 4500 Ada", [24])],
  [/rtx\s*4000\s*(sff\s*)?ada/, n("RTX 4000 Ada", [20])],
  [/rtx\s*2000\s*ada/, n("RTX 2000 Ada", [16])],
  [/rtx\s*a6000/, n("RTX A6000", [48])],
  [/rtx\s*a5000/, n("RTX A5000", [24])],
  [/rtx\s*a4000/, n("RTX A4000", [16])],
  [/rtx\s*a2000/, n("RTX A2000", [12, 6])],
  [/rtx\s*5090/, n("GeForce RTX 5090", [32])],
  [/rtx\s*5080/, n("GeForce RTX 5080", [16])],
  [/rtx\s*5070\s*ti/, n("GeForce RTX 5070 Ti", [16])],
  [/rtx\s*5070/, n("GeForce RTX 5070", [12])],
  [/rtx\s*5060\s*ti/, n("GeForce RTX 5060 Ti", [16, 8])],
  [/rtx\s*5060/, n("GeForce RTX 5060", [8])],
  [/rtx\s*4090/, n("GeForce RTX 4090", [24])],
  [/rtx\s*4080/, n("GeForce RTX 4080 / 4080 SUPER", [16])],
  [/rtx\s*4070\s*ti\s*super/, n("GeForce RTX 4070 Ti SUPER", [16])],
  [/rtx\s*4070\s*ti/, n("GeForce RTX 4070 Ti", [12])],
  [/rtx\s*4070/, n("GeForce RTX 4070 / 4070 SUPER", [12])],
  [/rtx\s*4060\s*ti/, n("GeForce RTX 4060 Ti", [8, 16])],
  [/rtx\s*4060/, n("GeForce RTX 4060", [8])],
  [/rtx\s*3090/, n("GeForce RTX 3090 / 3090 Ti", [24])],
  [/rtx\s*3080\s*ti/, n("GeForce RTX 3080 Ti", [12])],
  [/rtx\s*3080/, n("GeForce RTX 3080", [10, 12])],
  [/rtx\s*3070/, n("GeForce RTX 3070 / 3070 Ti", [8])],
  [/rtx\s*3060\s*ti/, n("GeForce RTX 3060 Ti", [8])],
  [/rtx\s*3060/, n("GeForce RTX 3060", [12, 8])],
  [/rtx\s*3050/, n("GeForce RTX 3050", [8, 6])],
  [/rtx\s*2080\s*ti/, n("GeForce RTX 2080 Ti", [11])],
  [/rtx\s*2080/, n("GeForce RTX 2080 / 2080 SUPER", [8])],
  [/rtx\s*2070/, n("GeForce RTX 2070 / 2070 SUPER", [8])],
  [/rtx\s*2060\s*super/, n("GeForce RTX 2060 SUPER", [8])],
  [/rtx\s*2060/, n("GeForce RTX 2060", [6, 12])],
  [/titan\s*rtx/, n("TITAN RTX", [24])],
  [/gtx\s*1660/, n("GeForce GTX 1660 series", [6])],
  [/gtx\s*1650/, n("GeForce GTX 1650", [4])],
  [/gtx\s*1080\s*ti/, n("GeForce GTX 1080 Ti", [11])],
  [/gtx\s*1080/, n("GeForce GTX 1080", [8])],
  [/gtx\s*1070/, n("GeForce GTX 1070 / 1070 Ti", [8])],
  [/gtx\s*1060/, n("GeForce GTX 1060", [6, 3])],
];

const AMD: Row[] = [
  [/rx\s*9070\s*xt/, n("Radeon RX 9070 XT", [16])],
  [/rx\s*9070/, n("Radeon RX 9070", [16])],
  [/rx\s*9060\s*xt/, n("Radeon RX 9060 XT", [16, 8])],
  [/rx\s*7900\s*xtx/, n("Radeon RX 7900 XTX", [24])],
  [/rx\s*7900\s*xt/, n("Radeon RX 7900 XT", [20])],
  [/rx\s*7900\s*gre/, n("Radeon RX 7900 GRE", [16])],
  [/rx\s*7800\s*xt/, n("Radeon RX 7800 XT", [16])],
  [/rx\s*7700\s*xt/, n("Radeon RX 7700 XT", [12])],
  [/rx\s*7600\s*xt/, n("Radeon RX 7600 XT", [16])],
  [/rx\s*7600/, n("Radeon RX 7600", [8])],
  [/rx\s*69[05]0\s*xt/, n("Radeon RX 6900/6950 XT", [16])],
  [/rx\s*6800/, n("Radeon RX 6800 / 6800 XT", [16])],
  [/rx\s*67[05]0\s*xt/, n("Radeon RX 6700/6750 XT", [12])],
  [/rx\s*6700/, n("Radeon RX 6700", [10])],
  [/rx\s*66[05]0/, n("Radeon RX 6600 series", [8])],
  [/rx\s*6500/, n("Radeon RX 6500 XT", [4, 8])],
  [/radeon\s*pro\s*w7900/, n("Radeon PRO W7900", [48])],
  [/radeon\s*pro\s*w7800/, n("Radeon PRO W7800", [32])],
];

const INTEL: Row[] = [
  [/arc.*b580/, n("Arc B580", [12])],
  [/arc.*b570/, n("Arc B570", [10])],
  [/arc.*a770/, n("Arc A770", [16, 8])],
  [/arc.*a750/, n("Arc A750", [8])],
  [/arc.*a580/, n("Arc A580", [8])],
  [/arc.*a380/, n("Arc A380", [6])],
];

// Apple Silicon unified-memory configurations (GB) per chip.
const APPLE: [RegExp, string, number[]][] = [
  [/m1\s*ultra/, "Apple M1 Ultra", [64, 128]],
  [/m1\s*max/, "Apple M1 Max", [32, 64]],
  [/m1\s*pro/, "Apple M1 Pro", [16, 32]],
  [/m1\b/, "Apple M1", [8, 16]],
  [/m2\s*ultra/, "Apple M2 Ultra", [64, 128, 192]],
  [/m2\s*max/, "Apple M2 Max", [32, 64, 96]],
  [/m2\s*pro/, "Apple M2 Pro", [16, 32]],
  [/m2\b/, "Apple M2", [8, 16, 24]],
  [/m3\s*ultra/, "Apple M3 Ultra", [96, 256, 512]],
  [/m3\s*max/, "Apple M3 Max", [36, 48, 64, 96, 128]],
  [/m3\s*pro/, "Apple M3 Pro", [18, 36]],
  [/m3\b/, "Apple M3", [8, 16, 24]],
  [/m4\s*max/, "Apple M4 Max", [36, 48, 64, 128]],
  [/m4\s*pro/, "Apple M4 Pro", [24, 48, 64]],
  [/m4\b/, "Apple M4", [16, 24, 32]],
  [/m5\b(?!\s*(pro|max|ultra))/, "Apple M5", [16, 24, 32]],
];

export const COMMON_RAM_GB = [8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256];

export function lookupGpu(rawName: string | null | undefined): GpuSpec | null {
  if (!rawName) return null;
  const s = rawName.toLowerCase();
  if (/apple/.test(s) || /\bm[1-5]\b/.test(s)) {
    const hit = APPLE.find(([re]) => re.test(s));
    if (hit) return { name: hit[1], vendor: "apple", kind: "unified", unifiedOptionsGB: hit[2] };
    if (/apple/.test(s)) return { name: "Apple Silicon GPU", vendor: "apple", kind: "unified" };
  }
  const isNvidia = /nvidia|geforce|rtx|gtx|quadro|titan/.test(s);
  const isAmd = /amd|radeon|\brx\s*\d/.test(s);
  const isIntel = /intel|arc\b|iris|uhd/.test(s);
  if (isNvidia) {
    const laptop = /laptop|max-q|mobile/.test(s);
    const hit = (laptop ? NVIDIA_LAPTOP : []).concat(NVIDIA).find(([re]) => re.test(s));
    if (hit) return { vendor: "nvidia", kind: "discrete", ...hit[1] };
    return { name: rawName, vendor: "nvidia", kind: "discrete" };
  }
  if (isAmd) {
    const hit = AMD.find(([re]) => re.test(s));
    if (hit) return { vendor: "amd", kind: "discrete", ...hit[1] };
    // "AMD Radeon(TM) Graphics", "Radeon 780M" etc. are APU graphics sharing system RAM
    if (/radeon(\s*\(?tm\)?)?\s*graphics|radeon\s*\d{3}m|vega/.test(s)) return { name: rawName, vendor: "amd", kind: "integrated" };
    return { name: rawName, vendor: "amd", kind: "discrete" };
  }
  if (isIntel) {
    const hit = INTEL.find(([re]) => re.test(s));
    if (hit) return { vendor: "intel", kind: "discrete", ...hit[1] };
    return { name: rawName, vendor: "intel", kind: "integrated" };
  }
  if (/swiftshader|llvmpipe|software|basic render|microsoft/.test(s)) return { name: rawName, vendor: "other", kind: "virtual" };
  return null;
}

/** Split on commas that are not inside parentheses. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Clean a WebGL/ANGLE renderer string into a GPU name. */
export function cleanRenderer(r: string | null | undefined): string | null {
  if (!r) return null;
  // Software rasterizers mean the real GPU is hidden (or not used) by the browser.
  if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(r)) return null;
  let s = r.trim();
  const angle = /^ANGLE \((.*)\)$/.exec(s);
  if (angle) {
    const parts = splitTopLevel(angle[1]);
    s = parts.length >= 2 ? parts[1] : parts[0];
    s = s.replace(/^ANGLE Metal Renderer:\s*/i, "");
  }
  s = s
    .replace(/\s*\(0x[0-9a-f]+\)/gi, "")
    .replace(/\s*Direct3D.*$/i, "")
    .replace(/\/PCIe\/SSE2.*$/i, "")
    .replace(/\s*\((radeonsi|navi|LLVM|DRM)[^)]*\).*$/i, "")
    .replace(/\s*OpenGL.*$/i, "")
    .replace(/\(TM\)|\(R\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
}

/** All known GPU names, for autocomplete in the setup form. */
export const KNOWN_GPU_NAMES: string[] = [
  ...APPLE.map(([, name]) => name),
  ...[...NVIDIA, ...NVIDIA_LAPTOP, ...AMD, ...INTEL].map(([, s]) => s.name),
];

/** Apple Silicon chips (newest first) with their unified-memory options. */
export const APPLE_CHIPS: { name: string; options: number[] }[] = [...APPLE].reverse().map(([, name, options]) => ({ name, options }));

/** Graphics cards (non-Apple) for autocomplete. */
export const CARD_NAMES: string[] = [...NVIDIA, ...NVIDIA_LAPTOP, ...AMD, ...INTEL].map(([, s]) => s.name);
