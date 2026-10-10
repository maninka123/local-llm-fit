import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { buildCatalog, type Snapshot } from "../catalog/buildCatalog";
import type { ImportReport } from "../catalog/seedImporter";
import type { OllamaVerification } from "../catalog/ollamaOfficial";
import type { InputSelection } from "../domain/capabilities";
import { DEFAULT_SETTINGS, type EstimatorSettings } from "../domain/estimator";
import type { BenchmarkRecord, CapEvidence, HardwareOverrides, HardwareReport, InputCap, ModelVariant, QuantId } from "../domain/types";
import { EMPTY_OVERRIDES } from "../domain/types";
import { addEvidence } from "../domain/capabilities";
import { DEMO_MACHINES } from "../platform/demoHardware";
import { isTauri, ollama, probeHardware } from "../platform/bridge";
import { modelFromInstalled, type OllamaPsModel, type OllamaTagModel } from "../platform/ollamaLocal";
import seedCsv from "../data/ollama_model_catalog_2026-10.csv?raw";

export type Page = "overview" | "explore" | "model" | "compare" | "find" | "settings";
export type Theme = "dark" | "light";
export type MotionPref = "system" | "reduce" | "full";
/** "AUTO" = the model's default published tag when known, otherwise Q4_K_M. */
export type QuantChoice = QuantId | "AUTO";

export interface Route {
  page: Page;
  modelId?: string;
}

export interface OllamaState {
  status: "unknown" | "checking" | "online" | "offline";
  version?: string;
  installed: OllamaTagModel[];
  running: OllamaPsModel[];
  error?: string;
  checkedAt?: string;
}

interface Persisted {
  overrides: HardwareOverrides;
  settings: EstimatorSettings;
  quantChoice: QuantChoice;
  perModelQuant: Record<string, QuantId>;
  liveVerifications: Record<string, OllamaVerification>;
  userModels: ModelVariant[];
  capabilityEvidence: Record<string, { key: InputCap; ev: CapEvidence }[]>;
  benchmarks: BenchmarkRecord[];
  compare: string[];
  theme: Theme;
  motion: MotionPref;
  inputs: InputSelection;
  verifiedOnly: boolean;
  demoId: string;
}

interface State extends Persisted {
  route: Route;
  hardware: HardwareReport | null;
  hardwareStatus: "idle" | "probing" | "ready" | "error";
  hardwareError?: string;
  catalog: Map<string, ModelVariant>;
  importReport: ImportReport | null;
  snapshotDate: string | null;
  snapshotStats: { applied: number; added: number };
  ollamaState: OllamaState;
  toast: { id: number; text: string; tone: "info" | "good" | "warn" | "bad" } | null;

  navigate(r: Route): void;
  setOverrides(p: Partial<HardwareOverrides>): void;
  resetOverrides(): void;
  setSettings(p: Partial<EstimatorSettings>): void;
  setQuantChoice(q: QuantChoice): void;
  setModelQuant(id: string, q: QuantId): void;
  rescanHardware(): Promise<void>;
  setDemo(id: string): void;
  rebuildCatalog(): Promise<void>;
  saveVerification(v: OllamaVerification): void;
  addUserModel(m: ModelVariant): void;
  removeUserModel(id: string): void;
  addCapabilityEvidence(modelId: string, key: InputCap, ev: CapEvidence): void;
  refreshOllama(): Promise<void>;
  addBenchmark(b: BenchmarkRecord): void;
  clearBenchmarks(): void;
  toggleCompare(id: string): void;
  setTheme(t: Theme): void;
  setMotion(m: MotionPref): void;
  setInputs(s: InputSelection): void;
  setVerifiedOnly(v: boolean): void;
  showToast(text: string, tone?: "info" | "good" | "warn" | "bad"): void;
}

function routeFromHash(): Route {
  const h = typeof location !== "undefined" ? location.hash.replace(/^#\/?/, "") : "";
  const [page, ...rest] = h.split("/");
  const valid: Page[] = ["overview", "explore", "model", "compare", "find", "settings"];
  if (page === "model" && rest.length) return { page: "model", modelId: decodeURIComponent(rest.join("/")) };
  if (valid.includes(page as Page)) return { page: page as Page };
  return { page: "overview" };
}

const safeStorage = createJSONStorage<Persisted>(() => {
  try {
    const k = "__mfe_probe";
    localStorage.setItem(k, "1");
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    const mem = new Map<string, string>();
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
  }
});

let snapshotCache: Snapshot | null | undefined;
async function loadSnapshot(): Promise<Snapshot | null> {
  if (snapshotCache !== undefined) return snapshotCache;
  try {
    const mod = await import("../data/verified-snapshot.json");
    snapshotCache = (mod.default ?? mod) as unknown as Snapshot;
  } catch {
    snapshotCache = null;
  }
  return snapshotCache;
}

function applyLocal(models: Map<string, ModelVariant>, s: Pick<State, "ollamaState" | "capabilityEvidence">, details: Map<string, Parameters<typeof modelFromInstalled>[1]>) {
  const now = new Date().toISOString();
  for (const tag of s.ollamaState.installed) {
    const id = tag.name.toLowerCase().replace(/:latest$/, "");
    const key = models.has(tag.name.toLowerCase()) ? tag.name.toLowerCase() : models.has(id) ? id : tag.name.toLowerCase();
    models.set(key, modelFromInstalled(tag, details.get(tag.name) ?? null, models.get(key), now));
  }
  for (const [id, list] of Object.entries(s.capabilityEvidence)) {
    const m = models.get(id);
    if (!m) continue;
    const caps = JSON.parse(JSON.stringify(m.capabilities));
    for (const { key, ev } of list) caps.inputs[key] = addEvidence(caps.inputs[key], ev);
    models.set(id, { ...m, capabilities: caps });
  }
}

const showDetails = new Map<string, Parameters<typeof modelFromInstalled>[1]>();
let toastId = 0;

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      overrides: EMPTY_OVERRIDES,
      settings: DEFAULT_SETTINGS,
      quantChoice: "AUTO",
      perModelQuant: {},
      liveVerifications: {},
      userModels: [],
      capabilityEvidence: {},
      benchmarks: [],
      compare: [],
      theme: "dark",
      motion: "system",
      inputs: { text: true },
      verifiedOnly: false,
      demoId: DEMO_MACHINES[0].id,

      route: routeFromHash(),
      hardware: null,
      hardwareStatus: "idle",
      catalog: new Map(),
      importReport: null,
      snapshotDate: null,
      snapshotStats: { applied: 0, added: 0 },
      ollamaState: { status: "unknown", installed: [], running: [] },
      toast: null,

      navigate(r) {
        const hash = r.page === "model" && r.modelId ? `#/model/${encodeURIComponent(r.modelId)}` : `#/${r.page}`;
        if (location.hash !== hash) history.pushState(null, "", hash);
        set({ route: r });
        window.scrollTo({ top: 0 });
      },
      setOverrides: (p) => set({ overrides: { ...get().overrides, ...p } }),
      resetOverrides: () => set({ overrides: EMPTY_OVERRIDES }),
      setSettings: (p) => set({ settings: { ...get().settings, ...p } }),
      setQuantChoice: (q) => set({ quantChoice: q }),
      setModelQuant: (id, q) => set({ perModelQuant: { ...get().perModelQuant, [id]: q } }),

      async rescanHardware() {
        set({ hardwareStatus: "probing", hardwareError: undefined });
        try {
          if (!isTauri()) {
            const demo = DEMO_MACHINES.find((d) => d.id === get().demoId) ?? DEMO_MACHINES[0];
            set({ hardware: { ...demo.report, detectedAt: new Date().toISOString() }, hardwareStatus: "ready" });
            return;
          }
          const r = await probeHardware();
          set({ hardware: r, hardwareStatus: "ready" });
        } catch (e) {
          set({ hardwareStatus: "error", hardwareError: String((e as Error).message ?? e) });
        }
      },
      setDemo(id) {
        set({ demoId: id, overrides: EMPTY_OVERRIDES });
        void get().rescanHardware();
      },

      async rebuildCatalog() {
        const s = get();
        const snap = await loadSnapshot();
        const b = buildCatalog(seedCsv, snap, s.liveVerifications, s.userModels);
        applyLocal(b.models, s, showDetails);
        set({ catalog: b.models, importReport: b.report, snapshotDate: b.snapshotDate, snapshotStats: { applied: b.snapshotApplied, added: b.snapshotAdded } });
      },
      saveVerification(v) {
        const id = `${v.family}:${v.variant}`.toLowerCase();
        set({ liveVerifications: { ...get().liveVerifications, [id]: v } });
        void get().rebuildCatalog();
      },
      addUserModel(m) {
        set({ userModels: [...get().userModels.filter((u) => u.id !== m.id), m] });
        void get().rebuildCatalog();
      },
      removeUserModel(id) {
        set({ userModels: get().userModels.filter((u) => u.id !== id), compare: get().compare.filter((c) => c !== id) });
        void get().rebuildCatalog();
      },
      addCapabilityEvidence(modelId, key, ev) {
        const cur = get().capabilityEvidence[modelId] ?? [];
        set({ capabilityEvidence: { ...get().capabilityEvidence, [modelId]: [...cur.filter((x) => !(x.key === key && x.ev.scope === ev.scope)), { key, ev }] } });
        void get().rebuildCatalog();
      },

      async refreshOllama() {
        set({ ollamaState: { ...get().ollamaState, status: "checking" } });
        const c = ollama();
        try {
          const v = await c.version();
          const [tags, ps] = await Promise.all([c.tags(), c.ps().catch(() => ({ models: [] }))]);
          for (const t of tags.models) {
            if (!showDetails.has(t.name)) {
              try {
                showDetails.set(t.name, await c.show(t.name));
              } catch {
                /* show failures leave metadata unknown */
              }
            }
          }
          set({ ollamaState: { status: "online", version: v.version, installed: tags.models, running: ps.models, checkedAt: new Date().toISOString() } });
        } catch (e) {
          set({ ollamaState: { status: "offline", installed: [], running: [], error: String((e as Error).message ?? e), checkedAt: new Date().toISOString() } });
        }
        await get().rebuildCatalog();
      },

      addBenchmark: (b) => set({ benchmarks: [b, ...get().benchmarks].slice(0, 200) }),
      clearBenchmarks: () => set({ benchmarks: [] }),
      toggleCompare(id) {
        const c = get().compare;
        if (c.includes(id)) set({ compare: c.filter((x) => x !== id) });
        else if (c.length >= 4) get().showToast("Compare holds up to 4 models. Remove one first.", "warn");
        else {
          set({ compare: [...c, id] });
          get().showToast("Added to Compare", "good");
        }
      },
      setTheme: (t) => set({ theme: t }),
      setMotion: (m) => set({ motion: m }),
      setInputs: (s) => set({ inputs: { ...s, text: true } }),
      setVerifiedOnly: (v) => set({ verifiedOnly: v }),
      showToast(text, tone = "info") {
        const id = ++toastId;
        set({ toast: { id, text, tone } });
        setTimeout(() => {
          if (get().toast?.id === id) set({ toast: null });
        }, 3200);
      },
    }),
    {
      name: "model-fit-explorer",
      version: 1,
      storage: safeStorage,
      partialize: (s): Persisted => ({
        overrides: s.overrides,
        settings: s.settings,
        quantChoice: s.quantChoice,
        perModelQuant: s.perModelQuant,
        liveVerifications: s.liveVerifications,
        userModels: s.userModels,
        capabilityEvidence: s.capabilityEvidence,
        benchmarks: s.benchmarks,
        compare: s.compare,
        theme: s.theme,
        motion: s.motion,
        inputs: s.inputs,
        verifiedOnly: s.verifiedOnly,
        demoId: s.demoId,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Persisted>;
        return { ...current, ...p, settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}), reserves: { ...DEFAULT_SETTINGS.reserves, ...(p.settings?.reserves ?? {}) } }, overrides: { ...EMPTY_OVERRIDES, ...(p.overrides ?? {}) } };
      },
    },
  ),
);

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => useStore.setState({ route: routeFromHash() }));
}
