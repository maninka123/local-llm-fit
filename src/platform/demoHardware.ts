import { GiB } from "../lib/units";
import type { Field, GpuDevice, HardwareReport } from "../domain/types";

// Demo machines for the web preview and tests. Clearly labelled "Sample".
const f = <T,>(value: T | null, source = "Demo fixture", confidence: Field<T>["confidence"] = "high"): Field<T> => ({ value, source, confidence });
const none = <T,>(why: string): Field<T> => ({ value: null, source: "Demo fixture", confidence: "none", error: why });

function gpu(p: Partial<GpuDevice> & Pick<GpuDevice, "id" | "name" | "vendor" | "kind">): GpuDevice {
  return {
    dedicatedBytes: none("n/a"),
    freeBytes: none("n/a"),
    sharedBytes: none("n/a"),
    backendHints: [],
    ...p,
  };
}

function base(name: string, p: Partial<HardwareReport>): HardwareReport {
  return {
    probeVersion: "demo",
    demo: true,
    detectedAt: "2026-10-10T09:00:00.000Z",
    os: { name: "Demo OS", version: "", arch: "x86_64" },
    formFactor: f("desktop"),
    formFactorEvidence: ["Demo fixture"],
    hasBattery: f(false),
    isVirtualMachine: f(false),
    cpu: { brand: "Demo CPU", physicalCores: 8, logicalCores: 16 },
    memory: { totalBytes: f(32 * GiB), availableBytes: f(22 * GiB, "Demo fixture (live)") },
    memoryArchitecture: f("discrete"),
    unifiedGpuWorkingSetBytes: none("Not applicable"),
    gpus: [],
    errors: [],
    notes: [`Sample machine: ${name}`],
    ...p,
  };
}

export interface DemoMachine {
  id: string;
  /** "Title · subtitle" — the UI splits on " · ". */
  name: string;
  /** Shown under "Single-board & edge AI" in the sample picker. */
  group?: "computer" | "board";
  report: HardwareReport;
}

// Small boards. Every board has a GPU, but Ollama only uses some of them:
//  - Raspberry Pi (VideoCore), RK3588 (Mali) and the original Jetson Nano (Maxwell, JetPack 4):
//    the GPU shares RAM and Ollama has no backend for it, so models run on the CPU.
//  - Jetson Orin / Thor and DGX Spark: one memory pool shared with a CUDA GPU that Ollama uses.
function sharedGpuBoard(id: string, name: string, gpuName: string, vendor: GpuDevice["vendor"], cpu: HardwareReport["cpu"], ramGiB: number, freeGiB: number, os: HardwareReport["os"], why: string): DemoMachine {
  return {
    id,
    name,
    group: "board",
    report: base(name.split(" · ")[0], {
      os,
      formFactor: f("embedded"),
      formFactorEvidence: [`Model: ${name.split(" · ")[0].replace(/ \(.*\)$/, "")}`, why],
      cpu,
      memory: { totalBytes: f(ramGiB * GiB), availableBytes: f(freeGiB * GiB, "Demo fixture (live)") },
      memoryArchitecture: f("integrated_shared"),
      gpus: [gpu({ id: "gpu0", name: gpuName, vendor, kind: "integrated", sharedBytes: f(ramGiB * GiB, "Demo fixture (shares system RAM)") })],
    }),
  };
}

function nvidiaBoard(id: string, name: string, gpuName: string, cpu: HardwareReport["cpu"], ramGiB: number, freeGiB: number, gpuLimitGiB: number, os: HardwareReport["os"], ff: "embedded" | "desktop" = "embedded"): DemoMachine {
  return {
    id,
    name,
    group: "board",
    report: base(name.split(" · ")[0], {
      os,
      formFactor: f(ff),
      formFactorEvidence: [`Model: ${name.split(" · ")[0]}`, "CPU and GPU share one memory pool"],
      cpu,
      memory: { totalBytes: f(ramGiB * GiB), availableBytes: f(freeGiB * GiB, "Demo fixture (live)") },
      memoryArchitecture: f("unified"),
      unifiedGpuWorkingSetBytes: f(gpuLimitGiB * GiB, "Demo fixture (CUDA can use nearly all shared memory)", "medium"),
      gpus: [gpu({ id: "gpu0", name: gpuName, vendor: "nvidia", kind: "unified", backendHints: ["cuda"] })],
    }),
  };
}

const PI_OS = { name: "Raspberry Pi OS", version: "Bookworm", arch: "aarch64" };
const JETPACK6 = { name: "Linux", version: "JetPack 6.2 (Ubuntu 22.04)", arch: "aarch64" };

export const BOARD_MACHINES: DemoMachine[] = [
  sharedGpuBoard("rpi5-8", "Raspberry Pi 5 (8 GB) · 8 GB RAM · GPU not used by Ollama", "Broadcom VideoCore VII", "other", { brand: "Broadcom BCM2712 (Cortex-A76)", physicalCores: 4, logicalCores: 4 }, 8, 7, PI_OS, "Ollama has no backend for the VideoCore GPU"),
  sharedGpuBoard("rpi5-16", "Raspberry Pi 5 (16 GB) · 16 GB RAM · GPU not used by Ollama", "Broadcom VideoCore VII", "other", { brand: "Broadcom BCM2712 (Cortex-A76)", physicalCores: 4, logicalCores: 4 }, 16, 14.8, PI_OS, "Ollama has no backend for the VideoCore GPU"),
  sharedGpuBoard("rpi4-8", "Raspberry Pi 4 (8 GB) · 8 GB RAM · GPU not used by Ollama", "Broadcom VideoCore VI", "other", { brand: "Broadcom BCM2711 (Cortex-A72)", physicalCores: 4, logicalCores: 4 }, 8, 7, PI_OS, "Ollama has no backend for the VideoCore GPU"),
  sharedGpuBoard("opi5plus-16", "Orange Pi 5 Plus · 16 GB RAM · Mali GPU + NPU not used by Ollama", "Arm Mali-G610 MP4 (+ 6 TOPS NPU)", "other", { brand: "Rockchip RK3588 (4× A76 + 4× A55)", physicalCores: 8, logicalCores: 8 }, 16, 14.5, { name: "Linux", version: "Ubuntu 22.04", arch: "aarch64" }, "Ollama has no backend for the Mali GPU or the NPU"),
  sharedGpuBoard("jetson-nano-4", "Jetson Nano (original) · 4 GB shared · CUDA GPU too old for Ollama", "NVIDIA Maxwell (128 CUDA cores)", "nvidia", { brand: "NVIDIA Tegra X1 (Cortex-A57)", physicalCores: 4, logicalCores: 4 }, 4, 3.2, { name: "Linux", version: "JetPack 4.6 (Ubuntu 18.04)", arch: "aarch64" }, "Current Ollama needs JetPack 5 or newer (Xavier / Orin)"),
  nvidiaBoard("jetson-orin-nano-8", "Jetson Orin Nano Super · 8 GB shared · CUDA GPU", "NVIDIA Jetson Orin Nano Super (1024-core Ampere)", { brand: "Arm Cortex-A78AE", physicalCores: 6, logicalCores: 6 }, 8, 6.4, 6.5, JETPACK6),
  nvidiaBoard("jetson-orin-nx-16", "Jetson Orin NX · 16 GB shared · CUDA GPU", "NVIDIA Jetson Orin NX (1024-core Ampere)", { brand: "Arm Cortex-A78AE", physicalCores: 8, logicalCores: 8 }, 16, 13.5, 14, JETPACK6),
  nvidiaBoard("jetson-agx-orin-64", "Jetson AGX Orin · 64 GB shared · CUDA GPU", "NVIDIA Jetson AGX Orin (2048-core Ampere)", { brand: "Arm Cortex-A78AE", physicalCores: 12, logicalCores: 12 }, 64, 58, 60, JETPACK6),
  nvidiaBoard("jetson-agx-thor-128", "Jetson AGX Thor · 128 GB shared · CUDA GPU", "NVIDIA Jetson AGX Thor (Blackwell)", { brand: "Arm Neoverse-V3AE", physicalCores: 14, logicalCores: 14 }, 128, 118, 120, { name: "Linux", version: "JetPack 7 (Ubuntu 24.04)", arch: "aarch64" }),
  nvidiaBoard("dgx-spark-128", "NVIDIA DGX Spark · 128 GB shared · CUDA GPU", "NVIDIA GB10 Grace Blackwell", { brand: "NVIDIA GB10 (10× X925 + 10× A725)", physicalCores: 20, logicalCores: 20 }, 128, 116, 120, { name: "DGX OS", version: "7 (Ubuntu 24.04)", arch: "aarch64" }, "desktop"),
];

export const COMPUTER_MACHINES: DemoMachine[] = [
  {
    id: "desktop-16g",
    name: "Gaming desktop · 16 GB GPU · 32 GB RAM",
    report: base("Gaming desktop", {
      os: { name: "Windows", version: "11 24H2", arch: "x86_64" },
      cpu: { brand: "AMD Ryzen 7 7800X3D", physicalCores: 8, logicalCores: 16 },
      gpus: [
        gpu({
          id: "gpu0",
          name: "NVIDIA GeForce RTX 4070 Ti SUPER",
          vendor: "nvidia",
          kind: "discrete",
          dedicatedBytes: f(16 * GiB, "Demo fixture (DXGI dedicated)"),
          freeBytes: f(15.1 * GiB, "Demo fixture (NVML)"),
          sharedBytes: f(15.9 * GiB, "Demo fixture (DXGI shared system memory)"),
          driverVersion: "580.88",
          backendHints: ["cuda"],
        }),
      ],
    }),
  },
  {
    id: "mac-m3pro-36",
    name: "MacBook · Apple M3 Pro · 36 GB unified",
    report: base("MacBook", {
      os: { name: "macOS", version: "26.1", arch: "aarch64" },
      formFactor: f("laptop"),
      formFactorEvidence: ["Demo fixture: battery present", "Model identifier Mac15,x"],
      hasBattery: f(true),
      cpu: { brand: "Apple M3 Pro", physicalCores: 12, logicalCores: 12 },
      memory: { totalBytes: f(36 * GiB), availableBytes: f(24 * GiB, "Demo fixture (live)") },
      memoryArchitecture: f("unified"),
      unifiedGpuWorkingSetBytes: f(27 * GiB, "Demo fixture (Metal recommendedMaxWorkingSetSize)"),
      gpus: [gpu({ id: "gpu0", name: "Apple M3 Pro (18-core GPU)", vendor: "apple", kind: "unified", backendHints: ["metal"] })],
    }),
  },
  {
    id: "laptop-8g",
    name: "Gaming laptop · 8 GB GPU · 16 GB RAM",
    report: base("Gaming laptop", {
      os: { name: "Linux", version: "Ubuntu 24.04", arch: "x86_64" },
      formFactor: f("laptop", "Demo fixture (DMI chassis type 10)"),
      formFactorEvidence: ["Battery present", "DMI chassis type: Notebook"],
      hasBattery: f(true),
      cpu: { brand: "Intel Core i7-13650HX", physicalCores: 14, logicalCores: 20 },
      memory: { totalBytes: f(16 * GiB), availableBytes: f(10.5 * GiB, "Demo fixture (live)") },
      gpus: [
        gpu({ id: "gpu0", name: "NVIDIA GeForce RTX 4060 Laptop GPU", vendor: "nvidia", kind: "discrete", dedicatedBytes: f(8 * GiB), freeBytes: f(7.6 * GiB), backendHints: ["cuda"] }),
        gpu({ id: "gpu1", name: "Intel UHD Graphics", vendor: "intel", kind: "integrated", backendHints: [] }),
      ],
    }),
  },
  {
    id: "office-igpu",
    name: "Office laptop · integrated graphics · 16 GB RAM",
    report: base("Office laptop", {
      os: { name: "Windows", version: "11 23H2", arch: "x86_64" },
      formFactor: f("laptop"),
      formFactorEvidence: ["Battery present", "Chassis type: Notebook"],
      hasBattery: f(true),
      cpu: { brand: "Intel Core Ultra 5 125U", physicalCores: 12, logicalCores: 14 },
      memory: { totalBytes: f(15.6 * GiB), availableBytes: f(8.2 * GiB, "Demo fixture (live)") },
      memoryArchitecture: f("integrated_shared"),
      gpus: [
        gpu({
          id: "gpu0",
          name: "Intel Graphics",
          vendor: "intel",
          kind: "integrated",
          dedicatedBytes: f(0.125 * GiB, "Demo fixture (DXGI dedicated carve-out)"),
          sharedBytes: f(7.8 * GiB, "Demo fixture (DXGI shared system memory)"),
        }),
      ],
    }),
  },
  {
    id: "workstation-2x24",
    name: "Workstation · 2 × 24 GB GPUs · 128 GB RAM",
    report: base("Workstation", {
      os: { name: "Linux", version: "Ubuntu 24.04", arch: "x86_64" },
      formFactor: f("workstation", "Demo fixture (DMI chassis type 7 + 128 GB RAM)", "medium"),
      formFactorEvidence: ["DMI chassis type: Tower", "Two discrete GPUs"],
      cpu: { brand: "AMD Ryzen Threadripper 7960X", physicalCores: 24, logicalCores: 48 },
      memory: { totalBytes: f(128 * GiB), availableBytes: f(110 * GiB, "Demo fixture (live)") },
      gpus: [
        gpu({ id: "gpu0", name: "NVIDIA GeForce RTX 3090", vendor: "nvidia", kind: "discrete", dedicatedBytes: f(24 * GiB), freeBytes: f(23.4 * GiB), backendHints: ["cuda"] }),
        gpu({ id: "gpu1", name: "NVIDIA GeForce RTX 3090", vendor: "nvidia", kind: "discrete", dedicatedBytes: f(24 * GiB), freeBytes: f(23.6 * GiB), backendHints: ["cuda"] }),
      ],
    }),
  },
];

export const DEMO_MACHINES: DemoMachine[] = [...COMPUTER_MACHINES, ...BOARD_MACHINES];

// Building blocks for configurable samples (see samples.ts).
export { f as fixtureField, gpu as fixtureGpu, base as fixtureBase };
