import { useMemo } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Gauge, SearchX, XCircle } from "lucide-react";
import { useStore } from "../state/store";
import { useMachine } from "../state/derived";
import { estimate, type Estimate, type EstimatorSettings } from "../domain/estimator";
import { resolveInput, resolveOutput } from "../domain/capabilities";
import { BUCKETS, bucketOf, recommend, type Bucket } from "../domain/recommend";
import type { ModelVariant, QuantId } from "../domain/types";
import { fmtBytes, fmtParams } from "../lib/units";
import { Avatar, SpeedLabel } from "./ui";

// "Real models like this": the best catalog matches for the Playground's current shape.
// Shown whether or not they run, each with the same coloured status as the main pages.

export interface Shape {
  kind: "dense" | "moe";
  totalB: number;
  activeB: number;
  quant: QuantId;
  images: number;
}

const BUCKET_ICON: Record<Bucket, React.ReactNode> = {
  runs_well: <CheckCircle2 size={16} />,
  runs_slower: <Gauge size={16} />,
  tight: <AlertTriangle size={15} />,
  wont_run: <XCircle size={16} />,
};

export function BucketBadge({ bucket }: { bucket: Bucket }) {
  const b = BUCKETS.find((x) => x.id === bucket)!;
  return (
    <span className="bucket-badge" style={{ ["--tone" as string]: b.tone }}>
      {BUCKET_ICON[bucket]}
      {b.title}
    </span>
  );
}

const sizeTolerance = Math.log(1.7); // within ~1.7× of the chosen size

export function SimilarModels({ shape, settings }: { shape: Shape; settings: EstimatorSettings }) {
  const catalog = useStore((s) => s.catalog);
  const families = useStore((s) => s.families);
  const navigate = useStore((s) => s.navigate);
  const machine = useMachine();

  const picks = useMemo(() => {
    if (!machine) return [];
    const out: { m: ModelVariant; score: number; bucket: Bucket; weights: number | null; reasons: string[]; e: Estimate }[] = [];
    for (const m of catalog.values()) {
      const total = m.totalParamsB.value;
      if (!total || m.cloudOnly) continue;
      if (m.useCases.includes("embedding") || m.useCases.includes("safety")) continue;
      if (resolveOutput(m.capabilities, "embeddings").status === "verified_supported") continue;
      const isMoe = m.architecture.value === "moe";
      if (shape.kind === "moe" ? !isMoe : isMoe) continue;
      if (shape.images > 0 && !["verified_supported", "family_suggests"].includes(resolveInput(m.capabilities, "image").status)) continue;
      const sizeGap = Math.abs(Math.log(total / shape.totalB));
      if (sizeGap > sizeTolerance) continue;
      let similarity = 1 - sizeGap / sizeTolerance;
      if (shape.kind === "moe" && m.activeParamsB.value) {
        const activeGap = Math.abs(Math.log(m.activeParamsB.value / shape.activeB));
        similarity = similarity * 0.6 + Math.max(0, 1 - activeGap / Math.log(3)) * 0.4;
      }
      const published = m.artifacts.some((a) => a.quant === shape.quant);
      const quant = published ? shape.quant : (m.artifacts.find((a) => a.isDefaultTag)?.quant ?? shape.quant);
      const e = estimate(m, { ...settings, quant }, machine);
      const r = recommend(m, e, families[m.family]);
      out.push({ m, score: similarity * 50 + r.score * 0.5, bucket: bucketOf(e.classification), weights: e.weights?.mid ?? null, reasons: r.reasons, e });
    }
    const seen = new Set<string>();
    return out
      .sort((a, b) => b.score - a.score)
      .filter((x) => (seen.has(x.m.family) ? false : (seen.add(x.m.family), true)))
      .slice(0, 3);
  }, [catalog, families, machine, shape, settings]);

  const seeAll = () => {
    const t = shape.totalB;
    const size = t < 3 ? "xs" : t < 9.5 ? "s" : t < 20.5 ? "m" : t < 40.5 ? "l" : t < 80.5 ? "xl" : "xxl";
    useStore.getState().setInputs({ text: true, image: shape.images > 0 });
    import("../screens/Explorer").then(({ useExplorer }) => {
      useExplorer.getState().set({ size, arch: shape.kind, buckets: [] });
      navigate({ page: "explore" });
    });
  };

  const what = `${shape.kind === "moe" ? "Mixture-of-Experts" : "dense"} models around ${fmtParams(shape.totalB)}${shape.images ? " that read images" : ""}`;

  return (
    <section className="card" aria-labelledby="similar-title">
      <div className="card-head" style={{ flexWrap: "wrap" }}>
        <div>
          <h2 id="similar-title">Real models like this</h2>
          <p>Best matches in the catalog for {what}. Updates as you change the settings.</p>
        </div>
        {picks.length > 0 && (
          <button className="btn sm" onClick={seeAll}>
            See all similar <ArrowRight size={14} />
          </button>
        )}
      </div>

      {picks.length === 0 ? (
        <div className="similar-empty appear" key="empty">
          <SearchX size={30} />
          <div>
            <b>Nothing in our catalog matches this shape.</b>
            <div className="muted" style={{ fontSize: 15, marginTop: 4 }}>
              Models like this may still exist elsewhere (on Ollama or Hugging Face) that our catalog doesn't include yet.{" "}
              {shape.images > 0 ? "Try turning off images, " : "Try "}
              {shape.kind === "moe" ? "a different size or Dense" : "a different size or Mixture of Experts"}, or look one up yourself.
            </div>
            <button className="btn sm" style={{ marginTop: 10 }} onClick={() => useStore.getState().setTryOpen(true)}>
              Try a specific model
            </button>
          </div>
        </div>
      ) : (
        <div className="similar-grid">
          {picks.map(({ m, bucket, weights, reasons, e }, i) => (
            <button key={m.id} className="similar-card" style={{ animationDelay: `${i * 60}ms`, ["--tone" as string]: BUCKETS.find((b) => b.id === bucket)!.tone }} onClick={() => navigate({ page: "model", modelId: m.id })}>
              <span className="similar-rank">#{i + 1}</span>
              <div className="row" style={{ gap: 12, flexWrap: "nowrap" }}>
                <Avatar name={m.family} developer={m.developer} />
                <div style={{ minWidth: 0, textAlign: "left" }}>
                  <div className="mname">{m.displayName}</div>
                  <div className="mdev">
                    {fmtParams(m.totalParamsB.value)}
                    {m.activeParamsB.value != null && m.architecture.value === "moe" ? ` · ${fmtParams(m.activeParamsB.value)} active` : ""}
                    {weights ? ` · ${fmtBytes(weights, "GB")}` : ""}
                  </div>
                </div>
              </div>
              <div className="row" style={{ gap: 10 }}>
                <BucketBadge bucket={bucket} />
                {e.speed && <SpeedLabel est={e} />}
              </div>
              {reasons.length > 0 && <div className="why-line">{reasons.slice(0, 2).join(" · ")}</div>}
            </button>
          ))}
          {picks.length < 3 && (
            <div className="similar-card ghost">
              <span>
                Only {picks.length} close match{picks.length > 1 ? "es" : ""} in our catalog.
                <br />
                Others may exist that we don't list.
              </span>
              <button className="btn sm" onClick={() => useStore.getState().setTryOpen(true)}>
                Look one up
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
