import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CARD_NAMES, bandwidthFor, lookupGpu } from "../platform/gpuSpecs";
import { scrollWithin } from "./Select";

// Styled, keyboard-friendly graphics-card picker (replaces the native datalist popup).
const WORKSTATION = /rtx pro|\bada\b|rtx a\d|radeon pro/i;
const ORDERED = [...new Set([...CARD_NAMES.filter((n) => !WORKSTATION.test(n)), ...CARD_NAMES.filter((n) => WORKSTATION.test(n))])];

export function GpuCombobox({ id, value, onChange, placeholder, names }: { id: string; value: string; onChange: (v: string) => void; placeholder?: string; names?: string[] }) {
  const [open, setOpen] = useState(false);
  // What you've typed since opening. Until you type, every card is listed (not just the current one).
  const [typed, setTyped] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const blurTimer = useRef<number | null>(null);

  const matches = useMemo(() => {
    const terms = (typed ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const all = names ?? ORDERED;
    return terms.length ? all.filter((n) => terms.every((t) => n.toLowerCase().includes(t))) : all;
  }, [typed, names]);

  const choose = (name: string) => {
    onChange(name);
    setTyped(null);
    setOpen(false);
  };
  // Keep the highlighted card in view (e.g. the current one when the list opens).
  useEffect(() => {
    if (open) scrollWithin(document.getElementById(listId), document.getElementById(`${listId}-${active}`));
  }, [open, active, listId]);
  const openList = () => {
    setTyped(null);
    const i = (names ?? ORDERED).indexOf(lookupGpu(value)?.name ?? value);
    setActive(Math.max(0, i));
    setOpen(true);
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
        onFocus={openList}
        onClick={() => !open && openList()}
        onBlur={() => {
          blurTimer.current = window.setTimeout(() => setOpen(false), 120);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setTyped(e.target.value);
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
          } else if (e.key === "Escape" && open) {
            e.stopPropagation(); // close the list, not the dialog around it
            setOpen(false);
          }
        }}
      />
      {open && matches.length > 0 && (
        <ul className="combo-list" id={listId} role="listbox">
          {matches.map((n, i) => {
            const vram = lookupGpu(n)?.vramGiB;
            const bw = bandwidthFor(n);
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
                {vram && (
                  <span className="combo-meta" title="Graphics memory sizes · memory speed (faster = quicker replies)">
                    {vram.join(" / ")} GB{bw ? ` · ${Math.round(bw)} GB/s` : ""}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
