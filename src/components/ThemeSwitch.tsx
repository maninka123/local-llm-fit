import { Monitor, Moon, Sun } from "lucide-react";
import { useStore, type Theme } from "../state/store";

const OPTIONS: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: "light", label: "Light", icon: <Sun size={16} /> },
  { value: "dark", label: "Dark", icon: <Moon size={16} /> },
  { value: "system", label: "Match system", icon: <Monitor size={16} /> },
];

/** Three-way theme switch with a sliding thumb (light / dark / system). */
export function ThemeSwitch({ showLabel }: { showLabel?: boolean }) {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const index = Math.max(0, OPTIONS.findIndex((o) => o.value === theme));
  return (
    <div className="theme-switch-wrap">
      <div className="theme-switch" role="radiogroup" aria-label="Theme" style={{ ["--i" as string]: index }}>
        <span className="theme-thumb" aria-hidden />
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={theme === o.value}
            aria-label={`${o.label} theme`}
            data-tip={o.label}
            className={theme === o.value ? "on" : ""}
            onClick={() => setTheme(o.value)}
          >
            {o.icon}
          </button>
        ))}
      </div>
      {showLabel && <span className="faint theme-name">{OPTIONS[index].label}</span>}
    </div>
  );
}
