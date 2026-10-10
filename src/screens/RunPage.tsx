import { useMemo } from "react";
import { Cpu, Search, Sparkles, Zap } from "lucide-react";
import { useStore } from "../state/store";
import { quantFor, useMachine } from "../state/derived";
import { acceptsInputs } from "../domain/capabilities";
import { DEFAULT_SETTINGS, estimate, type Estimate, type MachineProfile } from "../domain/estimator";
import { quantInfo } from "../domain/quant";
import type { ModelVariant } from "../domain/types";
import { fmtBytes, fmtParams, GiB } from "../lib/units";
import { Avatar, Switch, AnimatedBytes, Seg, SpeedLabel } from "../components/ui";
import { InputPicker, CapabilityStrip } from "../components/Capabilities";
import { FORM_LABEL, FormIcon } from "../components/MachineBar";
import { useExplorer } from "./Explorer";
import { BUCKETS, bucketOf, recommend, type Bucket, type Recommendation } from "../domain/recommend";
import { MachineSetupCard } from "../components/MachineSetup";
import { BucketBadge } from "../components/SimilarModels";


function Spec({ label, value, sub, manual, tip }: { label: string; value: React.ReactNode; sub?: React.ReactNode; manual?: boolean; tip?: string }) {
  const mode = useStore((s) => s.hardware?.mode);
  const srcLabel = mode === "browser" ? "Browser / you" : mode === "demo" ? "Sample" : "Detected";
  return (
    <div className="spec">
      <div className="label">
        {label}
        <span className={`src-tag ${manual ? "manual" : ""}`} data-tip={tip} tabIndex={tip ? 0 : undefined}>
          {manual ? "Manually entered" : srcLabel}
        </span>
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
        <span className="muted num" style={{ fontSize: 14.5 }}>
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
      <div className="faint" style={{ fontSize: 13.5 }}>
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

export function RunPage() {
  const hw = useStore((s) => s.hardware);
  const o = useStore((s) => s.overrides);
  const catalog = useStore((s) => s.catalog);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const choice = useStore((s) => s.quantChoice);
  const per = useStore((s) => s.perModelQuant);
  const inputs = useStore((s) => s.inputs);
  const setInputs = useStore((s) => s.setInputs);
  const verifiedOnly = useStore((s) => s.verifiedOnly);
  const setVerifiedOnly = useStore((s) => s.setVerifiedOnly);
  const navigate = useStore((s) => s.navigate);
  const families = useStore((s) => s.families);
  const machine = useMachine();

  const results = useMemo(() => {
    if (!machine) return [];
    const out: { m: ModelVariant; e: Estimate; r: Recommendation }[] = [];
    for (const m of catalog.values()) {
      if (m.cloudOnly) continue;
      if (!acceptsInputs(m.capabilities, inputs, verifiedOnly)) continue;
      if (verifiedOnly && !m.lastVerified) continue;
      if (m.useCases.includes("embedding") || m.useCases.includes("safety")) continue;
      const e = estimate(m, { ...settings, quant: quantFor(m, choice, per) }, machine);
      out.push({ m, e, r: recommend(m, e, families[m.family]) });
    }
    return out;
  }, [catalog, machine, settings, choice, per, inputs, verifiedOnly, families]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(BUCKETS.map((b) => [b.id, 0])) as Record<Bucket, number>;
    for (const r of results) c[bucketOf(r.e.classification)]++;
    return c;
  }, [results]);

  const picks = useMemo(() => {
    // Best-ranked model per family in each group (so one family doesn't fill the list).
    const pick = (b: Bucket, n: number) => {
      const seen = new Set<string>();
      return results
        .filter((r) => bucketOf(r.e.classification) === b)
        .sort((a, c) => c.r.score - a.r.score)
        .filter((r) => (seen.has(r.m.family) ? false : (seen.add(r.m.family), true)))
        .slice(0, n);
    };
    return { well: pick("runs_well", 5), slower: pick("runs_slower", 5), tight: pick("tight", 5) };
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
  // Whether a GPU can run models at all, and whether RAM is board-slow (e.g. a Raspberry Pi).
  const gpuRuns = machine.gpuBackendSupported !== false && (machine.arch === "unified" || (machine.arch === "discrete" && machine.gpus.length > 0));
  const slowRam = (machine.ramBandwidthGBs ?? 100) < 40;

  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">What can I run</div>
          <h1>What can this computer run?</h1>
          <p>We read your hardware and estimate which local AI models fit, where they would live in memory, and how responsive they are likely to be.</p>
        </div>
        <button className="btn primary" onClick={() => useStore.getState().setTryOpen(true)}>
          <Search size={16} /> Try a specific model
        </button>
      </div>

      {hw.mode === "browser" && !hw.browserConfirmed && <MachineSetupCard />}
      {hw.mode === "demo" && (
        <div className="warning" style={{ alignItems: "center" }}>
          <span>
            You're viewing a <b>sample machine</b>. Estimates below are for that computer, not yours.
          </span>
          <span className="spacer" />
          <button className="btn sm primary" onClick={() => useStore.getState().setSetupOpen(true)}>
            Switch to my computer
          </button>
        </div>
      )}
      <section className="card hero" aria-labelledby="hero-title">
        <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
          <div className="avatar lg" style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }} aria-hidden>
            <FormIcon f={ff} size={26} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="hero-title" id="hero-title">
              {modelName ?? (ff ? FORM_LABEL[ff] : "Computer")} · {hw.cpu.brand}
            </div>
            <div className="muted" style={{ fontSize: 15 }}>
              {hw.os.name} {hw.os.version} · detected {new Date(hw.detectedAt).toLocaleString()} ·{" "}
              {hw.mode === "browser" ? "estimated in your browser (exact readings need the desktop app)" : est0?.pools.mode === "live" ? "using live free-memory readings" : "planning mode (no live readings)"}
              {hw.mode === "demo" && (
                <button className="badge demo" style={{ marginLeft: 8, cursor: "pointer" }} onClick={() => useStore.getState().setSetupOpen(true)}>
                  Sample machine · change
                </button>
              )}
              {(hw.mode == null || hw.mode === "native") && (
                <button
                  className="badge"
                  style={{ marginLeft: 8, cursor: "pointer" }}
                  data-tip="Something not right? Correct RAM, VRAM or other values"
                  onClick={() => useStore.getState().setSetupOpen(true)}
                >
                  Adjust
                </button>
              )}
              {hw.mode === "browser" && (
                <button className="badge demo" style={{ marginLeft: 8, cursor: "pointer" }} onClick={() => useStore.getState().setSetupOpen(true)}>
                  My computer · edit
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="spec-grid four">
          <Spec
            label="Type"
            manual={!!o.formFactor}
            value={ff && ff !== "unknown" ? (hw.formFactor.confidence === "low" && !o.formFactor ? `Likely ${FORM_LABEL[ff].toLowerCase()}` : FORM_LABEL[ff]) : "Computer"}
            sub={`${hw.os.name} ${hw.os.version}`.trim()}
            tip={hw.formFactorEvidence.join(" · ") || hw.formFactor.error}
          />
          <Spec label="Processor" value={hw.cpu.brand} sub={hw.cpu.logicalCores ? `${hw.cpu.physicalCores ? `${hw.cpu.physicalCores} cores · ` : ""}${hw.cpu.logicalCores} threads` : undefined} />
          <Spec
            label="Graphics"
            manual={o.vramTotalGiB != null || o.unifiedGpuLimitGiB != null}
            value={machine.arch === "unified" ? (gpu?.name ?? hw.gpus[0]?.name ?? "Apple GPU") : gpu ? `${gpu.name}` : machine.arch === "integrated_shared" ? "Integrated graphics" : "No graphics card"}
            sub={
              machine.arch === "unified"
                ? `Shares memory · GPU can use up to ${fmtBytes(machine.unifiedGpuLimit)}`
                : gpu
                  ? `${fmtBytes(gpu.vramTotal)} VRAM${gpu.vramFree != null ? ` · ${fmtBytes(gpu.vramFree)} free` : ""}`
                  : "Models run on the CPU"
            }
            tip={hw.gpus.length > 1 ? `${hw.gpus.length} adapters: ${hw.gpus.map((g) => g.name).join(", ")}` : undefined}
          />
          <Spec
            label="Memory"
            manual={o.ramTotalGiB != null || o.ramFreeGiB != null}
            value={`${fmtBytes(machine.ramTotal)}${machine.arch === "unified" ? " unified" : " RAM"}`}
            sub={machine.ramFree != null ? `${fmtBytes(machine.ramFree)} free right now` : "Free memory not measured"}
          />
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
              note={machine.arch === "unified" ? "One shared pool. The dashed line marks how much the GPU may use." : gpuRuns ? "Used for offloaded model layers when GPU memory runs out." : "Models load here and run on the CPU."}
            />
          </div>
          <div className="divider" />
          <div className="row">
            <Zap size={16} style={{ color: "var(--good)" }} />
            <span>
              {gpuRuns ? "Comfortable size for fast replies" : "Comfortable size (runs on the CPU)"}: <b>{comfortableSize(machine, est0)}</b> <span className="faint">(dense model, Q4, 8K context)</span>
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
                  <span>{hw.gpus.some((g) => g.vendor === "nvidia") ? "CUDA acceleration" : "Metal acceleration"}</span>
                </div>
              </div>
              <div className="chipbox" style={{ background: "color-mix(in srgb, var(--seg-weights) 10%, transparent)" }}>
                <b>{fmtBytes(machine.ramTotal)} unified memory</b>
                <span>Both read the same memory: no copying, no double counting</span>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 15 }}>
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
              <p className="muted" style={{ margin: 0, fontSize: 15 }}>
                Fastest when the whole model fits in VRAM. If not, layers spill into system RAM and run on the CPU, which usually slows replies a lot.
                Mixture-of-Experts models suffer less because only a few experts work on each word.
              </p>
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 15 }}>
              {slowRam
                ? "Models run on the CPU from this board's memory, which is much slower than a PC's. Expect a few words per second: 1–4B models at Q4 are the sweet spot."
                : "Models run on the CPU from system RAM. Small models (1–8B at Q4) are usually pleasant; larger ones will be slow. GPU acceleration on integrated graphics is not assumed."}
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
            {machine.ramFree != null && <Seg
              label="Memory to plan for"
              value={settings.memoryBasis}
              onChange={(v) => setSettings({ memoryBasis: v })}
              options={[
                { value: "live", label: "Live", title: "Memory free right now, with your apps open" },
                { value: "planning", label: "Normal use", title: "Normal background use: keeps about 20% of memory for the system and apps" },
              ]}
            />}
            <InputPicker value={inputs} onChange={setInputs} />
            <Switch checked={verifiedOnly} onChange={setVerifiedOnly} label="Only verified" />
          </div>
        </div>
        {settings.memoryBasis === "live" && est0 && est0.pools.ramFree != null && machine.ramTotal != null && est0.pools.ramFree < machine.ramTotal * 0.5 && (
          <div className="warning warn" style={{ marginBottom: 12 }}>
            <span>
              Only <b>{fmtBytes(est0.pools.ramFree)}</b> of {fmtBytes(machine.ramTotal)} is free right now because other apps are using memory. Switch to{" "}
              <button className="btn sm" onClick={() => setSettings({ memoryBasis: "planning" })}>
                Try with apps closed
              </button>{" "}
              to see what fits on a fresh start.
            </span>
          </div>
        )}
        <div className="tank-bar" style={{ height: 16, borderRadius: 99 }} role="img" aria-label="Distribution of fit results">
          {BUCKETS.filter((b) => counts[b.id] > 0).map((b) => (
            <div key={b.id} className="tank-fill" style={{ width: `${(counts[b.id] / total) * 100}%`, background: b.tone }} title={`${b.title}: ${counts[b.id]}`} />
          ))}
        </div>
        <div className="legend" style={{ marginTop: 12 }}>
          {BUCKETS.filter((b) => counts[b.id] > 0).map((b) => (
            <button
              key={b.id}
              className="fchip"
              data-tip={b.blurb}
              onClick={() => {
                useExplorer.getState().set({ buckets: [b.id] });
                navigate({ page: "explore" });
              }}
            >
              <span className="lamp" style={{ background: b.tone }} />
              {b.title} <b className="num">{counts[b.id]}</b>
            </button>
          ))}
        </div>
        <div className="divider" />
        <div className="grid cols-3">
          <PickList title="Runs well · best picks" items={picks.well} empty={gpuRuns ? "Nothing fits entirely in GPU memory at these settings." : "No usable GPU, so nothing runs at full speed. See the next column."} />
          <PickList title="Runs, but slower · best picks" items={picks.slower} empty="Nothing in this group." note={gpuRuns ? "Part runs on the CPU. MoE models usually cope best." : "Runs on the CPU. Smaller and MoE models reply fastest."} />
          <PickList title="Tight fit · best picks" items={picks.tight} empty="Nothing in this group." note="Fits only if you close other apps." />
        </div>
        <p className="faint" style={{ fontSize: 13.5, margin: "14px 0 0" }}>
          Ranked by size, popularity on ollama.com, how recent the model is, features (tools, thinking, vision) and how comfortably it fits: not a quality benchmark.
        </p>
      </section>
    </div>
  );
}

function PickList({ title, items, empty, note }: { title: string; items: { m: ModelVariant; e: Estimate; r: Recommendation }[]; empty: string; note?: string }) {
  const navigate = useStore((s) => s.navigate);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="eyebrow">{title}</div>
      {note && items.length > 0 && <div className="faint" style={{ fontSize: 13.5, marginTop: -4 }}>{note}</div>}
      {items.length === 0 && <div className="faint" style={{ fontSize: 14.5 }}>{empty}</div>}
      {items.map(({ m, e, r }, i) => (
        <button key={m.id} className="mcard" style={{ padding: 12, gap: 8 }} onClick={() => navigate({ page: "model", modelId: m.id })}>
          <div className="mcard-top">
            <Avatar name={m.family} developer={m.developer} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="mname">
                <span className="faint num" style={{ marginRight: 6 }}>{i + 1}.</span>
                {m.displayName}
              </div>
              <div className="mdev">
                {fmtParams(m.totalParamsB.value)}
                {m.activeParamsB.value ? ` · ${fmtParams(m.activeParamsB.value)} active` : ""} · {e.weights ? fmtBytes(e.weights.mid, "GB") : "size ?"}
              </div>
            </div>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <BucketBadge bucket={bucketOf(e.classification)} />
            <SpeedLabel est={e} />
          </div>
          <CapabilityStrip caps={m.capabilities} />
          {r.reasons.length > 0 && <div className="why-line">{r.reasons.slice(0, 3).join(" · ")}</div>}
        </button>
      ))}
    </div>
  );
}
