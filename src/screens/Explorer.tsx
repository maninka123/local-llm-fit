import { useDeferredValue, useMemo } from "react";
import { create } from "zustand";
import { Columns3, Search, SlidersHorizontal, SearchX, Check, Download } from "lucide-react";
import { useStore, type QuantChoice } from "../state/store";
import { latestBenchmark, quantFor, useMachine } from "../state/derived";
import { acceptsInputs, matchesCapFilter, type CapFilter } from "../domain/capabilities";
import { CLASS_META, estimate, RESPONSIVENESS_TEXT, type Estimate, type FitClass } from "../domain/estimator";
import type { ModelVariant, UseCase } from "../domain/types";
import { fmtBytes, fmtParams } from "../lib/units";
import { Avatar, FitPill, Seg, Switch, TONE_VAR, Empty } from "../components/ui";
import { CapabilityStrip, InputPicker } from "../components/Capabilities";

const FITS: FitClass[] = ["full_gpu", "promising_moe", "cpu_only", "hybrid_slow", "memory_constrained", "cannot_fit", "unknown"];
const CAP_FILTERS: { k: CapFilter; label: string }[] = [
  { k: "text_only", label: "Text only" },
  { k: "image", label: "Image understanding" },
  { k: "audio", label: "Audio input" },
  { k: "video", label: "Video input" },
  { k: "multimodal", label: "Native multimodal" },
  { k: "tools", label: "Tool calling" },
  { k: "json", label: "Structured output" },
  { k: "embeddings", label: "Embeddings" },
  { k: "thinking", label: "Thinking" },
];
const USES: { k: UseCase; label: string }[] = [
  { k: "general", label: "General" },
  { k: "coding", label: "Coding" },
  { k: "reasoning", label: "Reasoning" },
  { k: "vision", label: "Vision" },
  { k: "embedding", label: "Embedding" },
  { k: "math", label: "Math" },
];
const SIZES: { k: string; label: string; min: number; max: number }[] = [
  { k: "any", label: "Any size", min: 0, max: Infinity },
  { k: "xs", label: "< 3B", min: 0, max: 3 },
  { k: "s", label: "3–9B", min: 3, max: 9.5 },
  { k: "m", label: "9–20B", min: 9.5, max: 20.5 },
  { k: "l", label: "20–40B", min: 20.5, max: 40.5 },
  { k: "xl", label: "40–80B", min: 40.5, max: 80.5 },
  { k: "xxl", label: "> 80B", min: 80.5, max: Infinity },
];
type Sort = "fit" | "largest" | "smallest" | "name";

interface Filters {
  q: string;
  fits: FitClass[];
  caps: CapFilter[];
  uses: UseCase[];
  arch: "any" | "dense" | "moe";
  size: string;
  installed: boolean;
  sort: Sort;
  more: boolean;
  limit: number;
  set(p: Partial<Omit<Filters, "set" | "reset">>): void;
  reset(): void;
}
const INITIAL = { q: "", fits: [] as FitClass[], caps: [] as CapFilter[], uses: [] as UseCase[], arch: "any" as const, size: "any", installed: false, sort: "fit" as Sort, more: false, limit: 48 };
export const useExplorer = create<Filters>((set) => ({ ...INITIAL, set: (p) => set({ ...p, limit: p.limit ?? 48 }), reset: () => set(INITIAL) }));

const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

export function Explorer() {
  const catalog = useStore((s) => s.catalog);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const choice = useStore((s) => s.quantChoice);
  const setChoice = useStore((s) => s.setQuantChoice);
  const per = useStore((s) => s.perModelQuant);
  const inputs = useStore((s) => s.inputs);
  const setInputs = useStore((s) => s.setInputs);
  const verifiedOnly = useStore((s) => s.verifiedOnly);
  const setVerifiedOnly = useStore((s) => s.setVerifiedOnly);
  const machine = useMachine();
  const f = useExplorer();
  const q = useDeferredValue(f.q);

  const all = useMemo(() => {
    if (!machine) return [];
    return [...catalog.values()].map((m) => ({ m, e: estimate(m, { ...settings, quant: quantFor(m, choice, per) }, machine) }));
  }, [catalog, machine, settings, choice, per]);

  const rows = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const size = SIZES.find((s) => s.k === f.size) ?? SIZES[0];
    const out = all.filter(({ m, e }) => {
      if (terms.length) {
        const hay = `${m.displayName} ${m.family} ${m.developer ?? ""} ${m.description ?? ""} ${m.useCases.join(" ")} ${m.resolvedTag ?? ""}`.toLowerCase();
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      if (!acceptsInputs(m.capabilities, inputs, verifiedOnly)) return false;
      if (verifiedOnly && !m.lastVerified) return false;
      if (f.fits.length && !f.fits.includes(e.classification)) return false;
      if (f.caps.length && !f.caps.every((c) => matchesCapFilter(m.capabilities, c, verifiedOnly))) return false;
      if (f.uses.length && !f.uses.some((u) => m.useCases.includes(u))) return false;
      if (f.arch === "moe" && m.architecture.value !== "moe") return false;
      if (f.arch === "dense" && m.architecture.value !== "dense") return false;
      if (f.size !== "any") {
        const p = m.totalParamsB.value;
        if (p == null || p < size.min || p >= size.max) return false;
      }
      if (f.installed && !m.installed) return false;
      return true;
    });
    const rank = (c: FitClass) => FITS.indexOf(c);
    out.sort((a, b) => {
      if (f.sort === "name") return a.m.displayName.localeCompare(b.m.displayName);
      const pa = a.m.totalParamsB.value ?? -1;
      const pb = b.m.totalParamsB.value ?? -1;
      if (f.sort === "largest") return pb - pa;
      if (f.sort === "smallest") return (pa < 0 ? 1e9 : pa) - (pb < 0 ? 1e9 : pb);
      return rank(a.e.classification) - rank(b.e.classification) || pb - pa;
    });
    return out;
  }, [all, q, f, inputs, verifiedOnly]);

  const counts = useMemo(() => {
    const c: Partial<Record<FitClass, number>> = {};
    for (const r of all) c[r.e.classification] = (c[r.e.classification] ?? 0) + 1;
    return c;
  }, [all]);

  const activeCount = f.fits.length + f.caps.length + f.uses.length + (f.arch !== "any" ? 1 : 0) + (f.size !== "any" ? 1 : 0) + (f.installed ? 1 : 0) + (f.q ? 1 : 0);
  const quantOptions: { value: QuantChoice; label: string; title?: string }[] = [
    { value: "AUTO", label: "Default tag", title: "Use each model's default published quantization" },
    { value: "F16", label: "FP16" },
    { value: "Q8_0", label: "Q8" },
    { value: "Q6_K", label: "Q6" },
    { value: "Q5_K_M", label: "Q5" },
    { value: "Q4_K_M", label: "Q4" },
    { value: "Q3_K_M", label: "Q3" },
    { value: "Q2_K", label: "Q2" },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="eyebrow">Model Explorer</div>
          <h1>{catalog.size} model variants</h1>
          <p>Every result is computed for your machine. Sizes marked "estimate" are not published files; capability icons with dashed borders are family hints, not verified.</p>
        </div>
      </div>

      <section className="card toolbar" aria-label="Search and filters">
        <div className="row">
          <div className="search">
            <Search size={17} />
            <input className="input" placeholder="Search models, families, developers…  e.g. qwen coder, vision, gemma" value={f.q} onChange={(e) => f.set({ q: e.target.value })} aria-label="Search models" />
          </div>
          <select className="select" value={f.sort} onChange={(e) => f.set({ sort: e.target.value as Sort })} aria-label="Sort by">
            <option value="fit">Best fit first</option>
            <option value="largest">Largest first</option>
            <option value="smallest">Smallest first</option>
            <option value="name">Name A–Z</option>
          </select>
          <button className="btn" onClick={() => f.set({ more: !f.more })} aria-expanded={f.more}>
            <SlidersHorizontal size={15} /> Filters{activeCount ? ` (${activeCount})` : ""}
          </button>
        </div>
        <div className="filter-row">
          <span className="lbl">I'll provide</span>
          <InputPicker value={inputs} onChange={setInputs} />
          <Switch checked={verifiedOnly} onChange={setVerifiedOnly} label="Only verified compatible" />
        </div>
        <div className="filter-row">
          <span className="lbl">Fit</span>
          {FITS.map((k) => (
            <button key={k} className="fchip" aria-pressed={f.fits.includes(k)} onClick={() => f.set({ fits: toggle(f.fits, k) })}>
              <span className="lamp" style={{ background: TONE_VAR[k] }} />
              {CLASS_META[k].title}
              <span className="faint num">{counts[k] ?? 0}</span>
            </button>
          ))}
        </div>
        {f.more && (
          <>
            <div className="filter-row">
              <span className="lbl">Quantization</span>
              <Seg label="Quantization" value={choice} onChange={setChoice} options={quantOptions} />
              <span className="lbl" style={{ minWidth: 0, marginLeft: 8 }}>
                Context
              </span>
              <Seg
                label="Context length"
                value={settings.contextTokens}
                onChange={(v) => setSettings({ contextTokens: v })}
                options={[2048, 4096, 8192, 16384, 32768, 65536, 131072].map((v) => ({ value: v, label: `${v / 1024}K` }))}
              />
            </div>
            <div className="filter-row">
              <span className="lbl">Capability</span>
              {CAP_FILTERS.map((c) => (
                <button key={c.k} className="fchip" aria-pressed={f.caps.includes(c.k)} onClick={() => f.set({ caps: toggle(f.caps, c.k) })}>
                  {c.label}
                </button>
              ))}
            </div>
            <div className="filter-row">
              <span className="lbl">Use case</span>
              {USES.map((u) => (
                <button key={u.k} className="fchip" aria-pressed={f.uses.includes(u.k)} onClick={() => f.set({ uses: toggle(f.uses, u.k) })}>
                  {u.label}
                </button>
              ))}
            </div>
            <div className="filter-row">
              <span className="lbl">Size</span>
              <Seg label="Parameter range" value={f.size} onChange={(v) => f.set({ size: v })} options={SIZES.map((s) => ({ value: s.k, label: s.label }))} />
              <Seg
                label="Architecture"
                value={f.arch}
                onChange={(v) => f.set({ arch: v })}
                options={[
                  { value: "any", label: "Any type" },
                  { value: "dense", label: "Dense" },
                  { value: "moe", label: "MoE" },
                ]}
              />
              <Switch checked={f.installed} onChange={(v) => f.set({ installed: v })} label="Installed in Ollama" />
              {activeCount > 0 && (
                <button className="btn ghost sm" onClick={() => f.reset()}>
                  Clear all
                </button>
              )}
            </div>
          </>
        )}
      </section>

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted" aria-live="polite">
          Showing <b className="num">{Math.min(rows.length, f.limit)}</b> of <b className="num">{rows.length}</b> matches
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <Empty icon={<SearchX size={34} />} title="No models match these filters">
            <span>Try removing a filter, turning off "Only verified", or searching online in Find a Model.</span>
            <button className="btn" onClick={() => f.reset()}>
              Clear filters
            </button>
          </Empty>
        </div>
      ) : (
        <div className="model-grid">
          {rows.slice(0, f.limit).map(({ m, e }) => (
            <ModelCard key={m.id} m={m} e={e} />
          ))}
        </div>
      )}
      {rows.length > f.limit && (
        <div className="row" style={{ justifyContent: "center", marginTop: 18 }}>
          <button className="btn" onClick={() => f.set({ limit: f.limit + 48 })}>
            Show more ({rows.length - f.limit} left)
          </button>
        </div>
      )}
    </div>
  );
}

export function ModelCard({ m, e }: { m: ModelVariant; e: Estimate }) {
  const navigate = useStore((s) => s.navigate);
  const compare = useStore((s) => s.compare);
  const toggleCompare = useStore((s) => s.toggleCompare);
  const benches = useStore((s) => s.benchmarks);
  const inCompare = compare.includes(m.id);
  const bench = latestBenchmark(benches, m);
  const p = e.pools;
  const cap = p.arch === "discrete" ? p.vramUsable : p.arch === "unified" ? Math.min(p.unifiedGpuLimit ?? Infinity, p.ramUsable ?? Infinity) : p.ramUsable;
  const need = e.totalNeed?.mid ?? null;
  const scale = Math.max(need ?? 0, cap ?? 0, 1) * 1.05;
  const dl = e.artifact?.downloadBytes ?? null;
  return (
    <div
      className="mcard"
      role="link"
      tabIndex={0}
      aria-label={`${m.displayName}: ${CLASS_META[e.classification].title}`}
      onClick={() => navigate({ page: "model", modelId: m.id })}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          navigate({ page: "model", modelId: m.id });
        }
      }}
    >
      <div className="mcard-top">
        <Avatar name={m.family} developer={m.developer} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="mname">{m.displayName}</div>
          <div className="mdev">
            {m.developer ?? "Unknown developer"}
            {m.lastVerified ? (
              <span className="badge verified" style={{ marginLeft: 6 }}>
                <Check size={11} /> verified
              </span>
            ) : (
              <span className="badge" style={{ marginLeft: 6 }} title="Seed/lookup data only; not checked against an official source">
                unverified
              </span>
            )}
            {m.installed && (
              <span className="badge" style={{ marginLeft: 6 }}>
                <Download size={11} /> installed
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="kv-row">
        <span>
          Total <b className="num">{fmtParams(m.totalParamsB.value)}</b>
        </span>
        <span title={m.activeParamsB.note}>
          Active <b className="num">{m.activeParamsB.value != null ? fmtParams(m.activeParamsB.value) : m.architecture.value === "dense" ? "all" : "Unknown"}</b>
        </span>
        <span>
          {e.quantSource === "published" ? "File" : "Size"}{" "}
          <b className="num">{e.weights ? fmtBytes(dl ?? e.weights.mid, "GB") : "?"}</b>
          {e.quantSource !== "published" && e.weights && <span className="faint"> est.</span>}
        </span>
        <span className="faint">{e.artifact?.quantLabel ?? e.quant}</span>
      </div>
      <CapabilityStrip caps={m.capabilities} />
      {need != null && cap != null && (
        <div className="minibar" title={`Needs ≈ ${fmtBytes(need)} · ${p.arch === "discrete" ? "usable VRAM" : p.arch === "unified" ? "GPU-usable memory" : "usable RAM"} ${fmtBytes(cap)}`}>
          <div style={{ width: `${(Math.min(need, scale) / scale) * 100}%`, background: TONE_VAR[e.classification] }} />
          <span className="cap-line" style={{ left: `${(cap / scale) * 100}%` }} />
        </div>
      )}
      <div className="mcard-foot">
        <div className="row" style={{ gap: 8 }}>
          <FitPill cls={e.classification} short cloud={m.cloudOnly} />
          <span className="faint" style={{ fontSize: 12 }}>
            {bench?.generationTokPerSec ? (
              <b style={{ color: "var(--good)" }}>Measured {bench.generationTokPerSec.toFixed(0)} tok/s here</b>
            ) : (
              RESPONSIVENESS_TEXT[e.responsiveness]
            )}
          </span>
        </div>
        <button
          className={`btn sm ${inCompare ? "" : "ghost"}`}
          aria-pressed={inCompare}
          onClick={(ev) => {
            ev.stopPropagation();
            toggleCompare(m.id);
          }}
          title={inCompare ? "Remove from Compare" : "Add to Compare"}
        >
          <Columns3 size={14} /> {inCompare ? "Comparing" : "Compare"}
        </button>
      </div>
    </div>
  );
}
