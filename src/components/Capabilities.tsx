import { AudioLines, Binary, Braces, Brain, CircleHelp, FileText, Image, ImagePlus, Lock, MessageSquareText, Type, Video, Volume2, Wrench, Check, Minus, AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { modalityLabel, resolveCap, resolveInput, resolveOutput, STATUS_TEXT, type InputSelection } from "../domain/capabilities";
import type { Capabilities, CapEvidence, CapStatus, InputCap, OutputCap } from "../domain/types";

const IN_META: Record<InputCap, { label: string; icon: ReactNode }> = {
  text: { label: "Text", icon: <Type size={14} /> },
  image: { label: "Image", icon: <Image size={14} /> },
  audio: { label: "Audio", icon: <AudioLines size={14} /> },
  video: { label: "Video", icon: <Video size={14} /> },
  pdf: { label: "PDF / docs", icon: <FileText size={14} /> },
};
const OUT_META: Record<OutputCap, { label: string; icon: ReactNode }> = {
  text: { label: "Text", icon: <MessageSquareText size={14} /> },
  image: { label: "Image generation", icon: <ImagePlus size={14} /> },
  audio: { label: "Speech / audio", icon: <Volume2 size={14} /> },
  embeddings: { label: "Embeddings", icon: <Binary size={14} /> },
  json: { label: "Structured JSON", icon: <Braces size={14} /> },
  tools: { label: "Tool calls", icon: <Wrench size={14} /> },
};

export function StatusIcon({ s }: { s: CapStatus }) {
  if (s === "verified_supported") return <Check size={14} aria-hidden />;
  if (s === "verified_unsupported") return <Minus size={14} aria-hidden />;
  if (s === "family_suggests") return <AlertTriangle size={13} aria-hidden />;
  return <CircleHelp size={13} aria-hidden />;
}

/** Compact strip for model cards: inputs + key outputs, styled by evidence strength. */
export function CapabilityStrip({ caps }: { caps: Capabilities }) {
  const label = modalityLabel(caps);
  const items: { key: string; label: string; short?: string; icon: ReactNode; s: CapStatus }[] = [
    ...(["text", "image", "audio", "video"] as InputCap[]).map((k) => ({ key: `in-${k}`, label: `${IN_META[k].label} input`, icon: IN_META[k].icon, s: resolveInput(caps, k).status })),
    { key: "out-emb", label: "Produces embeddings (for search), not chat", short: "Embeddings", icon: OUT_META.embeddings.icon, s: resolveOutput(caps, "embeddings").status },
    { key: "out-tools", label: "Tool calling: can call functions/tools an app provides", short: "Tools", icon: OUT_META.tools.icon, s: resolveOutput(caps, "tools").status },
    { key: "thinking", label: "Thinking mode: can reason step by step before answering", short: "Thinking", icon: <Brain size={14} />, s: resolveCap(caps.thinking).status },
  ].filter((i) => !(i.key.startsWith("out") || i.key === "thinking") || i.s !== "unknown");
  return (
    <div className="caps" aria-label={`Capabilities: ${label.label}${label.verified ? "" : " (not fully verified)"}`}>
      <span className="badge" style={{ marginRight: 4 }} data-tip={label.verified ? "Verified for this exact tag" : "* Not fully verified for this exact tag"} tabIndex={0}>
        {label.label}
        {!label.verified && label.label !== "Unknown" && <span style={{ color: "var(--warn)" }}>*</span>}
      </span>
      {items.map((i) => (
        <span key={i.key} className={`cap s-${i.s}`} data-tip={`${i.label} · ${STATUS_TEXT[i.s]}`} tabIndex={0} aria-label={`${i.label}: ${STATUS_TEXT[i.s]}`}>
          {i.icon}
          {i.short && <span className="cap-text">{i.short}</span>}
        </span>
      ))}
    </div>
  );
}

function EvidenceLine({ e }: { e: CapEvidence }) {
  return (
    <div style={{ marginBottom: 4 }} title={e.note}>
      {e.sourceUrl ? (
        <a href={e.sourceUrl} target="_blank" rel="noreferrer noopener">
          {e.source}
        </a>
      ) : (
        e.source
      )}{" "}
      · {e.scope.replace("_", " ")}
      {e.checkedAt ? ` · ${e.checkedAt.slice(0, 10)}` : ""}
    </div>
  );
}

function Row({ name, icon, rec }: { name: string; icon: ReactNode; rec: ReturnType<typeof resolveCap> }) {
  return (
    <tr>
      <td>
        <span className="row" style={{ gap: 8 }}>
          {icon}
          {name}
        </span>
      </td>
      <td>
        <span className={`status s-${rec.status}`}>
          <StatusIcon s={rec.status} />
          {STATUS_TEXT[rec.status]}
          {rec.userEntered && <span className="badge">user-entered</span>}
          {rec.conflict && <span className="badge estimated">conflicting sources</span>}
        </span>
      </td>
      <td>
        <span className={`status s-${rec.runtime}`} style={{ fontWeight: 500 }}>
          {rec.runtime === "unknown" ? "Not checked" : STATUS_TEXT[rec.runtime]}
        </span>
      </td>
      <td>
        <span className={`status s-${rec.model}`} style={{ fontWeight: 500 }}>
          {rec.model === "unknown" ? "Not checked" : STATUS_TEXT[rec.model]}
        </span>
        {rec.runtimeModelMismatch && <div className="field-hint" style={{ color: "var(--warn)" }}>Model card and Ollama runtime disagree</div>}
      </td>
      <td className="faint" style={{ fontSize: 13.5 }}>
        {rec.evidence.length === 0 ? (
          "No evidence"
        ) : (
          <>
            <EvidenceLine e={rec.best ?? rec.evidence[0]} />
            {rec.evidence.length > 1 && (
              <details>
                <summary style={{ cursor: "pointer" }}>+{rec.evidence.length - 1} more source(s)</summary>
                {rec.evidence
                  .filter((e) => e !== (rec.best ?? rec.evidence[0]))
                  .map((e, i) => (
                    <EvidenceLine key={i} e={e} />
                  ))}
              </details>
            )}
          </>
        )}
      </td>
    </tr>
  );
}

/** Full capability table for detail/compare screens. */
export function CapabilityPanel({ caps }: { caps: Capabilities }) {
  const label = modalityLabel(caps);
  return (
    <div className="stack">
      <div className="row">
        <span className="badge" style={{ fontSize: 14.5 }}>
          {label.label}
        </span>
        <span className={label.verified ? "badge verified" : "badge estimated"}>{label.verified ? "Verified for this tag" : "Not fully verified"}</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="cap-table">
          <thead>
            <tr>
              <th>Capability</th>
              <th>Status</th>
              <th>Ollama runtime</th>
              <th>Model card</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={5} className="eyebrow" style={{ paddingTop: 14 }}>
                Inputs
              </td>
            </tr>
            {(Object.keys(IN_META) as InputCap[]).map((k) => (
              <Row key={k} name={IN_META[k].label} icon={IN_META[k].icon} rec={resolveInput(caps, k)} />
            ))}
            <tr>
              <td colSpan={5} className="eyebrow" style={{ paddingTop: 14 }}>
                Outputs
              </td>
            </tr>
            {(Object.keys(OUT_META) as OutputCap[]).map((k) => (
              <Row key={k} name={OUT_META[k].label} icon={OUT_META[k].icon} rec={resolveOutput(caps, k)} />
            ))}
            <Row name="Thinking / reasoning mode" icon={<Brain size={14} />} rec={resolveCap(caps.thinking)} />
          </tbody>
        </table>
      </div>
      <p className="field-hint">
        PDFs are normally handled by extracting text (or rendering pages as images for a vision model). This app never claims native PDF input without
        runtime proof. Image understanding and image generation are tracked separately, and audio/video are never inferred from vision support.
      </p>
    </div>
  );
}

const PICKER: { k: InputCap; label: string; icon: ReactNode; hint: string }[] = [
  { k: "image", label: "Images", icon: <Image size={16} />, hint: "Photos, screenshots, charts" },
  { k: "audio", label: "Audio", icon: <AudioLines size={16} />, hint: "Speech or sound input" },
  { k: "video", label: "Video", icon: <Video size={16} />, hint: "Video / frame understanding" },
];

/** "What will you give the model?" — Text is always on; other inputs toggle. */
export function InputPicker({ value, onChange }: { value: InputSelection; onChange: (v: InputSelection) => void }) {
  return (
    <div className="input-picker" role="group" aria-label="Inputs you want to use">
      <button type="button" aria-pressed="true" className="locked" title="Text is always included" aria-disabled="true">
        <Type size={16} /> Text <Lock size={11} className="lock" />
      </button>
      {PICKER.map((p) => (
        <button key={p.k} type="button" aria-pressed={!!value[p.k]} title={p.hint} onClick={() => onChange({ ...value, [p.k]: !value[p.k] })}>
          {p.icon} {p.label}
        </button>
      ))}
    </div>
  );
}

/** Explains the border styles used by capability chips. */
export function CapabilityLegend() {
  return (
    <div className="caps cap-legend" aria-label="Capability legend">
      <span className="cap s-verified_supported"><Check size={13} /> <span className="cap-text">Verified</span></span>
      <span className="cap s-family_suggests"><AlertTriangle size={12} /> <span className="cap-text">Family hint, unconfirmed</span></span>
      <span className="cap s-unknown"><CircleHelp size={12} /> <span className="cap-text">Unknown</span></span>
      <span className="cap s-verified_unsupported" style={{ textDecoration: "none" }}><Minus size={13} /> <span className="cap-text">Not supported</span></span>
    </div>
  );
}
