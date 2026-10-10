import { useMemo } from "react";
import { estimate, type Estimate, type MachineProfile } from "../domain/estimator";
import { buildMachineProfile } from "../domain/hardware";
import type { BenchmarkRecord, ModelVariant, QuantId } from "../domain/types";
import { useStore, type QuantChoice } from "./store";

export function quantFor(m: ModelVariant, choice: QuantChoice, perModel: Record<string, QuantId>): QuantId {
  if (perModel[m.id]) return perModel[m.id];
  if (choice !== "AUTO") return choice;
  const def = m.artifacts.find((a) => a.isDefaultTag && a.quant !== "OTHER") ?? m.artifacts.find((a) => a.quant !== "OTHER");
  return def?.quant ?? "Q4_K_M";
}

export function useMachine(): MachineProfile | null {
  const hw = useStore((s) => s.hardware);
  const o = useStore((s) => s.overrides);
  return useMemo(() => (hw ? buildMachineProfile(hw, o) : null), [hw, o]);
}

export function useEstimate(m: ModelVariant | undefined, quantOverride?: QuantId): Estimate | null {
  const machine = useMachine();
  const settings = useStore((s) => s.settings);
  const choice = useStore((s) => s.quantChoice);
  const per = useStore((s) => s.perModelQuant);
  return useMemo(() => {
    if (!m || !machine) return null;
    return estimate(m, { ...settings, quant: quantOverride ?? quantFor(m, choice, per) }, machine);
  }, [m, machine, settings, choice, per, quantOverride]);
}

/**
 * The newest measurement that is really for this model file: same name and, when both are
 * known, the same digest and quantization (a re-pulled or different-quant model doesn't count).
 */
export function latestBenchmark(list: BenchmarkRecord[], m: ModelVariant): BenchmarkRecord | undefined {
  const names = new Set([m.resolvedTag, m.installed?.name, m.id].filter(Boolean) as string[]);
  const same = (b: BenchmarkRecord) =>
    names.has(b.model) &&
    !(b.digest && m.installed?.digest && b.digest !== m.installed.digest) &&
    !(b.quantLabel && m.installed?.quantLabel && b.quantLabel !== m.installed.quantLabel);
  return list.find((b) => same(b) && b.kind === "warm") ?? list.find(same);
}

const NO_BENCHMARKS: BenchmarkRecord[] = [];
/** Measurements from this computer; none while a sample machine is shown (they'd be for different hardware). */
export function useMeasuredBenchmarks(): BenchmarkRecord[] {
  const sample = useStore((s) => s.hardware?.mode === "demo");
  const list = useStore((s) => s.benchmarks);
  return sample ? NO_BENCHMARKS : list;
}

export const STALE_DAYS = 45;
export function isStale(iso: string | null | undefined, now = Date.now()): boolean {
  if (!iso) return false;
  return now - new Date(iso).getTime() > STALE_DAYS * 86400000;
}
export function ageText(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 60) return `${d} days ago`;
  return new Date(iso).toLocaleDateString();
}
