import { GiB } from "../lib/units";
import type { Field, GpuDevice, HardwareReport } from "../domain/types";

// Demo machines for the web preview and tests. Clearly labelled "Demo hardware".
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
    notes: [`Demo hardware: ${name}`],
    ...p,
  };
}

export interface DemoMachine {
  id: string;
  name: string;
  report: HardwareReport;
}

export const DEMO_MACHINES: DemoMachine[] = [
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
    name: "MacBook Pro · Apple M3 Pro · 36 GB unified",
    report: base("MacBook Pro", {
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
