import { useEffect, useMemo, useState } from "react";
import { Globe, Loader2, PenLine, Search, ShieldCheck, WifiOff } from "lucide-react";
import { useStore } from "../state/store";
import { parseLookupQuery, searchCandidates, type LookupCandidates } from "../catalog/lookup";
import { modelFromOllama, verifyOllamaVariant } from "../catalog/ollamaOfficial";
import { resolveHfModel } from "../catalog/huggingface";
import type { LibraryEntry } from "../catalog/ollamaLibrary";
import { addEvidence, emptyCapabilities, resolveInput } from "../domain/capabilities";
import type { ArchitectureKind, CapStatus, ModelVariant, Provenance } from "../domain/types";
import { fmtBytes } from "../lib/units";
import { canReachOllamaCom } from "../platform/bridge";
import { Prov } from "./ui";
import { safeSourceUrl } from "../catalog/sanitize";
import { Select } from "./Select";

const EXAMPLES = ["Qwen3.6 35B A3B", "gemma3", "Qwen/Qwen3-30B-A3B", "deepseek-r1:14b"];

/** Search official sources (or enter manually) and hand back an unsaved draft model. */
export function ModelLookup({ onDraft }: { onDraft: (m: ModelVariant) => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<LookupCandidates | null>(null);
  const [offline, setOffline] = useState(false);
  const saveVerification = useStore((s) => s.saveVerification);
  const catalog = useStore((s) => s.catalog);
  const toast = useStore((s) => s.showToast);
  const parsed = parseLookupQuery(q);

  const search = async (text = q) => {
    const pq = parseLookupQuery(text);
    if (!pq) return;
    setBusy("Searching official sources…");
    setRes(null);
    setOffline(false);
    try {
      const r = await searchCandidates(pq);
      setRes(r);
      if (r.ollama.length === 0 && r.hf.length === 0 && r.errors.length) setOffline(true);
    } catch {
      setOffline(true);
    } finally {
      setBusy(null);
    }
  };

  const pickOllama = async (e: LibraryEntry, size: string) => {
    setBusy(`Checking ${e.name}:${size} on ollama.com…`);
    try {
      const v = await verifyOllamaVariant(e.name, size, { badges: e.capabilities, progress: (s) => setBusy(s) });
      if (!v.artifacts.length) {
        toast(v.errors[0] ?? "No local tags found.", "warn");
        return;
      }
      const id = `${e.name}:${size}`.toLowerCase();
      if (catalog.has(id)) saveVerification(v);
      onDraft({ ...modelFromOllama(e, v), origin: "ollama_library" });
    } catch (err) {
      toast(`Lookup failed: ${(err as Error).message}`, "bad");
    } finally {
      setBusy(null);
    }
  };

  const pickHf = async (id: string) => {
    setBusy(`Reading huggingface.co/${id}…`);
    try {
      const m = await resolveHfModel(id);
      if (parsed?.kind === "text" && parsed.activeHintB && m.activeParamsB.value == null) {
        m.activeParamsB = { value: parsed.activeHintB, provenance: "user_entered", source: "From your search text", note: "Please confirm" };
      }
      onDraft(m);
    } catch (err) {
      toast(`Hugging Face lookup failed: ${(err as Error).message}`, "bad");
    } finally {
      setBusy(null);
    }
  };

  const manual = () => onDraft(manualDraft(q));

  return (
    <div className="stack" style={{ gap: 14 }}>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <div className="search">
          <Search size={17} />
          <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Model name, Ollama tag, or Hugging Face repo…" aria-label="Model to look up" />
        </div>
        <button className="btn primary" type="submit" disabled={!parsed || !!busy}>
          {busy ? <Loader2 size={15} className="spin" /> : <Globe size={15} />} Search online
        </button>
        <button className="btn" type="button" onClick={manual}>
          <PenLine size={15} /> Enter manually
        </button>
      </form>
      <div className="row" style={{ gap: 6 }}>
        <span className="faint" style={{ fontSize: 14 }}>Try:</span>
        {EXAMPLES.map((x) => (
          <button
            key={x}
            className="fchip"
            type="button"
            onClick={() => {
              setQ(x);
              void search(x);
            }}
          >
            {x}
          </button>
        ))}
      </div>
      <div className="row faint" style={{ fontSize: 13.5, gap: 6 }}>
        <ShieldCheck size={14} /> Only your search text is sent. Your hardware details never leave this computer.
        {!canReachOllamaCom() && <span style={{ color: "var(--warn)" }}>In the browser, ollama.com search is blocked by cross-site rules; Hugging Face works. The desktop app searches both.</span>}
      </div>

      {busy && (
        <div className="row muted">
          <Loader2 size={16} className="spin" /> {busy}
        </div>
      )}

      {offline && (
        <div className="warning warn">
          <WifiOff size={18} />
          <span>
            Can't reach the online sources. You can still add the model by hand; it will be labelled unverified.{" "}
            <button className="btn sm" type="button" onClick={manual}>
              Enter manually
            </button>
          </span>
        </div>
      )}

      {res && (
        <div className="grid cols-2">
          <div className="stack">
            <div className="eyebrow">Ollama library</div>
            {res.ollama.length === 0 && <p className="faint">No Ollama matches.</p>}
            {res.ollama.map((e) => (
              <div key={e.name} className="fact" style={{ padding: 14 }}>
                <div className="row">
                  <b style={{ fontSize: 16 }}>{e.name}</b>
                  {e.capabilities.map((c) => (
                    <span key={c} className="badge">
                      {c}
                    </span>
                  ))}
                </div>
                <p className="muted" style={{ margin: "6px 0 10px", fontSize: 14 }}>
                  {e.description}
                </p>
                <div className="row" style={{ gap: 6 }}>
                  {(e.sizes.length ? e.sizes : ["latest"]).map((s) => (
                    <button key={s} type="button" className="btn sm" onClick={() => void pickOllama(e, s)} disabled={!!busy}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="stack">
            <div className="eyebrow">Hugging Face</div>
            {res.hf.length === 0 && <p className="faint">No Hugging Face matches.</p>}
            {res.hf.map((h) => (
              <button key={h.id} type="button" className="fact" style={{ padding: 14, textAlign: "left", cursor: "pointer" }} onClick={() => void pickHf(h.id)} disabled={!!busy}>
                <div className="row">
                  <b className="mono" style={{ fontSize: 14.5 }}>
                    {h.id}
                  </b>
                  {h.pipeline_tag && <span className="badge">{h.pipeline_tag}</span>}
                </div>
                <div className="faint" style={{ fontSize: 13.5, marginTop: 4 }}>
                  {h.downloads != null ? `${h.downloads.toLocaleString()} downloads` : ""}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function manualDraft(q: string): ModelVariant {
  const parsed = parseLookupQuery(q);
  const name = parsed?.kind === "text" ? parsed.text : q.trim() || "my-model";
  const size = parsed?.kind === "text" ? parsed.sizeHintB : undefined;
  const active = parsed?.kind === "text" ? parsed.activeHintB : undefined;
  return {
    id: `user:${name.toLowerCase().replace(/[^a-z0-9._:-]+/g, "-")}`,
    family: name.split(/[\s:]/)[0] || "custom",
    variant: size ? `${size}b` : "custom",
    displayName: name,
    resolvedTag: null,
    lookupCandidate: name,
    origin: "user",
    totalParamsB: size ? { value: size, provenance: "user_entered", source: "From your search text" } : { value: null, provenance: "unknown" },
    activeParamsB: active ? { value: active, provenance: "user_entered", source: "From your search text" } : { value: null, provenance: "unknown" },
    architecture: { value: active ? "moe" : null, provenance: active ? "user_entered" : "unknown" },
    contextMax: { value: null, provenance: "unknown" },
    artifacts: [],
    arch: null,
    capabilities: emptyCapabilities(),
    useCases: ["general"],
    sourceUrls: [],
    lastVerified: null,
    notes: ["Manually entered and unverified. Estimates use wider uncertainty."],
  };
}

const CAP_CHOICES: { v: CapStatus; label: string }[] = [
  { v: "verified_supported", label: "Supported" },
  { v: "verified_unsupported", label: "Not supported" },
  { v: "unknown", label: "Unknown" },
];

type Caps3 = Record<"image" | "audio" | "video", CapStatus>;

function applyEdits(m: ModelVariant, draft: ModelVariant, caps: Caps3): ModelVariant {
  const now = new Date().toISOString();
  const c = JSON.parse(JSON.stringify(m.capabilities)) as ModelVariant["capabilities"];
  if (!c.inputs.text.evidence.length) c.inputs.text = addEvidence(c.inputs.text, { status: "verified_supported", scope: "user", source: "Confirmed by you", checkedAt: now });
  (Object.keys(caps) as (keyof Caps3)[]).forEach((k) => {
    if (caps[k] !== resolveInput(draft.capabilities, k).status && caps[k] !== "unknown")
      c.inputs[k] = addEvidence(c.inputs[k], { status: caps[k], scope: "user", source: "Confirmed by you", checkedAt: now });
  });
  return { ...m, capabilities: c };
}

/** Editable verification form. Reports the edited model live (for the compatibility preview). */
export function VerifyForm({ draft, onPreview, onSave, onCancel, saveLabel = "Save to my catalog" }: { draft: ModelVariant; onPreview?: (m: ModelVariant) => void; onSave: (m: ModelVariant) => void; onCancel: () => void; saveLabel?: string }) {
  const [m, setM] = useState<ModelVariant>(draft);
  const [confirmed, setConfirmed] = useState(false);
  const initialCaps = (k: keyof Caps3) => (resolveInput(draft.capabilities, k).status === "family_suggests" ? "unknown" : resolveInput(draft.capabilities, k).status);
  const [caps, setCaps] = useState<Caps3>({ image: initialCaps("image"), audio: initialCaps("audio"), video: initialCaps("video") });
  const edited = useMemo(() => applyEdits(m, draft, caps), [m, draft, caps]);
  useEffect(() => onPreview?.(edited), [edited, onPreview]);
  const ambiguous =
    m.origin === "user" ||
    m.totalParamsB.provenance !== "verified" ||
    (m.architecture.value === "moe" && m.activeParamsB.value == null) ||
    (["image", "audio", "video"] as const).some((k) => !["verified_supported", "verified_unsupported"].includes(resolveInput(draft.capabilities, k).status));

  const numField = (label: string, key: "totalParamsB" | "activeParamsB", hint?: string) => (
    <label className="field">
      <span className="row" style={{ justifyContent: "space-between" }}>
        {label} <Prov p={m[key].provenance} title={m[key].note ?? m[key].source} />
      </span>
      <input
        className="input"
        type="number"
        step="0.1"
        min="0"
        placeholder="Unknown"
        value={m[key].value ?? ""}
        onChange={(e) => setM({ ...m, [key]: { value: e.target.value === "" ? null : +e.target.value, provenance: e.target.value === "" ? "unknown" : "user_entered", source: "Entered by you" } })}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );

  const src = safeSourceUrl(m.sourceUrls[0]);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <p className="muted" style={{ margin: 0, fontSize: 15 }}>
        Check what we found. Edits are marked <Prov p="user_entered" />.
        {src && (
          <>
            {" "}
            Source:{" "}
            <a href={src} target="_blank" rel="noreferrer noopener">
              {src.replace("https://", "")}
            </a>
          </>
        )}
      </p>
      <div className="grid cols-2" style={{ gap: 14 }}>
        <label className="field">
          Display name
          <input className="input" value={m.displayName} onChange={(e) => setM({ ...m, displayName: e.target.value.slice(0, 120) })} />
        </label>
        <label className="field">
          <span className="row" style={{ justifyContent: "space-between" }}>
            Architecture <Prov p={m.architecture.provenance} />
          </span>
          <Select
            label="Architecture"
            value={m.architecture.value ?? "unknown"}
            onChange={(v) =>
              setM({ ...m, architecture: { value: v === "unknown" ? null : (v as ArchitectureKind), provenance: v === "unknown" ? "unknown" : ("user_entered" as Provenance), source: "Entered by you" } })
            }
            options={[
              { value: "unknown", label: "Unknown" },
              { value: "dense", label: "Dense" },
              { value: "moe", label: "Mixture of Experts" },
            ]}
          />
        </label>
        {numField("Total parameters (billions)", "totalParamsB")}
        {numField("Active parameters (billions)", "activeParamsB", m.architecture.value === "moe" ? "Needed for MoE estimates. Leave blank if unknown." : "Dense models: leave blank.")}
      </div>
      <div className="field-hint">
        Published files: {m.artifacts.length ? m.artifacts.map((a) => `${a.quantLabel} ${fmtBytes(a.downloadBytes ?? a.weightBytes, "GB")}`).join(" · ") : "none known, so sizes are estimates."}
      </div>
      <b style={{ fontSize: 15 }}>Inputs it accepts</b>
      {(["image", "audio", "video"] as const).map((k) => (
        <div key={k} className="row" style={{ justifyContent: "space-between" }}>
          <span style={{ textTransform: "capitalize", minWidth: 70 }}>{k}</span>
          <div className="seg" role="radiogroup" aria-label={`${k} input`}>
            {CAP_CHOICES.map((c) => (
              <button key={c.v} type="button" aria-pressed={caps[k] === c.v} onClick={() => setCaps({ ...caps, [k]: c.v })}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      {ambiguous && (
        <label className="switch">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          Some details are uncertain. I've checked them.
        </label>
      )}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn ghost" type="button" onClick={onCancel}>
          Back
        </button>
        <button
          className="btn primary"
          type="button"
          disabled={ambiguous && !confirmed}
          onClick={() => onSave({ ...edited, notes: [...edited.notes, `Added on ${new Date().toISOString().slice(0, 10)} after user confirmation.`] })}
        >
          {saveLabel}
        </button>
      </div>
    </div>
  );
}
