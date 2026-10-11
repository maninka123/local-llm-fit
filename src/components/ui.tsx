import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { CLASS_META, type EstConfidence, type FitClass } from "../domain/estimator";
import { fmtSpeed } from "../lib/units";
import type { Provenance } from "../domain/types";

// ------------------------------------------------------------------ motion helpers

export function prefersReducedMotion(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.classList.contains("reduce-motion");
}

/** Animates a number from its current displayed value toward `target` (interruptible). */
export function useTween(target: number, ms = 480): number {
  const [v, setV] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    if (prefersReducedMotion() || !Number.isFinite(target)) {
      cur.current = target;
      setV(target);
      return;
    }
    const from = cur.current;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      cur.current = from + (target - from) * e;
      setV(cur.current);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

export function AnimatedBytes({ bytes, unit = "GiB", digits = 1 }: { bytes: number | null | undefined; unit?: "GiB" | "GB"; digits?: number }) {
  const v = useTween(bytes ?? 0);
  if (bytes == null) return <span className="faint">Unknown</span>;
  const d = unit === "GiB" ? 2 ** 30 : 1e9;
  const n = v / d;
  return (
    <span className="num">
      {n >= 100 ? n.toFixed(0) : n.toFixed(digits)} {unit}
    </span>
  );
}

// ------------------------------------------------------------------ pills / badges

export const TONE: Record<FitClass, string> = {
  full_gpu: "tone-good",
  promising_moe: "tone-ok",
  hybrid_slow: "tone-warn",
  cpu_only: "tone-warn",
  memory_constrained: "tone-orange",
  cannot_fit: "tone-bad",
  unknown: "tone-neutral",
};
export const TONE_VAR: Record<FitClass, string> = {
  full_gpu: "var(--good)",
  promising_moe: "var(--ok)",
  hybrid_slow: "var(--warn)",
  cpu_only: "var(--warn)",
  memory_constrained: "var(--orange)",
  cannot_fit: "var(--bad)",
  unknown: "var(--neutral)",
};

export function FitPill({ cls, short, cloud }: { cls: FitClass; short?: boolean; cloud?: boolean }) {
  if (cloud)
    return (
      <span className="pill tone-neutral" title="Only cloud tags exist; not a downloadable local model">
        <span className="lamp" /> Cloud only
      </span>
    );
  const m = CLASS_META[cls];
  return (
    <span className={`pill ${TONE[cls]}`} title={m.title}>
      <span className="lamp" />
      {short ? m.short : m.title}
    </span>
  );
}

export function ConfidenceMeter({ c }: { c: EstConfidence }) {
  const n = c === "high" ? 3 : c === "medium" ? 2 : 1;
  const color = c === "high" ? "var(--good)" : c === "medium" ? "var(--warn)" : "var(--orange)";
  return (
    <span className="row" style={{ gap: 8 }} aria-label={`Confidence: ${c}`}>
      <span className="meter" style={{ color }}>
        {[1, 2, 3].map((i) => (
          <i key={i} className={i <= n ? "on" : ""} />
        ))}
      </span>
      <span style={{ fontSize: 14, fontWeight: 650, color }}>{c[0].toUpperCase() + c.slice(1)} confidence</span>
    </span>
  );
}

const PROV_TEXT: Record<string, string> = {
  verified: "Verified",
  derived: "Derived",
  estimated: "Estimated",
  user_entered: "User-entered",
  unknown: "Unknown",
  heuristic: "Heuristic",
  measured: "Measured",
  setting: "Setting",
};
export function Prov({ p, title }: { p: Provenance | "heuristic" | "measured" | "setting" | undefined; title?: string }) {
  const k = p ?? "unknown";
  return (
    <span className={`prov-${k}`} title={title} style={{ fontSize: 13, fontWeight: 650 }}>
      {PROV_TEXT[k] ?? k}
    </span>
  );
}

// ------------------------------------------------------------------ controls

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string; className?: string; dot?: boolean; disabled?: boolean }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} title={o.title} className={o.className} disabled={o.disabled} onClick={() => !o.disabled && onChange(o.value)}>
          {o.label}
          {o.dot && <span className="dot" aria-hidden />}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Modal({ title, onClose, children, wide, labelledBy }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers often pass a new onClose each render; keep the latest without re-running the focus setup.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button, [href], input, select, textarea")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab" && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute("disabled"));
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, []);
  const id = labelledBy ?? "modal-title";
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <div className="card-head" style={{ marginBottom: 16 }}>
          <h2 id={id} style={{ fontSize: 22 }}>
            {title}
          </h2>
          <button className="btn ghost icon-btn" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ avatar

const DEV_COLORS: Record<string, [string, string]> = {
  Meta: ["#3b82f6", "#1d4ed8"],
  "Alibaba Qwen": ["#7c5cff", "#4f2fd6"],
  Google: ["#22c3a6", "#0b8f7a"],
  "Mistral AI": ["#ff8a3d", "#e2531a"],
  Microsoft: ["#38bdf8", "#0369a1"],
  DeepSeek: ["#4f7dff", "#2747c9"],
  IBM: ["#5b8def", "#2a4fb0"],
  NVIDIA: ["#76b900", "#4d7a00"],
  OpenAI: ["#10a37f", "#0b6f57"],
  Cohere: ["#ff7aa2", "#c43e6c"],
};

export function Avatar({ name, developer, large }: { name: string; developer?: string; large?: boolean }) {
  const [a, b] = DEV_COLORS[developer ?? ""] ?? hashColors(name);
  const letters = name
    .replace(/[^a-zA-Z0-9]/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className={`avatar ${large ? "lg" : ""}`} style={{ background: `linear-gradient(135deg, ${a}, ${b})` }} aria-hidden>
      {letters || "?"}
    </div>
  );
}

function hashColors(s: string): [string, string] {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return [`hsl(${hue} 70% 58%)`, `hsl(${(hue + 30) % 360} 65% 42%)`];
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <b style={{ color: "var(--text)", fontSize: 17 }}>{title}</b>
      {children}
    </div>
  );
}

/** Rough tokens/second guess (or a measured value), colour-coded, with an explanation on hover. */
export function SpeedLabel({ est, measured, large }: { est: import("../domain/estimator").Estimate; measured?: number | null; large?: boolean }) {
  if (measured)
    return (
      <span className={`speed tone-good ${large ? "large" : ""}`} data-tip="Measured on this computer with a local test" tabIndex={0}>
        Measured {measured.toFixed(measured >= 10 ? 0 : 1)} tok/s
      </span>
    );
  if (!est.speed)
    return (
      <span className={`speed muted ${large ? "large" : ""}`} data-tip={est.classification === "cannot_fit" ? "Too large to run here" : "Speed unknown: this GPU's memory speed isn't in our table"} tabIndex={0}>
        {est.classification === "cannot_fit" ? "Won't run" : est.classification === "unknown" ? "Speed unknown" : "Speed unknown"}
      </span>
    );
  const tone = est.responsiveness === "likely_fast" ? "tone-good" : est.responsiveness === "reasonable" ? "tone-warn" : "tone-orange";
  const s = est.speed;
  const tip = `Rough guess: about ${s.gbPerToken.toFixed(1)} GB is read per word${s.gpuBandwidthGBs ? ` from ${s.gpuBandwidthGBs} GB/s memory` : ""}${s.cpuShare > 0.001 ? `, ${Math.round(s.cpuShare * 100)}% from slower RAM` : ""}.${est.classification === "memory_constrained" ? " Only if you close other apps." : ""} Run a test for the real number.`;
  return (
    <span className={`speed ${tone} ${large ? "large" : ""}`} data-tip={tip} tabIndex={0}>
      {fmtSpeed(s.range)}
    </span>
  );
}
