import { useMemo } from "react";
import { ArrowRight, Cpu, Sparkles, Zap } from "lucide-react";
import { useStore } from "../state/store";
import { quantFor, useMachine } from "../state/derived";
import { acceptsInputs } from "../domain/capabilities";
import { CLASS_META, DEFAULT_SETTINGS, estimate, RESPONSIVENESS_TEXT, type Estimate, type FitClass, type MachineProfile } from "../domain/estimator";
import { quantInfo } from "../domain/quant";
import type { ModelVariant } from "../domain/types";
import { fmtBytes, fmtParams, GiB } from "../lib/units";
import { FitPill, TONE_VAR, Avatar, Switch, AnimatedBytes } from "../components/ui";
import { InputPicker, CapabilityStrip } from "../components/Capabilities";
import { FORM_LABEL, FormIcon } from "../components/MachineBar";
import { useExplorer } from "./Explorer";

const ORDER: FitClass[] = ["full_gpu", "promising_moe", "cpu_only", "hybrid_slow", "memory_constrained", "cannot_fit", "unknown"];

function Spec({ label, value, sub, manual }: { label: string; value: React.ReactNode; sub?: React.ReactNode; manual?: boolean }) {
  return (
    <div className="spec">
      <div className="label">
        {label}
        <span className={`src-tag ${manual ? "manual" : ""}`}>{manual ? "Manually entered" : "Detected"}</span>
      </div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function Tank({ title, total, free, usable, limit, note }: { title: string; total: number | null; free: number | null; usable: number | null; limit?: number | null; note: string }) {
  const t = total ?? 0;
  const used = total != null && free != null ? total - free : null;
  const pct = (b: number) => `${t ? Math.min(100, (b / t) * 100) : 0}%`;
  return (
    <div className="tank">
      <div className="tank-head">
        <b>{title}</b>
        <span className="muted num" style={{ fontSize: 13 }}>
          {free != null ? (
            <>
              <AnimatedBytes bytes={free} /> free of {fmtBytes(total)}
            </>
          ) : (
            <>{fmtBytes(total)} total · free not measured</>
          )}
        </span>
      </div>
      <div className="tank-bar" style={{ position: "relative" }}>
        {used != null && (
          <div className="tank-fill" style={{ width: pct(used), background: "repeating-linear-gradient(135deg, var(--seg-reserve) 0 5px, transparent 5px 10px)" }} title={`In use now: ${fmtBytes(used)}`} />
        )}
        {usable != null && (
          <div
            className="tank-fill"
            style={{ width: pct(usable), background: "linear-gradient(90deg, color-mix(in srgb, var(--good) 45%, transparent), color-mix(in srgb, var(--good) 20%, transparent))" }}
            title={`Usable for models after reserve: ${fmtBytes(usable)}`}
          />
        )}
        {limit != null && t > 0 && <div className="limit-mark" style={{ left: pct(limit), top: -4, bottom: -4 }} title={`GPU working-set limit ${fmtBytes(limit)}`} />}
      </div>
      <div className="faint" style={{ fontSize: 12 }}>
        {note}
      </div>
    </div>
  );
}

function comfortableSize(m: MachineProfile, est0: Estimate | null): string {
  if (!est0) return "";
  const p = est0.pools;
  const budget = m.arch === "unified" ? Math.min(p.unifiedGpuLimit ?? 0, p.ramUsable ?? 0) : m.arch === "discrete" ? p.vramUsable ?? 0 : p.ramUsable ?? 0;
  const free = budget - 1.6 * GiB; // ~8K-context KV + buffers for a mid-size model
  if (free <= 0) return "Very small models only";
  const bytesPerParam = (quantInfo("Q4_K_M").bitsPerWeight / 8) * 1.02;
  const b = free / bytesPerParam / 1e9;
  return `≈ ${b >= 10 ? Math.floor(b) : b.toFixed(1)}B parameters`;
}

export function Overview() {
  const hw = useStore((s) => s.hardware);
  const o = useStore((s) => s.overrides);
  const catalog = useStore((s) => s.catalog);
  const settings = useStore((s) => s.settings);
  const choice = useStore((s) => s.quantChoice);
  const per = useStore((s) => s.perModelQuant);
  const inputs = useStore((s) => s.inputs);
  const setInputs = useStore((s) => s.setInputs);
  const verifiedOnly = useStore((s) => s.verifiedOnly);
  const setVerifiedOnly = useStore((s) => s.setVerifiedOnly);
  const navigate = useStore((s) => s.navigate);
  const ol = useStore((s) => s.ollamaState);
  const machine = useMachine();

  const results = useMemo(() => {
    if (!machine) return [];
    const out: { m: ModelVariant; e: Estimate }[] = [];
    for (const m of catalog.values()) {
      if (m.cloudOnly) continue;
      if (!acceptsInputs(m.capabilities, inputs, verifiedOnly)) continue;
      if (verifiedOnly && !m.lastVerified) continue;
      if (m.useCases.includes("embedding") || m.useCases.includes("safety")) continue;
      out.push({ m, e: estimate(m, { ...settings, quant: quantFor(m, choice, per) }, machine) });
    }
    return out;
  }, [catalog, machine, settings, choice, per, inputs, verifiedOnly]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(ORDER.map((k) => [k, 0])) as Record<FitClass, number>;
    for (const r of results) c[r.e.classification]++;
    return c;
  }, [results]);

  const picks = useMemo(() => {
    const pick = (cls: FitClass[], n: number, allowLow = false) => {
      const seen = new Set<string>();
      return results
        .filter((r) => cls.includes(r.e.classification) && (allowLow || r.e.confidence !== "low") && r.m.totalParamsB.value)
        .sort((a, b) => (b.m.lastVerified ? 1 : 0) - (a.m.lastVerified ? 1 : 0) || (b.m.totalParamsB.value ?? 0) - (a.m.totalParamsB.value ?? 0))
        .filter((r) => (seen.has(r.m.family) ? false : (seen.add(r.m.family), true)))
        .slice(0, n);
    };
    return { fast: pick(["full_gpu"], 6), moe: pick(["promising_moe"], 3, true), cpu: pick(["cpu_only", "hybrid_slow"], 3) };
  }, [results]);

  if (!hw || !machine) return <div className="card" style={{ marginTop: 24 }}>Detecting hardware…</div>;

  const est0 = results[0]?.e ?? (catalog.size ? estimate([...catalog.values()][0], { ...DEFAULT_SETTINGS, ...settings }, machine) : null);
  const ff = o.formFactor ?? hw.formFactor.value;
  const gpu = machine.gpus[0];
  const total = results.length || 1;
  const archText: Record<string, string> = {
    discrete: "Dedicated GPU memory + separate system RAM",
    unified: "Unified memory (one pool shared by CPU and GPU)",
    integrated_shared: "Integrated graphics sharing system RAM",
    cpu_only: "CPU only",
  };
  const modelName = hw.formFactorEvidence.find((e) => e.startsWith("Model: "))?.slice(7);

  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">Your Machine</div>
          <h1>What can this computer run?</h1>
          <p>We read your hardware and estimate which local AI models fit, where they would live in memory, and how responsive they are likely to be.</p>
        </div>
        <button className="btn primary" onClick={() => navigate({ page: "explore" })}>
          Explore all models <ArrowRight size={16} />
        </button>
      </div>

      <section className="card hero" aria-labelledby="hero-title">
        <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
          <div className="avatar lg" style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }} aria-hidden>
            <FormIcon f={ff} size={26} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="hero-title" id="hero-title">
              {modelName ?? (ff ? FORM_LABEL[ff] : "Computer")} · {hw.cpu.brand}
            </div>
            <div className="muted" style={{ fontSize: 13.5 }}>
              {hw.os.name} {hw.os.version} · detected {new Date(hw.detectedAt).toLocaleString()} ·{" "}
              {est0?.pools.mode === "live" ? "using live free-memory readings" : "planning mode (no live readings)"}
              {hw.demo && <span className="badge demo" style={{ marginLeft: 8 }}>Demo hardware</span>}
            </div>
          </div>
        </div>
        <div className="spec-grid">
          <Spec label="Operating system" value={hw.os.name} sub={`${hw.os.version} · ${hw.os.arch}`} />
          <Spec
            label="Hardware class"
            manual={!!o.formFactor}
            value={ff && ff !== "unknown" ? (hw.formFactor.confidence === "low" && !o.formFactor ? `Likely ${FORM_LABEL[ff].toLowerCase()}` : FORM_LABEL[ff]) : "Unknown"}
            sub={hw.formFactorEvidence.join(" · ") || hw.formFactor.error}
          />
          <Spec label="CPU" value={hw.cpu.brand} sub={`${hw.cpu.physicalCores ?? "?"} physical · ${hw.cpu.logicalCores ?? "?"} logical cores`} />
          <Spec
            label="GPU"
            manual={o.vramTotalGiB != null}
            value={hw.gpus.length ? (gpu?.name ?? hw.gpus.map((g) => g.name).join(", ")) : "No GPU detected"}
            sub={hw.gpus.length > 1 ? `${hw.gpus.length} adapters: ${hw.gpus.map((g) => g.name).join(", ")}` : hw.gpus[0]?.vendor}
          />
          {machine.arch === "unified" ? (
            <Spec label="GPU memory" value="Unified (no separate VRAM)" manual={o.unifiedGpuLimitGiB != null} sub={`GPU working-set limit: ${fmtBytes(machine.unifiedGpuLimit)} (${machine.unifiedGpuLimitSource})`} />
          ) : (
            <Spec
              label="Dedicated VRAM"
              manual={o.vramTotalGiB != null || o.vramFreeGiB != null}
              value={gpu ? fmtBytes(gpu.vramTotal) : "None"}
              sub={gpu ? (gpu.vramFree != null ? `${fmtBytes(gpu.vramFree)} free now` : "Free VRAM not reported") : machine.arch === "integrated_shared" ? "Integrated GPU uses system RAM" : undefined}
            />
          )}
          <Spec label="Memory (RAM)" manual={o.ramTotalGiB != null || o.ramFreeGiB != null} value={fmtBytes(machine.ramTotal)} sub={machine.ramFree != null ? `${fmtBytes(machine.ramFree)} available now` : "Available not measured"} />
          <Spec label="Memory architecture" manual={!!o.memoryArchitecture} value={archText[machine.arch]} sub={hw.memoryArchitecture.source} />
          <Spec label="Ollama" value={ol.status === "online" ? `Running · v${ol.version}` : ol.status === "checking" ? "Checking…" : "Not detected"} sub={ol.status === "online" ? `${ol.installed.length} model(s) installed` : "Optional: estimates work without it"} />
        </div>
        {hw.errors.length > 0 && (
          <div className="warning warn" style={{ marginTop: 14 }}>
            <span>
              Some readings are unavailable: {hw.errors.join(" · ")}. You can enter values manually in <a href="#/settings">Settings</a>.
            </span>
          </div>
        )}
      </section>

      <div className="grid cols-2">
        <section className="card" aria-labelledby="mem-title">
          <div className="card-head">
            <div>
              <h2 id="mem-title">Memory available for AI models</h2>
              <p>Green is what a model can use after keeping room for your system and apps.</p>
            </div>
          </div>
          <div className="tank-row">
            {machine.arch === "discrete" && gpu && (
              <Tank title={`GPU · ${gpu.name}`} total={gpu.vramTotal} free={gpu.vramFree} usable={est0?.pools.vramUsable ?? null} note="Dedicated VRAM only. Windows 'shared GPU memory' is system RAM and is not counted here." />
            )}
            <Tank
              title={machine.arch === "unified" ? "Unified memory (CPU + GPU)" : "System RAM"}
              total={machine.ramTotal}
              free={machine.ramFree}
              usable={est0?.pools.ramUsable ?? null}
              limit={machine.arch === "unified" ? machine.unifiedGpuLimit : null}
              note={machine.arch === "unified" ? "One shared pool. The dashed line marks how much the GPU may use." : "Used for offloaded model layers when GPU memory runs out."}
            />
          </div>
          <div className="divider" />
          <div className="row">
            <Zap size={16} style={{ color: "var(--good)" }} />
            <span>
              Comfortable size for fast replies: <b>{comfortableSize(machine, est0)}</b> <span className="faint">(dense model, Q4, 8K context)</span>
            </span>
          </div>
        </section>

        <section className="card" aria-labelledby="arch-title">
          <div className="card-head">
            <div>
              <h2 id="arch-title">How your computer runs AI models</h2>
              <p>{archText[machine.arch]}</p>
            </div>
          </div>
          {machine.arch === "unified" ? (
            <div className="stack">
              <div className="arch-diagram">
                <div className="chipbox">
                  <Cpu size={18} />
                  <b>CPU cores</b>
                  <span>run offloaded layers</span>
                </div>
                <div className="bus" />
                <div className="chipbox">
                  <Sparkles size={18} />
                  <b>GPU cores</b>
                  <span>Metal acceleration</span>
                </div>
              </div>
              <div className="chipbox" style={{ background: "color-mix(in srgb, var(--seg-weights) 10%, transparent)" }}>
                <b>{fmtBytes(machine.ramTotal)} unified memory</b>
                <span>Both read the same memory: no copying, no double counting</span>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
                A model fits well when it stays under the GPU's working-set limit. Beyond that, some layers run on the CPU: same memory, slower math.
              </p>
            </div>
          ) : machine.arch === "discrete" ? (
            <div className="stack">
              <div className="arch-diagram">
                <div className="chipbox">
                  <Cpu size={18} />
                  <b>CPU + system RAM</b>
                  <span>{fmtBytes(machine.ramTotal)}</span>
                </div>
                <div className="bus" title="PCIe link" />
                <div className="chipbox">
                  <Sparkles size={18} />
                  <b>GPU + VRAM</b>
                  <span>{fmtBytes(gpu?.vramTotal ?? null)}</span>
                </div>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
                Fastest when the whole model fits in VRAM. If not, layers spill into system RAM and run on the CPU, which usually slows replies a lot.
                Mixture-of-Experts models suffer less because only a few experts work on each word.
              </p>
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13.5 }}>
              Models run on the CPU from system RAM. Small models (1–8B at Q4) are usually pleasant; larger ones will be slow. GPU acceleration on integrated graphics
              is not assumed.
            </p>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="run-title">
        <div className="card-head" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <h2 id="run-title">What can I run?</h2>
            <p>
              Pick the inputs you need. {results.length} chat models match · {choice === "AUTO" ? "default published quantization" : quantInfo(choice).label} ·{" "}
              {Math.round(settings.contextTokens / 1024)}K context
            </p>
          </div>
          <div className="row">
            <InputPicker value={inputs} onChange={setInputs} />
            <Switch checked={verifiedOnly} onChange={setVerifiedOnly} label="Only verified" />
          </div>
        </div>
        <div className="tank-bar" style={{ height: 16, borderRadius: 99 }} role="img" aria-label="Distribution of fit results">
          {ORDER.filter((k) => counts[k] > 0).map((k) => (
            <div key={k} className="tank-fill" style={{ width: `${(counts[k] / total) * 100}%`, background: TONE_VAR[k] }} title={`${CLASS_META[k].title}: ${counts[k]}`} />
          ))}
        </div>
        <div className="legend" style={{ marginTop: 10 }}>
          {ORDER.map((k) => (
            <button key={k} className="fchip" onClick={() => { useExplorer.getState().set({ fits: [k] }); navigate({ page: "explore" }); }} style={{ height: 26 }} title={`See ${CLASS_META[k].title} models`}>
              <span className="lamp" style={{ background: TONE_VAR[k] }} />
              {CLASS_META[k].title} <b className="num">{counts[k]}</b>
            </button>
          ))}
        </div>
        <div className="divider" />
        <div className="grid cols-3">
          <PickList title="Fits in GPU — likely fast" items={picks.fast} empty="Nothing fits entirely in GPU memory at these settings." />
          <PickList title="Mixture-of-Experts worth testing" items={picks.moe} empty="No MoE models in the promising range." note="Lower confidence by design: real speed depends on expert placement." />
          <PickList title="Runs, but slower (CPU / offload)" items={picks.cpu} empty="—" />
        </div>
      </section>
    </div>
  );
}

function PickList({ title, items, empty, note }: { title: string; items: { m: ModelVariant; e: Estimate }[]; empty: string; note?: string }) {
  const navigate = useStore((s) => s.navigate);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="eyebrow">{title}</div>
      {note && items.length > 0 && <div className="faint" style={{ fontSize: 12, marginTop: -4 }}>{note}</div>}
      {items.length === 0 && <div className="faint" style={{ fontSize: 13 }}>{empty}</div>}
      {items.map(({ m, e }) => (
        <button key={m.id} className="mcard" style={{ padding: 12, gap: 8 }} onClick={() => navigate({ page: "model", modelId: m.id })}>
          <div className="mcard-top">
            <Avatar name={m.family} developer={m.developer} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="mname">{m.displayName}</div>
              <div className="mdev">
                {fmtParams(m.totalParamsB.value)}
                {m.activeParamsB.value ? ` · ${fmtParams(m.activeParamsB.value)} active` : ""} · {e.weights ? fmtBytes(e.weights.mid, "GB") : "size ?"} · {RESPONSIVENESS_TEXT[e.responsiveness]}
              </div>
            </div>
            <FitPill cls={e.classification} short />
          </div>
          <CapabilityStrip caps={m.capabilities} />
        </button>
      ))}
    </div>
  );
}
