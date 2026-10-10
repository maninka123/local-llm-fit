import { useId, useMemo, useRef, useState } from "react";
import { CARD_NAMES, lookupGpu } from "../platform/gpuSpecs";

// Styled, keyboard-friendly graphics-card picker (replaces the native datalist popup).
const WORKSTATION = /rtx pro|\bada\b|rtx a\d|radeon pro/i;
const ORDERED = [...new Set([...CARD_NAMES.filter((n) => !WORKSTATION.test(n)), ...CARD_NAMES.filter((n) => WORKSTATION.test(n))])];

export function GpuCombobox({ id, value, onChange, placeholder, names }: { id: string; value: string; onChange: (v: string) => void; placeholder?: string; names?: string[] }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const blurTimer = useRef<number | null>(null);

  const matches = useMemo(() => {
    const terms = value.toLowerCase().split(/\s+/).filter(Boolean);
    const all = names ?? ORDERED;
    const list = terms.length ? all.filter((n) => terms.every((t) => n.toLowerCase().includes(t))) : all;
    return list.slice(0, 8);
  }, [value, names]);

  const choose = (name: string) => {
    onChange(name);
    setOpen(false);
  };

  return (
    <div className="combo">
      <input
        id={id}
        className="input"
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          blurTimer.current = window.setTimeout(() => setOpen(false), 120);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && open && matches[active]) {
            e.preventDefault();
            choose(matches[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && matches.length > 0 && (
        <ul className="combo-list" id={listId} role="listbox">
          {matches.map((n, i) => {
            const vram = lookupGpu(n)?.vramGiB;
            return (
              <li
                key={n}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "on" : ""}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (blurTimer.current) clearTimeout(blurTimer.current);
                  choose(n);
                }}
              >
                <span>{n}</span>
                {vram && <span className="combo-meta">{vram.join(" / ")} GB</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
