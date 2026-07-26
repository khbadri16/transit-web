import { Fragment, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  Copyright,
  Delete,
  Eraser,
  Eye,
  FileText,
  History,
  Keyboard,
  Loader2,
  Mail,
  Plus,
  ScrollText,
  Ship,
  Table,
  Trash2,
  X,
  Upload,
  Sparkles,
  RotateCcw,
  Zap,
  Brain,
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
  /** AI classification metadata (not sent to the backend). */
  aiConfidence?: "high" | "low";
  aiCandidates?: { code: string; label: string }[];
};

/** Exactly what is POSTed to the FastAPI backend. */
type GeneratePayload = {
  transit_name: string;
  client_name: string;
  company_name: string;
  bl_number: string; // AKKON only — printed on every AKKON Mise à Quai
  marchandise_type: string;
  weight_of_all_containers: string;
  force_uppercase: boolean;
  containers: { number: string; size: Size }[];
  /* Which transit documents to generate */
  doc_mise: boolean;
  doc_lettre: boolean;
  doc_bon: boolean;
  doc_merge: boolean; // one Word file: Mise ×2 each + Lettre ×2 + Bon
  dcp_enabled: boolean;
  dcp: Record<string, string>;
  dcp_produits: { produit: string; code: string }[];
  /* Mandat MSC — client_name / transit_name are reused from the fields above */
  mandat_enabled: boolean;
  mandat: MandatFields;
};

/** Contact block of the Mandat MSC letter (both columns of its table). */
type MandatFields = {
  client_username: string;
  client_email: string;
  client_address: string;
  client_phone: string;
  transit_username: string;
  transit_email: string;
  transit_address: string;
  transit_phone: string;
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
  /** "rc" = registre de commerce composite (nn/nn-nnnnnnn + letter + nn) */
  type: "text" | "date" | "rc";
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
    { key: "رقم_س_ت", label: "رقم السجل التجاري (س ت)", type: "rc" },
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
    { key: "فاتورة_الشراء", num: "8", label: "رقم فاتورة الشراء", type: "text" },
    { key: "القيمة", num: "9", label: "القيمة", type: "text", currency: true },
  ],
  [
    { key: "القيمة_بالدينار", num: "9", label: "القيمة بالدينار", type: "text", suffix: "DA" },
    { key: "الفاتورة_تاريخ", label: "تاريخ الفاتورة", type: "date" },
  ],
  [{ key: "الصانع", num: "10", label: "الصانع", type: "text" }],
  [{ key: "مكان_المصدر", num: "11", label: "مكان المصدر", type: "text" }],
  /* The placeholder in DCP.docx stays مرجع_النقل — only the label changed. */
  [{ key: "مرجع_النقل", num: "14", label: "شركة النقل", type: "text" }],
  [{ key: "وثائق_النقل", num: "15", label: "رقم ال BL", type: "text" }],
  [
    { key: "الانطلاق_من", num: "16", label: "الانطلاق من", type: "text" },
    { key: "تاريخ_الانطلاق", label: "تاريخ الانطلاق", type: "date" },
  ],
  /* العبور / الوصول are now static text inside DCP.docx — no form fields. */
];

const DCP_ALL_FIELDS = DCP_ROWS.flat();

/* رقم السجل التجاري — fixed format, entered left-to-right:
 *   nn / nn - nnnnnnn [arabic letter] nn      e.g. 19/00-1163066ب23
 * Stored as 5 separate dcp keys. The document renders it as an inline image
 * (drawn left-to-right, immune to bidi); the preview uses isolated spans. */
const RC_PARTS = [
  { key: "رقم_س_ت_1", max: 2, ph: "19", w: "w-14" },
  { key: "رقم_س_ت_2", max: 2, ph: "00", w: "w-14" },
  { key: "رقم_س_ت_3", max: 7, ph: "1163066", w: "w-24" },
  { key: "رقم_س_ت_حرف", max: 1, ph: "ب", w: "w-11" },
  { key: "رقم_س_ت_4", max: 2, ph: "23", w: "w-14" },
] as const;
const RC_LETTER_KEY = "رقم_س_ت_حرف";

/** The 5 س ت parts, trimmed, in typing order ("" placeholders when empty). */
const rcParts = (dcp: Record<string, string>) =>
  RC_PARTS.map((p) => (dcp[p.key] ?? "").trim());

const initialDcp: Record<string, string> = {
  ...Object.fromEntries(DCP_ALL_FIELDS.map((f) => [f.key, ""])),
  ...Object.fromEntries(RC_PARTS.map((p) => [p.key, ""])),
  [RC_LETTER_KEY]: "ب", // most common letter — editable
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

/* --------------------------------------------------------------------------
 * Mandat MSC (autorisation aux mandataires)
 * ------------------------------------------------------------------------ */

/** The transitaire side rarely changes — prefilled, still editable. */
const initialMandat: MandatFields = {
  client_username: "",
  client_email: "",
  client_address: "",
  client_phone: "",
  transit_username: "Belarbi Tayeb",
  transit_email: "transittayeb@gmail.com",
  transit_address: "",
  transit_phone: "+213 675714539",
};

const MANDAT_ROWS: {
  label: string;
  client: keyof MandatFields;
  transit: keyof MandatFields;
  type?: "email" | "tel";
  placeholder?: string;
}[] = [
  { label: "Personne à contacter", client: "client_username", transit: "transit_username", placeholder: "e.g. M. Benali" },
  { label: "Email", client: "client_email", transit: "transit_email", type: "email", placeholder: "e.g. contact@societe.dz" },
  { label: "Adresse postale", client: "client_address", transit: "transit_address", placeholder: "e.g. 12 Rue X, Alger" },
  { label: "Téléphone", client: "client_phone", transit: "transit_phone", type: "tel", placeholder: "e.g. +213 21 00 00 00" },
];

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
  bl_number: string; // shown + used only when the resolved company is AKKON
  marchandise_type: string;
  weight_of_all_containers: string;
  force_uppercase: boolean;
  containers: Container[];
  doc_mise: boolean;
  doc_lettre: boolean;
  doc_bon: boolean;
  doc_merge: boolean;
  dcp_enabled: boolean;
  dcp: Record<string, string>;
  dcp_produits: DcpProduit[];
  mandat_enabled: boolean;
  mandat: MandatFields;
};

const initialForm: FormState = {
  transit_name: "",
  client_name: "",
  company_choice: "",
  company_custom: "",
  bl_number: "",
  marchandise_type: "",
  weight_of_all_containers: "",
  force_uppercase: true,
  containers: [],
  doc_mise: true,
  doc_lettre: true,
  doc_bon: true,
  doc_merge: false,
  dcp_enabled: false,
  dcp: { ...initialDcp },
  dcp_produits: [],
  mandat_enabled: false,
  mandat: { ...initialMandat },
};

function App() {
  const [form, setForm] = useState<FormState>({
    ...initialForm,
    dcp: { ...initialDcp },
    mandat: { ...initialMandat },
  });
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [historyOpen, setHistoryOpen] = useState(false); // mobile drawer
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  /** Which DCP field currently shows the Arabic keyboard (by key). */
  const [kbField, setKbField] = useState<string | null>(null);
  /** Live DCP paper collapsed with the << button (desktop). */
  const [paperCollapsed, setPaperCollapsed] = useState(false);
  /** Live DCP paper slid in as a drawer (phones only). */
  const [mobilePaperOpen, setMobilePaperOpen] = useState(false);
  const dcpInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  /* AI tariff classification */
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [invoicePreview, setInvoicePreview] = useState<string | null>(null);
  const [classifyMode, setClassifyMode] = useState<"pro" | "normal">("pro");
  const [isClassifying, setIsClassifying] = useState(false);
  const [classifyError, setClassifyError] = useState<string | null>(null);

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

  /** At least one transit document type must be selected. */
  const anyDocSelected =
    form.doc_mise || form.doc_lettre || form.doc_bon || form.doc_merge;

  const transitFieldsReady =
    form.transit_name.trim() !== "" &&
    form.client_name.trim() !== "" &&
    companyName !== "" &&
    form.containers.length > 0 &&
    form.containers.every((c) => c.number.trim() !== "");
  const transitReady = transitFieldsReady && anyDocSelected;
  const dcpReady = form.dcp_enabled;
  const annexReady = form.dcp_produits.some(
    (p) => p.produit.trim() !== "" || p.code.trim() !== ""
  );
  /* The Mandat reuses the two names from Global details — nothing else from
     the transit part, so it can be generated without any container. */
  const mandatReady =
    form.mandat_enabled &&
    form.transit_name.trim() !== "" &&
    form.client_name.trim() !== "";
  const canGenerate = transitReady || dcpReady || annexReady || mandatReady;
  const docCount =
    (transitReady
      ? (form.doc_mise ? counts.total : 0) +
        (form.doc_lettre ? 1 : 0) +
        (form.doc_bon ? 1 : 0) +
        (form.doc_merge ? 1 : 0)
      : 0) +
    (dcpReady ? 1 : 0) +
    (annexReady ? 1 : 0) +
    (mandatReady ? 1 : 0);

  /** The live DCP paper: available on large screens while DCP is enabled. */
  const paperAvailable = form.dcp_enabled;
  const showPaper = paperAvailable && !paperCollapsed;

  /** Opens Gmail's compose page (works in any browser, no mail app needed). */
  const bugReportSubject = "Bug Report - Transit Document Generator";
  const bugReportHref =
    "https://mail.google.com/mail/?view=cm&fs=1&to=kh.badri16@gmail.com&su=" +
    encodeURIComponent(bugReportSubject);

  const flash = (message: string, type: Toast["type"]) => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 3200);
  };

  /* --- field handlers ----------------------------------------------------- */

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    if (name === "dcp_enabled" && !checked) {
      setKbField(null);
      setMobilePaperOpen(false);
    }
    setForm((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));
  };

  /* --- DCP handlers ------------------------------------------------------- */

  const updateDcp = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, dcp: { ...prev.dcp, [key]: value } }));
  };

  /* --- Mandat MSC handlers ------------------------------------------------ */

  const updateMandat = (key: keyof MandatFields, value: string) => {
    setForm((prev) => ({ ...prev, mandat: { ...prev.mandat, [key]: value } }));
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
    } else if (key === RC_LETTER_KEY) {
      // the س ت letter box holds exactly one Arabic letter
      updateDcp(key, value.replace(/[\d\s]/g, "").slice(-1));
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

  /* --- AI tariff classification ------------------------------------------------ */

  const handleInvoiceSelect = (file: File | null) => {
    setClassifyError(null);
    if (!file) {
      setInvoiceFile(null);
      setInvoicePreview(null);
      return;
    }
    // Validate type
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.type)) {
      setClassifyError("صيغة غير مدعومة. الصيغ المقبولة: JPEG, PNG, WebP");
      return;
    }
    // Validate size (10MB)
    if (file.size > 10 * 1024 * 1024) {
      setClassifyError("حجم الملف يتجاوز 10MB");
      return;
    }
    setInvoiceFile(file);
    // Create preview URL
    const url = URL.createObjectURL(file);
    setInvoicePreview(url);
  };

  const handleInvoiceDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files?.[0];
    if (file) handleInvoiceSelect(file);
  };

  const removeInvoice = () => {
    if (invoicePreview) URL.revokeObjectURL(invoicePreview);
    setInvoiceFile(null);
    setInvoicePreview(null);
    setClassifyError(null);
  };

  const classifyInvoice = async () => {
    if (!invoiceFile || isClassifying) return;
    setIsClassifying(true);
    setClassifyError(null);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 305000); // just above the 300s server maxDuration

    try {
      const formData = new FormData();
      formData.append("invoice", invoiceFile);
      formData.append("mode", classifyMode);

      const res = await fetch(`${API_URL}/api/classify-tariff`, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      if (!res.ok) {
        let message = `خطأ في الخادم (HTTP ${res.status})`;
        try {
          const data = await res.json();
          if (data?.detail) {
            message = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
          }
        } catch { /* non-JSON error body */ }
        throw new Error(message);
      }

      const data = await res.json();
      const products: DcpProduit[] = (data.products || []).map(
        (p: {
          product?: string;
          codeHS?: string;
          confidence?: "high" | "low";
          candidates?: { code: string; label: string }[];
        }) => ({
          id: crypto.randomUUID(),
          produit: (p.product || "").trim(),
          code: (p.codeHS || "").trim(),
          aiConfidence: p.confidence,
          aiCandidates: p.candidates?.length ? p.candidates : undefined,
        })
      );

      if (products.length === 0) {
        throw new Error("لم يتم استخراج أي منتوج من الفاتورة. تأكد من وضوح الصورة.");
      }

      // Replace existing products with AI results
      setForm((prev) => ({ ...prev, dcp_produits: products }));
      flash(`تم استخراج ${products.length} منتوج بنجاح.`, "success");
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === "AbortError"
          ? "انتهت مهلة الطلب (5 دقائق). حاول مرة أخرى."
          : err instanceof TypeError
            ? "تعذر الاتصال بالخادم. تأكد من تشغيل الخادم المحلي."
            : err instanceof Error
              ? err.message
              : "حدث خطأ غير متوقع.";
      setClassifyError(message);
      flash("فشل تصنيف الفاتورة.", "error");
    } finally {
      clearTimeout(timeout);
      setIsClassifying(false);
    }
  };

  const clearForm = () => {
    setForm({
      ...initialForm,
      dcp: { ...initialDcp },
      dcp_produits: [],
      mandat: { ...initialMandat },
    });
    setError(null);
    setKbField(null);
    // AI state
    removeInvoice();
    setClassifyError(null);
    setIsClassifying(false);
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
      bl_number: p.bl_number ?? "",
      marchandise_type: p.marchandise_type ?? "",
      weight_of_all_containers: p.weight_of_all_containers ?? "",
      force_uppercase: p.force_uppercase ?? true,
      containers: (p.containers ?? []).map((c) => ({
        id: crypto.randomUUID(),
        number: c.number,
        size: c.size,
      })),
      doc_mise: p.doc_mise ?? true,
      doc_lettre: p.doc_lettre ?? true,
      doc_bon: p.doc_bon ?? true,
      doc_merge: p.doc_merge ?? false,
      dcp_enabled: p.dcp_enabled ?? false,
      dcp: { ...initialDcp, ...(p.dcp ?? {}) },
      dcp_produits: (p.dcp_produits ?? []).map((pr) => ({
        id: crypto.randomUUID(),
        produit: pr.produit ?? "",
        code: pr.code ?? "",
      })),
      mandat_enabled: p.mandat_enabled ?? false,
      mandat: { ...initialMandat, ...(p.mandat ?? {}) },
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
      bl_number: companyName === "AKKON" ? form.bl_number.trim() : "",
      marchandise_type: form.marchandise_type.trim(),
      weight_of_all_containers: form.weight_of_all_containers.trim(),
      force_uppercase: form.force_uppercase,
      containers: form.containers.map((c) => ({
        number: c.number.trim(),
        size: c.size,
      })),
      doc_mise: form.doc_mise,
      doc_lettre: form.doc_lettre,
      doc_bon: form.doc_bon,
      doc_merge: form.doc_merge,
      dcp_enabled: form.dcp_enabled,
      dcp: { ...form.dcp },
      dcp_produits: form.dcp_produits.map((p) => ({
        produit: p.produit,
        code: p.code,
      })),
      mandat_enabled: form.mandat_enabled,
      mandat: { ...form.mandat },
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

        {/* Re-open button when the paper is hidden (desktop) */}
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

        {/* Phones: >> tab on the left edge slides the paper in */}
        {paperAvailable && !mobilePaperOpen && (
          <button
            onClick={() => setMobilePaperOpen(true)}
            className="paper-reopen flex lg:hidden"
            title="إظهار المعاينة"
            aria-label="إظهار المعاينة"
          >
            <ChevronsRight size={16} />
            <span className="paper-reopen-label">معاينة</span>
          </button>
        )}

        {/* Phones: backdrop while the paper drawer is open */}
        {paperAvailable && mobilePaperOpen && (
          <div
            className="drawer-backdrop fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
            onClick={() => setMobilePaperOpen(false)}
          />
        )}

        {/* Phones: the DCP paper as a left drawer over the form */}
        <aside
          className={`fixed inset-y-0 left-0 z-50 w-[92vw] max-w-md flex flex-col border-r border-slate-800 bg-[#0c101c]/95 backdrop-blur-md transition-transform duration-300 lg:hidden ${
            paperAvailable && mobilePaperOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="px-4 pt-4 pb-3 flex items-center justify-between gap-2" dir="rtl">
            <h2 className="text-sm font-bold text-white flex items-center gap-2 min-w-0">
              <Eye size={16} className="text-indigo-400 shrink-0" />
              معاينة مباشرة — تصريح باستيراد المنتوج
            </h2>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[10px] text-slate-500 border border-slate-700 rounded-full px-2 py-0.5">
                للقراءة فقط
              </span>
              <button
                onClick={() => setMobilePaperOpen(false)}
                className="paper-toggle"
                title="إخفاء المعاينة"
                aria-label="إخفاء المعاينة"
              >
                <ChevronsLeft size={16} />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-6">
            <DcpPaper dcp={form.dcp} />
          </div>
        </aside>

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

                  {/* BL number — only for AKKON; printed on every AKKON Mise à Quai */}
                  {companyName === "AKKON" && (
                    <div className="mt-3">
                      <label className="text-sm font-medium text-slate-300">
                        BL number
                        <span className="text-xs text-slate-500 font-normal">
                          {" "}— optional, printed on every AKKON Mise à Quai
                        </span>
                      </label>
                      <input
                        className="input mt-2 !w-64 max-w-full block"
                        type="text"
                        value={form.bl_number}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, bl_number: e.target.value }))
                        }
                        placeholder="BL NUMBER"
                        style={{ textTransform: "uppercase" }}
                      />
                    </div>
                  )}
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

                {/* Documents to generate — selection drives the ZIP content */}
                <div className="mt-6 pt-5 border-t border-slate-800">
                  <h3 className="text-sm font-semibold text-slate-300 mb-1 flex items-center gap-2">
                    <FileText size={15} className="text-indigo-400" />
                    Documents to generate
                  </h3>
                  <p className="text-xs text-slate-500 mb-3">
                    Lettre d'Engagement is always ×2 copies, and each Mise à Quai
                    ×2 copies (second page in the same file).
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {(
                      [
                        {
                          key: "doc_mise",
                          label: "MISE A QUAI L",
                          hint: "one file per container — ×2 copies each",
                        },
                        {
                          key: "doc_lettre",
                          label: "LETTRE D'ENGAGEMENT",
                          hint: "×2 copies",
                        },
                        {
                          key: "doc_bon",
                          label: "BON DE COMMANDE",
                          hint: "1 copy",
                        },
                        {
                          key: "doc_merge",
                          label: "Merge everything",
                          hint: "one Word file: Mise ×2 + Lettre ×2 + Bon",
                        },
                      ] as const
                    ).map((opt) => (
                      <label
                        key={opt.key}
                        className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer select-none transition-colors ${
                          form[opt.key]
                            ? "bg-indigo-500/10 border-indigo-500/50"
                            : "bg-slate-900/50 border-slate-700/70 hover:border-indigo-500/40"
                        }`}
                      >
                        <input
                          type="checkbox"
                          name={opt.key}
                          checked={form[opt.key]}
                          onChange={handleInputChange}
                          className="mt-0.5 w-4 h-4 shrink-0 accent-indigo-500"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-slate-200">
                            {opt.label}
                          </span>
                          <span className="block text-[11px] text-slate-500">
                            {opt.hint}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {transitFieldsReady && !anyDocSelected && (
                    <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-300">
                      <AlertTriangle size={13} className="shrink-0" />
                      Select at least one document to generate.
                    </p>
                  )}
                </div>
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
                        (f) =>
                          (f.key === kbField && f.type === "text") ||
                          (f.type === "rc" && kbField === RC_LETTER_KEY)
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
                            {row.map((f) =>
                              f.type === "rc" ? (
                                <RcField
                                  key={f.key}
                                  def={f}
                                  dcp={form.dcp}
                                  kbOpen={kbField === RC_LETTER_KEY}
                                  onChange={updateDcp}
                                  onToggleKb={() => toggleKb(RC_LETTER_KEY)}
                                  onEscape={() => setKbField(null)}
                                  setLetterRef={(el) => {
                                    dcpInputRefs.current[RC_LETTER_KEY] = el;
                                  }}
                                />
                              ) : (
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
                              )
                            )}
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

                {/* AI Invoice Classification */}
                <div className="mb-5 p-4 rounded-xl border border-dashed border-slate-700 bg-slate-900/30">
                  <div className="flex items-center gap-2 mb-3">
                    <Sparkles size={16} className="text-amber-400" />
                    <span className="text-sm font-semibold text-white">تصنيف تلقائي بالذكاء الاصطناعي</span>
                  </div>

                  {!invoiceFile ? (
                    <div
                      className="invoice-upload-zone"
                      onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("invoice-upload-zone-active"); }}
                      onDragLeave={(e) => { e.currentTarget.classList.remove("invoice-upload-zone-active"); }}
                      onDrop={(e) => { e.currentTarget.classList.remove("invoice-upload-zone-active"); handleInvoiceDrop(e); }}
                      onClick={() => document.getElementById("invoice-file-input")?.click()}
                    >
                      <Upload size={28} className="text-slate-500 mx-auto mb-2" />
                      <p className="text-sm text-slate-400 text-center">
                        اسحب صورة الفاتورة هنا أو <span className="text-indigo-400 font-medium">تصفح</span>
                      </p>
                      <p className="text-xs text-slate-600 text-center mt-1">JPEG, PNG, WebP — حد أقصى 10MB</p>
                      <input
                        id="invoice-file-input"
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="hidden"
                        onChange={(e) => handleInvoiceSelect(e.target.files?.[0] || null)}
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-800/60 border border-slate-700">
                      {invoicePreview && (
                        <img
                          src={invoicePreview}
                          alt="Invoice preview"
                          className="w-14 h-14 object-cover rounded-lg border border-slate-600"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white font-medium truncate">{invoiceFile.name}</p>
                        <p className="text-xs text-slate-500">{(invoiceFile.size / 1024).toFixed(0)} KB</p>
                      </div>
                      <button
                        onClick={removeInvoice}
                        className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-400/10 transition-colors"
                        title="إزالة"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  )}

                  {/* Mode toggle + Start button */}
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mt-3">
                    <div className="seg">
                      <button
                        type="button"
                        className={`seg-btn ${classifyMode === "pro" ? "seg-active seg-active-violet" : ""}`}
                        onClick={() => setClassifyMode("pro")}
                      >
                        <Brain size={13} className="inline -mt-px ml-1" /> Pro
                      </button>
                      <button
                        type="button"
                        className={`seg-btn ${classifyMode === "normal" ? "seg-active seg-active-sky" : ""}`}
                        onClick={() => setClassifyMode("normal")}
                      >
                        <Zap size={13} className="inline -mt-px ml-1" /> سريع
                      </button>
                    </div>
                    <button
                      onClick={classifyInvoice}
                      disabled={!invoiceFile || isClassifying}
                      className="btn-primary flex-1 sm:flex-none !py-2 !px-5 !text-sm"
                    >
                      {isClassifying ? (
                        <>
                          <Loader2 size={16} className="animate-spin" />
                          <span>جاري التحليل… قد يستغرق حتى 60 ثانية</span>
                        </>
                      ) : (
                        <>
                          <Sparkles size={16} />
                          <span>بدء التصنيف</span>
                        </>
                      )}
                    </button>
                  </div>

                  {/* Classification error */}
                  {classifyError && (
                    <div className="mt-3 flex items-start gap-2 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">
                      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                      <span className="flex-1">{classifyError}</span>
                      <button
                        onClick={classifyInvoice}
                        className="shrink-0 inline-flex items-center gap-1 text-xs font-medium text-rose-200 hover:text-white transition-colors"
                      >
                        <RotateCcw size={12} /> إعادة
                      </button>
                    </div>
                  )}
                </div>

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

              {/* Mandat MSC — autorisation aux mandataires */}
              <section className="card">
                <label className="flex items-center gap-3 cursor-pointer select-none">
                  <span className="relative shrink-0">
                    <input
                      type="checkbox"
                      name="mandat_enabled"
                      checked={form.mandat_enabled}
                      onChange={handleInputChange}
                      className="peer sr-only"
                    />
                    <span className="block w-10 h-6 rounded-full bg-slate-700 peer-checked:bg-indigo-500 transition-colors" />
                    <span className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
                  </span>
                  <span className="flex items-center gap-2.5">
                    <ScrollText size={18} className="text-indigo-400 shrink-0" />
                    <span>
                      <span className="block text-base font-bold text-white">
                        Mandat MSC
                      </span>
                      <span className="block text-xs text-slate-400 mt-0.5">
                        Autorisation aux mandataires — lettre datée du jour
                      </span>
                    </span>
                  </span>
                </label>

                {form.mandat_enabled && (
                  <div className="mt-6">
                    {!mandatReady && (
                      <p className="mb-4 flex items-start gap-2 text-xs text-amber-300/90 p-3 rounded-lg bg-amber-400/10 border border-amber-400/30">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                        <span>
                          Fill <strong>Transit name</strong> and{" "}
                          <strong>Client name</strong> in “Global details” above — the
                          Mandat reuses them.
                        </span>
                      </p>
                    )}

                    {/* Column headers mirroring the letter's contact table */}
                    <div className="hidden sm:grid grid-cols-[9rem_1fr_1fr] gap-3 mb-2 px-1">
                      <span />
                      <span className="text-[11px] font-bold uppercase tracking-wide text-indigo-300">
                        Entreprise (client)
                      </span>
                      <span className="text-[11px] font-bold uppercase tracking-wide text-indigo-300">
                        Transitaire (mandataire)
                      </span>
                    </div>

                    {/* Names come from Global details — shown read-only for context */}
                    <div className="grid grid-cols-1 sm:grid-cols-[9rem_1fr_1fr] gap-3 items-center mb-3">
                      <span className="text-xs font-medium text-slate-400 sm:text-right sm:pr-1">
                        Nom
                      </span>
                      <input
                        className="input opacity-60 cursor-not-allowed"
                        value={form.client_name}
                        readOnly
                        placeholder="— from Global details"
                        style={upper}
                        aria-label="Nom de l'entreprise (from Global details)"
                      />
                      <input
                        className="input opacity-60 cursor-not-allowed"
                        value={
                          form.transit_name.trim()
                            ? `TRANSIT ${form.transit_name
                                .trim()
                                .replace(/^\s*transit[\s:,-]+/i, "")}`
                            : ""
                        }
                        readOnly
                        placeholder="— from Global details"
                        style={upper}
                        aria-label="Nom du transitaire (from Global details)"
                      />
                    </div>

                    {MANDAT_ROWS.map((row) => (
                      <div
                        key={row.label}
                        className="grid grid-cols-1 sm:grid-cols-[9rem_1fr_1fr] gap-3 items-center mb-3"
                      >
                        <span className="text-xs font-medium text-slate-400 sm:text-right sm:pr-1">
                          {row.label}
                        </span>
                        <input
                          className="input"
                          type={row.type ?? "text"}
                          value={form.mandat[row.client]}
                          onChange={(e) => updateMandat(row.client, e.target.value)}
                          placeholder={row.placeholder}
                          aria-label={`${row.label} — entreprise`}
                        />
                        <input
                          className="input"
                          type={row.type ?? "text"}
                          value={form.mandat[row.transit]}
                          onChange={(e) => updateMandat(row.transit, e.target.value)}
                          placeholder={row.placeholder}
                          aria-label={`${row.label} — transitaire`}
                        />
                      </div>
                    ))}

                    <p className="mt-4 text-xs text-slate-500">
                      Blank fields are simply left empty in the letter. The DPO address
                      in §6 uses the entreprise email.
                    </p>
                  </div>
                )}
              </section>
            </div>

            {/* Actions */}
            <div className="mt-8 pt-5 pb-2 border-t border-slate-800">
              {!canGenerate ? (
                <p className="text-xs text-slate-500 mb-3">
                  Every part is optional — complete any one of them to generate: transit
                  documents (names + shipping company + containers + at least one
                  document type), the DCP declaration, the tariff annex, or the
                  Mandat MSC (transit + client name).
                </p>
              ) : (
                <p className="text-xs text-slate-400 mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  {transitReady && (
                    <>
                      {form.doc_bon && (
                        <span className="doc-pill">1 × Bon de Commande</span>
                      )}
                      {form.doc_lettre && (
                        <span className="doc-pill">1 × Lettre d'Engagement (×2)</span>
                      )}
                      {form.doc_mise && (
                        <span className="doc-pill">
                          {counts.total} × Mise à Quai (×2)
                        </span>
                      )}
                      {form.doc_merge && (
                        <span className="doc-pill">
                          1 × Merged file (Mise + Lettre + Bon)
                        </span>
                      )}
                    </>
                  )}
                  {dcpReady && (
                    <span className="doc-pill">1 × DCP تصريح باستيراد</span>
                  )}
                  {annexReady && (
                    <span className="doc-pill">1 × ملحق التعريفات الجمركية</span>
                  )}
                  {mandatReady && <span className="doc-pill">1 × Mandat MSC</span>}
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

            {/* Footer — copyright + report a bug (far bottom) */}
            <footer className="mt-auto pt-8 flex flex-col-reverse sm:flex-row items-center justify-between gap-3 border-t border-slate-800/60">
              <p className="flex items-center gap-1.5 text-xs text-slate-500 text-center">
                <Copyright size={13} className="shrink-0" />
                <span>
                  {new Date().getFullYear()} Kh Badereddine. All rights reserved.
                </span>
              </p>
              <a
                href={bugReportHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-slate-400 border border-slate-700/70 bg-slate-800/40 transition-colors hover:text-white hover:border-indigo-500/50 hover:bg-indigo-500/10"
                title="Report a bug"
                aria-label="Report a bug by email"
              >
                <Mail size={14} className="shrink-0" />
                <span>Report a bug</span>
              </a>
            </footer>
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
                          {entry.payload.mandat_enabled && (
                            <span className="doc-pill !text-[10px]">Mandat</span>
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

/* --- رقم السجل التجاري composite field (nn/nn-nnnnnnn + letter + nn) -------- */
function RcField({
  def,
  dcp,
  kbOpen,
  onChange,
  onToggleKb,
  onEscape,
  setLetterRef,
}: {
  def: DcpFieldDef;
  dcp: Record<string, string>;
  kbOpen: boolean;
  onChange: (key: string, value: string) => void;
  onToggleKb: () => void;
  onEscape: () => void;
  setLetterRef: (el: HTMLInputElement | null) => void;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const focusNext = (i: number) => {
    let j = i + 1;
    // the letter is usually pre-filled with ب — skip it while typing digits
    if (RC_PARTS[j]?.key === RC_LETTER_KEY && (dcp[RC_LETTER_KEY] ?? "").trim()) {
      j += 1;
    }
    refs.current[j]?.focus();
  };

  const handlePart = (i: number, rawVal: string) => {
    const part = RC_PARTS[i];
    const v =
      part.key === RC_LETTER_KEY
        ? rawVal.replace(/[\d\s]/g, "").slice(-1) // one letter, new one replaces
        : rawVal.replace(/\D/g, "").slice(0, part.max);
    onChange(part.key, v);
    if (part.key !== RC_LETTER_KEY && v.length >= part.max) focusNext(i);
    if (part.key === RC_LETTER_KEY && v) focusNext(i);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-slate-300">
        {def.label}
        <span className="text-xs text-slate-500 font-normal"> — يُكتب من اليسار إلى اليمين</span>
      </label>
      {/* left-to-right so the visual order matches the typing order */}
      <div className="flex flex-wrap items-center gap-1" dir="ltr">
        {RC_PARTS.map((part, i) => (
          <Fragment key={part.key}>
            <input
              ref={(el) => {
                refs.current[i] = el;
                if (part.key === RC_LETTER_KEY) setLetterRef(el);
              }}
              type="text"
              dir={part.key === RC_LETTER_KEY ? "rtl" : "ltr"}
              inputMode={part.key === RC_LETTER_KEY ? undefined : "numeric"}
              className={`input ${part.w} flex-none !px-1.5 text-center font-mono text-sm`}
              value={dcp[part.key] ?? ""}
              placeholder={part.ph}
              onChange={(e) => handlePart(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onEscape();
                if (
                  e.key === "Backspace" &&
                  !(dcp[part.key] ?? "") &&
                  i > 0
                ) {
                  refs.current[i - 1]?.focus();
                }
              }}
              title={part.key === RC_LETTER_KEY ? "الحرف العربي" : undefined}
            />
            {i === 0 && <span className="text-slate-400 font-bold select-none">/</span>}
            {i === 1 && <span className="text-slate-400 font-bold select-none">-</span>}
          </Fragment>
        ))}
        {/* Arabic keyboard for the letter box */}
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleKb}
          className={`p-1.5 rounded-lg transition-colors ${
            kbOpen
              ? "text-indigo-300 bg-indigo-500/15"
              : "text-slate-500 hover:text-indigo-300 hover:bg-indigo-500/15"
          }`}
          title="لوحة مفاتيح عربية (للحرف)"
          aria-label="لوحة مفاتيح عربية للحرف"
        >
          <Keyboard size={15} />
        </button>
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

/** س ت value in the live paper: direction-isolated segments laid out
 *  left-to-right — mirrors the inline image of the generated document. */
function RcValue({ dcp }: { dcp: Record<string, string> }) {
  const [p1, p2, p3, letter, p4] = rcParts(dcp);
  if (!(p1 || p2 || p3 || p4)) {
    const legacy = (dcp["رقم_س_ت"] ?? "").trim();
    return legacy ? (
      <span className="dcp-val" dir="auto">
        {legacy}
      </span>
    ) : (
      <span className="dcp-dots" style={{ minWidth: 40 }} />
    );
  }
  const iso: React.CSSProperties = { unicodeBidi: "isolate", direction: "ltr" };
  return (
    <span className="dcp-val" dir="ltr" style={{ unicodeBidi: "isolate" }}>
      <span style={iso}>
        {p1}/{p2}-{p3}
      </span>
      <span style={iso}>{letter}</span>
      <span style={iso}>{p4}</span>
    </span>
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
          رقم وتاريخ س ت: <RcValue dcp={dcp} /> بتاريخ: <F v={date("تاريخ_الاستراد")} w={40} />
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
          {val("القيمة_بالدينار") ? (
            <span className="dcp-val" dir="ltr">
              {val("القيمة_بالدينار")} DA
            </span>
          ) : (
            <>
              <span className="dcp-dots" style={{ minWidth: 45 }} />{" "}
              <span className="dcp-unit" dir="ltr">
                DA
              </span>
            </>
          )}
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
          (14) شركة النقل: <F v={val("مرجع_النقل")} />
        </PaperLine>
        <PaperLine ins="14) مرجع وسائل النقل">
          (15) وثائق النقل: <F v={val("وثائق_النقل")} />
        </PaperLine>
        <PaperLine ins="15) مرجع الوثائق المرفقة للمنتوج">
          (16) الانطلاق من: <F v={val("الانطلاق_من")} w={35} /> بتاريخ: <F v={date("تاريخ_الانطلاق")} w={40} />
        </PaperLine>
        {/* العبور / الوصول are static text in the template — shown as fixed dots */}
        <PaperLine ins="16) بيّن المكان والتاريخ">
          (16) العبور: <span className="dcp-dots" style={{ minWidth: 35 }} /> (16)
          الوصول: <span className="dcp-dots" style={{ minWidth: 35 }} />
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

