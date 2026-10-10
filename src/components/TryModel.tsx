import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2 } from "lucide-react";
import { useStore } from "../state/store";
import { quantFor, useMachine } from "../state/derived";
import { estimate } from "../domain/estimator";
import type { ModelVariant } from "../domain/types";
import { fmtBytes, fmtParams, fmtRange } from "../lib/units";
import { Avatar, ConfidenceMeter, FitPill, Modal, SpeedLabel, TONE_VAR } from "./ui";
import { CapabilityStrip } from "./Capabilities";
import { ModelLookup, VerifyForm } from "./ModelLookup";

/** Live compatibility of a (possibly unsaved) model with this machine. */
function Compatibility({ m }: { m: ModelVariant }) {
  const machine = useMachine();
  const settings = useStore((s) => s.settings);
  const est = useMemo(() => (machine ? estimate(m, { ...settings, quant: quantFor(m, "AUTO", {}) }, machine) : null), [m, machine, settings]);
  if (!est || !machine) return null;
  const p = est.pools;
  const cap = p.arch === "discrete" ? p.vramUsable : p.arch === "unified" ? Math.min(p.unifiedGpuLimit ?? Infinity, p.ramUsable ?? Infinity) : p.ramUsable;
  const combined = p.arch === "discrete" ? (p.vramUsable ?? 0) + (p.ramUsable ?? 0) : p.ramUsable;
  const need = est.totalNeed?.mid ?? 0;
  const scale = Math.max(need, combined ?? 0, cap ?? 0, 1) * 1.08;
  const pct = (b: number) => `${(b / scale) * 100}%`;
  return (
    <div className="verdict compat" style={{ ["--vc" as string]: TONE_VAR[est.classification] }} aria-live="polite">
      <div className="row" style={{ gap: 12 }}>
        <Avatar name={m.family} developer={m.developer} />
        <div style={{ minWidth: 0 }}>
          <div className="mname">{m.displayName}</div>
          <div className="mdev">
            {fmtParams(m.totalParamsB.value)}
            {m.activeParamsB.value != null ? ` · ${fmtParams(m.activeParamsB.value)} active` : ""} · {est.artifact?.quantLabel ?? est.quant}
          </div>
        </div>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <FitPill cls={est.classification} cloud={m.cloudOnly} />
        <ConfidenceMeter c={est.confidence} />
      </div>
      <h2 style={{ fontSize: 21 }}>{est.headline}.</h2>
      <p style={{ fontSize: 15 }}>{est.summary}</p>
      <div className="compat-bar" role="img" aria-label={`Needs ${fmtBytes(need)}`}>
        <div className="compat-fill" style={{ width: pct(need), background: TONE_VAR[est.classification] }} />
        {cap != null && <span className="compat-line" style={{ left: pct(cap) }} data-tip={p.arch === "discrete" ? "Usable GPU memory" : "Fast (GPU-usable) memory"} />}
        {combined != null && p.arch === "discrete" && <span className="compat-line dashed" style={{ left: pct(combined) }} data-tip="GPU + RAM together" />}
      </div>
      <div className="row faint" style={{ fontSize: 13.5, justifyContent: "space-between" }}>
        <span>Needs {est.totalNeed ? fmtRange(est.totalNeed) : "unknown"}</span>
        <SpeedLabel est={est} />
      </div>
      <div style={{ marginTop: 12 }}>
        <CapabilityStrip caps={m.capabilities} />
      </div>
    </div>
  );
}

export function TryModelModal() {
  const open = useStore((s) => s.tryOpen);
  const setOpen = useStore((s) => s.setTryOpen);
  const catalog = useStore((s) => s.catalog);
  const add = useStore((s) => s.addUserModel);
  const navigate = useStore((s) => s.navigate);
  const toast = useStore((s) => s.showToast);
  const [draft, setDraft] = useState<ModelVariant | null>(null);
  const [preview, setPreview] = useState<ModelVariant | null>(null);
  const onPreview = useCallback((m: ModelVariant) => setPreview(m), []);
  if (!open) return null;
  const close = () => {
    setOpen(false);
    setDraft(null);
    setPreview(null);
  };
  const existing = draft && catalog.has(draft.id) && catalog.get(draft.id)!.origin !== "user";

  return (
    <Modal title={draft ? "Is it a good fit?" : "Try a specific model"} onClose={close} wide>
      {!draft ? (
        <div className="appear">
          <p className="muted" style={{ marginTop: 0, fontSize: 15.5 }}>
            Search Ollama or Hugging Face, paste a link, or type the details yourself. You'll see right away whether it fits this computer.
          </p>
          <ModelLookup onDraft={(m) => setDraft(m)} />
        </div>
      ) : (
        <div className="try-grid appear">
          <div>
            <button className="btn ghost sm" onClick={() => (setDraft(null), setPreview(null))} style={{ marginBottom: 10 }}>
              <ArrowLeft size={14} /> Search again
            </button>
            {existing ? (
              <div className="stack">
                <p className="muted" style={{ margin: 0 }}>
                  <CheckCircle2 size={16} color="var(--good)" style={{ verticalAlign: -3 }} /> This model is already in the catalog, now with freshly verified details.
                </p>
                <button
                  className="btn primary"
                  onClick={() => {
                    close();
                    navigate({ page: "model", modelId: draft.id });
                  }}
                >
                  Open full details <ArrowRight size={15} />
                </button>
              </div>
            ) : (
              <VerifyForm
                draft={draft}
                onPreview={onPreview}
                onCancel={() => (setDraft(null), setPreview(null))}
                onSave={(m) => {
                  add(m);
                  toast(`Saved “${m.displayName}” to your catalog`, "good");
                  close();
                  navigate({ page: "model", modelId: m.id });
                }}
              />
            )}
          </div>
          <Compatibility m={preview ?? draft} />
        </div>
      )}
    </Modal>
  );
}
