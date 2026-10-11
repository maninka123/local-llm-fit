import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import { useStore } from "../state/store";
import { quantFor, useMachine } from "../state/derived";
import { estimate } from "../domain/estimator";
import { BUCKETS, bucketFor, recommend } from "../domain/recommend";
import { fmtBytes, fmtParams } from "../lib/units";
import { Avatar, SpeedLabel } from "./ui";
import { BucketBadge } from "./SimilarModels";

/** "+ Add model" slot with a searchable dropdown of compact model cards. */
export function AddToCompare({ big }: { big?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const catalog = useStore((s) => s.catalog);
  const families = useStore((s) => s.families);
  const settings = useStore((s) => s.settings);
  const choice = useStore((s) => s.quantChoice);
  const per = useStore((s) => s.perModelQuant);
  const compare = useStore((s) => s.compare);
  const toggle = useStore((s) => s.toggleCompare);
  const machine = useMachine();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ranked = useMemo(() => {
    if (!machine || !open) return [];
    const order = (b: string) => BUCKETS.findIndex((x) => x.id === b);
    return [...catalog.values()]
      .filter((m) => !m.cloudOnly && !compare.includes(m.id))
      .map((m) => {
        const e = estimate(m, { ...settings, quant: quantFor(m, choice, per) }, machine);
        return { m, e, b: bucketFor(e), score: recommend(m, e, families[m.family]).score };
      })
      .sort((a, b) => order(a.b) - order(b.b) || b.score - a.score);
  }, [catalog, machine, settings, choice, per, families, compare, open]);

  const list = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = terms.length ? ranked.filter(({ m }) => terms.every((t) => `${m.displayName} ${m.family} ${m.developer ?? ""}`.toLowerCase().includes(t))) : ranked;
    return hits.slice(0, 40);
  }, [ranked, q]);

  const full = compare.length >= 4;
  const add = (id: string) => {
    toggle(id);
    setOpen(false);
    setQ("");
  };

  return (
    <div className="add-compare" ref={ref}>
      <button className={`add-slot ${big ? "big" : ""}`} disabled={full} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="listbox">
        <span className="add-plus">
          <Plus size={20} strokeWidth={2.75} />
        </span>
        {full ? "Compare is full (4)" : "Add model"}
      </button>
      {open && (
        <div className="add-pop" role="dialog" aria-label="Add a model to compare">
          <div className="search">
            <Search size={16} />
            <input
              className="input"
              autoFocus
              placeholder="Search models…"
              value={q}
              aria-label="Search models to compare"
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, list.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === "Enter" && list[active]) {
                  e.preventDefault();
                  add(list[active].m.id);
                }
              }}
            />
          </div>
          <div className="add-list" role="listbox">
            {list.length === 0 && <div className="faint" style={{ padding: 14 }}>No models match “{q}”.</div>}
            {list.map(({ m, e, b }, i) => (
              <button key={m.id} role="option" aria-selected={i === active} className={`add-item ${i === active ? "on" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => add(m.id)}>
                <Avatar name={m.family} developer={m.developer} />
                <span className="add-text">
                  <span className="mname">{m.displayName}</span>
                  <span className="mdev">
                    {fmtParams(m.totalParamsB.value)}
                    {m.architecture.value === "moe" && m.activeParamsB.value ? ` · ${fmtParams(m.activeParamsB.value)} active` : ""}
                    {e.weights ? ` · ${fmtBytes(e.weights.mid, "GB")}` : ""}
                  </span>
                </span>
                <span className="add-meta">
                  <BucketBadge bucket={b} />
                  <SpeedLabel est={e} />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
