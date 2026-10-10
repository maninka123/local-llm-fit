import { useEffect, useMemo } from "react";
import { Gauge, LayoutGrid, Columns3, Search, Settings2, Moon, Sun } from "lucide-react";
import { useStore, type Page } from "./state/store";
import { MachineBar } from "./components/MachineBar";
import { Overview } from "./screens/Overview";
import { Explorer } from "./screens/Explorer";
import { ModelDetail } from "./screens/ModelDetail";
import { Compare } from "./screens/Compare";
import { FindModel } from "./screens/FindModel";
import { Settings } from "./screens/Settings";

const NAV: { page: Page; label: string; icon: React.ReactNode }[] = [
  { page: "overview", label: "Overview", icon: <Gauge size={18} /> },
  { page: "explore", label: "Model Explorer", icon: <LayoutGrid size={18} /> },
  { page: "compare", label: "Compare", icon: <Columns3 size={18} /> },
  { page: "find", label: "Find a Model", icon: <Search size={18} /> },
  { page: "settings", label: "Settings & Diagnostics", icon: <Settings2 size={18} /> },
];

export function App() {
  const route = useStore((s) => s.route);
  const navigate = useStore((s) => s.navigate);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const motion = useStore((s) => s.motion);
  const compare = useStore((s) => s.compare);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    const s = useStore.getState();
    void s.rescanHardware();
    void s.rebuildCatalog().then(() => s.refreshOllama());
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const systemReduce = useMemo(() => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  useEffect(() => {
    const reduce = motion === "reduce" || (motion === "system" && systemReduce);
    document.documentElement.classList.toggle("reduce-motion", reduce);
  }, [motion, systemReduce]);

  const active: Page = route.page === "model" ? "explore" : route.page;

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="app">
        <nav className="sidebar" aria-label="Main">
          <div className="brand">
            <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
            <div>
              <b>Model Fit Explorer</b>
              <span>Local AI on your machine</span>
            </div>
          </div>
          {NAV.map((n) => (
            <button key={n.page} className="nav-item" aria-current={active === n.page ? "page" : undefined} onClick={() => navigate({ page: n.page })}>
              {n.icon}
              <span>{n.label}</span>
              {n.page === "compare" && compare.length > 0 && <span className="count num">{compare.length}</span>}
            </button>
          ))}
          <div className="sidebar-foot">
            <button className="btn ghost sm" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
              {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
              <span className="hide-narrow">{theme === "dark" ? "Light theme" : "Dark theme"}</span>
            </button>
            <p className="faint hide-narrow" style={{ fontSize: 11.5, margin: 0 }}>
              Estimates, not guarantees. Nothing leaves your computer unless you search online.
            </p>
          </div>
        </nav>
        <div className="main">
          <MachineBar />
          <main id="main" className="page" tabIndex={-1}>
            {route.page === "overview" && <Overview />}
            {route.page === "explore" && <Explorer />}
            {route.page === "model" && <ModelDetail id={route.modelId ?? ""} />}
            {route.page === "compare" && <Compare />}
            {route.page === "find" && <FindModel />}
            {route.page === "settings" && <Settings />}
          </main>
        </div>
      </div>
      {toast && (
        <div className={`toast`} role="status" aria-live="polite" style={{ color: toast.tone === "good" ? "var(--good)" : toast.tone === "warn" ? "var(--warn)" : toast.tone === "bad" ? "var(--bad)" : undefined }}>
          {toast.text}
        </div>
      )}
    </>
  );
}
