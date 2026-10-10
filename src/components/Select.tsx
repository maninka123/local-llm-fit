import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Check } from "lucide-react";

// Themed dropdown that matches the graphics-card picker. Replaces native <select>, whose
// popup list is drawn by the OS and ignores the app's light/dark theme.

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  /** Options with the same group are listed under that heading. */
  group?: string;
  /** Small text on the right, e.g. memory sizes. */
  meta?: string;
}

export function Select<T extends string | number>({
  id,
  value,
  onChange,
  options,
  label,
  className = "",
  style,
}: {
  id?: string;
  value: T;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  /** Accessible name when there is no <label htmlFor>. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const close = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (open) scrollWithin(list.current, list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`) ?? null);
  }, [open, active]);

  const choose = (i: number) => {
    const o = options[i];
    if (o) onChange(o.value);
    setOpen(false);
  };

  return (
    <div className={`combo select-wrap ${className}`} ref={wrap} style={style}>
      <button
        id={id}
        type="button"
        className="select select-btn"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={label}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen(true);
          } else if (open) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, options.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Home" || e.key === "End") {
              e.preventDefault();
              setActive(e.key === "Home" ? 0 : options.length - 1);
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              choose(active);
            } else if (e.key === "Escape" || e.key === "Tab") {
              if (e.key === "Escape") e.stopPropagation(); // close the list, not the dialog
              setOpen(false);
            }
          }
        }}
      >
        <span className="select-value">{current?.label ?? "Choose…"}</span>
      </button>
      {open && (
        <ul className="combo-list" id={listId} role="listbox" ref={list} aria-label={label}>
          {options.map((o, i) => (
            <li key={String(o.value)} role="none" className="select-item">
              {o.group && o.group !== options[i - 1]?.group && <div className="combo-group">{o.group}</div>}
              <div
                id={`${listId}-${i}`}
                data-i={i}
                role="option"
                aria-selected={o.value === value}
                className={`combo-opt ${i === active ? "on" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(i);
                }}
              >
                <span>{o.label}</span>
                {o.meta ? <span className="combo-meta">{o.meta}</span> : o.value === value ? <Check size={15} className="combo-check" /> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Scroll a list so `el` is visible, without scrolling the page or dialog around it. */
export function scrollWithin(list: HTMLElement | null, el: HTMLElement | null) {
  if (!list || !el) return;
  const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
  if (top < list.scrollTop) list.scrollTop = top - 6;
  else if (top + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + el.offsetHeight - list.clientHeight + 6;
}
