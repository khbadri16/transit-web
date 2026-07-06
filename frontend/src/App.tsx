import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  Delete,
  Eraser,
  Eye,
  FileText,
  History,
  Keyboard,
  Loader2,
  Plus,
  ScrollText,
  Ship,
  Table,
  Trash2,
  X,
} from "lucide-react";

/* --------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------ */

type Size = "20" | "40" | "45";

type Container = {
  id: string;
  number: string;
  size: Size;
};

type DcpProduit = {
  id: string;
  produit: string;
  code: string;
};

/** Exactly what is POSTed to the FastAPI backend. */
type GeneratePayload = {
  transit_name: string;
  client_name: string;
  company_name: string;
  marchandise_type: string;
  weight_of_all_containers: string;
  force_uppercase: boolean;
  containers: { number: string; size: Size }[];
  dcp_enabled: boolean;
  dcp: Record<string, string>;
  dcp_produits: { produit: string; code: string }[];
};

type HistoryEntry = {
  id: string;
  savedAt: string; // ISO timestamp
  payload: GeneratePayload;
};

type Toast = { message: string; type: "success" | "error" };

/* --------------------------------------------------------------------------
 * API configuration
 * ------------------------------------------------------------------------ */

/**
 * API base URL. Empty by default = same origin:
 * - production (Vercel): the Python function lives on the same domain (/api/*)
 * - local dev: the Vite proxy forwards /api/* to http://127.0.0.1:8000
 * Set VITE_API_URL only to point at an API hosted somewhere else.
 */
const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

/* --------------------------------------------------------------------------
 * Local history cache (localStorage)
 * ------------------------------------------------------------------------ */

const HISTORY_KEY = "bl_history";
const HISTORY_MAX = 10;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is HistoryEntry =>
        e &&
        typeof e.id === "string" &&
        typeof e.savedAt === "string" &&
        e.payload &&
        Array.isArray(e.payload.containers)
    );
  } catch {
    return [];
  }
}

function persistHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch {
    /* storage full / unavailable — history is a nice-to-have, never fatal */
  }
}

const fmtTimestamp = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/* --------------------------------------------------------------------------
 * DCP (تصريح باستيراد المنتوج) definitions
 * ------------------------------------------------------------------------ */

type DcpFieldDef = {
  /** Exact placeholder name used in DCP.docx */
  key: string;
  label: string;
  /** Item number printed on the paper, e.g. (1) */
  num?: string;
  type: "text" | "date";
  placeholder?: string;
  /** Static unit shipped with the value (e.g. DA, طن) */
  suffix?: string;
  /** true = unit sits at the far left (end of an RTL row) */
  suffixEnd?: boolean;
  /** Show the currency selector (EUR / USD / DA / custom) */
  currency?: boolean;
};

/** Fields grouped exactly like the lines of the printed DCP paper. */
const DCP_ROWS: DcpFieldDef[][] = [
  [{ key: "المستورد", num: "1", label: "المستورد", type: "text", placeholder: "اللقب والاسم أو شركة المتعامل" }],
  [
    { key: "رقم_س_ت", label: "رقم السجل التجاري (س ت)", type: "text" },
    { key: "تاريخ_الاستراد", label: "تاريخ س ت", type: "date" },
  ],
  [{ key: "العنوان", num: "2", label: "العنوان", type: "text", placeholder: "العنوان الحقيقي للمتعامل" }],
  [{ key: "تعيين_المنتوج", num: "3", label: "تعيين المنتوج", type: "text" }],
  [
    { key: "معروض_في", num: "4", label: "معروض في", type: "text" },
    { key: "متكون_من", num: "5", label: "متكون من", type: "text" },
  ],
  [{ key: "الكمية", num: "6", label: "الكمية", type: "text", placeholder: "الكمية بالأطنان", suffix: "طن", suffixEnd: true }],
  [
    { key: "فاتورة_الشراء", num: "8", label: "فاتورة الشراء", type: "text" },
    { key: "القيمة", num: "9", label: "القيمة", type: "text", currency: true },
  ],
  [
    { key: "القيمة_بالدينار", num: "9", label: "القيمة بالدينار", type: "text", suffix: "DA" },
    { key: "الفاتورة_تاريخ", label: "تاريخ الفاتورة", type: "date" },
  ],
  [{ key: "الصانع", num: "10", label: "الصانع", type: "text" }],
  [{ key: "مكان_المصدر", num: "11", label: "مكان المصدر", type: "text" }],
  [{ key: "مرجع_النقل", num: "14", label: "مرجع النقل", type: "text" }],
  [{ key: "وثائق_النقل", num: "15", label: "وثائق النقل", type: "text" }],
  [
    { key: "الانطلاق_من", num: "16", label: "الانطلاق من", type: "text" },
    { key: "تاريخ_الانطلاق", label: "تاريخ الانطلاق", type: "date" },
  ],
  [
    { key: "العبور", num: "16", label: "العبور", type: "text" },
    { key: "الوصول", num: "16", label: "الوصول", type: "text" },
  ],
];

const DCP_ALL_FIELDS = DCP_ROWS.flat();

const initialDcp: Record<string, string> = {
  ...Object.fromEntries(DCP_ALL_FIELDS.map((f) => [f.key, ""])),
  القيمة_عملة: "EUR",
  القيمة_عملة_نص: "",
};

/** Currency options for القيمة — "SPEC" lets the user type his own. */
const CURRENCY_OPTIONS = ["EUR", "USD", "DA"] as const;

/** Resolve the currency to ship/preview with القيمة. */
const resolveCurrency = (dcp: Record<string, string>) => {
  const cur = (dcp["القيمة_عملة"] || "EUR").trim();
  return cur === "SPEC" ? (dcp["القيمة_عملة_نص"] || "").trim() : cur;
};

/** Arabic on-screen keyboard layout. */
const AR_KB_ROWS: string[][] = [
  ["ض", "ص", "ث", "ق", "ف", "غ", "ع", "ه", "خ", "ح", "ج", "د", "ذ"],
  ["ش", "س", "ي", "ب", "ل", "ا", "ت", "ن", "م", "ك", "ط"],
  ["ئ", "ء", "ؤ", "ر", "لا", "ى", "ة", "و", "ز", "ظ"],
  ["أ", "إ", "آ", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
  ["،", "؛", ":", "/", "-", ".", "(", ")", "٪"],
];

/** 2026-01-31 -> 31/01/2026 (forms already use dd/mm/yyyy; ISO just in case) */
const fmtDateDMY = (v: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((v || "").trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
};

/** Auto-mask typed digits into dd/mm/yyyy. */
const maskDmy = (raw: string) => {
  const d = raw.replace(/\D/g, "").slice(0, 8);
  if (d.length > 4) return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
  if (d.length > 2) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return d;
};

/* --------------------------------------------------------------------------
 * UI constants
 * ------------------------------------------------------------------------ */

const SIZE_STYLES: Record<Size, string> = {
  "20": "bg-sky-500/15 text-sky-300 border-sky-500/30",
  "40": "bg-violet-500/15 text-violet-300 border-violet-500/30",
  "45": "bg-amber-500/15 text-amber-300 border-amber-500/30",
};

const SIZE_ACTIVE: Record<Size, string> = {
  "20": "seg-active-sky",
  "40": "seg-active-violet",
  "45": "seg-active-amber",
};

/** Marque shown on MISE A QUAI: always 01TC{size}. */
const marqueFor = (size: Size) => `01TC${size}`;

/** Shipping companies — one is chosen per generation and printed on every
 *  MISE A QUAI. "OTHER" lets the user type a custom company name. */
const COMPANIES: string[] = ["CMA", "AKKON", "MSC", "HMM", "WHITE LINE", "COSCO"];

const sanitizeForFilename = (s: string) =>
  s.trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_") || "DOCUMENTS";

/* --------------------------------------------------------------------------
 * App
 * ------------------------------------------------------------------------ */

type FormState = {
  transit_name: string;
  client_name: string;
  company_choice: string; // "" | one of COMPANIES | "OTHER"
  company_custom: string; // free text when company_choice === "OTHER"
  marchandise_type: string;
  weight_of_all_containers: string;
  force_uppercase: boolean;
  containers: Container[];
  dcp_enabled: boolean;
  dcp: Record<string, string>;
  dcp_produits: DcpProduit[];
};

const initialForm: FormState = {
  transit_name: "",
  client_name: "",
  company_choice: "",
  company_custom: "",
  marchandise_type: "",
  weight_of_all_containers: "",
  force_uppercase: true,
  containers: [],
  dcp_enabled: false,
  dcp: { ...initialDcp },
  dcp_produits: [],
};

function App() {
  const [form, setForm] = useState<FormState>({
    ...initialForm,
    dcp: { ...initialDcp },
  });
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [historyOpen, setHistoryOpen] = useState(false); // mobile drawer
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  /** Which DCP field currently shows the Arabic keyboard (by key). */
  const [kbField, setKbField] = useState<string | null>(null);
  /** Live DCP paper collapsed with the << button. */
  const [paperCollapsed, setPaperCollapsed] = useState(false);
  const dcpInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const counts = useMemo(() => {
    const c = { "20": 0, "40": 0, "45": 0 } as Record<Size, number>;
    for (const ct of form.containers) c[ct.size]++;
    return { ...c, total: form.containers.length };
  }, [form.containers]);

  /* The three parts are independent — any complete part can be generated. */
  /** Resolved company name — always uppercase, custom text when "OTHER". */
  const companyName = (
    form.company_choice === "OTHER" ? form.company_custom.trim() : form.company_choice
  ).toUpperCase();

  const transitReady =
    form.transit_name.trim() !== "" &&
    form.client_name.trim() !== "" &&
    companyName !== "" &&
    form.containers.length > 0 &&
    form.containers.every((c) => c.number.trim() !== "");
  const dcpReady = form.dcp_enabled;
  const annexReady = form.dcp_produits.some(
    (p) => p.produit.trim() !== "" || p.code.trim() !== ""
  );
  const canGenerate = transitReady || dcpReady || annexReady;
  const docCount =
    (transitReady ? counts.total + 2 : 0) + (dcpReady ? 1 : 0) + (annexReady ? 1 : 0);

  /** The live DCP paper: available on large screens while DCP is enabled. */
  const paperAvailable = form.dcp_enabled;
  const showPaper = paperAvailable && !paperCollapsed;

  const flash = (message: string, type: Toast["type"]) => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 3200);
  };

  /* --- field handlers ----------------------------------------------------- */

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    if (name === "dcp_enabled" && !checked) setKbField(null);
    setForm((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));
  };

  /* --- DCP handlers ------------------------------------------------------- */

  const updateDcp = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, dcp: { ...prev.dcp, [key]: value } }));
  };

  /* Annex products (ملحق التعريفات الجمركية) */
  const addProduit = () => {
    setForm((prev) => ({
      ...prev,
      dcp_produits: [
        ...prev.dcp_produits,
        { id: crypto.randomUUID(), produit: "", code: "" },
      ],
    }));
  };

  const removeProduit = (id: string) => {
    setKbField((prev) => (prev === `prod:${id}` ? null : prev));
    setForm((prev) => ({
      ...prev,
      dcp_produits: prev.dcp_produits.filter((p) => p.id !== id),
    }));
  };

  const updateProduit = (id: string, field: "produit" | "code", value: string) => {
    setForm((prev) => ({
      ...prev,
      dcp_produits: prev.dcp_produits.map((p) =>
        p.id === id ? { ...p, [field]: value } : p
      ),
    }));
  };

  /* The keyboard writes into either a DCP field or an annex Produit field.
     Annex fields use the key "prod:{id}". */
  const getKbValue = (key: string): string => {
    if (key.startsWith("prod:")) {
      const id = key.slice(5);
      return form.dcp_produits.find((p) => p.id === id)?.produit ?? "";
    }
    return form.dcp[key] ?? "";
  };

  const setKbValue = (key: string, value: string) => {
    if (key.startsWith("prod:")) {
      updateProduit(key.slice(5), "produit", value);
    } else {
      updateDcp(key, value);
    }
  };

  const toggleKb = (key: string) => {
    setKbField((prev) => (prev === key ? null : key));
    requestAnimationFrame(() => dcpInputRefs.current[key]?.focus());
  };

  const kbInsert = (ch: string) => {
    if (!kbField) return;
    const el = dcpInputRefs.current[kbField];
    const cur = getKbValue(kbField);
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    setKbValue(kbField, cur.slice(0, start) + ch + cur.slice(end));
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        const pos = start + ch.length;
        el.setSelectionRange(pos, pos);
      }
    });
  };

  const kbBackspace = () => {
    if (!kbField) return;
    const el = dcpInputRefs.current[kbField];
    const cur = getKbValue(kbField);
    let start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    if (start === end) {
      if (start === 0) return;
      start -= 1;
    }
    setKbValue(kbField, cur.slice(0, start) + cur.slice(end));
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(start, start);
      }
    });
  };

  const kbClear = () => {
    if (!kbField) return;
    setKbValue(kbField, "");
    requestAnimationFrame(() => dcpInputRefs.current[kbField]?.focus());
  };

  /* --- containers ----------------------------------------------------------- */

  const addContainer = () => {
    setForm((prev) => ({
      ...prev,
      containers: [
        ...prev.containers,
        { id: crypto.randomUUID(), number: "", size: "20" },
      ],
    }));
  };

  const removeContainer = (id: string) => {
    setForm((prev) => ({
      ...prev,
      containers: prev.containers.filter((c) => c.id !== id),
    }));
  };

  const updateContainer = (id: string, field: "number" | "size", value: string) => {
    setForm((prev) => ({
      ...prev,
      containers: prev.containers.map((c) =>
        c.id === id ? { ...c, [field]: value } : c
      ),
    }));
  };

  const clearForm = () => {
    setForm({ ...initialForm, dcp: { ...initialDcp }, dcp_produits: [] });
    setError(null);
    setKbField(null);
  };

  /* --- history --------------------------------------------------------------- */

  const saveToHistory = (payload: GeneratePayload) => {
    setHistory((prev) => {
      const entry: HistoryEntry = {
        id: crypto.randomUUID(),
        savedAt: new Date().toISOString(),
        payload,
      };
      const next = [entry, ...prev].slice(0, HISTORY_MAX);
      persistHistory(next);
      return next;
    });
  };

  const applyHistoryEntry = (entry: HistoryEntry) => {
    const p = entry.payload;
    const savedCompany = (p.company_name ?? "").trim().toUpperCase();
    setForm({
      transit_name: p.transit_name ?? "",
      client_name: p.client_name ?? "",
      company_choice: savedCompany
        ? COMPANIES.includes(savedCompany) ? savedCompany : "OTHER"
        : "",
      company_custom:
        savedCompany && !COMPANIES.includes(savedCompany) ? savedCompany : "",
      marchandise_type: p.marchandise_type ?? "",
      weight_of_all_containers: p.weight_of_all_containers ?? "",
      force_uppercase: p.force_uppercase ?? true,
      containers: (p.containers ?? []).map((c) => ({
        id: crypto.randomUUID(),
        number: c.number,
        size: c.size,
      })),
      dcp_enabled: p.dcp_enabled ?? false,
      dcp: { ...initialDcp, ...(p.dcp ?? {}) },
      dcp_produits: (p.dcp_produits ?? []).map((pr) => ({
        id: crypto.randomUUID(),
        produit: pr.produit ?? "",
        code: pr.code ?? "",
      })),
    });
    setHistoryOpen(false);
    setError(null);
    setKbField(null);
    flash("Form restored from history.", "success");
  };

  const deleteHistoryEntry = (id: string) => {
    setHistory((prev) => {
      const next = prev.filter((e) => e.id !== id);
      persistHistory(next);
      return next;
    });
  };

  const clearHistory = () => {
    setHistory([]);
    persistHistory([]);
  };

  /* --- generate + download ---------------------------------------------------- */

  const generateDocuments = async () => {
    if (!canGenerate || isGenerating) return;
    setIsGenerating(true);
    setError(null);
    setKbField(null);

    const payload: GeneratePayload = {
      transit_name: form.transit_name.trim(),
      client_name: form.client_name.trim(),
      company_name: companyName,
      marchandise_type: form.marchandise_type.trim(),
      weight_of_all_containers: form.weight_of_all_containers.trim(),
      force_uppercase: form.force_uppercase,
      containers: form.containers.map((c) => ({
        number: c.number.trim(),
        size: c.size,
      })),
      dcp_enabled: form.dcp_enabled,
      dcp: { ...form.dcp },
      dcp_produits: form.dcp_produits.map((p) => ({
        produit: p.produit,
        code: p.code,
      })),
    };

    try {
      const res = await fetch(`${API_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let message = `Server error (HTTP ${res.status})`;
        try {
          const data = await res.json();
          if (data?.detail) {
            message =
              typeof data.detail === "string"
                ? data.detail
                : JSON.stringify(data.detail);
          }
        } catch {
          /* non-JSON error body — keep the generic message */
        }
        throw new Error(message);
      }

      // ZIP blob -> automatic browser download
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      const base = payload.client_name || payload.dcp["المستورد"] || "DOCUMENTS";
      a.href = url;
      a.download = `DOCUMENTS_${sanitizeForFilename(base)}_${stamp}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);

      saveToHistory(payload);
      flash(`${docCount} document(s) generated — download started.`, "success");
    } catch (err) {
      const isNetwork = err instanceof TypeError;
      const message = isNetwork
        ? "Could not reach the API. In local dev, make sure it is running: uvicorn api.index:app --reload --port 8000 (from the frontend folder)."
        : err instanceof Error
          ? err.message
          : "An unexpected error occurred.";
      setError(message);
      flash("Generation failed.", "error");
    } finally {
      setIsGenerating(false);
    }
  };

  /* --- render ------------------------------------------------------------------ */

  const upper = form.force_uppercase ? { textTransform: "uppercase" as const } : undefined;

  return (
    <div className="app-shell min-h-screen text-slate-100">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-5 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2.5 px-4 py-2.5 rounded-xl border shadow-2xl backdrop-blur-md animate-[toastIn_.25s_ease] max-w-[calc(100vw-2rem)] ${
            toast.type === "success"
              ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200"
              : "bg-rose-500/15 border-rose-500/40 text-rose-200"
          }`}
        >
          {toast.type === "success" ? (
            <CheckCircle2 size={16} className="shrink-0" />
          ) : (
            <AlertTriangle size={16} className="shrink-0" />
          )}
          <span className="text-sm font-medium">{toast.message}</span>
        </div>
      )}

      <div className="flex min-h-screen">
        {/* DCP live paper preview — left side, read-only (large screens) */}
        {showPaper && (
          <aside className="dcp-aside hidden lg:flex w-[32rem] shrink-0 h-screen flex-col border-r border-slate-800 bg-slate-900/40 backdrop-blur">
            <div className="px-5 pt-5 pb-3 flex items-center justify-between gap-2" dir="rtl">
              <h2 className="text-sm font-bold text-white flex items-center gap-2 min-w-0">
                <Eye size={16} className="text-indigo-400 shrink-0" />
                معاينة مباشرة — تصريح باستيراد المنتوج
              </h2>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[10px] text-slate-500 border border-slate-700 rounded-full px-2 py-0.5">
                  للقراءة فقط
                </span>
                <button
                  onClick={() => setPaperCollapsed(true)}
                  className="paper-toggle"
                  title="إخفاء المعاينة"
                  aria-label="إخفاء المعاينة"
                >
                  <ChevronsLeft size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 pb-6">
              <DcpPaper dcp={form.dcp} />
            </div>
          </aside>
        )}

        {/* Re-open button when the paper is hidden */}
        {paperAvailable && paperCollapsed && (
          <button
            onClick={() => setPaperCollapsed(false)}
            className="paper-reopen hidden lg:flex"
            title="إظهار المعاينة"
            aria-label="إظهار المعاينة"
          >
            <ChevronsRight size={16} />
            <span className="paper-reopen-label">معاينة</span>
          </button>
        )}

        {/* Main column */}
        <main className="flex-1 min-w-0 h-screen overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 sm:px-8 py-6 sm:py-10 flex flex-col min-h-screen">
            {/* Header */}
            <header className="mb-6 sm:mb-8 flex items-center gap-3 sm:gap-4">
              <div className="grid place-items-center w-11 h-11 sm:w-12 sm:h-12 shrink-0 rounded-2xl bg-gradient-to-br from-indigo-500 to-blue-600 shadow-lg shadow-indigo-500/30">
                <Ship size={24} className="text-white" />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="text-lg sm:text-2xl font-bold tracking-tight text-white leading-tight">
                  Transit Document Generator
                </h1>
                <p className="text-slate-400 text-xs sm:text-sm">
                  Fill in the details once — generate all templates instantly.
                </p>
              </div>
              {/* History toggle — phones & tablets only */}
              <button
                onClick={() => setHistoryOpen(true)}
                className="btn-ghost relative shrink-0 !px-3 !py-2.5 lg:hidden"
                title="Recent shipments"
                aria-label="Open recent shipments"
              >
                <History size={18} />
                {history.length > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 grid place-items-center min-w-[1.15rem] h-[1.15rem] px-1 rounded-full bg-indigo-500 text-white text-[10px] font-bold">
                    {history.length}
                  </span>
                )}
              </button>
            </header>

            {/* Error banner */}
            {error && (
              <div className="mb-6 flex items-start gap-3 p-4 rounded-xl bg-rose-500/10 border border-rose-500/40 text-rose-200">
                <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                <div className="flex-1 text-sm whitespace-pre-wrap break-words">
                  {error}
                </div>
                <button
                  onClick={() => setError(null)}
                  className="text-rose-300/70 hover:text-rose-200"
                  aria-label="Dismiss error"
                >
                  <X size={16} />
                </button>
              </div>
            )}

            <div className="space-y-5 sm:space-y-6 flex-1">
              {/* Global details */}
              <section className="card">
                <h2 className="section-title">Global details</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field label="Transit name" required>
                    <input
                      className="input"
                      type="text"
                      name="transit_name"
                      value={form.transit_name}
                      onChange={handleInputChange}
                      placeholder="e.g. ALPHA TRANSIT"
                      style={upper}
                    />
                  </Field>
                  <Field label="Client name" required>
                    <input
                      className="input"
                      type="text"
                      name="client_name"
                      value={form.client_name}
                      onChange={handleInputChange}
                      placeholder="e.g. ACME CORP"
                      style={upper}
                    />
                  </Field>
                  <Field label="Merchandise type">
                    <input
                      className="input"
                      type="text"
                      name="marchandise_type"
                      value={form.marchandise_type}
                      onChange={handleInputChange}
                      placeholder="e.g. ELECTRONICS"
                      style={upper}
                    />
                  </Field>
                  <Field label="Total weight">
                    <div className="flex items-center gap-1.5">
                      <input
                        className="input flex-1 min-w-0"
                        type="text"
                        inputMode="decimal"
                        name="weight_of_all_containers"
                        value={form.weight_of_all_containers}
                        onChange={handleInputChange}
                        placeholder="e.g. 15000"
                      />
                      <span className="unit-suffix">Kgs</span>
                    </div>
                  </Field>
                </div>

                {/* Force uppercase toggle */}
                <label className="mt-5 inline-flex items-center gap-3 cursor-pointer select-none">
                  <span className="relative">
                    <input
                      type="checkbox"
                      name="force_uppercase"
                      checked={form.force_uppercase}
                      onChange={handleInputChange}
                      className="peer sr-only"
                    />
                    <span className="block w-10 h-6 rounded-full bg-slate-700 peer-checked:bg-indigo-500 transition-colors" />
                    <span className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
                  </span>
                  <span className="text-sm font-medium text-slate-300">
                    Force uppercase (Majuscule)
                  </span>
                </label>
              </section>

              {/* Containers */}
              <section className="card">
                <div className="flex items-center justify-between mb-4 gap-2">
                  <h2 className="section-title mb-0 flex items-center gap-2.5">
                    <ContainerIcon />
                    Containers
                  </h2>
                  <button onClick={addContainer} className="btn-ghost shrink-0">
                    <Plus size={16} /> <span className="hidden sm:inline">Add container</span>
                    <span className="sm:hidden">Add</span>
                  </button>
                </div>

                {/* Shipping company — chosen once, printed on every Mise à Quai */}
                <div className="mb-5">
                  <label className="text-sm font-medium text-slate-300">
                    Shipping company <span className="text-indigo-400">*</span>
                    <span className="text-xs text-slate-500 font-normal">
                      {" "}— one per generation, printed on every Mise à Quai
                    </span>
                  </label>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {[...COMPANIES, "OTHER"].map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() =>
                          setForm((prev) => ({
                            ...prev,
                            company_choice: prev.company_choice === c ? "" : c,
                          }))
                        }
                        className={`px-3 py-1.5 rounded-lg border text-xs font-bold tracking-wide transition-colors ${
                          form.company_choice === c
                            ? "bg-indigo-500/25 border-indigo-400/70 text-indigo-100"
                            : "border-slate-700 text-slate-400 hover:border-indigo-500/40 hover:text-slate-200"
                        }`}
                      >
                        {c === "OTHER" ? "Other…" : c}
                      </button>
                    ))}
                    {form.company_choice === "OTHER" && (
                      <input
                        className="input !w-48 flex-none"
                        type="text"
                        value={form.company_custom}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, company_custom: e.target.value }))
                        }
                        placeholder="COMPANY NAME"
                        style={{ textTransform: "uppercase" }}
                        autoFocus
                      />
                    )}
                  </div>
                </div>

                {/* Live summary */}
                {counts.total > 0 && (
                  <div className="flex flex-wrap gap-2 mb-4">
                    {(["20", "40", "45"] as Size[]).map((s) => (
                      <span
                        key={s}
                        className={`text-xs font-semibold px-2.5 py-1 rounded-lg border ${SIZE_STYLES[s]}`}
                      >
                        {counts[s]} × {s}'
                      </span>
                    ))}
                    <span className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-slate-600 text-slate-300 bg-slate-700/30">
                      {counts.total} total
                    </span>
                  </div>
                )}

                {form.containers.length === 0 ? (
                  <button
                    onClick={addContainer}
                    className="w-full text-center py-10 rounded-xl border border-dashed border-slate-700 text-slate-500 hover:border-indigo-500/60 hover:text-slate-300 transition-colors"
                  >
                    No containers yet — click to add the first one.
                  </button>
                ) : (
                  <div className="space-y-2.5">
                    {form.containers.map((container, index) => (
                      <div
                        key={container.id}
                        className="container-row flex flex-wrap sm:flex-nowrap items-center gap-2.5 sm:gap-3 p-2.5 rounded-xl bg-slate-900/50 border border-slate-700/70 hover:border-indigo-500/40 transition-colors"
                      >
                        <span className="grid place-items-center w-7 h-7 shrink-0 rounded-lg bg-slate-800 text-slate-400 text-xs font-mono">
                          {index + 1}
                        </span>
                        <span
                          className={`hidden md:inline-block shrink-0 text-[11px] font-mono font-semibold px-2 py-1 rounded-md border ${SIZE_STYLES[container.size]}`}
                          title="Marque (Mise à Quai)"
                        >
                          {marqueFor(container.size)}
                        </span>
                        <input
                          type="text"
                          placeholder="Container number (e.g. CMAU9753972)"
                          value={container.number}
                          onChange={(e) =>
                            updateContainer(container.id, "number", e.target.value)
                          }
                          style={upper}
                          className="flex-1 min-w-0 basis-full sm:basis-auto order-last sm:order-none bg-transparent px-1 py-1.5 font-mono text-sm text-white placeholder-slate-600 focus:outline-none"
                        />
                        <div className="seg shrink-0 ml-auto sm:ml-0" role="group" aria-label="Container size">
                          {(["20", "40", "45"] as Size[]).map((s) => (
                            <button
                              key={s}
                              type="button"
                              onClick={() => updateContainer(container.id, "size", s)}
                              className={`seg-btn ${
                                container.size === s ? `seg-active ${SIZE_ACTIVE[s]}` : ""
                              }`}
                            >
                              {s}'
                            </button>
                          ))}
                        </div>
                        <button
                          onClick={() => removeContainer(container.id)}
                          className="p-2 sm:p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-400/10 transition-colors shrink-0"
                          title="Remove"
                          aria-label="Remove container"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* DCP — تصريح باستيراد منتوج */}
              <section className="card" dir="rtl">
                <label className="flex items-center gap-3 cursor-pointer select-none">
                  <span className="relative shrink-0">
                    <input
                      type="checkbox"
                      name="dcp_enabled"
                      checked={form.dcp_enabled}
                      onChange={handleInputChange}
                      className="peer sr-only"
                    />
                    <span className="block w-10 h-6 rounded-full bg-slate-700 peer-checked:bg-indigo-500 transition-colors" />
                    <span className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-white transition-transform peer-checked:-translate-x-4" />
                  </span>
                  <span className="flex items-center gap-2.5">
                    <ScrollText size={18} className="text-indigo-400 shrink-0" />
                    <span>
                      <span className="block text-base font-bold text-white">
                        تصريح باستيراد منتوج
                      </span>
                      <span className="block text-xs text-slate-400 mt-0.5">
                        DCP — املأ الحقول وشاهد الورقة تتحدّث مباشرة على اليسار
                      </span>
                    </span>
                  </span>
                </label>

                {form.dcp_enabled && (
                  <div className="dcp-form mt-6 space-y-4">
                    {DCP_ROWS.map((row, ri) => {
                      const kbInRow = row.some(
                        (f) => f.key === kbField && f.type === "text"
                      );
                      return (
                        <div key={ri}>
                          <div
                            className={`grid gap-4 ${
                              row.length > 1
                                ? "grid-cols-1 sm:grid-cols-2"
                                : "grid-cols-1"
                            }`}
                          >
                            {row.map((f) => (
                              <DcpField
                                key={f.key}
                                def={f}
                                value={form.dcp[f.key] ?? ""}
                                dcp={form.dcp}
                                kbOpen={kbField === f.key}
                                onChange={updateDcp}
                                onToggleKb={() => toggleKb(f.key)}
                                onEscape={() => setKbField(null)}
                                setRef={(el) => {
                                  dcpInputRefs.current[f.key] = el;
                                }}
                              />
                            ))}
                          </div>
                          {kbInRow && (
                            <ArabicKeyboard
                              onKey={kbInsert}
                              onBackspace={kbBackspace}
                              onClear={kbClear}
                              onClose={() => setKbField(null)}
                            />
                          )}
                        </div>
                      );
                    })}

                    {/* Inline paper preview for narrow windows */}
                    <details className="lg:hidden rounded-xl border border-slate-700/70 bg-slate-900/50 overflow-hidden">
                      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-300 flex items-center gap-2 hover:text-white transition-colors">
                        <Eye size={15} className="text-indigo-400" />
                        معاينة الورقة (مباشر — للقراءة فقط)
                      </summary>
                      <div className="p-3 pt-0">
                        <DcpPaper dcp={form.dcp} />
                      </div>
                    </details>
                  </div>
                )}
              </section>

              {/* ملحق التعريفات الجمركية — standalone, optional, generated independently */}
              <section className="card" dir="rtl">
                <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
                  <h2 className="section-title mb-0 flex items-center gap-2">
                    <Table size={17} className="text-indigo-400" />
                    ملحق التعريفات الجمركية
                    <span className="text-[11px] font-normal text-slate-500">(اختياري)</span>
                  </h2>
                  <button onClick={addProduit} className="btn-ghost">
                    <Plus size={14} /> إضافة منتوج
                  </button>
                </div>
                <p className="text-xs text-slate-400 mb-4">
                  جدول Produit / Code HS — يُنشأ كملف مستقل عند إضافة منتوجات.
                </p>

                {form.dcp_produits.length === 0 ? (
                  <button
                    onClick={addProduit}
                    className="w-full text-center py-6 rounded-xl border border-dashed border-slate-700 text-slate-500 hover:border-indigo-500/60 hover:text-slate-300 transition-colors text-sm"
                  >
                    لا توجد منتوجات بعد — اضغط لإضافة أول منتوج (Produit / Code HS)
                  </button>
                ) : (
                  /* dir=ltr so Produit sits left and Code HS right, like the paper */
                  <div className="space-y-2.5" dir="ltr">
                    <div className="hidden sm:grid grid-cols-[minmax(0,1fr)_8.5rem_2.25rem] gap-2 px-1 text-[11px] font-semibold text-slate-500">
                      <span>Produit</span>
                      <span>Code HS</span>
                      <span />
                    </div>
                    {form.dcp_produits.map((p, index) => (
                      <div key={p.id}>
                        <div className="container-row grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_8.5rem_2.25rem] gap-2 items-center">
                          <div className="relative">
                            <input
                              ref={(el) => {
                                dcpInputRefs.current[`prod:${p.id}`] = el;
                              }}
                              type="text"
                              dir="auto"
                              className="input !pl-10"
                              placeholder={`منتوج ${index + 1} — e.g. BROSSE A CHEVEUX`}
                              value={p.produit}
                              onChange={(e) =>
                                updateProduit(p.id, "produit", e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Escape") setKbField(null);
                              }}
                            />
                            <button
                              type="button"
                              tabIndex={-1}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => toggleKb(`prod:${p.id}`)}
                              className={`kb-toggle ${
                                kbField === `prod:${p.id}` ? "kb-toggle-active" : ""
                              }`}
                              title="لوحة مفاتيح عربية"
                            >
                              <Keyboard size={15} />
                            </button>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              dir="ltr"
                              inputMode="numeric"
                              className="input font-mono text-sm flex-1 sm:flex-none sm:w-full"
                              placeholder="8516329000"
                              value={p.code}
                              onChange={(e) =>
                                updateProduit(p.id, "code", e.target.value)
                              }
                            />
                            <button
                              onClick={() => removeProduit(p.id)}
                              className="sm:hidden p-2 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-400/10 transition-colors"
                              title="حذف"
                              aria-label="حذف"
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                          <button
                            onClick={() => removeProduit(p.id)}
                            className="hidden sm:block p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-400/10 transition-colors justify-self-center"
                            title="حذف"
                            aria-label="حذف"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                        {kbField === `prod:${p.id}` && (
                          <ArabicKeyboard
                            onKey={kbInsert}
                            onBackspace={kbBackspace}
                            onClear={kbClear}
                            onClose={() => setKbField(null)}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            {/* Actions */}
            <div className="mt-8 pt-5 pb-2 border-t border-slate-800">
              {!canGenerate ? (
                <p className="text-xs text-slate-500 mb-3">
                  Every part is optional — complete any one of them to generate: transit
                  documents (names + shipping company + containers), the DCP declaration,
                  or the tariff annex.
                </p>
              ) : (
                <p className="text-xs text-slate-400 mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  {transitReady && (
                    <>
                      <span className="doc-pill">1 × Bon de Commande</span>
                      <span className="doc-pill">1 × Lettre d'Engagement</span>
                      <span className="doc-pill">{counts.total} × Mise à Quai</span>
                    </>
                  )}
                  {dcpReady && (
                    <span className="doc-pill">1 × DCP تصريح باستيراد</span>
                  )}
                  {annexReady && (
                    <span className="doc-pill">1 × ملحق التعريفات الجمركية</span>
                  )}
                  <span className="text-slate-500">
                    will be generated ({docCount} document{docCount > 1 ? "s" : ""}, ZIP download)
                  </span>
                </p>
              )}
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={generateDocuments}
                  disabled={isGenerating || !canGenerate}
                  className="btn-primary flex-1 min-h-12"
                >
                  {isGenerating ? (
                    <>
                      <Loader2 size={18} className="animate-spin" /> Generating…
                    </>
                  ) : (
                    <>
                      <FileText size={18} /> Generate documents
                    </>
                  )}
                </button>
                <button onClick={clearForm} className="btn-secondary min-h-12">
                  Clear
                </button>
              </div>
            </div>
          </div>
        </main>

        {/* Mobile drawer backdrop */}
        {historyOpen && (
          <div
            className="drawer-backdrop fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
            onClick={() => setHistoryOpen(false)}
          />
        )}

        {/* Recent Shipments sidebar — static on desktop, drawer on mobile */}
        <aside
          className={`fixed inset-y-0 right-0 z-50 w-[86vw] max-w-sm h-screen overflow-y-auto border-l border-slate-800 bg-[#0c101c]/95 backdrop-blur-md transition-transform duration-300 lg:static lg:z-auto lg:w-80 lg:shrink-0 lg:bg-slate-900/50 ${
            historyOpen ? "translate-x-0" : "translate-x-full"
          } lg:translate-x-0`}
        >
          <div className="p-5 sm:p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <History size={19} className="text-indigo-400" />
                Recent Shipments
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">{history.length}/{HISTORY_MAX}</span>
                <button
                  onClick={() => setHistoryOpen(false)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/50 lg:hidden"
                  aria-label="Close history"
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <p className="text-[11px] text-slate-500 mb-5">
              Saved locally in this browser after each successful generation. Click
              an item to refill the form.
            </p>

            {history.length === 0 ? (
              <div className="text-center py-12 px-4 rounded-xl border border-dashed border-slate-700/80 text-slate-500 text-sm">
                <FileText size={26} className="mx-auto mb-3 opacity-50" />
                No shipments yet.
                <br />
                Generate your first documents and they'll appear here.
              </div>
            ) : (
              <>
                <div className="space-y-2.5">
                  {history.map((entry) => (
                    <div key={entry.id} className="relative group">
                      <button
                        onClick={() => applyHistoryEntry(entry)}
                        className="hist-item"
                        title="Load into the form"
                      >
                        <span className="block font-semibold text-sm text-slate-100 break-words pr-7">
                          {entry.payload.transit_name ||
                            entry.payload.dcp?.["المستورد"] ||
                            "—"}
                        </span>
                        {entry.payload.client_name && (
                          <span className="block text-xs text-slate-400 mt-0.5 break-words pr-7">
                            {entry.payload.client_name}
                          </span>
                        )}
                        <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                          <span className="inline-flex items-center gap-1">
                            <Clock size={11} />
                            {fmtTimestamp(entry.savedAt)}
                          </span>
                          {entry.payload.containers.length > 0 && (
                            <span className="doc-pill !text-[10px]">
                              {entry.payload.containers.length} TC
                            </span>
                          )}
                          {entry.payload.dcp_enabled && (
                            <span className="doc-pill !text-[10px]">DCP</span>
                          )}
                          {(entry.payload.dcp_produits?.length ?? 0) > 0 && (
                            <span className="doc-pill !text-[10px]">
                              ملحق ({entry.payload.dcp_produits.length})
                            </span>
                          )}
                        </span>
                      </button>
                      <button
                        onClick={() => deleteHistoryEntry(entry.id)}
                        className="absolute top-2 right-2 p-1.5 rounded-lg text-slate-600 hover:text-rose-400 hover:bg-rose-400/10 transition-colors"
                        title="Delete from history"
                        aria-label="Delete from history"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  onClick={clearHistory}
                  className="btn-ghost w-full justify-center mt-4 !text-xs"
                >
                  <Trash2 size={13} /> Clear history
                </button>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Small presentational helpers
 * ------------------------------------------------------------------------ */

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-slate-300">
        {label}
        {required && <span className="text-indigo-400"> *</span>}
      </label>
      {children}
    </div>
  );
}

/** Shipping container icon (site colors, real container shape). */
function ContainerIcon({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={Math.round(size * 0.62)}
      viewBox="0 0 60 37"
      fill="none"
      className="text-indigo-400 shrink-0"
      aria-hidden="true"
    >
      <rect
        x="1.5"
        y="1.5"
        width="57"
        height="34"
        rx="3"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        d="M10.5 8.5v20M18.5 8.5v20M26.5 8.5v20M34.5 8.5v20M42.5 8.5v20M50.5 8.5v20"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.7"
      />
    </svg>
  );
}

/* --- DCP field with Arabic keyboard toggle -------------------------------- */
function DcpField({
  def,
  value,
  dcp,
  kbOpen,
  onChange,
  onToggleKb,
  onEscape,
  setRef,
}: {
  def: DcpFieldDef;
  value: string;
  dcp: Record<string, string>;
  kbOpen: boolean;
  onChange: (key: string, value: string) => void;
  onToggleKb: () => void;
  onEscape: () => void;
  setRef: (el: HTMLInputElement | null) => void;
}) {
  const isDate = def.type === "date";
  const isSpec = def.currency && (dcp["القيمة_عملة"] || "EUR") === "SPEC";

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    // dates: auto-mask into dd/mm/yyyy while typing (not while deleting)
    onChange(def.key, isDate && v.length > value.length ? maskDmy(v) : v);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
        {def.num && <span className="dcp-num">({def.num})</span>}
        {def.label}
      </label>
      <div className="flex items-center gap-1.5">
        {/* currency selector — far right of the box (start of the RTL row) */}
        {def.currency && (
          <>
            <select
              dir="ltr"
              className="input dcp-cur-select"
              value={dcp["القيمة_عملة"] || "EUR"}
              onChange={(e) => onChange("القيمة_عملة", e.target.value)}
              title="العملة"
            >
              {CURRENCY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="SPEC">أخرى…</option>
            </select>
            {isSpec && (
              <input
                type="text"
                dir="ltr"
                className="input dcp-cur-custom"
                placeholder="عملة"
                value={dcp["القيمة_عملة_نص"] || ""}
                onChange={(e) => onChange("القيمة_عملة_نص", e.target.value)}
              />
            )}
          </>
        )}
        {def.suffix && !def.suffixEnd && (
          <span className="unit-suffix">{def.suffix}</span>
        )}
        <div className="relative flex-1 min-w-0">
          <input
            ref={setRef}
            type="text"
            dir={isDate ? "ltr" : "auto"}
            inputMode={isDate ? "numeric" : undefined}
            maxLength={isDate ? 10 : undefined}
            className={`input ${!isDate ? "!pl-10" : ""}`}
            value={value}
            onChange={handleChange}
            onKeyDown={(e) => {
              if (e.key === "Escape") onEscape();
            }}
            placeholder={isDate ? "dd/mm/yyyy" : def.placeholder}
          />
          {!isDate && (
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onToggleKb}
              className={`kb-toggle ${kbOpen ? "kb-toggle-active" : ""}`}
              title="لوحة مفاتيح عربية"
              aria-label="لوحة مفاتيح عربية"
            >
              <Keyboard size={15} />
            </button>
          )}
        </div>
        {/* unit — far left of the box (end of the RTL row) */}
        {def.suffix && def.suffixEnd && (
          <span className="unit-suffix">{def.suffix}</span>
        )}
      </div>
    </div>
  );
}

/* --- Arabic on-screen keyboard --------------------------------------------- */
function ArabicKeyboard({
  onKey,
  onBackspace,
  onClear,
  onClose,
}: {
  onKey: (ch: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="ar-kb mt-2"
      dir="rtl"
      onMouseDown={(e) => e.preventDefault()}
    >
      {AR_KB_ROWS.map((row, i) => (
        <div key={i} className="flex flex-wrap justify-center gap-1 mb-1">
          {row.map((k) => (
            <button
              key={k}
              type="button"
              className="ar-key"
              onClick={() => onKey(k)}
            >
              {k}
            </button>
          ))}
        </div>
      ))}
      <div className="flex justify-center gap-1">
        <button type="button" className="ar-key ar-key-space" onClick={() => onKey(" ")}>
          مسافة
        </button>
        <button type="button" className="ar-key ar-key-fn" onClick={onBackspace} title="حذف">
          <Delete size={14} />
        </button>
        <button type="button" className="ar-key ar-key-fn" onClick={onClear} title="مسح الكل">
          <Eraser size={14} />
        </button>
        <button type="button" className="ar-key ar-key-fn" onClick={onClose} title="إغلاق">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

/* --- DCP live paper preview (read-only) ------------------------------------ */
function DcpPaper({ dcp }: { dcp: Record<string, string> }) {
  const val = (k: string) => (dcp[k] ?? "").trim();
  const date = (k: string) => fmtDateDMY(val(k));
  const currency = resolveCurrency(dcp);

  const F = ({ v, w }: { v: string; w?: number }) =>
    v ? (
      <span className="dcp-val" dir="auto">
        {v}
      </span>
    ) : (
      <span className="dcp-dots" style={w ? { minWidth: w } : undefined} />
    );

  return (
    <div className="dcp-paper" dir="rtl">
      {/* Header — mirrors the template's own alignment */}
      <div className="dcp-h1">الجمهورية الجزائرية الديمقراطية الشعبية</div>
      <div className="dcp-h2">وزارة التجارة</div>
      <div className="dcp-h2">مديرية التجارة لولاية عنابة</div>
      <div className="dcp-h2">مفتشية الحدود لميناء عنابة</div>
      <div className="dcp-title">تصريح باستيراد المنتوج</div>
      <div className="dcp-numline">رقم :...../ المؤرخ :....../......./..........</div>
      <div className="dcp-decree">
        المادة3 من المرسوم التنفيذي رقم05-467مؤرخ في8دي القعدة عام1426الموافق10 ديسمبر في2005
      </div>

      {/* Body */}
      <div className="dcp-body">
        <PaperLine ins="1) اللقب والاسم أو شركة المتعامل">
          (1) المستورد: <F v={val("المستورد")} />
        </PaperLine>
        <PaperLine ins="2) العنوان الحقيقي للمتعامل المعني">
          رقم وتاريخ س ت: <F v={val("رقم_س_ت")} w={40} /> بتاريخ: <F v={date("تاريخ_الاستراد")} w={40} />
        </PaperLine>
        <PaperLine ins="3) بيّن الطبيعة الحقيقية للمنتوج">
          (2) العنوان: <F v={val("العنوان")} />
        </PaperLine>
        <PaperLine ins="4) بيّن كيفية عرض المنتوج">
          (3) تعيين المنتوج: <F v={val("تعيين_المنتوج")} />
        </PaperLine>
        <PaperLine ins="5) بيّن عدد الطروز">
          (4) معروض في: <F v={val("معروض_في")} w={35} /> (5) متكون من: <F v={val("متكون_من")} w={35} />
        </PaperLine>
        <PaperLine ins="6) الكمية بالأطنان">
          (6) الكمية: <F v={val("الكمية")} w={40} /> طن (7) رقم التعريفة: انظر الملحق
        </PaperLine>
        <PaperLine ins="7) التعريفة الجمركية بـ8 أرقام القيمة">
          (8) فاتورة الشراء: <F v={val("فاتورة_الشراء")} w={35} /> (9) القيمة:{" "}
          {currency ? (
            <span className="dcp-unit" dir="ltr">
              {currency}
            </span>
          ) : null}{" "}
          <F v={val("القيمة")} w={35} />
        </PaperLine>
        <PaperLine ins="8) بيّن الرقم والتاريخ">
          بتاريخ: <F v={date("الفاتورة_تاريخ")} w={40} /> <span className="dcp-gap" />{" "}
          <span className="dcp-unit" dir="ltr">
            DA
          </span>{" "}
          <F v={val("القيمة_بالدينار")} w={45} />
        </PaperLine>
        <PaperLine ins="9) القيمة بالدينار الجزائري">
          (10) الصانع: <F v={val("الصانع")} />
        </PaperLine>
        <PaperLine ins="10) اللقب والاسم أو اسم شركة المنتج">
          (11) مكان المصدر: <F v={val("مكان_المصدر")} />
        </PaperLine>
        <PaperLine ins="11) بيّن البلد الأصلي للمنتوج أو مكان التصنيع">
          (12) رقم الحصة: <span className="dcp-dots" />
        </PaperLine>
        <PaperLine ins="12) علامة التعريف والمعلومات المتعلقة بشفرة المنتوج">
          (13) اشهاد المنتوج: ....شهادة المنشأ.... المراقبات التي تعرض لها المنتوج: شهادة المطابقة....
        </PaperLine>
        <PaperLine ins="13) مرجع الاشهاد المحتمل للمنتوج">
          (14) مرجع النقل: <F v={val("مرجع_النقل")} />
        </PaperLine>
        <PaperLine ins="14) مرجع وسائل النقل">
          (15) وثائق النقل: <F v={val("وثائق_النقل")} />
        </PaperLine>
        <PaperLine ins="15) مرجع الوثائق المرفقة للمنتوج">
          (16) الانطلاق من: <F v={val("الانطلاق_من")} w={35} /> بتاريخ: <F v={date("تاريخ_الانطلاق")} w={40} />
        </PaperLine>
        <PaperLine ins="16) بيّن المكان والتاريخ">
          (16) العبور: <F v={val("العبور")} w={35} /> (16) الوصول: <F v={val("الوصول")} w={35} />
        </PaperLine>
      </div>

      {/* Footer */}
      <div className="dcp-footer">
        <span>تأشير وختم المستورد</span>
        <span>التاريخ: &nbsp;/&nbsp;&nbsp;/&nbsp;</span>
        <span>إشعار بالاستلام لمفتشية الحدود</span>
      </div>
    </div>
  );
}

function PaperLine({
  ins,
  children,
}: {
  ins?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="dcp-line">
      <span className="dcp-ins">{ins ?? ""}</span>
      <span className="dcp-fld">{children}</span>
    </div>
  );
}

export default App;

