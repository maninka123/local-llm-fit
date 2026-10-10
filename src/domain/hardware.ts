import { GiB } from "../lib/units";
import type { MachineGpu, MachineProfile } from "./estimator";
import type { GpuDevice, HardwareOverrides, HardwareReport, MemoryArchitecture } from "./types";
import { bandwidthFor } from "../platform/gpuSpecs";

// Turns a detected HardwareReport + user overrides into the MachineProfile the estimator uses.
// Rules enforced here:
//  - Windows "shared GPU memory" is NEVER added to VRAM.
//  - Multiple GPUs are NOT summed unless the user explicitly enables combineGpus.
//  - Unified memory is one pool; there is no separate VRAM figure.

export function computeGpus(report: HardwareReport): GpuDevice[] {
  return report.gpus.filter((g) => g.kind === "discrete" || (g.kind === "unknown" && (g.dedicatedBytes.value ?? 0) >= 2 * GiB));
}

export function defaultGpuSelection(report: HardwareReport): string[] {
  const gpus = computeGpus(report);
  if (!gpus.length) return [];
  const best = [...gpus].sort((a, b) => (b.dedicatedBytes.value ?? 0) - (a.dedicatedBytes.value ?? 0))[0];
  return [best.id];
}

export function gpuBackendSupport(g: GpuDevice | undefined): boolean | null {
  if (!g) return null;
  if (g.vendor === "nvidia" || g.vendor === "apple") return true;
  if (g.kind === "virtual" || g.vendor === "microsoft") return false;
  return null; // AMD (ROCm/Vulkan support varies by model), Intel, others: not assumed
}

export function effectiveArchitecture(report: HardwareReport, o: HardwareOverrides): MemoryArchitecture {
  if (o.memoryArchitecture) return o.memoryArchitecture;
  const detected = report.memoryArchitecture.value;
  if (detected) return detected;
  return computeGpus(report).length ? "discrete" : "cpu_only";
}

export function buildMachineProfile(report: HardwareReport, o: HardwareOverrides): MachineProfile {
  const arch = effectiveArchitecture(report, o);
  const ramTotal = o.ramTotalGiB != null ? o.ramTotalGiB * GiB : report.memory.totalBytes.value;
  const ramFree = o.ramFreeGiB != null ? o.ramFreeGiB * GiB : report.memory.availableBytes.value;

  let gpus: MachineGpu[] = [];
  let backend: boolean | null = null;
  if (arch === "discrete") {
    const all = computeGpus(report);
    const ids = o.selectedGpuIds?.length ? o.selectedGpuIds : defaultGpuSelection(report);
    const chosen = ids.map((id) => all.find((g) => g.id === id)).filter((g): g is GpuDevice => !!g);
    gpus = chosen.map((g) => ({
      id: g.id,
      name: g.name,
      vramTotal: g.dedicatedBytes.value, // dedicated only — sharedBytes deliberately ignored
      vramFree: g.freeBytes.value,
    }));
    if (!gpus.length && (o.vramTotalGiB != null || o.vramFreeGiB != null)) gpus = [{ id: "manual", name: "Manually entered GPU", vramTotal: null, vramFree: null }];
    if (gpus.length) {
      if (o.vramTotalGiB != null) gpus[0] = { ...gpus[0], vramTotal: o.vramTotalGiB * GiB };
      if (o.vramFreeGiB != null) gpus[0] = { ...gpus[0], vramFree: o.vramFreeGiB * GiB };
      // A manual total without a live free reading means planning mode for that GPU.
      if (o.vramTotalGiB != null && o.vramFreeGiB == null && gpus[0].vramFree != null && gpus[0].vramFree > gpus[0].vramTotal!) {
        gpus[0] = { ...gpus[0], vramFree: gpus[0].vramTotal };
      }
    }
    backend = chosen.length ? (chosen.every((g) => gpuBackendSupport(g) === true) ? true : chosen.some((g) => gpuBackendSupport(g) === false) ? false : null) : null;
    if (gpus[0]?.id === "manual") backend = true;
  } else if (arch === "unified") {
    backend = report.gpus.some((g) => g.vendor === "apple") || o.memoryArchitecture === "unified" ? true : null;
  }

  const unifiedGpuLimit = o.unifiedGpuLimitGiB != null ? o.unifiedGpuLimitGiB * GiB : report.unifiedGpuWorkingSetBytes.value;
  const label =
    arch === "unified"
      ? "Unified memory"
      : arch === "discrete"
        ? gpus.map((g) => g.name).join(" + ") || "Discrete GPU"
        : arch === "integrated_shared"
          ? "Integrated graphics (shared RAM)"
          : "CPU only";

  const bandwidths = gpus.map((g) => bandwidthFor(g.name));
  const gpuBandwidthGBs =
    arch === "unified"
      ? (bandwidthFor(report.gpus[0]?.name) ?? bandwidthFor(report.cpu.brand))
      : arch === "discrete" && bandwidths.length && bandwidths.every((b) => b != null)
        ? Math.min(...(bandwidths as number[]))
        : null;
  return {
    arch,
    gpus,
    gpuBandwidthGBs,
    combineGpus: o.combineGpus && gpus.length > 1,
    ramTotal,
    ramFree,
    unifiedGpuLimit,
    unifiedGpuLimitSource: o.unifiedGpuLimitGiB != null ? "user" : report.unifiedGpuWorkingSetBytes.value != null ? "detected" : "assumed",
    gpuBackendSupported: backend,
    label,
  };
}
