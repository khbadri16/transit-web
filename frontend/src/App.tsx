import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ArabicKeyboard } from "./ArabicKeyboard";
import { DcpClientBook, rememberDcpClient } from "./DcpClientBook";
import FolderCover from "./FolderCover";
import { SIZE_ACTIVE, SIZE_STYLES, marqueFor, type Size } from "./containerSizes";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copyright,
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
  Send,
  Receipt,
  Lock,
  KeyRound,
} from "lucide-react";

/* --------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------ */

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
  /* Mandat MSC — has its own entreprise / transitaire names (mandat.client_name / mandat.transit_name) */
  mandat_enabled: boolean;
  mandat: MandatFields;
  /* Facture de transit — completely independent from everything above */
  facture_enabled: boolean;
  facture: FacturePayload;
};

/* ---- Facture de transit -------------------------------------------------- */

/** The single merchandise line (POID BRUT is typed without "KG"). */
type FactureLigne = {
  marque: string;
  designation: string;
  nbrs: string;
  poids: string;
};

/** One line of the invoice table. */
type FactureRow = {
  debours: string;
  produit: string;
  observation: string;
};

/** A line the user adds on top of the nine fixed libellés. */
type FactureExtra = FactureRow & { id: string; libelle: string };

/** The nine fixed libellés, in printing order. */
/** Body rows — user-added extras appear after these. */
const FACTURE_BODY_KEYS = [
  "echange", "magasinage", "dechargement", "restitution", "surestaries",
] as const;
/** Footer rows — always last in the table. */
const FACTURE_FOOTER_KEYS = [
  "ouverture", "honnoraire", "tva", "timbre",
] as const;
const FACTURE_KEYS = [...FACTURE_BODY_KEYS, ...FACTURE_FOOTER_KEYS] as const;
type FactureKey = (typeof FACTURE_KEYS)[number];

const FACTURE_LABELS: Record<FactureKey, string> = {
  echange: "ECHANGE",
  magasinage: "MAGASINAGE",
  dechargement: "DECHARGEMENT",
  restitution: "RESTITUSION TC",
  surestaries: "SURESTARIES",
  ouverture: "OUVERTURE DOSSIER",
  honnoraire: "HONNORAIRE",
  tva: "TVA 9%",
  timbre: "TIMBRE",
};

type FactureFields = {
  transit_name: string;
  agrement: string;
  nif_transit: string;
  client_name: string;
  client_adresse: string;
  client_nif: string;
  d10_numero: string;
  d10_date: string;
  ligne: FactureLigne;
  rows: Record<FactureKey, FactureRow>;
  extras: FactureExtra[];
  /** True once the user typed over the automatic TVA. */
  tva_manual: boolean;
};

/** What is POSTed for the facture (ids dropped, rows keyed like the backend). */
type FacturePayload = Omit<FactureFields, "extras"> & {
  extras: { libelle: string; debours: string; produit: string; observation: string }[];
};

/** Contact block of the Mandat MSC letter (both columns of its table). */
type MandatFields = {
  /** Nom de l'entreprise — typed here, independent from Global details. */
  client_name: string;
  /** Transitaire (mandataire) — typed here, printed exactly as written. */
  transit_name: string;
  client_username: string;
  client_email: string;
  client_address: string;
  client_phone: string;
  client_rc: string;
  client_nif: string;
  transit_username: string;
  transit_email: string;
  transit_address: string;
  transit_phone: string;
  transit_rc: string;
  transit_nif: string;
  transit_agrement: string;
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

/** AI used by the tariff annex — both do the same steps on the server. */
type AiProvider = "gemini" | "claude";
const AI_PROVIDER_KEY = "ai_provider_v1";
/** Claude costs money: unlocked with a code (CLAUDE_CODE on the server), remembered on this PC. */
const CLAUDE_CODE_KEY = "claude_code_v1";
const readLocal = (k: string) => {
  try {
    return localStorage.getItem(k) || "";
  } catch {
    return "";
  }
};
const writeLocal = (k: string, v: string) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* private window */
  }
};
const AI_LABEL: Record<AiProvider, string> = { gemini: "Gemini", claude: "Claude" };

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
  /** Show the currency selector (USD / EUR / DA / custom) */
  currency?: boolean;
  /** Mobile keyboard hint for number-only fields */
  inputMode?: "numeric";
  /** القيمة بالدينار — computed live from القيمة × the fixed rate */
  autoDa?: boolean;
  /** Typed in kg, kept (and printed) in tonnes — 17255 -> 17.255 */
  kgToTon?: boolean;
};

/** Fields grouped exactly like the lines of the printed DCP paper. */
const DCP_ROWS: DcpFieldDef[][] = [
  [{ key: "المستورد", num: "1", label: "المستورد", type: "text", placeholder: "اللقب والاسم أو شركة المتعامل" }],
  [
    { key: "رقم_س_ت", label: "رقم السجل التجاري (س ت)", type: "rc" },
    { key: "تاريخ_الاستراد", label: "تاريخ س ت", type: "date" },
  ],
  [{ key: "العنوان", num: "2", label: "العنوان", type: "text", placeholder: "العنوان الحقيقي للمتعامل" }],
  /* The placeholder in DCP.docx / the PDF stays تعيين_المنتوج (and the paper
     still prints "تعيين المنتوج") — only the on-screen label changed. */
  [{ key: "تعيين_المنتوج", num: "3", label: "نوع المنتوج", type: "text" }],
  [
    { key: "معروض_في", num: "4", label: "معروض في", type: "text" },
    /* Only the number is typed — "طرد" is a static unit added on generation. */
    { key: "متكون_من", num: "5", label: "متكون من", type: "text", placeholder: "عدد الطرود", suffix: "طرد", suffixEnd: true, inputMode: "numeric" },
  ],
  /* The placeholder in DCP.docx / the PDF stays الكمية (and the paper still
     prints "الكمية" in tonnes) — only the on-screen label changed. */
  [{ key: "الكمية", num: "6", label: "الوزن", type: "text", placeholder: "الوزن بالكيلوغرام (kg)", suffix: "طن", suffixEnd: true, inputMode: "numeric", kgToTon: true }],
  [
    { key: "فاتورة_الشراء", num: "8", label: "رقم فاتورة الشراء", type: "text" },
    { key: "القيمة", num: "9", label: "القيمة", type: "text", currency: true },
  ],
  [
    { key: "القيمة_بالدينار", num: "9", label: "القيمة بالدينار", type: "text", suffix: "DA", autoDa: true },
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
 * (drawn left-to-right, immune to bidi). */
const RC_PARTS = [
  { key: "رقم_س_ت_1", max: 2, ph: "19", w: "w-14" },
  { key: "رقم_س_ت_2", max: 2, ph: "00", w: "w-14" },
  { key: "رقم_س_ت_3", max: 7, ph: "1163066", w: "w-24" },
  { key: "رقم_س_ت_حرف", max: 1, ph: "ب", w: "w-11" },
  { key: "رقم_س_ت_4", max: 2, ph: "23", w: "w-14" },
] as const;
const RC_LETTER_KEY = "رقم_س_ت_حرف";

const initialDcp: Record<string, string> = {
  ...Object.fromEntries(DCP_ALL_FIELDS.map((f) => [f.key, ""])),
  ...Object.fromEntries(RC_PARTS.map((p) => [p.key, ""])),
  [RC_LETTER_KEY]: "ب", // most common letter — editable
  معروض_في: "طرود", // default — editable
  القيمة_عملة: "USD",
  القيمة_عملة_نص: "",
};

/** Currency options for القيمة — "SPEC" lets the user type his own. */
const CURRENCY_OPTIONS = ["USD", "EUR", "DA"] as const;
const DEFAULT_CURRENCY = "USD";

/* --------------------------------------------------------------------------
 * القيمة بالدينار — live conversion with a FIXED rate.
 * Official Banque d'Algérie rates of 30/09/2026 — update these two numbers
 * whenever you want a newer rate (1 unit of currency = X DA).
 * ------------------------------------------------------------------------ */
const DA_RATES: Record<string, number> = {
  USD: 133.7,
  EUR: 152.0,
  DA: 1,
};
const DA_RATES_DATE = "30/09/2026";

/** "12 500,50" / "12,500.50" / "12500.5" -> 12500.5 ; unusable text -> null. */
const parseAmount = (value: string): number | null => {
  let t = (value || "").replace(/[\s\u00a0\u202f]/g, "");
  if (!t) return null;
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    // both present: the last one is the decimal separator
    t = lastComma > lastDot
      ? t.replace(/\./g, "").replace(",", ".")
      : t.replace(/,/g, "");
  } else if (lastComma !== -1) {
    // commas only: "1,5" / "1,50" = decimal, "12,500" / "1,250,000" = thousands
    const parts = t.split(",");
    t = parts.length === 2 && parts[1].length <= 2
      ? parts.join(".")
      : parts.join("");
  } else if ((t.match(/\./g) || []).length > 1) {
    t = t.replace(/\./g, ""); // "1.250.000" = thousands
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** 1671250 -> "1 671 250,00" (Algerian/French style, plain spaces). */
const fmtDa = (n: number) => {
  const [int, dec] = n.toFixed(2).split(".");
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${dec}`;
};

/** The DA rate for the selected currency, or null for a custom currency. */
const daRateFor = (dcp: Record<string, string>): number | null =>
  DA_RATES[(dcp["القيمة_عملة"] || DEFAULT_CURRENCY).trim()] ?? null;

/** القيمة converted to DA ("" while القيمة is empty or not a number). */
const convertToDa = (dcp: Record<string, string>): string => {
  const rate = daRateFor(dcp);
  const amount = parseAmount(dcp["القيمة"] ?? "");
  return rate === null || amount === null ? "" : fmtDa(amount * rate);
};

/** الوزن: kg typed -> tonnes kept ("17255" -> "17.255"); other text stays as typed. */
const kgToTon = (kg: string): string => {
  const n = parseAmount(kg);
  return n === null ? kg : String(Number((n / 1000).toFixed(6)));
};

/** The kept tonnes shown back in kg while the box is edited ("17.255" -> "17255"). */
const tonToKg = (ton: string): string => {
  const n = parseAmount(ton);
  return n === null ? ton : String(Number((n * 1000).toFixed(3)));
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

/** Shipping companies — one is chosen per generation and printed on every
 *  MISE A QUAI. "OTHER" lets the user type a custom company name. */
const COMPANIES: string[] = ["CMA", "AKKON", "MSC", "HMM", "WHITE LINE", "COSCO", "MAERSK", "ARKAS"];

/* --------------------------------------------------------------------------
 * Mandat MSC (autorisation aux mandataires)
 * ------------------------------------------------------------------------ */

/** The transitaire side rarely changes — prefilled, still editable. */
const initialMandat: MandatFields = {
  client_name: "",
  transit_name: "",
  client_username: "",
  client_email: "",
  client_address: "",
  client_phone: "",
  client_rc: "",
  client_nif: "",
  transit_username: "Belarbi Tayeb",
  transit_email: "transittayeb@gmail.com",
  transit_address: "N 14 RUE MUSTAPHA ADJEKIM SKIKDA",
  transit_phone: "+213 675714539",
  transit_rc: "23/01-0073687 A 01",
  transit_nif: "15021010095418000000",
  transit_agrement: "20133",
};

const MANDAT_ROWS: {
  label: string;
  client: keyof MandatFields | null;
  transit: keyof MandatFields;
  type?: "email" | "tel";
  placeholder?: string;
}[] = [
  { label: "Personne à contacter", client: "client_username", transit: "transit_username", placeholder: "e.g. M. Benali" },
  { label: "RC", client: "client_rc", transit: "transit_rc", placeholder: "e.g. 23/01-XXXXXXX X XX" },
  { label: "NIF", client: "client_nif", transit: "transit_nif", placeholder: "e.g. 150XXXXXXXXXXXXXXXX" },
  { label: "Agrément N°", client: null, transit: "transit_agrement", placeholder: "e.g. 20133" },
  { label: "Email", client: "client_email", transit: "transit_email", type: "email", placeholder: "e.g. contact@societe.dz" },
  { label: "Adresse postale", client: "client_address", transit: "transit_address", placeholder: "e.g. 12 Rue X, Alger" },
  { label: "Téléphone", client: "client_phone", transit: "transit_phone", type: "tel", placeholder: "e.g. +213 21 00 00 00" },
];

/* ---- Facture defaults + money helpers ------------------------------------ */

const emptyFactureRow = (): FactureRow => ({
  debours: "",
  produit: "",
  observation: "",
});

const initialFactureRows = (): Record<FactureKey, FactureRow> => {
  const rows = {} as Record<FactureKey, FactureRow>;
  for (const k of FACTURE_KEYS) rows[k] = emptyFactureRow();
  // Pre-filled but editable, exactly like the paper invoice.
  rows.honnoraire.produit = "20000.00";
  rows.timbre.produit = "436.00";
  return rows;
};

const initialFacture = (): FactureFields => ({
  transit_name: "TRANSIT AOULA",
  agrement: "04048",
  nif_transit: "196919250099510",
  client_name: "",
  client_adresse: "",
  client_nif: "",
  d10_numero: "",
  d10_date: "",
  ligne: { marque: "", designation: "", nbrs: "", poids: "" },
  rows: initialFactureRows(),
  extras: [],
  tva_manual: false,
});

const TVA_RATE = 0.09;

/** "20 000,50" -> 20000.5 ; unusable text -> null. */
const parseMoney = (value: string): number | null => {
  const txt = (value || "").replace(/[\s ]/g, "").replace(",", ".");
  if (!txt) return null;
  const n = Number(txt);
  return Number.isFinite(n) ? n : null;
};

const money2 = (n: number) => n.toFixed(2);

/** dd/mm/yyyy mask — the user types digits only, the slashes appear alone. */
const maskDate = (value: string) => {
  const d = value.replace(/\D/g, "").slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
};

/** History entries hold the POSTed shape — rebuild the editable one (ids). */
const restoreFacture = (p?: FacturePayload): FactureFields => {
  const base = initialFacture();
  if (!p) return base;
  const rows = initialFactureRows();
  for (const k of FACTURE_KEYS) {
    rows[k] = { ...emptyFactureRow(), ...(p.rows?.[k] ?? {}) };
  }
  // history entries saved before the merchandise table became a single line
  const legacy = (p as { lignes?: FactureLigne[] }).lignes?.[0];
  return {
    ...base,
    ...p,
    rows,
    ligne: { ...base.ligne, ...(p.ligne ?? legacy ?? {}) },
    extras: (p.extras ?? []).map((e) => ({ id: crypto.randomUUID(), ...e })),
  };
};

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
  facture_enabled: boolean;
  facture: FactureFields;
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
  /* Default: only the single merged Word file; the separate files are opt-in. */
  doc_mise: false,
  doc_lettre: false,
  doc_bon: false,
  doc_merge: true,
  dcp_enabled: false,
  dcp: { ...initialDcp },
  dcp_produits: [],
  mandat_enabled: false,
  mandat: { ...initialMandat },
  facture_enabled: false,
  facture: initialFacture(),
};

function App() {
  const [form, setForm] = useState<FormState>({
    ...initialForm,
    dcp: { ...initialDcp },
    mandat: { ...initialMandat },
    facture: initialFacture(),
  });
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [historyOpen, setHistoryOpen] = useState(false); // mobile drawer
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  /** Which DCP field currently shows the Arabic keyboard (by key). */
  const [kbField, setKbField] = useState<string | null>(null);
  const dcpInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  /* AI tariff classification */
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [invoicePreview, setInvoicePreview] = useState<string | null>(null);
  const [classifyMode, setClassifyMode] = useState<"pro" | "normal">("pro");
  const [isClassifying, setIsClassifying] = useState(false);
  const [classifyError, setClassifyError] = useState<string | null>(null);
  /** Sending hand-typed products (rows with an empty Code HS) to the AI. */
  const [isSendingProducts, setIsSendingProducts] = useState(false);
  /** Which AI reads the invoice / picks the codes — remembered on this PC. */
  /** The Claude code typed once on this PC ("" = Claude locked). */
  const [claudeCode, setClaudeCode] = useState(() => readLocal(CLAUDE_CODE_KEY));
  const [aiProvider, setAiProvider] = useState<AiProvider>(() =>
    readLocal(AI_PROVIDER_KEY) === "claude" && readLocal(CLAUDE_CODE_KEY) ? "claude" : "gemini"
  );
  /** Which AIs have a key on the server (null = not known yet). */
  const [aiKeys, setAiKeys] = useState<{ gemini: boolean; claude: boolean; claude_code: boolean } | null>(null);
  const [claudeUnlockOpen, setClaudeUnlockOpen] = useState(false);
  const [claudeCodeInput, setClaudeCodeInput] = useState("");
  const [claudeUnlockError, setClaudeUnlockError] = useState("");
  const [claudeUnlocking, setClaudeUnlocking] = useState(false);
  /** What the error's "retry" button must redo. */
  const [lastAiAction, setLastAiAction] = useState<"invoice" | "typed">("invoice");

  useEffect(() => writeLocal(AI_PROVIDER_KEY, aiProvider), [aiProvider]);

  useEffect(() => {
    fetch(`${API_URL}/api/ai-providers`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setAiKeys({ gemini: !!d.gemini, claude: !!d.claude, claude_code: !!d.claude_code }))
      .catch(() => undefined);
  }, []);

  /** Forget the Claude code on this PC and go back to Gemini. */
  const lockClaude = () => {
    writeLocal(CLAUDE_CODE_KEY, "");
    setClaudeCode("");
    setAiProvider("gemini");
  };

  const unlockClaude = async () => {
    const code = claudeCodeInput.trim();
    if (!code) return setClaudeUnlockError("أدخل الرمز.");
    setClaudeUnlocking(true);
    setClaudeUnlockError("");
    try {
      const res = await fetch(`${API_URL}/api/claude-unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data?.detail === "string" ? data.detail : `خطأ في الخادم (HTTP ${res.status})`);
      }
      writeLocal(CLAUDE_CODE_KEY, code);
      setClaudeCode(code);
      setAiProvider("claude");
      setClaudeUnlockOpen(false);
      setClaudeCodeInput("");
      flash("تم فتح Claude على هذا الجهاز.", "success");
    } catch (err) {
      setClaudeUnlockError(err instanceof TypeError ? "تعذر الاتصال بالخادم." : err instanceof Error ? err.message : "خطأ غير متوقع.");
    } finally {
      setClaudeUnlocking(false);
    }
  };

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
  /** Typed products still waiting for a Code HS — what the Send button sends. */
  const pendingProductCount = form.dcp_produits.filter(
    (p) => p.produit.trim() !== "" && p.code.trim() === ""
  ).length;

  /* ---- Facture: live TVA + totals (same rules as the backend) ------------ */
  const facture = form.facture;
  const factureCalc = useMemo(() => {
    const { rows, extras, tva_manual } = facture;

    // TVA 9% of HONNORAIRE — taken from whichever column it was typed
    // in, printed in PRODUIT, overridable by hand.
    const base =
      (parseMoney(rows.honnoraire.produit) ?? 0) +
      (parseMoney(rows.honnoraire.debours) ?? 0);
    const tvaAuto = base ? money2(base * TVA_RATE) : "";
    const tvaValue = tva_manual ? rows.tva.produit : tvaAuto;

    const columnTotal = (field: "debours" | "produit") => {
      const cells = FACTURE_KEYS.map((k) =>
        k === "tva" && field === "produit" ? tvaValue : rows[k][field]
      ).concat(extras.map((e) => e[field]));
      const values = cells.map(parseMoney);
      const sum = values.reduce<number>((a, v) => a + (v ?? 0), 0);
      return values.some((v) => v !== null) ? money2(sum) : "";
    };

    const tauxDebours = columnTotal("debours");
    const tauxProduit = columnTotal("produit");
    const total = (parseMoney(tauxDebours) ?? 0) + (parseMoney(tauxProduit) ?? 0);
    return {
      tvaAuto,
      tvaValue,
      tauxDebours,
      tauxProduit,
      totalTtc: tauxDebours || tauxProduit ? money2(total) : "",
    };
  }, [facture]);

  const factureReady =
    form.facture_enabled && form.facture.client_name.trim() !== "";
  /* The Mandat is independent: it has its own entreprise + transitaire
     names (typed in the Mandat part), so it needs nothing from Global details. */
  const mandatReady =
    form.mandat_enabled &&
    form.mandat.client_name.trim() !== "" &&
    form.mandat.transit_name.trim() !== "";
  const canGenerate =
    transitReady || dcpReady || annexReady || mandatReady || factureReady;
  const docCount =
    (transitReady
      ? (form.doc_mise ? counts.total : 0) +
        (form.doc_lettre ? 1 : 0) +
        (form.doc_bon ? 1 : 0) +
        (form.doc_merge ? 1 : 0)
      : 0) +
    (dcpReady ? 1 : 0) +
    (annexReady ? 1 : 0) +
    (mandatReady ? 1 : 0) +
    (factureReady ? 1 : 0);

  /** Report a bug by email, subject already written.
   *  PC: Gmail's compose page (works without any mail app installed).
   *  Phone/tablet: a mailto: link — it opens the phone's mail app (Gmail,
   *  Mail…) with the address + subject; Gmail's web compose page does not
   *  work on phones (it lands on the inbox instead). */
  const bugReportSubject = "Bug Report - Transit Document Generator";
  const isPhone = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    return (
      /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua) ||
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) // iPad asking for the desktop site
    );
  }, []);
  const bugReportHref = isPhone
    ? `mailto:kh.badri16@gmail.com?subject=${encodeURIComponent(bugReportSubject)}`
    : "https://mail.google.com/mail/?view=cm&fs=1&to=kh.badri16@gmail.com&su=" +
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
    }
    setForm((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));
  };

  /* --- DCP handlers ------------------------------------------------------- */

  /* القيمة بالدينار follows القيمة live (fixed rate). Only a custom currency
     ("أخرى…") has no rate — then the field is typed by hand. */
  const daRate = daRateFor(form.dcp);
  const daValue =
    daRate !== null ? convertToDa(form.dcp) : form.dcp["القيمة_بالدينار"] ?? "";
  const daHint: React.ReactNode = (() => {
    const cur = (form.dcp["القيمة_عملة"] || DEFAULT_CURRENCY).trim();
    if (daRate === null) return "عملة أخرى — أدخل القيمة بالدينار يدويًا";
    if (cur === "DA") return "القيمة بالدينار نفسها";
    return (
      <>
        تحويل تلقائي — <bdi dir="ltr">1 {cur} = {daRate.toFixed(2)} DA</bdi>{" "}
        (سعر <bdi dir="ltr">{DA_RATES_DATE}</bdi>)
      </>
    );
  })();

  const updateDcp = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, dcp: { ...prev.dcp, [key]: value } }));
  };

  /* --- Mandat MSC handlers ------------------------------------------------ */

  const updateMandat = (key: keyof MandatFields, value: string) => {
    setForm((prev) => ({ ...prev, mandat: { ...prev.mandat, [key]: value } }));
  };

  /* --- Facture de transit ------------------------------------------------- */

  const updateFacture = <K extends keyof FactureFields>(
    key: K,
    value: FactureFields[K]
  ) => {
    setForm((prev) => ({ ...prev, facture: { ...prev.facture, [key]: value } }));
  };

  const updateFactureRow = (
    key: FactureKey,
    field: keyof FactureRow,
    value: string
  ) => {
    setForm((prev) => ({
      ...prev,
      facture: {
        ...prev.facture,
        // typing in the TVA amount switches it to manual for good
        tva_manual:
          key === "tva" && field === "produit" ? true : prev.facture.tva_manual,
        rows: {
          ...prev.facture.rows,
          [key]: { ...prev.facture.rows[key], [field]: value },
        },
      },
    }));
  };

  /** Give the TVA back to the automatic 9% calculation. */
  const resetTva = () => {
    setForm((prev) => ({
      ...prev,
      facture: {
        ...prev.facture,
        tva_manual: false,
        rows: { ...prev.facture.rows, tva: { ...prev.facture.rows.tva, produit: "" } },
      },
    }));
  };

  const updateFactureLigne = (field: keyof FactureLigne, value: string) =>
    updateFacture("ligne", { ...form.facture.ligne, [field]: value });

  const addFactureExtra = () =>
    updateFacture("extras", [
      ...form.facture.extras,
      { id: crypto.randomUUID(), libelle: "", debours: "", produit: "", observation: "" },
    ]);

  const removeFactureExtra = (id: string) =>
    updateFacture("extras", form.facture.extras.filter((e) => e.id !== id));

  const updateFactureExtra = (
    id: string,
    field: keyof Omit<FactureExtra, "id">,
    value: string
  ) =>
    updateFacture(
      "extras",
      form.facture.extras.map((e) => (e.id === id ? { ...e, [field]: value } : e))
    );

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
    // Validate type — images and PDF invoices are both accepted
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ];
    if (!allowed.includes(file.type)) {
      setClassifyError("صيغة غير مدعومة. الصيغ المقبولة: JPEG, PNG, WebP, PDF");
      return;
    }
    // Validate size (20MB — a scanned PDF is heavier than a photo)
    if (file.size > 20 * 1024 * 1024) {
      setClassifyError("حجم الملف يتجاوز 20MB");
      return;
    }
    if (invoicePreview) URL.revokeObjectURL(invoicePreview);
    setInvoiceFile(file);
    // Thumbnail for images only; PDFs show a file icon instead.
    setInvoicePreview(
      file.type === "application/pdf" ? null : URL.createObjectURL(file)
    );
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

  const classifyInvoice = async (provider: AiProvider = aiProvider) => {
    if (!invoiceFile || isClassifying) return;
    setLastAiAction("invoice");
    setIsClassifying(true);
    setClassifyError(null);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 305000); // just above the 300s server maxDuration

    try {
      const formData = new FormData();
      formData.append("invoice", invoiceFile);
      formData.append("mode", classifyMode);
      formData.append("provider", provider);

      const res = await fetch(`${API_URL}/api/classify-tariff`, {
        method: "POST",
        body: formData,
        headers: provider === "claude" ? { "X-Claude-Code": claudeCode } : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        if (provider === "claude" && res.status === 401) lockClaude(); // code changed / wrong
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

  /* Send the hand-typed products (rows still without a Code HS) to the AI and
     fill their codes in place — for invoices with only a few lines, where
     typing is faster than photographing the invoice. */
  const sendTypedProducts = async (provider: AiProvider = aiProvider) => {
    if (isSendingProducts || isClassifying) return;
    const pending = form.dcp_produits.filter(
      (p) => p.produit.trim() !== "" && p.code.trim() === ""
    );
    if (pending.length === 0) return;

    setLastAiAction("typed");
    setIsSendingProducts(true);
    setClassifyError(null);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 305000);

    try {
      const res = await fetch(`${API_URL}/api/classify-products`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(provider === "claude" ? { "X-Claude-Code": claudeCode } : {}),
        },
        body: JSON.stringify({
          products: pending.map((p) => p.produit.trim()),
          mode: classifyMode,
          provider,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        if (provider === "claude" && res.status === 401) lockClaude(); // code changed / wrong
        let message = `خطأ في الخادم (HTTP ${res.status})`;
        try {
          const data = await res.json();
          if (data?.detail) {
            message =
              typeof data.detail === "string"
                ? data.detail
                : JSON.stringify(data.detail);
          }
        } catch { /* non-JSON error body */ }
        throw new Error(message);
      }

      const data = await res.json();
      const results: {
        i?: number;
        codeHS?: string;
        confidence?: "high" | "low";
        candidates?: { code: string; label: string }[];
      }[] = data.products || [];

      /* Map results back onto the exact rows we sent, by position. */
      const byId = new Map<string, (typeof results)[number]>();
      results.forEach((r, idx) => {
        const row = pending[typeof r.i === "number" ? r.i : idx];
        if (row) byId.set(row.id, r);
      });

      /* Count BEFORE setForm: React runs the updater below later (batched),
         so a counter incremented inside it was still 0 here -> false error. */
      const filled = pending.filter((p) => (byId.get(p.id)?.codeHS || "").trim() !== "").length;
      setForm((prev) => ({
        ...prev,
        dcp_produits: prev.dcp_produits.map((p) => {
          const r = byId.get(p.id);
          if (!r || !r.codeHS || p.code.trim() !== "") return p;
          return {
            ...p,
            code: r.codeHS.trim(),
            aiConfidence: r.confidence,
            aiCandidates: r.candidates?.length ? r.candidates : undefined,
          };
        }),
      }));

      if (filled === 0) {
        throw new Error("لم يتم إيجاد أي رمز تعريفي. أعد صياغة أسماء المنتوجات.");
      }
      flash(`تم تصنيف ${filled} منتوج بنجاح.`, "success");
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
      flash("فشل تصنيف المنتوجات.", "error");
    } finally {
      clearTimeout(timeout);
      setIsSendingProducts(false);
    }
  };

  const clearForm = () => {
    setForm({
      ...initialForm,
      dcp: { ...initialDcp },
      dcp_produits: [],
      mandat: { ...initialMandat },
      facture: initialFacture(),
    });
    setError(null);
    setKbField(null);
    // AI state
    removeInvoice();
    setClassifyError(null);
    setIsClassifying(false);
    setIsSendingProducts(false);
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
      mandat: {
        ...initialMandat,
        ...(p.mandat ?? {}),
        // entries saved before the Mandat had its own names reused Global details
        client_name: p.mandat?.client_name ?? p.client_name ?? "",
        transit_name:
          p.mandat?.transit_name ??
          (p.transit_name?.trim()
            ? `TRANSIT ${p.transit_name.trim().replace(/^\s*transit[\s:,-]+/i, "")}`
            : ""),
      },
      facture_enabled: p.facture_enabled ?? false,
      facture: restoreFacture(p.facture),
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
      // القيمة بالدينار is shipped exactly as displayed (live conversion)
      dcp: { ...form.dcp, القيمة_بالدينار: daValue },
      dcp_produits: form.dcp_produits.map((p) => ({
        produit: p.produit,
        code: p.code,
      })),
      mandat_enabled: form.mandat_enabled,
      mandat: { ...form.mandat },
      facture_enabled: form.facture_enabled,
      facture: {
        ...form.facture,
        // send the TVA exactly as displayed (auto or overridden)
        rows: {
          ...form.facture.rows,
          tva: { ...form.facture.rows.tva, produit: factureCalc.tvaValue },
        },
        extras: form.facture.extras.map(({ id: _id, ...e }) => e),
      },
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
      const base =
        payload.client_name ||
        payload.dcp["المستورد"] ||
        payload.facture.client_name ||
        "DOCUMENTS";
      a.href = url;
      a.download = `DOCUMENTS_${sanitizeForFilename(base)}_${stamp}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);

      saveToHistory(payload);
      // remember / update this importer's fixed lines (this browser only)
      if (payload.dcp_enabled) rememberDcpClient(payload.dcp);
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
    <div className="app-shell h-full text-slate-100">
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

      <div className="flex h-full">
        {/* Main column */}
        <main className="flex-1 min-w-0 h-full overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 sm:px-8 py-6 sm:py-10 flex flex-col min-h-full">
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
                className="btn-ghost relative shrink-0 !px-3 !py-2.5 lg:!hidden"
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
              {/* ── Preparation ─────────────────────────────────────────── */}
              <fieldset className="group-box">
                <legend className="group-title">Preparation</legend>
                <div className="group-body">
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
                </div>
              </fieldset>

              {/* ── DCP ─────────────────────────────────────────────────── */}
              <fieldset className="group-box">
                <legend className="group-title">DCP</legend>
                <div className="group-body">
              {/* DCP — تصريح باستيراد منتوج */}
              <section className="card" dir="rtl">
                <label className="flex items-center gap-3 cursor-pointer select-none">
                  {/* dir="ltr": the knob must sit LEFT when off and slide RIGHT
                      when on, like every other toggle — mirrored by the RTL
                      card it looked "on" while it was actually off. */}
                  <span className="relative shrink-0" dir="ltr">
                    <input
                      type="checkbox"
                      name="dcp_enabled"
                      checked={form.dcp_enabled}
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
                        تصريح باستيراد منتوج
                      </span>
                      <span className="block text-xs text-slate-400 mt-0.5">
                        DCP — فعّل الخيار لإظهار الحقول وملئها
                      </span>
                    </span>
                  </span>
                </label>

                {form.dcp_enabled && (
                  <div className="dcp-form mt-6 space-y-4">
                    {/* saved importers: fill المستورد / س ت / تاريخ س ت / العنوان */}
                    <DcpClientBook
                      dcp={form.dcp}
                      onApply={(patch) =>
                        setForm((prev) => ({ ...prev, dcp: { ...prev.dcp, ...patch } }))
                      }
                    />
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
                                  value={f.autoDa ? daValue : form.dcp[f.key] ?? ""}
                                  readOnly={f.autoDa && daRate !== null}
                                  hint={
                                    f.autoDa
                                      ? daHint
                                      : f.kgToTon
                                        ? "اكتب الوزن بالكيلوغرام — يتحول إلى الطن تلقائيًا"
                                        : undefined
                                  }
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
                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    <Sparkles size={16} className="text-amber-400" />
                    <span className="text-sm font-semibold text-white">تصنيف تلقائي بالذكاء الاصطناعي</span>
                    {/* Which AI: Gemini or Claude (same steps, same results format) */}
                    <div className="ms-auto flex items-center gap-1.5" dir="ltr">
                      <div className="seg" title="النموذج المستعمل">
                        {(["gemini", "claude"] as AiProvider[]).map((p) => (
                          <button
                            key={p}
                            type="button"
                            className={`seg-btn ${aiProvider === p ? "seg-active seg-active-violet" : ""}`}
                            onClick={() => {
                              if (p === "claude" && !claudeCode) {
                                setClaudeUnlockOpen((o) => !o);
                                setClaudeUnlockError("");
                                return;
                              }
                              setAiProvider(p);
                            }}
                            title={p === "claude" && !claudeCode ? "Claude مقفل — يلزم الرمز" : undefined}
                          >
                            {p === "claude" && !claudeCode && <Lock size={11} className="inline -mt-px me-1" />}
                            {AI_LABEL[p]}
                            {aiKeys && !aiKeys[p] && <span className="ms-1 text-[10px] text-slate-500">(بدون مفتاح)</span>}
                          </button>
                        ))}
                      </div>
                      {claudeCode && (
                        <button
                          type="button"
                          onClick={lockClaude}
                          className="p-1.5 rounded-lg text-slate-500 hover:text-amber-300 hover:bg-amber-400/10 transition-colors"
                          title="قفل Claude على هذا الجهاز"
                          aria-label="قفل Claude"
                        >
                          <Lock size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                  {claudeUnlockOpen && !claudeCode && (
                    <form
                      className="mb-3 flex flex-wrap items-center gap-2 p-3 rounded-lg border border-amber-400/30 bg-amber-500/5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void unlockClaude();
                      }}
                    >
                      <KeyRound size={15} className="text-amber-300 shrink-0" />
                      <span className="text-xs text-amber-100/90">Claude مدفوع — أدخل الرمز لفتحه على هذا الجهاز:</span>
                      <input
                        type="password"
                        dir="ltr"
                        autoComplete="off"
                        className="input !py-1.5 !w-40 text-sm"
                        value={claudeCodeInput}
                        onChange={(e) => setClaudeCodeInput(e.target.value)}
                        placeholder="الرمز"
                        aria-label="رمز Claude"
                      />
                      <button type="submit" className="btn-primary !py-1.5 !px-3 !text-xs" disabled={claudeUnlocking}>
                        {claudeUnlocking ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />} فتح
                      </button>
                      <button type="button" className="text-xs text-slate-400 hover:text-white" onClick={() => setClaudeUnlockOpen(false)}>
                        إلغاء
                      </button>
                      {claudeUnlockError && <p className="basis-full text-xs text-rose-300">{claudeUnlockError}</p>}
                    </form>
                  )}
                  {aiKeys && !aiKeys[aiProvider] && (aiProvider !== "claude" || claudeCode) && (
                    <p className="-mt-1 mb-3 text-xs text-amber-300/90">
                      مفتاح {AI_LABEL[aiProvider]} غير مُعدّ بعد على الخادم ({aiProvider === "claude" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY"} في Vercel).
                    </p>
                  )}

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
                        اسحب صورة الفاتورة أو ملف PDF هنا أو <span className="text-indigo-400 font-medium">تصفح</span>
                      </p>
                      <p className="text-xs text-slate-600 text-center mt-1">JPEG, PNG, WebP, PDF — حد أقصى 20MB</p>
                      <input
                        id="invoice-file-input"
                        type="file"
                        accept="image/jpeg,image/png,image/webp,application/pdf"
                        className="hidden"
                        onChange={(e) => handleInvoiceSelect(e.target.files?.[0] || null)}
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-800/60 border border-slate-700">
                      {invoicePreview ? (
                        <img
                          src={invoicePreview}
                          alt="Invoice preview"
                          className="w-14 h-14 object-cover rounded-lg border border-slate-600"
                        />
                      ) : (
                        <span className="w-14 h-14 grid place-items-center rounded-lg border border-slate-600 bg-slate-900/60 shrink-0">
                          <FileText size={22} className="text-rose-400" />
                        </span>
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
                      onClick={() => void classifyInvoice()}
                      disabled={!invoiceFile || isClassifying || isSendingProducts}
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
                      {(() => {
                        const other: AiProvider = aiProvider === "gemini" ? "claude" : "gemini";
                        const retry = (p: AiProvider) =>
                          lastAiAction === "typed" ? void sendTypedProducts(p) : void classifyInvoice(p);
                        return (
                          <span className="shrink-0 flex flex-col items-end gap-1.5">
                            <button
                              onClick={() => retry(aiProvider)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-rose-200 hover:text-white transition-colors"
                            >
                              <RotateCcw size={12} /> إعادة
                            </button>
                            {aiKeys?.[other] !== false && (other !== "claude" || claudeCode) && (
                              <button
                                onClick={() => {
                                  setAiProvider(other);
                                  retry(other);
                                }}
                                className="inline-flex items-center gap-1 text-xs font-semibold text-amber-200 hover:text-white transition-colors"
                                title={`أعد نفس الطلب باستعمال ${AI_LABEL[other]}`}
                              >
                                <Sparkles size={12} /> جرّب {AI_LABEL[other]}
                              </button>
                            )}
                          </span>
                        );
                      })()}
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

                    {/* Send the typed products to the AI — fills the blank
                        Code HS cells without touching codes already entered. */}
                    <div
                      dir="rtl"
                      className="flex flex-wrap items-center justify-between gap-3 pt-3 mt-1 border-t border-slate-800"
                    >
                      <p className="text-xs text-slate-500">
                        {pendingProductCount > 0
                          ? `${pendingProductCount} منتوج بدون رمز — أرسلها للتصنيف الآلي.`
                          : "كل المنتوجات لها رمز تعريفي."}
                      </p>
                      <button
                        onClick={() => void sendTypedProducts()}
                        disabled={
                          pendingProductCount === 0 ||
                          isSendingProducts ||
                          isClassifying
                        }
                        className="btn-primary !py-2 !px-5 !text-sm"
                      >
                        {isSendingProducts ? (
                          <>
                            <Loader2 size={16} className="animate-spin" />
                            <span>جاري التصنيف…</span>
                          </>
                        ) : (
                          <>
                            <Send size={15} />
                            <span>
                              إرسال
                              {pendingProductCount > 0
                                ? ` (${pendingProductCount})`
                                : ""}
                            </span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </section>
                </div>
              </fieldset>

              {/* ── Mandat ──────────────────────────────────────────────── */}
              <fieldset className="group-box">
                <legend className="group-title">Mandat</legend>
                <div className="group-body">
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
                          Fill the <strong>Nom</strong> of the entreprise (client) and
                          of the transitaire (mandataire) below.
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

                    {/* Names — free text, independent from Global details */}
                    <div className="grid grid-cols-1 sm:grid-cols-[9rem_1fr_1fr] gap-3 items-center mb-3">
                      <span className="text-xs font-medium text-slate-400 sm:text-right sm:pr-1">
                        Nom <span className="text-indigo-400">*</span>
                      </span>
                      <input
                        className="input"
                        value={form.mandat.client_name}
                        onChange={(e) => updateMandat("client_name", e.target.value)}
                        placeholder="e.g. SARL ACME IMPORT"
                        style={upper}
                        aria-label="Nom de l'entreprise (client)"
                      />
                      <input
                        className="input"
                        value={form.mandat.transit_name}
                        onChange={(e) => updateMandat("transit_name", e.target.value)}
                        placeholder="e.g. TRANSIT ALPHA"
                        style={upper}
                        aria-label="Nom du transitaire (mandataire)"
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
                        {row.client ? (
                          <input
                            className="input"
                            type={row.type ?? "text"}
                            value={form.mandat[row.client]}
                            onChange={(e) => updateMandat(row.client!, e.target.value)}
                            placeholder={row.placeholder}
                            aria-label={`${row.label} — entreprise`}
                          />
                        ) : (
                          <span className="input opacity-30 cursor-not-allowed bg-slate-800/50" aria-hidden />
                        )}
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
              </fieldset>

              {/* ── Facture ─────────────────────────────────────────────── */}
              <fieldset className="group-box">
                <legend className="group-title">Facture</legend>
                <div className="group-body">
              <section className="card">
                <label className="flex items-center gap-3 cursor-pointer select-none">
                  <span className="relative shrink-0">
                    <input
                      type="checkbox"
                      name="facture_enabled"
                      checked={form.facture_enabled}
                      onChange={handleInputChange}
                      className="peer sr-only"
                    />
                    <span className="block w-10 h-6 rounded-full bg-slate-700 peer-checked:bg-indigo-500 transition-colors" />
                    <span className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
                  </span>
                  <span className="flex items-center gap-2.5">
                    <Receipt size={18} className="text-indigo-400 shrink-0" />
                    <span>
                      <span className="block text-base font-bold text-white">
                        Facture de transit
                      </span>
                      <span className="block text-xs text-slate-400 mt-0.5">
                        Indépendante — ses propres noms, marchandise et montants
                      </span>
                    </span>
                  </span>
                </label>

                {form.facture_enabled && (
                  <div className="mt-6 space-y-7">
                    {!factureReady && (
                      <p className="flex items-start gap-2 text-xs text-amber-300/90 p-3 rounded-lg bg-amber-400/10 border border-amber-400/30">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                        <span>Fill the client name (DOIT) to generate the facture.</span>
                      </p>
                    )}

                    {/* ---- En-tête ---- */}
                    <div>
                      <h3 className="text-sm font-semibold text-slate-300 mb-3">
                        En-tête
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Field label="Transit (en-tête)">
                          <input
                            className="input"
                            value={form.facture.transit_name}
                            onChange={(e) => updateFacture("transit_name", e.target.value)}
                            placeholder="TRANSIT AOULA"
                            style={upper}
                          />
                        </Field>
                        <Field label="Client — DOIT" required>
                          <input
                            className="input"
                            value={form.facture.client_name}
                            onChange={(e) => updateFacture("client_name", e.target.value)}
                            placeholder="e.g. SARL BAK BAY ASIE IMP /EXP"
                            style={upper}
                          />
                        </Field>
                        <Field label="N° agrément">
                          <input
                            className="input font-mono text-sm"
                            value={form.facture.agrement}
                            onChange={(e) => updateFacture("agrement", e.target.value)}
                            placeholder="04048"
                          />
                        </Field>
                        <Field label="Adresse client">
                          <input
                            className="input"
                            value={form.facture.client_adresse}
                            onChange={(e) => updateFacture("client_adresse", e.target.value)}
                            placeholder="e.g. ORAN"
                            style={upper}
                          />
                        </Field>
                        <Field label="NIF transit">
                          <input
                            className="input font-mono text-sm"
                            value={form.facture.nif_transit}
                            onChange={(e) => updateFacture("nif_transit", e.target.value)}
                            placeholder="196919250099510"
                          />
                        </Field>
                        <Field label="NIF client">
                          <input
                            className="input font-mono text-sm"
                            value={form.facture.client_nif}
                            onChange={(e) => updateFacture("client_nif", e.target.value)}
                            placeholder="002231011879137"
                          />
                        </Field>
                        <Field label="D10 N°">
                          <input
                            className="input font-mono text-sm"
                            value={form.facture.d10_numero}
                            onChange={(e) => updateFacture("d10_numero", e.target.value)}
                            placeholder="5020100002026DED025979I"
                          />
                        </Field>
                        <Field label="DU (date)">
                          <input
                            className="input font-mono text-sm"
                            inputMode="numeric"
                            maxLength={10}
                            value={form.facture.d10_date}
                            onChange={(e) =>
                              updateFacture("d10_date", maskDate(e.target.value))
                            }
                            placeholder="jj/mm/aaaa"
                          />
                        </Field>
                      </div>
                    </div>

                    {/* ---- Marchandise — one single line, four columns ---- */}
                    <div>
                      <h3 className="text-sm font-semibold text-slate-300 mb-3">
                        Marchandise
                      </h3>
                      <div className="space-y-2">
                        <div className="hidden sm:grid grid-cols-[1fr_1.4fr_5rem_8rem_2.25rem] gap-2 px-1 text-[11px] font-semibold text-slate-500">
                          <span>MARQUE BL</span>
                          <span>DESIGNATION</span>
                          <span>NBRS CTN</span>
                          <span>POID BRUT</span>
                          <span />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.4fr_5rem_8rem_2.25rem] gap-2 items-center">
                          <input
                            className="input"
                            value={form.facture.ligne.marque}
                            onChange={(e) => updateFactureLigne("marque", e.target.value)}
                            placeholder="Marque BL"
                            style={upper}
                          />
                          <input
                            className="input"
                            value={form.facture.ligne.designation}
                            onChange={(e) =>
                              updateFactureLigne("designation", e.target.value)
                            }
                            placeholder="Désignation"
                            style={upper}
                          />
                          <input
                            className="input font-mono text-sm"
                            inputMode="numeric"
                            value={form.facture.ligne.nbrs}
                            onChange={(e) => updateFactureLigne("nbrs", e.target.value)}
                            placeholder="02"
                          />
                          <div className="flex items-center gap-1.5">
                            <input
                              className="input font-mono text-sm flex-1 min-w-0"
                              inputMode="decimal"
                              value={form.facture.ligne.poids}
                              onChange={(e) => updateFactureLigne("poids", e.target.value)}
                              placeholder="33190.00"
                            />
                            <span className="unit-suffix">KG</span>
                          </div>
                          <span />
                        </div>
                      </div>
                    </div>

                    {/* ---- Détail de la facture ---- */}
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <h3 className="text-sm font-semibold text-slate-300">
                          Détail — débours / produit
                        </h3>
                        <button onClick={addFactureExtra} className="btn-ghost shrink-0">
                          <Plus size={14} /> Ajouter un libellé
                        </button>
                      </div>

                      <div className="space-y-2">
                        <div className="hidden sm:grid grid-cols-[10.5rem_1fr_1fr_1.3fr_2.25rem] gap-2 px-1 text-[11px] font-semibold text-slate-500">
                          <span>LIBELLES</span>
                          <span>DEBOURS</span>
                          <span>PRODUIT</span>
                          <span>OBSERVATION</span>
                          <span />
                        </div>

                        {/* Helper: render one fixed-row key */}
                        {(() => {
                          const renderFixedRow = (k: FactureKey) => {
                            const isTva = k === "tva";
                            const quietDebours =
                              k === "ouverture" || k === "tva" || k === "timbre";
                            return (
                              <div
                                key={k}
                                className="grid grid-cols-1 sm:grid-cols-[10.5rem_1fr_1fr_1.3fr_2.25rem] gap-2 items-center"
                              >
                                <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                                  -{FACTURE_LABELS[k]}
                                  {isTva && !form.facture.tva_manual && (
                                    <span className="text-[10px] font-bold uppercase tracking-wide text-indigo-300/80">
                                      auto
                                    </span>
                                  )}
                                </span>
                                <input
                                  className="input font-mono text-sm"
                                  inputMode="decimal"
                                  value={form.facture.rows[k].debours}
                                  onChange={(e) =>
                                    updateFactureRow(k, "debours", e.target.value)
                                  }
                                  placeholder={quietDebours ? "" : "DEBOURS"}
                                />
                                <div className="flex items-center gap-1.5">
                                  <input
                                    className={`input font-mono text-sm flex-1 min-w-0 ${
                                      isTva && !form.facture.tva_manual
                                        ? "text-indigo-200"
                                        : ""
                                    }`}
                                    inputMode="decimal"
                                    value={
                                      isTva
                                        ? factureCalc.tvaValue
                                        : form.facture.rows[k].produit
                                    }
                                    onChange={(e) =>
                                      updateFactureRow(k, "produit", e.target.value)
                                    }
                                    placeholder="PRODUIT"
                                  />
                                  {isTva && form.facture.tva_manual && (
                                    <button
                                      onClick={resetTva}
                                      className="p-1.5 rounded-lg text-slate-500 hover:text-indigo-300 hover:bg-indigo-400/10 transition-colors shrink-0"
                                      title="Revenir au calcul automatique (9%)"
                                    >
                                      <RotateCcw size={14} />
                                    </button>
                                  )}
                                </div>
                                <input
                                  className="input text-sm"
                                  value={form.facture.rows[k].observation}
                                  onChange={(e) =>
                                    updateFactureRow(k, "observation", e.target.value)
                                  }
                                  placeholder="OBSERVATION"
                                />
                                <span />
                              </div>
                            );
                          };
                          return (
                            <>
                              {/* Body rows: ECHANGE → SURESTARIES */}
                              {FACTURE_BODY_KEYS.map(renderFixedRow)}

                              {/* Extra libellés added by the user — between body and footer */}
                              {form.facture.extras.map((e) => (
                                <div
                                  key={e.id}
                                  className="container-row grid grid-cols-1 sm:grid-cols-[10.5rem_1fr_1fr_1.3fr_2.25rem] gap-2 items-center"
                                >
                                  <input
                                    className="input !px-2.5 text-xs font-semibold"
                                    value={e.libelle}
                                    onChange={(ev) =>
                                      updateFactureExtra(e.id, "libelle", ev.target.value)
                                    }
                                    placeholder="LIBELLE"
                                    style={upper}
                                  />
                                  <input
                                    className="input font-mono text-sm"
                                    inputMode="decimal"
                                    value={e.debours}
                                    onChange={(ev) =>
                                      updateFactureExtra(e.id, "debours", ev.target.value)
                                    }
                                    placeholder="DEBOURS"
                                  />
                                  <input
                                    className="input font-mono text-sm"
                                    inputMode="decimal"
                                    value={e.produit}
                                    onChange={(ev) =>
                                      updateFactureExtra(e.id, "produit", ev.target.value)
                                    }
                                    placeholder="PRODUIT"
                                  />
                                  <input
                                    className="input text-sm"
                                    value={e.observation}
                                    onChange={(ev) =>
                                      updateFactureExtra(e.id, "observation", ev.target.value)
                                    }
                                    placeholder="OBSERVATION"
                                  />
                                  <button
                                    onClick={() => removeFactureExtra(e.id)}
                                    className="inline-flex items-center justify-center gap-1.5 p-1.5 rounded-lg text-rose-300/80 bg-rose-500/10 border border-rose-500/25 hover:text-white hover:bg-rose-500/25 transition-colors justify-self-stretch sm:justify-self-center"
                                    title="Supprimer cette ligne"
                                    aria-label="Supprimer cette ligne"
                                  >
                                    <Trash2 size={15} />
                                    <span className="sm:hidden text-xs font-medium">
                                      Supprimer la ligne
                                    </span>
                                  </button>
                                </div>
                              ))}

                              {/* Footer rows: OUVERTURE DOSSIER → TIMBRE (always last) */}
                              {FACTURE_FOOTER_KEYS.map(renderFixedRow)}
                            </>
                          );
                        })()}

                        {/* live totals */}
                        <div className="grid grid-cols-1 sm:grid-cols-[10.5rem_1fr_1fr_1.3fr_2.25rem] gap-2 items-center pt-3 mt-1 border-t border-slate-800">
                          <span className="text-xs font-bold text-slate-200">TAUX</span>
                          <span className="total-cell">
                            {factureCalc.tauxDebours || "—"}
                          </span>
                          <span className="total-cell">
                            {factureCalc.tauxProduit || "—"}
                          </span>
                          <span />
                          <span />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-[10.5rem_1fr_1fr_1.3fr_2.25rem] gap-2 items-center">
                          <span className="text-xs font-bold text-slate-200">
                            TOTAL TTC
                          </span>
                          <span className="total-cell total-cell-strong sm:col-span-2">
                            {factureCalc.totalTtc || "—"}
                          </span>
                          <span />
                          <span />
                        </div>
                        <p className="text-xs text-slate-500 pt-1">
                          TVA 9% calculée sur OUVERTURE DOSSIER (débours ou produit) —
                          modifiable à la main. TAUX = somme de chaque colonne,
                          TOTAL TTC = débours + produit.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </section>
                </div>
              </fieldset>
            </div>

            {/* Actions */}
            <div className="mt-8 pt-5 pb-2 border-t border-slate-800">
              {!canGenerate ? (
                <p className="text-xs text-slate-500 mb-3">
                  Every part is optional — complete any one of them to generate: transit
                  documents (names + shipping company + containers + at least one
                  document type), the DCP declaration, the tariff annex, the
                  Mandat MSC (its entreprise + transitaire names), or the Facture (client name).
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
                  {factureReady && (
                    <span className="doc-pill">1 × Facture de transit</span>
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

            {/* ── Folder cover (page glued on the client's folder) ─────── */}
            <FolderCover
              source={{
                client: form.client_name,
                line: companyName,
                bl: form.bl_number,
                containers: form.containers
                  .filter((c) => c.number.trim())
                  .map((c) => ({ number: c.number.trim(), size: c.size })),
                weight: form.weight_of_all_containers,
                goods: form.marchandise_type,
                packages: form.facture.ligne.nbrs,
              }}
            />

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
                target={isPhone ? undefined : "_blank"}
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
          className={`fixed inset-y-0 right-0 z-50 w-[86vw] max-w-sm h-screen lg:h-full overflow-y-auto border-l border-slate-800 bg-[#0c101c]/95 backdrop-blur-md transition-transform duration-300 lg:static lg:z-auto lg:w-80 lg:shrink-0 lg:bg-slate-900/50 ${
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
                          {entry.payload.facture_enabled && (
                            <span className="doc-pill !text-[10px]">Facture</span>
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
  readOnly = false,
  hint,
}: {
  def: DcpFieldDef;
  value: string;
  dcp: Record<string, string>;
  kbOpen: boolean;
  onChange: (key: string, value: string) => void;
  onToggleKb: () => void;
  onEscape: () => void;
  setRef: (el: HTMLInputElement | null) => void;
  /** Computed field (القيمة بالدينار) — shown, not typed. */
  readOnly?: boolean;
  /** Small helper line under the input. */
  hint?: React.ReactNode;
}) {
  const isDate = def.type === "date";
  /* الوزن: while the box has focus it shows the kg being typed; the form
     always keeps the tonnes, shown again as soon as the box is left. */
  const [kgDraft, setKgDraft] = useState<string | null>(null);
  const suffix = def.kgToTon && kgDraft !== null ? "kg" : def.suffix;
  /* A computed field can't be typed in — no Arabic keyboard for it
     (nor for الوزن, which takes digits only). */
  const showKb = !isDate && !readOnly && !def.kgToTon;
  const isSpec =
    def.currency && (dcp["القيمة_عملة"] || DEFAULT_CURRENCY) === "SPEC";

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    if (def.kgToTon) {
      setKgDraft(v);
      onChange(def.key, kgToTon(v));
      return;
    }
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
              value={dcp["القيمة_عملة"] || DEFAULT_CURRENCY}
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
        {suffix && !def.suffixEnd && (
          <span className="unit-suffix">{suffix}</span>
        )}
        <div className="relative flex-1 min-w-0">
          <input
            ref={setRef}
            type="text"
            dir={isDate || readOnly ? "ltr" : "auto"}
            inputMode={isDate ? "numeric" : def.inputMode}
            maxLength={isDate ? 10 : undefined}
            readOnly={readOnly}
            tabIndex={readOnly ? -1 : undefined}
            className={`input ${showKb ? "!pl-10" : ""} ${
              readOnly ? "dcp-computed" : ""
            }`}
            value={kgDraft ?? value}
            onChange={handleChange}
            onFocus={def.kgToTon ? () => setKgDraft(tonToKg(value)) : undefined}
            onBlur={def.kgToTon ? () => setKgDraft(null) : undefined}
            onKeyDown={(e) => {
              if (e.key === "Escape") onEscape();
            }}
            placeholder={
              isDate ? "dd/mm/yyyy" : readOnly ? "يُحسب تلقائيًا" : def.placeholder
            }
          />
          {showKb && (
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
        {suffix && def.suffixEnd && (
          <span className="unit-suffix">{suffix}</span>
        )}
      </div>
      {hint && <p className="text-[11px] text-slate-500">{hint}</p>}
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

export default App;

