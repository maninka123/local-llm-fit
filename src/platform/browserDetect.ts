import { GiB } from "../lib/units";
import type { Field, FormFactor, GpuDevice, HardwareReport, MemoryArchitecture } from "../domain/types";
import { cleanRenderer, lookupGpu } from "./gpuSpecs";

// Browser-only hardware detection. Browsers deliberately hide VRAM, free memory and exact
// RAM, so this collects what IS exposed (GPU name, CPU threads, coarse RAM, OS, battery)
// and combines it with published GPU specs and the user's own answers. Every field is
// labelled with where it came from; nothing here is a live measurement.

export interface BrowserSignals {
  renderer: string | null;
  gpuName: string | null;
  webgpu: { vendor?: string; architecture?: string; description?: string } | null;
  cores: number | null;
  /** navigator.deviceMemory: Chrome-only, rounded and capped at 8. */
  deviceMemoryGB: number | null;
  os: { name: string; version: string; arch: string };
  mobile: boolean;
  battery: "present" | "unknown";
}

export interface BrowserSetup {
  confirmed: boolean;
  gpuName: string | null;
  /** null = no dedicated GPU / don't know. */
  vramGiB: number | null;
  ramGiB: number | null;
  formFactor: FormFactor | null;
}

type NavigatorExtras = Navigator & {
  deviceMemory?: number;
  userAgentData?: { mobile?: boolean; platform?: string; getHighEntropyValues?: (h: string[]) => Promise<Record<string, string>> };
  getBattery?: () => Promise<{ charging: boolean; level: number; dischargingTime: number }>;
};
type GpuLike = { requestAdapter: () => Promise<{ info?: Record<string, string>; requestAdapterInfo?: () => Promise<Record<string, string>> } | null> };

function webglRenderer(): string | null {
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return typeof r === "string" ? r : null;
  } catch {
    return null;
  }
}

export function osFromUserAgent(ua: string): { name: string; version: string } {
  const win = /Windows NT ([\d.]+)/.exec(ua);
  if (win) return { name: "Windows", version: win[1] === "10.0" ? "10 or 11" : win[1] };
  const mac = /Mac OS X ([\d_]+)/.exec(ua);
  if (mac) return { name: "macOS", version: mac[1].replace(/_/g, ".") };
  if (/CrOS/.test(ua)) return { name: "ChromeOS", version: "" };
  if (/Android/.test(ua)) return { name: "Android", version: /Android ([\d.]+)/.exec(ua)?.[1] ?? "" };
  if (/iPhone|iPad/.test(ua)) return { name: "iOS", version: "" };
  if (/Linux/.test(ua)) return { name: "Linux", version: "" };
  return { name: "Unknown OS", version: "" };
}

export async function detectBrowser(): Promise<BrowserSignals> {
  const nav = navigator as NavigatorExtras;
  const renderer = webglRenderer();
  let webgpu: BrowserSignals["webgpu"] = null;
  try {
    const a = await (navigator as unknown as { gpu?: GpuLike }).gpu?.requestAdapter();
    if (a) {
      const info = a.info ?? (a.requestAdapterInfo ? await a.requestAdapterInfo() : undefined);
      if (info) webgpu = { vendor: info.vendor, architecture: info.architecture, description: info.description };
    }
  } catch {
    /* WebGPU unavailable */
  }
  const ua = navigator.userAgent;
  let os = { ...osFromUserAgent(ua), arch: "" };
  try {
    const h = await nav.userAgentData?.getHighEntropyValues?.(["platform", "platformVersion", "architecture", "bitness"]);
    if (h?.platform === "Windows" && h.platformVersion) {
      const major = parseInt(h.platformVersion.split(".")[0], 10);
      os = { name: "Windows", version: major >= 13 ? "11" : "10", arch: h.architecture ?? "" };
    } else if (h?.platform === "macOS" && h.platformVersion) {
      os = { name: "macOS", version: h.platformVersion, arch: h.architecture ?? "" };
    } else if (h?.platform) {
      os = { ...os, arch: h.architecture ?? "" };
    }
  } catch {
    /* client hints unavailable */
  }
  let battery: BrowserSignals["battery"] = "unknown";
  try {
    const b = await nav.getBattery?.();
    // Desktops report a permanently full, charging "battery"; anything else means a real one.
    if (b && (!b.charging || b.level < 1 || Number.isFinite(b.dischargingTime))) battery = "present";
  } catch {
    /* Battery API unavailable */
  }
  const fromWebgpu = cleanRenderer(webgpu?.description || null);
  const gpuName = cleanRenderer(renderer) ?? fromWebgpu;
  return {
    renderer,
    gpuName,
    webgpu,
    cores: navigator.hardwareConcurrency || null,
    deviceMemoryGB: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    os,
    mobile: !!nav.userAgentData?.mobile || /Mobi|Android|iPhone|iPad/.test(ua),
    battery,
  };
}

const f = <T,>(value: T | null, source: string, confidence: Field<T>["confidence"], error?: string): Field<T> =>
  value == null ? { value: null, source, confidence: "none", error: error ?? "Not available in the browser" } : { value, source, confidence };

/** Best-guess setup from detection alone (before the user confirms). */
export function suggestSetup(sig: BrowserSignals): BrowserSetup {
  const spec = lookupGpu(sig.gpuName);
  const ram =
    spec?.kind === "unified"
      ? (spec.unifiedOptionsGB?.[0] ?? null)
      : sig.deviceMemoryGB != null && sig.deviceMemoryGB < 8
        ? sig.deviceMemoryGB
        : null;
  return {
    confirmed: false,
    gpuName: spec?.name ?? sig.gpuName,
    vramGiB: spec?.kind === "discrete" ? (spec.vramGiB?.[0] ?? null) : null,
    ramGiB: ram,
    formFactor: sig.battery === "present" ? "laptop" : null,
  };
}

export function buildBrowserReport(sig: BrowserSignals, setup: BrowserSetup): HardwareReport {
  const confirmed = setup.confirmed;
  const answer = confirmed ? "You confirmed" : "Suggested (not yet confirmed)";
  const spec = lookupGpu(setup.gpuName ?? sig.gpuName);
  const gpuName = setup.gpuName ?? spec?.name ?? sig.gpuName ?? "Unknown GPU";
  const unified = spec?.kind === "unified";
  const assumedRam = setup.ramGiB == null;
  const ramGiB = setup.ramGiB ?? (unified ? (spec?.unifiedOptionsGB?.[0] ?? 16) : 16);

  const gpus: GpuDevice[] = [];
  if (spec || sig.gpuName) {
    const kind = spec?.kind ?? (setup.vramGiB ? "discrete" : "unknown");
    const g: GpuDevice = {
      id: "gpu0",
      name: gpuName,
      vendor: spec?.vendor ?? "unknown",
      kind: kind === "unknown" && setup.vramGiB ? "discrete" : kind,
      dedicatedBytes:
        kind === "unified"
          ? f<number>(null, "Apple Silicon", "none", "Unified memory: there is no separate VRAM")
          : setup.vramGiB != null
            ? f(setup.vramGiB * GiB, spec?.vramGiB?.includes(setup.vramGiB) ? `${answer} · known spec for ${spec.name}` : answer, confirmed ? "medium" : "low")
            : f<number>(null, "Browser", "none", kind === "integrated" ? "Integrated GPU shares system RAM" : "Browsers cannot read VRAM; enter it in setup"),
      freeBytes: f<number>(null, "Browser", "none", "Browsers cannot read free VRAM (planning mode is used)"),
      sharedBytes: f<number>(null, "Browser", "none", "Not applicable"),
      backendHints: spec?.vendor === "nvidia" ? ["cuda"] : spec?.vendor === "apple" ? ["metal"] : [],
    };
    gpus.push(g);
  }
  const arch: MemoryArchitecture = unified
    ? "unified"
    : gpus[0]?.kind === "discrete" && setup.vramGiB
      ? "discrete"
      : gpus[0]?.kind === "integrated"
        ? "integrated_shared"
        : "cpu_only";
  const ff = setup.formFactor ?? (sig.battery === "present" ? "laptop" : null);

  return {
    probeVersion: "browser",
    demo: false,
    mode: "browser",
    browserConfirmed: confirmed,
    detectedAt: new Date().toISOString(),
    os: { name: sig.os.name, version: sig.os.version, arch: sig.os.arch },
    formFactor: f<FormFactor>(ff, setup.formFactor ? answer : "Battery API", setup.formFactor ? "medium" : "low", "Browsers don't expose the device type"),
    formFactorEvidence: [sig.battery === "present" ? "Battery detected by the browser" : "No battery reported", ...(setup.formFactor ? [answer] : [])],
    hasBattery: f<boolean>(sig.battery === "present" ? true : null, "Battery API", "low"),
    isVirtualMachine: f<boolean>(null, "Browser", "none"),
    cpu: { brand: unified ? (spec?.name ?? "Apple Silicon") : sig.cores ? `${sig.cores}-thread CPU` : "CPU", physicalCores: null, logicalCores: sig.cores },
    memory: {
      totalBytes: f(ramGiB * GiB, assumedRam ? "Assumed 16 GiB: confirm in setup" : answer, assumedRam ? "low" : confirmed ? "medium" : "low"),
      availableBytes: f<number>(null, "Browser", "none", "Browsers cannot read free memory (planning reserves are used)"),
    },
    memoryArchitecture: f(arch, unified ? "Apple Silicon detected from the GPU name" : arch === "discrete" ? "Dedicated GPU" : arch === "integrated_shared" ? "Integrated GPU" : "No dedicated GPU entered", "medium"),
    unifiedGpuWorkingSetBytes: f<number>(null, "Browser", "none", "Not exposed in the browser; an assumed limit is used"),
    gpus,
    errors: [],
    notes: [
      `Browser estimate. Detected: ${sig.gpuName ?? "no GPU name"}${sig.cores ? `, ${sig.cores} CPU threads` : ""}${sig.deviceMemoryGB ? `, ≥${sig.deviceMemoryGB} GB RAM reported` : ""}.`,
      "Memory sizes come from published GPU specs and your answers, not live readings. The desktop app measures them exactly.",
    ],
  };
}
