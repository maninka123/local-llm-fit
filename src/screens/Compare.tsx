import { useMemo } from "react";
import { Columns3, X } from "lucide-react";
import { useStore } from "../state/store";
import { latestBenchmark, useMeasuredBenchmarks, useBenchContext, quantFor, useMachine, ageText } from "../state/derived";
import { estimate, CLASS_META } from "../domain/estimator";
import { modalityLabel, resolveInput, resolveOutput, STATUS_TEXT } from "../domain/capabilities";
import { quantInfo } from "../domain/quant";
import { fmtBytes, fmtParams, fmtRange, fmtTokens } from "../lib/units";
import { Avatar, ConfidenceMeter, Empty, FitPill, TONE_VAR, Prov, SpeedLabel } from "../components/ui";
import { StatusIcon } from "../components/Capabilities";
import { AddToCompare } from "../components/AddToCompare";

export function Compare() {
  const ids = useStore((s) => s.compare);
  const catalog = useStore((s) => s.catalog);
  const toggle = useStore((s) => s.toggleCompare);
  const navigate = useStore((s) => s.navigate);
  const settings = useStore((s) => s.settings);
  const choice = useStore((s) => s.quantChoice);
  const per = useStore((s) => s.perModelQuant);
  const benches = useMeasuredBenchmarks();
  const machine = useMachine();
  const benchCtx = useBenchContext();
  // Machines where Ollama can't use a GPU: everything lives in RAM.
  const gpuRuns = !!machine && machine.gpuBackendSupported !== false && (machine.arch === "unified" || (machine.arch === "discrete" && machine.gpus.length > 0));

  const rows = useMemo(() => {
    if (!machine) return [];
    return ids
      .map((id) => catalog.get(id))
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map((m) => ({ m, e: estimate(m, { ...settings, quant: quantFor(m, choice, per) }, machine) }));
  }, [ids, catalog, machine, settings, choice, per]);

  if (!machine) return null;
  if (rows.length === 0) {
    return (
      <div>
        <div className="page-head">
          <div>
            <div className="eyebrow">Compare</div>
            <h1>Compare models side by side</h1>
          </div>
        </div>
        <div className="card">
          <Empty icon={<Columns3 size={34} />} title="Nothing to compare yet">
            <span>Add up to four models here, or with the Compare button on any card in the Model Explorer.</span>
            <div className="row" style={{ justifyContent: "center" }}>
              <AddToCompare big />
              <button className="btn" onClick={() => navigate({ page: "explore" })}>
                Open Model Explorer
              </button>
            </div>
          </Empty>
        </div>
      </div>
    );
  }

  const p = rows[0].e.pools;
  const capLine = machine.arch === "discrete" ? p.vramUsable : machine.arch === "unified" ? p.unifiedGpuLimit : p.ramUsable;
  const ramLine = machine.arch === "discrete" ? (p.vramUsable ?? 0) + (p.ramUsable ?? 0) : p.ramUsable;
  const scale = Math.max(...rows.map((r) => r.e.totalNeed?.high ?? 0), capLine ?? 0, ramLine ?? 0, 1) * 1.05;
  const pct = (b: number) => `${(b / scale) * 100}%`;
  const cols = `180px repeat(${rows.length}, minmax(0, 1fr))`;

  const line = (label: string, cells: React.ReactNode[]) => (
    <div key={label} style={{ display: "grid", gridTemplateColumns: cols, gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border)", alignItems: "start" }}>
      <div className="faint" style={{ fontSize: 14, fontWeight: 650 }}>
        {label}
      </div>
      {cells.map((c, i) => (
        <div key={i} style={{ fontSize: 15, minWidth: 0 }}>
          {c}
        </div>
      ))}
    </div>
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="eyebrow">Compare · same hardware, same settings</div>
          <h1>{rows.length} models side by side</h1>
          <p>
            {fmtTokens(settings.contextTokens)} context · {settings.parallel} session(s) · {settings.imageCount ? `${settings.imageCount} image(s)` : "text only"}. Change these on any model page.
          </p>
        </div>
        {rows.length < 4 && <AddToCompare />}
      </div>

      <section className="card" style={{ marginBottom: 18 }} aria-labelledby="pressure-title">
        <div className="card-head">
          <div>
            <h2 id="pressure-title">Memory pressure</h2>
            <p>
              Solid line: {machine.arch === "discrete" ? "usable VRAM" : machine.arch === "unified" ? "GPU working-set limit" : "usable RAM"}. Dashed: {machine.arch === "discrete" ? "VRAM + RAM combined" : "usable memory"}. Shaded tail = uncertainty.
            </p>
          </div>
        </div>
        <div className="stack">
          {rows.map(({ m, e }) => (
            <div key={m.id} className="lane" style={{ gridTemplateColumns: "180px 1fr" }}>
              <div className="lane-label">
                <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.displayName}</b>
                <span>{e.totalNeed ? fmtRange(e.totalNeed) : "size unknown"}</span>
              </div>
              <div className="lane-track" style={{ height: 30 }}>
                {e.totalNeed && (
                  <>
                    <div className="tank-fill" style={{ position: "absolute", left: 0, top: 4, bottom: 4, width: pct(e.totalNeed.high), borderRadius: 8, background: `color-mix(in srgb, ${TONE_VAR[e.classification]} 22%, transparent)` }} />
                    <div className="tank-fill" style={{ position: "absolute", left: 0, top: 4, bottom: 4, width: pct(e.totalNeed.mid), borderRadius: 8, background: TONE_VAR[e.classification] }} />
                  </>
                )}
                {capLine != null && <div style={{ position: "absolute", top: 0, bottom: 0, left: pct(capLine), borderLeft: "2px solid var(--text)" }} />}
                {ramLine != null && <div style={{ position: "absolute", top: 0, bottom: 0, left: pct(ramLine), borderLeft: "2px dashed var(--text-3)" }} />}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card" style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 180 + rows.length * 200 }}>
          <div style={{ display: "grid", gridTemplateColumns: cols, gap: 12, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
            <div />
            {rows.map(({ m }) => (
              <div key={m.id} className="stack" style={{ gap: 8 }}>
                <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
                  <Avatar name={m.family} developer={m.developer} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <button className="mname" style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left", color: "var(--text)" }} onClick={() => navigate({ page: "model", modelId: m.id })}>
                      {m.displayName}
                    </button>
                    <div className="mdev">{m.developer}</div>
                  </div>
                  <button className="btn ghost icon-btn sm" aria-label={`Remove ${m.displayName} from compare`} onClick={() => toggle(m.id)}>
                    <X size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          {line("Fit", rows.map(({ m, e }) => <FitPill key={m.id} cls={e.classification} cloud={m.cloudOnly} />))}
          {line("Confidence", rows.map(({ m, e }) => <ConfidenceMeter key={m.id} c={e.confidence} />))}
          {line("Speed (guess)", rows.map(({ m, e }) => {
            const b = latestBenchmark(benches, m, { ...benchCtx, quant: e.quant });
            return <SpeedLabel key={m.id} est={e} measured={b?.generationTokPerSec} />;
          }))}
          {line("Expected residency", rows.map(({ m, e }) => <span key={m.id}>{e.placement ? (gpuRuns ? `${Math.round(e.placement.gpuFraction * 100)}% GPU (planned)` : "RAM · runs on the CPU") : "—"}</span>))}
          {line("Total / active params", rows.map(({ m }) => <span key={m.id} className="num">{fmtParams(m.totalParamsB.value)} / {m.activeParamsB.value != null ? fmtParams(m.activeParamsB.value) : m.architecture.value === "dense" ? "all" : "Unknown"}</span>))}
          {line("Architecture", rows.map(({ m }) => <span key={m.id}>{m.architecture.value === "moe" ? `MoE${m.arch?.expertCount ? ` · ${m.arch.expertUsedCount}/${m.arch.expertCount} experts` : ""}` : m.architecture.value === "dense" ? "Dense" : "Unknown"} <Prov p={m.architecture.provenance} /></span>))}
          {line("Quantization", rows.map(({ m, e }) => <span key={m.id}>{e.artifact?.quantLabel ?? quantInfo(e.quant).label} <span className="faint">{e.quantSource === "published" ? "published" : "hypothetical"}</span></span>))}
          {line("Weights", rows.map(({ m, e }) => <span key={m.id} className="num">{e.weights ? fmtRange(e.weights, "GB") : "Unknown"} <Prov p={e.weightsProvenance} /></span>))}
          {line("KV cache", rows.map(({ m, e }) => <span key={m.id} className="num">{fmtRange(e.kv)} <Prov p={e.kvMethod === "metadata" ? "derived" : "heuristic"} /></span>))}
          {line("Runtime budget", rows.map(({ m, e }) => <span key={m.id} className="num">{gpuRuns ? `${fmtRange(e.gpuRuntime)} GPU · ${fmtRange(e.hostRuntime)} host` : `${fmtRange(e.gpuRuntime)} buffers · ${fmtRange(e.hostRuntime)} host (all in RAM)`}</span>))}
          {line("Total need", rows.map(({ m, e }) => <b key={m.id} className="num">{e.totalNeed ? fmtRange(e.totalNeed) : "Unknown"}</b>))}
          {line("Modalities", rows.map(({ m }) => {
            const l = modalityLabel(m.capabilities);
            return <span key={m.id}>{l.label} {!l.verified && <span className="faint">(unverified)</span>}</span>;
          }))}
          {(["text", "image", "audio", "video"] as const).map((k) =>
            line(`${k[0].toUpperCase() + k.slice(1)} input`, rows.map(({ m }) => {
              const s = resolveInput(m.capabilities, k).status;
              return <span key={m.id} className={`status s-${s}`} style={{ whiteSpace: "normal" }}><StatusIcon s={s} /> {STATUS_TEXT[s]}</span>;
            })),
          )}
          {line("Tool calls", rows.map(({ m }) => {
            const s = resolveOutput(m.capabilities, "tools").status;
            return <span key={m.id} className={`status s-${s}`} style={{ whiteSpace: "normal" }}><StatusIcon s={s} /> {STATUS_TEXT[s]}</span>;
          }))}
          {line("Max context", rows.map(({ m }) => <span key={m.id}>{m.contextMax.value ?? m.arch?.contextLength ? fmtTokens((m.contextMax.value ?? m.arch?.contextLength)!) : "Unknown"}</span>))}
          {line("Download", rows.map(({ m, e }) => <span key={m.id} className="num">{e.artifact?.downloadBytes ? fmtBytes(e.artifact.downloadBytes, "GB") : "—"}</span>))}
          {line("Last verified", rows.map(({ m }) => <span key={m.id}>{ageText(m.lastVerified)}</span>))}
          {line("Why", rows.map(({ m, e }) => <span key={m.id} className="faint" style={{ fontSize: 14 }}>{CLASS_META[e.classification].title}: {e.summary}</span>))}
        </div>
      </section>
    </div>
  );
}
