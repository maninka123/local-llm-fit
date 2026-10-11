import { GiB } from "../lib/units";
import type { GpuDevice, HardwareReport } from "../domain/types";
import { BOARD_MACHINES, fixtureBase as base, fixtureField as f, fixtureGpu as gpu, type DemoMachine } from "./demoHardware";
import { APPLE_CHIPS, lookupGpu } from "./gpuSpecs";

// Configurable sample machines. The user picks a type and its parts (graphics card, Mac chip,
// board, memory); everything else (names, memory pools, bandwidth, backend support) follows
// from those choices, using the same GPU and chip data as the "My computer" setup.

export type MacModel = "MacBook Air" | "MacBook Pro" | "Mac mini" | "iMac" | "Mac Studio";

export type SampleConfig =
  | { kind: "desktop"; gpu: string; vramGiB: number; gpuCount: 1 | 2; ramGiB: number }
  | { kind: "laptop"; gpu: string; vramGiB: number; ramGiB: number }
  | { kind: "mac"; model: MacModel; chip: string; ramGiB: number }
  | { kind: "office"; ramGiB: number }
  | { kind: "board"; boardId: string; ramGiB: number };

export type SampleKind = SampleConfig["kind"];

export const MAC_MODELS: MacModel[] = ["MacBook Air", "MacBook Pro", "Mac mini", "iMac", "Mac Studio"];

// Chips Apple has shipped in each Mac (memory options come from the chip).
const MAC_CHIPS: Record<MacModel, string[]> = {
  "MacBook Air": ["M1", "M2", "M3", "M4", "M5"],
  "MacBook Pro": ["M1", "M1 Pro", "M1 Max", "M2", "M2 Pro", "M2 Max", "M3", "M3 Pro", "M3 Max", "M4", "M4 Pro", "M4 Max", "M5"],
  "Mac mini": ["M1", "M2", "M2 Pro", "M4", "M4 Pro"],
  iMac: ["M1", "M3", "M4"],
  "Mac Studio": ["M1 Max", "M1 Ultra", "M2 Max", "M2 Ultra", "M3 Ultra", "M4 Max"],
};

/** Chips (newest first) available in a Mac model, with their memory options in GB. */
export function chipsFor(model: MacModel): { name: string; options: number[] }[] {
  const allowed = new Set(MAC_CHIPS[model].map((c) => `Apple ${c}`));
  return APPLE_CHIPS.filter((c) => allowed.has(c.name));
}

/** Memory sizes (GB) a graphics card ships with, most common first. */
export const vramOptionsFor = (gpuName: string): number[] => lookupGpu(gpuName)?.vramGiB ?? [];

export const DEFAULT_SAMPLES: Record<SampleKind, SampleConfig> = {
  desktop: { kind: "desktop", gpu: "GeForce RTX 4070 Ti SUPER", vramGiB: 16, gpuCount: 1, ramGiB: 32 },
  laptop: { kind: "laptop", gpu: "GeForce RTX 4060 Laptop GPU", vramGiB: 8, ramGiB: 16 },
  mac: { kind: "mac", model: "MacBook Pro", chip: "Apple M4 Pro", ramGiB: 24 },
  office: { kind: "office", ramGiB: 16 },
  board: { kind: "board", boardId: "jetson-orin-nano-8", ramGiB: 8 },
};

/** Older saved sample ids (and board ids) → configuration. */
export function presetConfig(id: string): SampleConfig {
  switch (id) {
    case "desktop-16g":
      return DEFAULT_SAMPLES.desktop;
    case "workstation-2x24":
      return { kind: "desktop", gpu: "GeForce RTX 3090 / 3090 Ti", vramGiB: 24, gpuCount: 2, ramGiB: 128 };
    case "laptop-8g":
      return DEFAULT_SAMPLES.laptop;
    case "mac-m3pro-36":
      return { kind: "mac", model: "MacBook Pro", chip: "Apple M3 Pro", ramGiB: 36 };
    case "office-igpu":
      return DEFAULT_SAMPLES.office;
  }
  const board = BOARD_MACHINES.find((b) => b.id === id);
  if (board) return { kind: "board", boardId: id, ramGiB: Math.round((board.report.memory.totalBytes.value ?? 0) / GiB) };
  return DEFAULT_SAMPLES.desktop;
}

/** "GeForce RTX 4070 / 4070 SUPER" → "RTX 4070", for short titles. */
export function shortGpu(name: string): string {
  return name.replace(/^GeForce\s+/, "").replace(/\s*\/.*$/, "").replace(/ Laptop GPU$/, " Laptop").replace(/ series$/, "");
}

const winOs = { name: "Windows", version: "11 24H2", arch: "x86_64" };
const r1 = (x: number) => Math.round(x * 10) / 10;

function discreteGpu(id: string, name: string, vramGiB: number): GpuDevice {
  const spec = lookupGpu(name);
  const vendor = spec?.vendor ?? "unknown";
  return gpu({
    id,
    // Named the way drivers report it, e.g. "NVIDIA GeForce RTX 4070".
    name: spec ? `${{ nvidia: "NVIDIA ", amd: "AMD ", intel: "Intel " }[vendor as string] ?? ""}${spec.name}` : name,
    vendor,
    kind: "discrete",
    dedicatedBytes: f(vramGiB * GiB, "Sample (your choice)"),
    // A sample has no live reading: it is always planned with "Normal use" reserves.
    freeBytes: f<number>(null, "Sample (planned, no live reading)", "none"),
    backendHints: vendor === "nvidia" ? ["cuda"] : vendor === "amd" ? ["rocm", "vulkan"] : [],
  });
}

// Samples have no "free right now": memory is planned with the Normal use reserves.
const ram = (totalGiB: number) => ({ totalBytes: f(totalGiB * GiB, "Sample (your choice)"), availableBytes: f<number>(null, "Sample (planned, no live reading)", "none") });

/** Builds the hardware report for a sample configuration. */
export function buildSample(cfg: SampleConfig): DemoMachine {
  switch (cfg.kind) {
    case "desktop": {
      const card = shortGpu(lookupGpu(cfg.gpu)?.name ?? cfg.gpu);
      const workstation = cfg.gpuCount === 2 || cfg.ramGiB >= 96 || /rtx pro|\bada\b|rtx a\d|radeon pro/i.test(cfg.gpu);
      const title = workstation ? "Workstation" : "Desktop PC";
      const name = `${title} · ${cfg.gpuCount === 2 ? `2 × ${card}` : card} · ${cfg.ramGiB} GB RAM`;
      return {
        id: "sample",
        name,
        report: base(title, {
          os: workstation ? { name: "Linux", version: "Ubuntu 24.04", arch: "x86_64" } : winOs,
          formFactor: f(workstation ? "workstation" : "desktop", "Sample", "high"),
          formFactorEvidence: [`Model: ${title}`],
          cpu: workstation ? { brand: "AMD Ryzen Threadripper 7960X", physicalCores: 24, logicalCores: 48 } : { brand: "AMD Ryzen 7 7800X3D", physicalCores: 8, logicalCores: 16 },
          memory: ram(cfg.ramGiB),
          memoryArchitecture: f("discrete"),
          gpus: Array.from({ length: cfg.gpuCount }, (_, i) => discreteGpu(`gpu${i}`, cfg.gpu, cfg.vramGiB)),
        }),
      };
    }
    case "laptop": {
      const card = shortGpu(lookupGpu(cfg.gpu)?.name ?? cfg.gpu);
      return {
        id: "sample",
        name: `Gaming laptop · ${card} · ${cfg.vramGiB} GB VRAM · ${cfg.ramGiB} GB RAM`,
        report: base("Gaming laptop", {
          os: winOs,
          formFactor: f("laptop"),
          formFactorEvidence: ["Model: Gaming laptop", "Battery present"],
          hasBattery: f(true),
          cpu: { brand: "Intel Core i7-14650HX", physicalCores: 16, logicalCores: 24 },
          memory: ram(cfg.ramGiB),
          memoryArchitecture: f("discrete"),
          // The CPU's own graphics are there too, but models use the NVIDIA GPU.
          gpus: [discreteGpu("gpu0", cfg.gpu, cfg.vramGiB), gpu({ id: "gpu1", name: "Intel UHD Graphics", vendor: "intel", kind: "integrated" })],
        }),
      };
    }
    case "mac": {
      const chip = cfg.chip.replace(/^Apple /, "");
      // macOS lets the GPU use about ⅔ of memory (¾ on larger configurations).
      const limit = cfg.ramGiB * (cfg.ramGiB <= 36 ? 2 / 3 : 3 / 4);
      const laptop = cfg.model.startsWith("MacBook");
      return {
        id: "sample",
        name: `${cfg.model} · ${chip} · ${cfg.ramGiB} GB`,
        report: base(cfg.model, {
          os: { name: "macOS", version: "26", arch: "aarch64" },
          formFactor: f(cfg.model === "Mac Studio" ? "workstation" : laptop ? "laptop" : "desktop"),
          formFactorEvidence: [`Model: ${cfg.model}`],
          hasBattery: f(laptop),
          cpu: { brand: cfg.chip, physicalCores: null, logicalCores: null },
          memory: ram(cfg.ramGiB),
          memoryArchitecture: f("unified"),
          unifiedGpuWorkingSetBytes: f(r1(limit) * GiB, "Sample (typical macOS GPU limit)", "medium"),
          gpus: [gpu({ id: "gpu0", name: `${cfg.chip} GPU`, vendor: "apple", kind: "unified", backendHints: ["metal"] })],
        }),
      };
    }
    case "office":
      return {
        id: "sample",
        name: `Office laptop · built-in graphics · ${cfg.ramGiB} GB RAM`,
        report: base("Office laptop", {
          os: winOs,
          formFactor: f("laptop"),
          formFactorEvidence: ["Model: Office laptop", "Battery present"],
          hasBattery: f(true),
          cpu: { brand: "Intel Core Ultra 5 125U", physicalCores: 12, logicalCores: 14 },
          memory: ram(cfg.ramGiB),
          memoryArchitecture: f("integrated_shared"),
          gpus: [gpu({ id: "gpu0", name: "Intel Graphics", vendor: "intel", kind: "integrated", sharedBytes: f((cfg.ramGiB / 2) * GiB, "Sample (shares system RAM)") })],
        }),
      };
    case "board": {
      const b = BOARD_MACHINES.find((x) => x.id === cfg.boardId) ?? BOARD_MACHINES[0];
      const baseRam = (b.report.memory.totalBytes.value ?? GiB) / GiB;
      const k = cfg.ramGiB / baseRam;
      const scale = (bytes: number | null) => (bytes == null ? null : bytes * k);
      const r: HardwareReport = {
        ...b.report,
        memory: {
          totalBytes: f(cfg.ramGiB * GiB, "Sample (your choice)"),
          availableBytes: f<number>(null, "Sample (planned, no live reading)", "none"),
        },
        unifiedGpuWorkingSetBytes:
          b.report.unifiedGpuWorkingSetBytes.value != null ? f(scale(b.report.unifiedGpuWorkingSetBytes.value), b.report.unifiedGpuWorkingSetBytes.source, "medium") : b.report.unifiedGpuWorkingSetBytes,
      };
      const parts = b.name.split(" · ");
      return { id: "sample", group: "board", name: k === 1 ? b.name : [parts[0], parts[1].replace(/^\d+ GB/, `${cfg.ramGiB} GB`), ...parts.slice(2)].join(" · "), report: r };
    }
  }
}

/** Overrides a sample needs: two cards are used together, as Ollama spreads a model across GPUs. */
export function sampleOverrides(cfg: SampleConfig): { selectedGpuIds?: string[]; combineGpus?: boolean } {
  return cfg.kind === "desktop" && cfg.gpuCount === 2 ? { selectedGpuIds: ["gpu0", "gpu1"], combineGpus: true } : {};
}
