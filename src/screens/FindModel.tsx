import { useState } from "react";
import { Globe, Loader2, PenLine, Search, ShieldCheck, WifiOff, Trash2 } from "lucide-react";
import { useStore } from "../state/store";
import { parseLookupQuery, searchCandidates, type LookupCandidates } from "../catalog/lookup";
import { modelFromOllama, verifyOllamaVariant } from "../catalog/ollamaOfficial";
import { resolveHfModel } from "../catalog/huggingface";
import type { LibraryEntry } from "../catalog/ollamaLibrary";
import { addEvidence, emptyCapabilities, resolveInput } from "../domain/capabilities";
import type { ArchitectureKind, CapStatus, InputCap, ModelVariant, Provenance } from "../domain/types";
import { fmtBytes } from "../lib/units";
import { canReachOllamaCom } from "../platform/bridge";
import { Modal, Prov } from "../components/ui";
import { safeSourceUrl } from "../catalog/sanitize";

const EXAMPLES = ["Qwen3.6 35B A3B", "gemma3", "https://ollama.com/library/gpt-oss", "Qwen/Qwen3-30B-A3B", "deepseek-r1:14b"];

export function FindModel() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<LookupCandidates | null>(null);
  const [draft, setDraft] = useState<ModelVariant | null>(null);
  const [offline, setOffline] = useState(false);
  const catalog = useStore((s) => s.catalog);
  const userModels = useStore((s) => s.userModels);
  const removeUser = useStore((s) => s.removeUserModel);
  const navigate = useStore((s) => s.navigate);
  const saveVerification = useStore((s) => s.saveVerification);
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
    setBusy(`Verifying ${e.name}:${size} on ollama.com…`);
    try {
      const v = await verifyOllamaVariant(e.name, size, { badges: e.capabilities, progress: (s) => setBusy(s) });
      if (!v.artifacts.length) {
        toast(v.errors[0] ?? "No local tags found.", "warn");
        return;
      }
      const id = `${e.name}:${size}`.toLowerCase();
      if (catalog.has(id)) {
        saveVerification(v);
        toast("Updated the catalog entry with verified data", "good");
        navigate({ page: "model", modelId: id });
        return;
      }
      setDraft({ ...modelFromOllama(e, v), origin: "ollama_library" });
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
      setDraft(m);
    } catch (err) {
      toast(`Hugging Face lookup failed: ${(err as Error).message}`, "bad");
    } finally {
      setBusy(null);
    }
  };

  const manual = () => {
    const name = parsed?.kind === "text" ? parsed.text : q.trim() || "my-model";
    const t: ModelVariant = {
      id: `user:${name.toLowerCase().replace(/[^a-z0-9._:-]+/g, "-")}`,
      family: name.split(/[\s:]/)[0] || "custom",
      variant: parsed?.kind === "text" && parsed.sizeHintB ? `${parsed.sizeHintB}b` : "custom",
      displayName: name,
      resolvedTag: null,
      lookupCandidate: name,
      origin: "user",
      totalParamsB: parsed?.kind === "text" && parsed.sizeHintB ? { value: parsed.sizeHintB, provenance: "user_entered", source: "From your search text" } : { value: null, provenance: "unknown" },
      activeParamsB: parsed?.kind === "text" && parsed.activeHintB ? { value: parsed.activeHintB, provenance: "user_entered", source: "From your search text" } : { value: null, provenance: "unknown" },
      architecture: { value: parsed?.kind === "text" && parsed.activeHintB ? "moe" : null, provenance: parsed?.kind === "text" && parsed.activeHintB ? "user_entered" : "unknown" },
      contextMax: { value: null, provenance: "unknown" },
      artifacts: [],
      arch: null,
      capabilities: emptyCapabilities(),
      useCases: ["general"],
      sourceUrls: [],
      lastVerified: null,
      notes: ["Manually entered and unverified. Estimates use wider uncertainty."],
    };
    setDraft(t);
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="eyebrow">Find a Model</div>
          <h1>Look up any model</h1>
          <p>Type a name, an Ollama tag or URL, or a Hugging Face repo. We search official sources, show what they publish, and you confirm before anything is saved.</p>
        </div>
      </div>

      <section className="card toolbar">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <div className="search">
            <Search size={17} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Qwen3.6 35B A3B · gemma3 · Qwen/Qwen3-30B-A3B · ollama.com/library/…" aria-label="Model to look up" />
          </div>
          <button className="btn primary" type="submit" disabled={!parsed || !!busy}>
            {busy ? <Loader2 size={15} className="spin" /> : <Globe size={15} />} Search online
          </button>
          <button className="btn" type="button" onClick={manual}>
            <PenLine size={15} /> Enter manually
          </button>
        </form>
        <div className="row" style={{ gap: 6 }}>
          <span className="faint" style={{ fontSize: 12.5 }}>Try:</span>
          {EXAMPLES.map((x) => (
            <button
              key={x}
              className="fchip"
              onClick={() => {
                setQ(x);
                void search(x);
              }}
            >
              {x}
            </button>
          ))}
        </div>
        <div className="row faint" style={{ fontSize: 12.5, gap: 6 }}>
          <ShieldCheck size={14} /> Only your search text is sent (to ollama.com and huggingface.co). Your hardware details never leave this computer. Retrieved text is treated as data only.
          {!canReachOllamaCom() && <span style={{ color: "var(--warn)" }}>In this browser preview, ollama.com is blocked by cross-site rules; Hugging Face still works. Use the desktop app for full lookups.</span>}
        </div>
      </section>

      {busy && (
        <div className="card row" style={{ marginBottom: 16 }}>
          <Loader2 size={16} className="spin" /> {busy}
        </div>
      )}

      {offline && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row">
            <WifiOff size={18} color="var(--warn)" />
            <b>Can't reach the online sources.</b>
            <span className="muted">You can still add the model by hand. It will be labelled unverified and estimated with wider uncertainty.</span>
            <button className="btn" onClick={manual}>
              <PenLine size={15} /> Enter manually
            </button>
          </div>
        </div>
      )}

      {res && (
        <div className="grid cols-2">
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Ollama library</h2>
                <p>Pick a size to verify its exact tags and file sizes.</p>
              </div>
            </div>
            {res.ollama.length === 0 && <p className="faint">No Ollama matches{res.errors.find((e) => e.startsWith("Ollama")) ? ` (${res.errors.find((e) => e.startsWith("Ollama"))})` : ""}.</p>}
            <div className="stack">
              {res.ollama.map((e) => (
                <div key={e.name} className="fact" style={{ padding: 14 }}>
                  <div className="row">
                    <b style={{ fontSize: 15 }}>{e.name}</b>
                    {e.capabilities.map((c) => (
                      <span key={c} className="badge">
                        {c}
                      </span>
                    ))}
                    {e.cloud && <span className="badge estimated">cloud</span>}
                    <a className="faint" style={{ marginLeft: "auto", fontSize: 12 }} href={`https://ollama.com/library/${e.name}`} target="_blank" rel="noreferrer noopener">
                      ollama.com ↗
                    </a>
                  </div>
                  <p className="muted" style={{ margin: "6px 0 10px", fontSize: 13 }}>
                    {e.description}
                  </p>
                  <div className="row" style={{ gap: 6 }}>
                    {(e.sizes.length ? e.sizes : ["latest"]).map((s) => (
                      <button key={s} className="btn sm" onClick={() => void pickOllama(e, s)} disabled={!!busy}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Hugging Face</h2>
                <p>Model cards describe the model; they don't prove it runs in your Ollama.</p>
              </div>
            </div>
            {res.hf.length === 0 && <p className="faint">No Hugging Face matches.</p>}
            <div className="stack">
              {res.hf.map((h) => (
                <button key={h.id} className="fact" style={{ padding: 14, textAlign: "left", cursor: "pointer" }} onClick={() => void pickHf(h.id)} disabled={!!busy}>
                  <div className="row">
                    <b className="mono" style={{ fontSize: 13.5 }}>
                      {h.id}
                    </b>
                    {h.pipeline_tag && <span className="badge">{h.pipeline_tag}</span>}
                  </div>
                  <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
                    {h.downloads != null ? `${h.downloads.toLocaleString()} downloads` : ""}
                  </div>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {userModels.length > 0 && (
        <section className="card" style={{ marginTop: 18 }}>
          <div className="card-head">
            <div>
              <h2>Your added models</h2>
              <p>Saved on this computer only.</p>
            </div>
          </div>
          <table className="table">
            <tbody>
              {userModels.map((u) => (
                <tr key={u.id}>
                  <td>
                    <a href={`#/model/${encodeURIComponent(u.id)}`}>{u.displayName}</a>
                  </td>
                  <td className="faint">{u.origin.replace("_", " ")}</td>
                  <td className="faint">{u.lastVerified ? `verified ${u.lastVerified.slice(0, 10)}` : "unverified"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn ghost sm danger" onClick={() => removeUser(u.id)} aria-label={`Remove ${u.displayName}`}>
                      <Trash2 size={13} /> Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {draft && <VerifySheet draft={draft} onClose={() => setDraft(null)} />}
    </div>
  );
}

const CAP_CHOICES: { v: CapStatus; label: string }[] = [
  { v: "verified_supported", label: "Supported" },
  { v: "verified_unsupported", label: "Not supported" },
  { v: "unknown", label: "Unknown" },
];

export function VerifySheet({ draft, onClose }: { draft: ModelVariant; onClose: () => void }) {
  const add = useStore((s) => s.addUserModel);
  const navigate = useStore((s) => s.navigate);
  const [m, setM] = useState<ModelVariant>(draft);
  const [confirmed, setConfirmed] = useState(false);
  const [caps, setCaps] = useState<Record<"image" | "audio" | "video", CapStatus>>({
    image: resolveInput(draft.capabilities, "image").status === "family_suggests" ? "unknown" : resolveInput(draft.capabilities, "image").status,
    audio: resolveInput(draft.capabilities, "audio").status === "family_suggests" ? "unknown" : resolveInput(draft.capabilities, "audio").status,
    video: resolveInput(draft.capabilities, "video").status === "family_suggests" ? "unknown" : resolveInput(draft.capabilities, "video").status,
  });
  const ambiguous =
    m.origin === "user" ||
    m.totalParamsB.provenance !== "verified" ||
    (m.architecture.value === "moe" && m.activeParamsB.value == null) ||
    (["image", "audio", "video"] as const).some((k) => resolveInput(draft.capabilities, k).status !== "verified_supported" && resolveInput(draft.capabilities, k).status !== "verified_unsupported");

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

  const save = () => {
    const now = new Date().toISOString();
    let c = JSON.parse(JSON.stringify(m.capabilities)) as ModelVariant["capabilities"];
    if (!c.inputs.text.evidence.length) c.inputs.text = addEvidence(c.inputs.text, { status: "verified_supported", scope: "user", source: "Confirmed by you", checkedAt: now });
    (Object.keys(caps) as ("image" | "audio" | "video")[]).forEach((k: InputCap & ("image" | "audio" | "video")) => {
      const current = resolveInput(draft.capabilities, k).status;
      if (caps[k] !== current && caps[k] !== "unknown") c.inputs[k] = addEvidence(c.inputs[k], { status: caps[k], scope: "user", source: "Confirmed by you", checkedAt: now });
    });
    const out: ModelVariant = { ...m, capabilities: c, notes: [...m.notes, `Added on ${now.slice(0, 10)} after user confirmation.`] };
    add(out);
    onClose();
    navigate({ page: "model", modelId: out.id });
  };

  const src = safeSourceUrl(m.sourceUrls[0]);
  return (
    <Modal title="Verify details before saving" onClose={onClose} wide>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          Check what we found. Anything you edit is marked <Prov p="user_entered" />. {src && (
            <>
              Source:{" "}
              <a href={src} target="_blank" rel="noreferrer noopener">
                {src.replace("https://", "")}
              </a>
            </>
          )}
        </p>
        <div className="grid cols-2">
          <label className="field">
            Display name
            <input className="input" value={m.displayName} onChange={(e) => setM({ ...m, displayName: e.target.value.slice(0, 120) })} />
          </label>
          <label className="field">
            <span className="row" style={{ justifyContent: "space-between" }}>
              Architecture <Prov p={m.architecture.provenance} />
            </span>
            <select
              className="select"
              value={m.architecture.value ?? "unknown"}
              onChange={(e) => setM({ ...m, architecture: { value: e.target.value === "unknown" ? null : (e.target.value as ArchitectureKind), provenance: e.target.value === "unknown" ? "unknown" : ("user_entered" as Provenance), source: "Entered by you" } })}
            >
              <option value="unknown">Unknown</option>
              <option value="dense">Dense</option>
              <option value="moe">Mixture of Experts</option>
            </select>
          </label>
          {numField("Total parameters (billions)", "totalParamsB")}
          {numField("Active parameters (billions)", "activeParamsB", m.architecture.value === "moe" ? "Required for MoE hybrid estimates. Leave blank if unknown — we never invent it." : "For dense models, leave blank (all weights are active).")}
          <label className="field">
            <span className="row" style={{ justifyContent: "space-between" }}>
              Max context (tokens) <Prov p={m.contextMax.provenance} />
            </span>
            <input
              className="input"
              type="number"
              min="0"
              placeholder="Unknown"
              value={m.contextMax.value ?? ""}
              onChange={(e) => setM({ ...m, contextMax: { value: e.target.value ? +e.target.value : null, provenance: e.target.value ? "user_entered" : "unknown", source: "Entered by you" } })}
            />
          </label>
          <div className="field">
            Published files
            <div className="faint" style={{ fontSize: 12.5 }}>
              {m.artifacts.length ? m.artifacts.map((a) => `${a.quantLabel} ${fmtBytes(a.downloadBytes ?? a.weightBytes, "GB")}`).join(" · ") : "None known: sizes will be hypothetical estimates."}
            </div>
          </div>
        </div>
        <div className="divider" />
        <b>Inputs this model accepts</b>
        <span className="field-hint">Confirm only what the source actually states for this exact model. Vision does not imply audio or video.</span>
        {(["image", "audio", "video"] as const).map((k) => (
          <div key={k} className="row" style={{ justifyContent: "space-between" }}>
            <span style={{ textTransform: "capitalize", minWidth: 80 }}>{k}</span>
            <div className="seg" role="radiogroup" aria-label={`${k} input`}>
              {CAP_CHOICES.map((c) => (
                <button key={c.v} type="button" aria-pressed={caps[k] === c.v} onClick={() => setCaps({ ...caps, [k]: c.v })}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="divider" />
        {ambiguous && (
          <label className="switch">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            Some details are uncertain. I've checked them and want to save this model as {m.origin === "user" ? "manually entered (unverified)" : "reviewed"}.
          </label>
        )}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={ambiguous && !confirmed} onClick={save}>
            Save to my catalog
          </button>
        </div>
      </div>
    </Modal>
  );
}
