import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FilePlus2,
  Keyboard,
  LayoutGrid,
  Loader2,
  Minus,
  MousePointerClick,
  Plus,
  Redo2,
  Scissors,
  Tag,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { ArabicKeyboard } from "./ArabicKeyboard";

/* ==========================================================================
 * Étiquetage — product labels (ملصقات) laid out freely on A4 sheets, then
 * exported as a PDF to print and cut.
 *
 * Everything is in MILLIMETRES. The browser computes the whole layout of each
 * label (font size, line breaks, baselines, care-symbol position) with the
 * very same font the server uses (IBM Plex Sans Arabic Bold), and the server
 * only draws what it receives — so the PDF matches the screen.
 * ======================================================================== */

const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

/* ---- sheet geometry (mm) ------------------------------------------------ */
const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 6; // printer-safe margin: labels always stay inside it
const GAP = 3; // spacing used by "ترتيب تلقائي" / "ملء الصفحة"
const MIN_W = 22;
const MIN_H = 14;
const DEFAULT_W = 64;
const DEFAULT_H = 44;
const SNAP = 1.8; // snapping distance to edges (mm)

/* ---- text layout -------------------------------------------------------- */
const PAD = 2; // inner padding of a label (mm)
const PT = 0.352778; // 1 pt in mm
const MIN_PT = 4;
const MAX_PT = 30;
const LINE_H = 1.32; // distance between baselines, × font size
const ASC = 1.085; // IBM Plex Sans Arabic ascent / descent (em)
const DESC = 0.415;
const FONT_FAMILY = "EtiqPlexArabic";
const TEXT_U = 10; // px per mm of the (scaled) text layer in the preview
const FONT_URL = "/fonts/PlexSansArabic-Bold.ttf";

/* ---- care symbols (علامة الصيانة) ---------------------------------------
 * Copied from the drawing in TIKTAJ I.docx (the VML group of 10 shapes),
 * in its own units: 1723 × 330. Kept identical in api/labels_pdf.py. */
const CARE_W = 1723;
const CARE_HU = 330;
const CARE_RATIO = CARE_W / CARE_HU;
const CARE_H = 1.15; // symbol height, × font size
const CARE_MIN_SCALE = 0.75; // auto-fit keeps the symbols at least this big

/* ---- cut line (dashed border of each label) ------------------------------ */
const CUT_DASH = 1.6;
const CUT_GAP = 1.1;
const CUT_W = 0.25;
const CUT_INK = "#1f2937"; // same ink as the PDF (api/labels_pdf.py CUT_INK)

const STORAGE_KEY = "etiquetage_v1";
const HISTORY_MAX = 60;

/* --------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------ */

type Label = {
  id: string;
  page: number; // 0-based sheet index
  x: number;
  y: number;
  w: number;
  h: number;
  /** الاسم / العنوان — printed as plain lines, without their titles. */
  name: string;
  address: string;
  product: string;
  composition: string;
  origin: string;
  /** التركيب and علامة الصيانة are optional on each label. */
  showComposition: boolean;
  showCare: boolean;
  /** null = auto-fit to the box; a number = forced size in pt. */
  fontPt: number | null;
};

type Sheet = { pages: number; labels: Label[] };

type Rect = { x: number; y: number; w: number; h: number };

type LaidOut = {
  pt: number;
  /** Baselines are measured from the top of the label (mm). */
  lines: { text: string; baseline: number }[];
  care: Rect | null;
  overflow: boolean;
};

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type Interaction =
  | {
      kind: "move" | "resize";
      id: string;
      handle?: Handle;
      startX: number;
      startY: number;
      orig: Rect;
      before: Sheet;
      moved: boolean;
    }
  | null;

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

const newLabel = (page: number, x: number, y: number, w = DEFAULT_W, h = DEFAULT_H): Label => ({
  id: uid(),
  page,
  x,
  y,
  w,
  h,
  name: "",
  address: "",
  product: "",
  composition: "",
  origin: "الصين",
  showComposition: true,
  showCare: true,
  fontPt: null,
});

const overlaps = (a: Rect, b: Rect, gap = 0) =>
  a.x < b.x + b.w + gap - 0.01 &&
  b.x < a.x + a.w + gap - 0.01 &&
  a.y < b.y + b.h + gap - 0.01 &&
  b.y < a.y + a.h + gap - 0.01;

/** First free spot for a w×h label on a page, in Arabic reading order
 *  (top to bottom, right to left). null when the page is full. */
function findFreeSpot(labels: Label[], page: number, w: number, h: number): { x: number; y: number } | null {
  const others = labels.filter((l) => l.page === page);
  const xs = new Set<number>([PAGE_W - MARGIN - w]);
  const ys = new Set<number>([MARGIN]);
  for (const o of others) {
    xs.add(o.x - GAP - w);
    xs.add(o.x + o.w + GAP);
    xs.add(o.x + o.w - w);
    ys.add(o.y);
    ys.add(o.y + o.h + GAP);
  }
  const candidates: { x: number; y: number }[] = [];
  for (const y of ys) for (const x of xs) candidates.push({ x, y });
  candidates.sort((a, b) => a.y - b.y || b.x - a.x);
  for (const c of candidates) {
    if (c.x < MARGIN - 0.01 || c.y < MARGIN - 0.01) continue;
    if (c.x + w > PAGE_W - MARGIN + 0.01 || c.y + h > PAGE_H - MARGIN + 0.01) continue;
    const r = { x: c.x, y: c.y, w, h };
    if (others.every((o) => !overlaps(r, o, GAP))) return { x: round1(c.x), y: round1(c.y) };
  }
  return null;
}

/** Re-pack every label in reading order, page after page. */
function autoArrange(sheet: Sheet): Sheet {
  const sorted = [...sheet.labels].sort(
    (a, b) => a.page - b.page || a.y - b.y || b.x - a.x
  );
  const maxW = PAGE_W - 2 * MARGIN;
  const maxH = PAGE_H - 2 * MARGIN;
  let page = 0;
  let cursorX = PAGE_W - MARGIN; // right edge of the next label
  let rowY = MARGIN;
  let rowH = 0;
  const out: Label[] = [];
  for (const l of sorted) {
    const w = Math.min(l.w, maxW);
    const h = Math.min(l.h, maxH);
    if (cursorX - w < MARGIN - 0.01) {
      rowY += rowH + GAP;
      cursorX = PAGE_W - MARGIN;
      rowH = 0;
    }
    if (rowY + h > PAGE_H - MARGIN + 0.01) {
      page += 1;
      rowY = MARGIN;
      cursorX = PAGE_W - MARGIN;
      rowH = 0;
    }
    out.push({ ...l, page, w, h, x: round1(cursorX - w), y: round1(rowY) });
    cursorX -= w + GAP;
    rowH = Math.max(rowH, h);
  }
  return { pages: Math.max(sheet.pages, page + 1), labels: out };
}

/** The labels used to carry a small scissors icon on their top edge. The icon
 *  is gone, but its size still sets the top padding so the text keeps exactly
 *  the same place on the label. */
const scissorsFor = (w: number, h: number) => {
  const size = clamp(Math.min(w, h) * 0.13, 3.2, 5);
  return { size, cx: w - size * 1.9, cy: 0 };
};

/** Top padding (unchanged since the scissors icon was removed). */
const padTop = (l: { w: number; h: number }) =>
  Math.max(PAD, scissorsFor(l.w, l.h).size / 2 + 0.4);

/* ---- text measurement (canvas, same font as the PDF) --------------------- */

let measureCtx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>(); // text -> width at 100px

function textWidth100(text: string): number {
  const hit = widthCache.get(text);
  if (hit !== undefined) return hit;
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  let w = text.length * 55; // fallback estimate
  if (measureCtx) {
    measureCtx.font = `100px "${FONT_FAMILY}", "Noto Sans Arabic", Arial, sans-serif`;
    measureCtx.direction = "rtl";
    w = measureCtx.measureText(text).width;
  }
  if (widthCache.size > 20000) widthCache.clear();
  widthCache.set(text, w);
  return w;
}

/** Width of a string in mm at a given pt size. */
const measureMm = (text: string, pt: number) => (textWidth100(text) / 100) * pt * PT;

/** Greedy word wrap. `hard` = a single word had to be cut. */
function wrap(text: string, pt: number, maxW: number): { lines: string[]; hard: boolean } {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [], hard: false };
  const lines: string[] = [];
  let hard = false;
  let line = "";
  for (const word of words) {
    let pieces = [word];
    if (measureMm(word, pt) > maxW) {
      hard = true;
      pieces = [];
      let cur = "";
      for (const ch of Array.from(word)) {
        if (cur && measureMm(cur + ch, pt) > maxW) {
          pieces.push(cur);
          cur = ch;
        } else cur += ch;
      }
      if (cur) pieces.push(cur);
    }
    for (const piece of pieces) {
      const cand = line ? `${line} ${piece}` : piece;
      if (line && measureMm(cand, pt) > maxW) {
        lines.push(line);
        line = piece;
      } else line = cand;
    }
  }
  if (line) lines.push(line);
  return { lines, hard };
}

/** The printed paragraphs of a label, in order. */
function paragraphs(l: Label): { text: string; care?: boolean }[] {
  const out: { text: string; care?: boolean }[] = [];
  // الاسم / العنوان: values only (their titles exist only on screen)
  for (const part of [l.name, l.address]) {
    for (const ln of part.split(/\n/)) if (ln.trim()) out.push({ text: ln.trim() });
  }
  out.push({ text: `المنتوج: ${l.product.trim()}`.trim() });
  if (l.showComposition) out.push({ text: `التركيب: ${l.composition.trim()}`.trim() });
  out.push({ text: `المنشأ: ${l.origin.trim()}`.trim() });
  if (l.showCare) out.push({ text: "علامة الصيانة:", care: true });
  return out;
}

type Row =
  | { kind: "text"; text: string; h: number }
  | { kind: "careInline"; text: string; h: number; tw: number; cw: number; ch: number; gap: number };

function buildRows(
  l: Label,
  pt: number
): { rows: Row[]; height: number; hard: boolean; squeezed: boolean } {
  const innerW = l.w - 2 * PAD;
  const S = pt * PT;
  const lh = S * LINE_H;
  const rows: Row[] = [];
  let hard = false;
  let squeezed = false;
  for (const p of paragraphs(l)) {
    if (p.care) {
      /* The symbols ALWAYS sit on the same line as "علامة الصيانة:", to its
         left — never on a line below. When the line is too short they shrink
         into the free space (auto-fit picks a font size where they keep at
         least CARE_MIN_SCALE of their natural size). */
      const gap = S * 0.45;
      const wr = wrap(p.text, pt, innerW); // one line, except in a tiny box
      hard ||= wr.hard;
      const titleLines = wr.lines.length ? wr.lines : [p.text];
      for (const t of titleLines.slice(0, -1)) rows.push({ kind: "text", text: t, h: lh });
      const last = titleLines[titleLines.length - 1];
      const tw = measureMm(last, pt);
      const naturalW = S * CARE_H * CARE_RATIO;
      const cw = Math.min(naturalW, Math.max(0, innerW - tw - gap));
      const ch = cw / CARE_RATIO;
      if (cw < naturalW * CARE_MIN_SCALE) squeezed = true;
      rows.push({ kind: "careInline", text: last, h: Math.max(lh, ch * 1.3), tw, cw, ch, gap });
    } else {
      const wr = wrap(p.text, pt, innerW);
      hard ||= wr.hard;
      for (const t of wr.lines) rows.push({ kind: "text", text: t, h: lh });
    }
  }
  return { rows, height: rows.reduce((a, r) => a + r.h, 0), hard, squeezed };
}

function place(l: Label, pt: number, rows: Row[], height: number): LaidOut {
  const S = pt * PT;
  const top = padTop(l);
  const innerH = l.h - top - PAD;
  let y = top + Math.max(0, (innerH - height) / 2);
  const right = l.w - PAD;
  const lines: { text: string; baseline: number }[] = [];
  let care: Rect | null = null;
  // visual centre of Arabic glyphs sits ~0.22 em above the baseline
  const baselineIn = (top: number, h: number) => top + h / 2 + S * 0.22;
  for (const r of rows) {
    if (r.kind === "text") {
      lines.push({ text: r.text, baseline: baselineIn(y, r.h) });
    } else {
      lines.push({ text: r.text, baseline: baselineIn(y, r.h) });
      if (r.cw > 0.3) {
        care = { x: right - r.tw - r.gap - r.cw, y: y + (r.h - r.ch) / 2, w: r.cw, h: r.ch };
      }
    }
    y += r.h;
  }
  return { pt, lines, care, overflow: height > innerH + 0.05 };
}

const layoutCache = new Map<string, LaidOut & { autoPt: number }>();

/** Full layout of one label (cached — moving a label doesn't recompute). */
function layoutLabel(l: Label, fontKey: number): LaidOut & { autoPt: number } {
  const key = JSON.stringify([
    fontKey, l.w, l.h, l.name, l.address, l.product, l.composition, l.origin,
    l.showComposition, l.showCare, l.fontPt,
  ]);
  const hit = layoutCache.get(key);
  if (hit) return hit;

  const innerH = l.h - padTop(l) - PAD;
  const fits = (pt: number) => {
    const b = buildRows(l, pt);
    return !b.hard && !b.squeezed && b.height <= innerH;
  };
  // auto-fit: the biggest size that fits without cutting a word
  let autoPt = MIN_PT;
  if (fits(MAX_PT)) autoPt = MAX_PT;
  else if (fits(MIN_PT)) {
    let lo = MIN_PT;
    let hi = MAX_PT;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    autoPt = Math.floor(lo * 4) / 4;
  }
  const pt = l.fontPt ?? autoPt;
  const b = buildRows(l, pt);
  const out = { ...place(l, pt, b.rows, b.height), autoPt };
  // a cut word or care symbols squeezed too small = "doesn't fit" warning
  if (b.hard || b.squeezed) out.overflow = true;
  if (layoutCache.size > 3000) layoutCache.clear();
  layoutCache.set(key, out);
  return out;
}

/* ---- persistence --------------------------------------------------------- */

function loadSheet(): Sheet {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { pages: 1, labels: [] };
    const p = JSON.parse(raw);
    if (!p || !Array.isArray(p.labels)) return { pages: 1, labels: [] };
    const labels: Label[] = p.labels
      .filter((l: Partial<Label>) => l && typeof l.id === "string")
      .map((l: Partial<Label>) => ({ ...newLabel(0, MARGIN, MARGIN), ...l }));
    const pages = Math.max(1, Number(p.pages) || 1, ...labels.map((l) => l.page + 1));
    return { pages, labels };
  } catch {
    return { pages: 1, labels: [] };
  }
}

function saveSheet(s: Sheet) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — autosave is a convenience only */
  }
}

/* ---- snapping ------------------------------------------------------------ */

/** Snap a value (or one of several edges) to the nearest target. */
function snapAxis(
  edges: number[],
  targets: number[]
): { delta: number; guide: number | null } {
  let best: { delta: number; guide: number | null } = { delta: 0, guide: null };
  let bestDist = SNAP;
  for (const e of edges) {
    for (const t of targets) {
      const d = Math.abs(t - e);
      if (d < bestDist) {
        bestDist = d;
        best = { delta: t - e, guide: t };
      }
    }
  }
  return best;
}

function snapTargets(labels: Label[], page: number, exceptId: string) {
  const xs = [MARGIN, PAGE_W - MARGIN, PAGE_W / 2];
  const ys = [MARGIN, PAGE_H - MARGIN, PAGE_H / 2];
  for (const o of labels) {
    if (o.page !== page || o.id === exceptId) continue;
    xs.push(o.x, o.x + o.w, o.x - GAP, o.x + o.w + GAP);
    ys.push(o.y, o.y + o.h, o.y - GAP, o.y + o.h + GAP);
  }
  return { xs, ys };
}

/* --------------------------------------------------------------------------
 * Care symbols (SVG, same geometry as the PDF)
 * ------------------------------------------------------------------------ */

function CareSymbols({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      className={className}
      style={style}
      viewBox={`-8 -8 ${CARE_W + 16} ${CARE_HU + 16}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <g fill="none" stroke="currentColor" strokeWidth={16} strokeLinejoin="round">
        {/* iron */}
        <rect x={1390} y={227.3} width={333} height={102.7} />
        <line x1={1560.1} y1={105} x2={1723} y2={227.3} />
        <line x1={1305} y1={105} x2={1560.1} y2={105} />
        {/* wash tub */}
        <polygon points="1020,105 1091.2,330 1233.8,330 1305,105" />
        {/* crossed triangle — do not bleach */}
        <polygon points="855.5,0 968,330 743,330" />
        <line x1={705} y1={0} x2={848} y2={330} />
        <line x1={1001} y1={0} x2={848} y2={330} />
        {/* dry clean */}
        <ellipse cx={562.5} cy={217.5} rx={142.5} ry={112.5} />
        {/* tumble dry */}
        <rect x={0} y={30} width={345} height={300} />
        <ellipse cx={172.5} cy={180} rx={172.5} ry={150} />
      </g>
    </svg>
  );
}


/* --------------------------------------------------------------------------
 * Inspector field with the Arabic on-screen keyboard
 * ------------------------------------------------------------------------ */

function ArField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  multiline,
  kbOpen,
  onToggleKb,
  disabled,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  kbOpen: boolean;
  onToggleKb: () => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  const insert = (ch: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + ch + value.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + ch.length, start + ch.length);
    });
  };
  const backspace = () => {
    const el = ref.current;
    let start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    if (start === end) {
      if (start === 0) return;
      start -= 1;
    }
    onChange(value.slice(0, start) + value.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start, start);
    });
  };

  const common = {
    ref,
    dir: "auto" as const,
    value,
    placeholder,
    disabled,
    className: `input !pl-10 ${disabled ? "opacity-40" : ""}`,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(e.target.value),
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className="text-sm font-medium text-slate-300">{label}</label>
        {children}
      </div>
      <div className="relative">
        {multiline ? <textarea rows={2} {...common} className={`${common.className} resize-none`} /> : <input type="text" {...common} />}
        {!disabled && (
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onToggleKb}
            className={`kb-toggle ${multiline ? "!top-5" : ""} ${kbOpen ? "kb-toggle-active" : ""}`}
            title="لوحة مفاتيح عربية"
            aria-label="لوحة مفاتيح عربية"
          >
            <Keyboard size={15} />
          </button>
        )}
      </div>
      {hint && <p className="text-[11px] text-slate-500">{hint}</p>}
      {kbOpen && !disabled && (
        <ArabicKeyboard
          onKey={insert}
          onBackspace={backspace}
          onClear={() => onChange("")}
          onClose={onToggleKb}
        />
      )}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none text-xs text-slate-400">
      <span>{label}</span>
      <span className="relative shrink-0" dir="ltr">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span className="block w-9 h-5 rounded-full bg-slate-700 peer-checked:bg-indigo-500 transition-colors" />
        <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
      </span>
    </label>
  );
}

const ORIGIN_CHIPS = ["الصين", "تركيا", "إيطاليا", "الهند", "إسبانيا"];

/* --------------------------------------------------------------------------
 * Page component
 * ------------------------------------------------------------------------ */

export default function Etiquetage({ active }: { active: boolean }) {
  const [sheet, setSheet] = useState<Sheet>(loadSheet);
  const [past, setPast] = useState<Sheet[]>([]);
  const [future, setFuture] = useState<Sheet[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activePage, setActivePage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fitScale, setFitScale] = useState(3);
  const [fontKey, setFontKey] = useState(0); // bumps once the font is loaded
  const [guides, setGuides] = useState<{ page: number; xs: number[]; ys: number[] } | null>(null);
  const [kbField, setKbField] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const interaction = useRef<Interaction>(null);
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  const canvasRef = useRef<HTMLDivElement>(null);

  const s = fitScale * zoom; // px per mm
  const selected = sheet.labels.find((l) => l.id === selectedId) ?? null;

  const flash = (message: string, type: "success" | "error") => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 3000);
  };

  /* ---- load the label font (measurement must use the real glyphs) ------- */
  useEffect(() => {
    let cancelled = false;
    const face = new FontFace(FONT_FAMILY, `url(${FONT_URL})`);
    face
      .load()
      .then((f) => {
        document.fonts.add(f);
        widthCache.clear();
        layoutCache.clear();
        if (!cancelled) setFontKey(1);
      })
      .catch(() => {
        if (!cancelled) setFontKey(-1);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---- autosave ----------------------------------------------------------- */
  useEffect(() => {
    const t = window.setTimeout(() => saveSheet(sheet), 250);
    return () => window.clearTimeout(t);
  }, [sheet]);

  /* ---- fit the sheet to the available width ------------------------------ */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setFitScale(clamp((w - 32) / PAGE_W, 1.2, 4));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);

  /* ---- history ------------------------------------------------------------ */
  /** Typing in one field keeps ONE undo step (not one per letter). */
  const lastEdit = useRef<{ key: string; t: number } | null>(null);

  const commit = useCallback((next: Sheet, mergeKey?: string) => {
    const now = Date.now();
    const merge =
      mergeKey !== undefined &&
      lastEdit.current?.key === mergeKey &&
      now - lastEdit.current.t < 1500;
    lastEdit.current = mergeKey !== undefined ? { key: mergeKey, t: now } : null;
    if (!merge) {
      const prev = sheetRef.current;
      setPast((p) => [...p.slice(-(HISTORY_MAX - 1)), prev]);
    }
    setFuture([]);
    setSheet(next);
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (!p.length) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [sheetRef.current, ...f].slice(0, HISTORY_MAX));
      setSheet(prev);
      return p.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f;
      const next = f[0];
      setPast((p) => [...p, sheetRef.current].slice(-HISTORY_MAX));
      setSheet(next);
      return f.slice(1);
    });
  }, []);

  /* ---- label operations --------------------------------------------------- */
  const updateLabel = (id: string, patch: Partial<Label>, mergeKey?: string) => {
    const cur = sheetRef.current;
    const next = { ...cur, labels: cur.labels.map((l) => (l.id === id ? { ...l, ...patch } : l)) };
    commit(next, mergeKey && `${id}:${mergeKey}`);
    sheetRef.current = next; // several quick edits in a row stay consistent
  };

  const addLabel = () => {
    const cur = sheetRef.current;
    const page = clamp(selected ? selected.page : activePage, 0, cur.pages - 1);
    const w = selected ? selected.w : DEFAULT_W;
    const h = selected ? selected.h : DEFAULT_H;
    let spot = findFreeSpot(cur.labels, page, w, h);
    let pages = cur.pages;
    let target = page;
    if (!spot) {
      // try the following pages, else open a new one
      for (let p = page + 1; p < pages && !spot; p++) {
        spot = findFreeSpot(cur.labels, p, w, h);
        if (spot) target = p;
      }
      if (!spot) {
        target = pages;
        pages += 1;
        spot = { x: PAGE_W - MARGIN - w, y: MARGIN };
      }
    }
    const l = newLabel(target, spot.x, spot.y, w, h);
    commit({ pages, labels: [...cur.labels, l] });
    setSelectedId(l.id);
    setActivePage(target);
    setKbField(null);
  };

  const duplicateLabel = (id: string) => {
    const cur = sheetRef.current;
    const src = cur.labels.find((l) => l.id === id);
    if (!src) return;
    let spot = findFreeSpot(cur.labels, src.page, src.w, src.h);
    let page = src.page;
    let pages = cur.pages;
    if (!spot) {
      page = pages;
      pages += 1;
      spot = { x: PAGE_W - MARGIN - src.w, y: MARGIN };
    }
    const copy = { ...src, id: uid(), page, ...spot };
    commit({ pages, labels: [...cur.labels, copy] });
    setSelectedId(copy.id);
    setActivePage(page);
  };

  /** Copies of the label in every free place of its page. */
  const fillPage = (id: string) => {
    const cur = sheetRef.current;
    const src = cur.labels.find((l) => l.id === id);
    if (!src) return;
    const labels = [...cur.labels];
    let added = 0;
    for (let i = 0; i < 300; i++) {
      const spot = findFreeSpot(labels, src.page, src.w, src.h);
      if (!spot) break;
      labels.push({ ...src, id: uid(), ...spot });
      added++;
    }
    if (!added) {
      flash("لا يوجد مكان فارغ في هذه الصفحة.", "error");
      return;
    }
    commit({ ...cur, labels });
    flash(`تمت إضافة ${added} نسخة.`, "success");
  };

  const deleteLabel = (id: string) => {
    const cur = sheetRef.current;
    commit({ ...cur, labels: cur.labels.filter((l) => l.id !== id) });
    if (selectedId === id) setSelectedId(null);
    setKbField(null);
  };

  const addPage = () => {
    const cur = sheetRef.current;
    commit({ ...cur, pages: cur.pages + 1 });
    setActivePage(cur.pages);
    setSelectedId(null);
    requestAnimationFrame(() => {
      document.getElementById(`etq-page-${cur.pages}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const deletePage = (page: number) => {
    const cur = sheetRef.current;
    if (cur.pages <= 1) return;
    commit({
      pages: cur.pages - 1,
      labels: cur.labels
        .filter((l) => l.page !== page)
        .map((l) => (l.page > page ? { ...l, page: l.page - 1 } : l)),
    });
    setSelectedId(null);
    setActivePage((p) => clamp(p > page ? p - 1 : p, 0, cur.pages - 2));
  };

  const arrange = () => {
    const cur = sheetRef.current;
    if (!cur.labels.length) return;
    commit(autoArrange(cur));
    flash("تم ترتيب الملصقات.", "success");
  };

  const clearAll = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      window.setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    commit({ pages: 1, labels: [] });
    setSelectedId(null);
    setActivePage(0);
    setConfirmClear(false);
  };

  /* ---- drag / resize ------------------------------------------------------ */
  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const it = interaction.current;
      if (!it) return;
      const dx = (e.clientX - it.startX) / s;
      const dy = (e.clientY - it.startY) / s;
      if (!it.moved && Math.abs(dx) + Math.abs(dy) < 0.4) return;
      it.moved = true;
      const cur = sheetRef.current;
      const me = cur.labels.find((l) => l.id === it.id);
      if (!me) return;
      const { xs, ys } = snapTargets(cur.labels, me.page, me.id);
      const o = it.orig;
      let r: Rect;
      const g: { xs: number[]; ys: number[] } = { xs: [], ys: [] };

      if (it.kind === "move") {
        let x = o.x + dx;
        let y = o.y + dy;
        const sx = snapAxis([x, x + o.w, x + o.w / 2], xs);
        const sy = snapAxis([y, y + o.h, y + o.h / 2], ys);
        x += sx.delta;
        y += sy.delta;
        if (sx.guide !== null) g.xs.push(sx.guide);
        if (sy.guide !== null) g.ys.push(sy.guide);
        if (sx.guide === null) x = Math.round(x * 2) / 2;
        if (sy.guide === null) y = Math.round(y * 2) / 2;
        r = {
          x: clamp(x, MARGIN, PAGE_W - MARGIN - o.w),
          y: clamp(y, MARGIN, PAGE_H - MARGIN - o.h),
          w: o.w,
          h: o.h,
        };
      } else {
        const hd = it.handle!;
        let left = o.x;
        let right = o.x + o.w;
        let top = o.y;
        let bottom = o.y + o.h;
        if (hd.includes("w")) {
          left = o.x + dx;
          const sn = snapAxis([left], xs);
          left += sn.delta;
          if (sn.guide !== null) g.xs.push(sn.guide);
          else left = Math.round(left * 2) / 2;
          left = clamp(left, MARGIN, right - MIN_W);
        }
        if (hd.includes("e")) {
          right = o.x + o.w + dx;
          const sn = snapAxis([right], xs);
          right += sn.delta;
          if (sn.guide !== null) g.xs.push(sn.guide);
          else right = Math.round(right * 2) / 2;
          right = clamp(right, left + MIN_W, PAGE_W - MARGIN);
        }
        if (hd.includes("n")) {
          top = o.y + dy;
          const sn = snapAxis([top], ys);
          top += sn.delta;
          if (sn.guide !== null) g.ys.push(sn.guide);
          else top = Math.round(top * 2) / 2;
          top = clamp(top, MARGIN, bottom - MIN_H);
        }
        if (hd.includes("s")) {
          bottom = o.y + o.h + dy;
          const sn = snapAxis([bottom], ys);
          bottom += sn.delta;
          if (sn.guide !== null) g.ys.push(sn.guide);
          else bottom = Math.round(bottom * 2) / 2;
          bottom = clamp(bottom, top + MIN_H, PAGE_H - MARGIN);
        }
        r = { x: left, y: top, w: right - left, h: bottom - top };
      }
      setGuides(g.xs.length || g.ys.length ? { page: me.page, ...g } : null);
      setSheet((prev) => ({
        ...prev,
        labels: prev.labels.map((l) => (l.id === it.id ? { ...l, ...r } : l)),
      }));
    },
    [s]
  );

  const onPointerUp = useCallback(() => {
    const it = interaction.current;
    interaction.current = null;
    setGuides(null);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    if (it?.moved) {
      setPast((p) => [...p.slice(-(HISTORY_MAX - 1)), it.before]);
      setFuture([]);
    }
  }, [onPointerMove]);

  const startInteraction = (
    e: React.PointerEvent,
    label: Label,
    kind: "move" | "resize",
    handle?: Handle
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setSelectedId(label.id);
    setActivePage(label.page);
    interaction.current = {
      kind,
      handle,
      id: label.id,
      startX: e.clientX,
      startY: e.clientY,
      orig: { x: label.x, y: label.y, w: label.w, h: label.h },
      before: sheetRef.current,
      moved: false,
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  };

  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    },
    [onPointerMove, onPointerUp]
  );

  /* ---- keyboard shortcuts (only while this page is shown) ----------------- */
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        redo();
        return;
      }
      if (typing || !selectedId) return;
      const cur = sheetRef.current;
      const l = cur.labels.find((x) => x.id === selectedId);
      if (!l) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteLabel(l.id);
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateLabel(l.id);
      } else if (e.key === "Escape") {
        setSelectedId(null);
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 5 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        updateLabel(l.id, {
          x: clamp(l.x + dx, MARGIN, PAGE_W - MARGIN - l.w),
          y: clamp(l.y + dy, MARGIN, PAGE_H - MARGIN - l.h),
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, selectedId, undo, redo]);

  /* ---- layouts ------------------------------------------------------------ */
  const layouts = useMemo(() => {
    const m = new Map<string, LaidOut & { autoPt: number }>();
    for (const l of sheet.labels) m.set(l.id, layoutLabel(l, fontKey));
    return m;
  }, [sheet.labels, fontKey]);

  const overlapIds = useMemo(() => {
    const ids = new Set<string>();
    const ls = sheet.labels;
    for (let i = 0; i < ls.length; i++)
      for (let j = i + 1; j < ls.length; j++)
        if (ls[i].page === ls[j].page && overlaps(ls[i], ls[j], -0.3)) {
          ids.add(ls[i].id);
          ids.add(ls[j].id);
        }
    return ids;
  }, [sheet.labels]);

  /* ---- PDF ---------------------------------------------------------------- */
  const generatePdf = async () => {
    if (!sheet.labels.length || isGenerating) return;
    setIsGenerating(true);
    setKbField(null);
    const usedPages = Math.max(...sheet.labels.map((l) => l.page)) + 1;
    const payload = {
      pages: usedPages,
      labels: sheet.labels
        .slice()
        .sort((a, b) => a.page - b.page || a.y - b.y || b.x - a.x)
        .map((l) => {
          const lay = layouts.get(l.id) ?? layoutLabel(l, fontKey);
          return {
            page: l.page,
            x: l.x,
            y: l.y,
            w: l.w,
            h: l.h,
            size_pt: lay.pt,
            max_width: l.w - 2 * PAD,
            lines: lay.lines.map((ln) => ({
              text: ln.text,
              x_right: l.x + l.w - PAD,
              baseline: l.y + ln.baseline,
            })),
            care: lay.care
              ? { x: l.x + lay.care.x, y: l.y + lay.care.y, w: lay.care.w, h: lay.care.h }
              : null,
          };
        }),
    };
    try {
      const res = await fetch(`${API_URL}/api/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let message = `Server error (HTTP ${res.status})`;
        try {
          const data = await res.json();
          if (data?.detail) message = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
        } catch {
          /* keep the generic message */
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      a.href = url;
      a.download = `ETIQUETTES_${stamp}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      flash(`تم إنشاء PDF — ${sheet.labels.length} ملصق.`, "success");
    } catch (err) {
      const message =
        err instanceof TypeError
          ? "تعذر الاتصال بالخادم. في التطوير المحلي شغّل: uvicorn api.index:app --reload --port 8000"
          : err instanceof Error
            ? err.message
            : "حدث خطأ غير متوقع.";
      flash(message, "error");
    } finally {
      setIsGenerating(false);
    }
  };

  /* ---- render ------------------------------------------------------------- */
  const pages = Array.from({ length: sheet.pages }, (_, i) => i);
  const selLayout = selected ? layouts.get(selected.id) : null;
  const toggleKb = (key: string) => setKbField((k) => (k === key ? null : key));

  const inspector = selected && (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Tag size={16} className="text-indigo-400" /> الملصق المحدد
        </h3>
        <button
          type="button"
          className="paper-close"
          onClick={() => {
            setSelectedId(null);
            setKbField(null);
          }}
          aria-label="إغلاق"
          title="إلغاء التحديد"
        >
          <X size={15} />
        </button>
      </div>

      <ArField
        label="الاسم"
        hint="يُطبع بدون كلمة «الاسم»"
        value={selected.name}
        onChange={(v) => updateLabel(selected.id, { name: v }, "name")}
        placeholder="مثال: ش.ذ.م.م ... للاستيراد والتصدير"
        kbOpen={kbField === "name"}
        onToggleKb={() => toggleKb("name")}
      />
      <ArField
        label="العنوان"
        hint="يُطبع بدون كلمة «العنوان»"
        value={selected.address}
        onChange={(v) => updateLabel(selected.id, { address: v }, "address")}
        placeholder="العنوان الكامل"
        multiline
        kbOpen={kbField === "address"}
        onToggleKb={() => toggleKb("address")}
      />
      <ArField
        label="المنتوج"
        value={selected.product}
        onChange={(v) => updateLabel(selected.id, { product: v }, "product")}
        placeholder="مثال: بيجاما"
        kbOpen={kbField === "product"}
        onToggleKb={() => toggleKb("product")}
      />
      <ArField
        label="التركيب"
        value={selected.composition}
        onChange={(v) => updateLabel(selected.id, { composition: v }, "composition")}
        placeholder="مثال: 65% كوتون 35% بوليستر"
        disabled={!selected.showComposition}
        kbOpen={kbField === "composition"}
        onToggleKb={() => toggleKb("composition")}
      >
        <Toggle
          label={selected.showComposition ? "يظهر" : "مخفي"}
          checked={selected.showComposition}
          onChange={(v) => updateLabel(selected.id, { showComposition: v })}
        />
      </ArField>
      <ArField
        label="المنشأ"
        value={selected.origin}
        onChange={(v) => updateLabel(selected.id, { origin: v }, "origin")}
        placeholder="الصين"
        kbOpen={kbField === "origin"}
        onToggleKb={() => toggleKb("origin")}
      />
      <div className="flex flex-wrap gap-1.5 -mt-2">
        {ORIGIN_CHIPS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => updateLabel(selected.id, { origin: c })}
            className={`etq-chip ${selected.origin.trim() === c ? "etq-chip-active" : ""}`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-slate-300">علامة الصيانة</span>
          <Toggle
            label={selected.showCare ? "تظهر" : "مخفية"}
            checked={selected.showCare}
            onChange={(v) => updateLabel(selected.id, { showCare: v })}
          />
        </div>
        <div className={`rounded-lg border border-slate-700/70 bg-white px-3 py-2.5 ${selected.showCare ? "" : "opacity-30"}`}>
          <CareSymbols className="block h-7 mx-auto text-black" style={{ width: 28 * CARE_RATIO }} />
        </div>
        <p className="text-[11px] text-slate-500">رسم ثابت منسوخ من ملف TIKTAJ.</p>
      </div>

      {/* text size */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-slate-300">حجم الخط</span>
        <div className="flex items-center gap-2" dir="ltr">
          <button
            type="button"
            className={`etq-seg ${selected.fontPt === null ? "etq-seg-active" : ""}`}
            onClick={() => updateLabel(selected.id, { fontPt: null })}
          >
            تلقائي
          </button>
          <button
            type="button"
            className="etq-icon-btn"
            onClick={() =>
              updateLabel(selected.id, {
                fontPt: clamp(Math.round(((selected.fontPt ?? selLayout?.pt ?? 8) - 0.5) * 2) / 2, MIN_PT, MAX_PT),
              })
            }
            title="تصغير الخط"
            aria-label="تصغير الخط"
          >
            <Minus size={14} />
          </button>
          <span className="min-w-[4.5rem] text-center text-sm font-semibold text-slate-200 tabular-nums">
            {(selLayout?.pt ?? 0).toFixed(1)} pt
          </span>
          <button
            type="button"
            className="etq-icon-btn"
            onClick={() =>
              updateLabel(selected.id, {
                fontPt: clamp(Math.round(((selected.fontPt ?? selLayout?.pt ?? 8) + 0.5) * 2) / 2, MIN_PT, MAX_PT),
              })
            }
            title="تكبير الخط"
            aria-label="تكبير الخط"
          >
            <Plus size={14} />
          </button>
        </div>
        {selLayout?.overflow && (
          <p className="flex items-start gap-1.5 text-xs text-amber-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            النص أكبر من الملصق — كبّر الملصق أو صغّر الخط أو اختر «تلقائي».
          </p>
        )}
      </div>

      {/* size */}
      <div className="grid grid-cols-2 gap-3">
        {(["w", "h"] as const).map((k) => (
          <label key={k} className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-slate-400">{k === "w" ? "العرض (مم)" : "الارتفاع (مم)"}</span>
            <input
              type="number"
              dir="ltr"
              className="input"
              min={k === "w" ? MIN_W : MIN_H}
              max={k === "w" ? PAGE_W - 2 * MARGIN : PAGE_H - 2 * MARGIN}
              step={1}
              value={Math.round(selected[k] * 10) / 10}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                if (k === "w") {
                  const w = clamp(v, MIN_W, PAGE_W - 2 * MARGIN);
                  updateLabel(selected.id, { w, x: clamp(selected.x, MARGIN, PAGE_W - MARGIN - w) });
                } else {
                  const h = clamp(v, MIN_H, PAGE_H - 2 * MARGIN);
                  updateLabel(selected.id, { h, y: clamp(selected.y, MARGIN, PAGE_H - MARGIN - h) });
                }
              }}
            />
          </label>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2 pt-1">
        <button type="button" className="etq-action" onClick={() => duplicateLabel(selected.id)} title="Ctrl+D">
          <Copy size={15} /> نسخ
        </button>
        <button type="button" className="etq-action" onClick={() => fillPage(selected.id)}>
          <LayoutGrid size={15} /> ملء الصفحة
        </button>
        <button type="button" className="etq-action etq-action-danger" onClick={() => deleteLabel(selected.id)} title="Delete">
          <Trash2 size={15} /> حذف
        </button>
      </div>
    </div>
  );

  return (
    <div className="app-shell h-full flex flex-col lg:flex-row" dir="rtl">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-5 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2.5 px-4 py-2.5 rounded-xl border shadow-2xl backdrop-blur-md animate-[toastIn_.25s_ease] max-w-[calc(100vw-2rem)] ${
            toast.type === "success"
              ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200"
              : "bg-rose-500/15 border-rose-500/40 text-rose-200"
          }`}
        >
          {toast.type === "success" ? <CheckCircle2 size={16} className="shrink-0" /> : <AlertTriangle size={16} className="shrink-0" />}
          <span className="text-sm font-medium">{toast.message}</span>
        </div>
      )}

      {/* ── Inspector (right on desktop) ─────────────────────────────── */}
      <aside className="etq-inspector hidden lg:block">
        {inspector || (
          <div className="h-full flex flex-col items-center justify-center text-center gap-3 px-4 text-slate-400">
            <div className="grid place-items-center w-14 h-14 rounded-2xl bg-indigo-500/10 border border-indigo-500/30">
              <MousePointerClick size={24} className="text-indigo-300" />
            </div>
            <p className="text-sm font-semibold text-slate-200">اختر ملصقًا لتعديله</p>
            <p className="text-xs leading-relaxed">
              اضغط على أي ملصق في الورقة لتعبئة الاسم والعنوان والمنتوج…
              <br />
              أو أضف ملصقًا جديدًا.
            </p>
            <button type="button" className="btn-primary !py-2.5 !px-4 mt-1" onClick={addLabel}>
              <Plus size={16} /> ملصق جديد
            </button>
          </div>
        )}
      </aside>

      {/* ── Workspace ──────────────────────────────────────────────────── */}
      <section className="flex-1 min-w-0 min-h-0 flex flex-col">
        {/* Header + toolbar */}
        <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-6 pb-3 border-b border-slate-800/80 bg-[#0a0d14]/60 backdrop-blur">
          <div className="flex items-center gap-3 mb-3">
            <div className="grid place-items-center w-10 h-10 shrink-0 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 shadow-lg shadow-indigo-500/30">
              <Tag size={20} className="text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-bold text-white leading-tight">
                Étiquetage <span className="text-slate-400 font-semibold">— الملصقات</span>
              </h1>
              <p className="hidden sm:block text-xs text-slate-400 truncate">
                أضف الملصقات، حرّكها وغيّر حجمها، ثم حمّل PDF — اقطع على الخط المتقطع ✂
              </p>
            </div>
            <button
              type="button"
              className="btn-primary !py-2.5 !px-4 !text-sm ms-auto shrink-0"
              onClick={generatePdf}
              disabled={!sheet.labels.length || isGenerating}
            >
              {isGenerating ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              تحميل PDF
              {sheet.labels.length > 0 && (
                <span className="text-[11px] font-semibold bg-white/15 rounded-full px-2 py-0.5">
                  {sheet.labels.length}
                </span>
              )}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary !py-2 !px-3.5 !text-sm" onClick={addLabel}>
              <Plus size={16} /> ملصق جديد
            </button>
            <button type="button" className="etq-tool" onClick={arrange} disabled={!sheet.labels.length} title="ترتيب تلقائي">
              <LayoutGrid size={15} /> <span className="hidden sm:inline">ترتيب تلقائي</span>
            </button>
            <button type="button" className="etq-tool" onClick={addPage} title="صفحة جديدة">
              <FilePlus2 size={15} /> <span className="hidden sm:inline">صفحة جديدة</span>
            </button>
            <span className="etq-divider" />
            <button type="button" className="etq-icon-btn" onClick={undo} disabled={!past.length} title="تراجع (Ctrl+Z)" aria-label="تراجع">
              <Undo2 size={15} />
            </button>
            <button type="button" className="etq-icon-btn" onClick={redo} disabled={!future.length} title="إعادة (Ctrl+Y)" aria-label="إعادة">
              <Redo2 size={15} />
            </button>
            <span className="etq-divider hidden sm:block" />
            <button type="button" className="etq-icon-btn" onClick={() => setZoom((z) => clamp(round1(z - 0.15), 0.4, 2.5))} title="تصغير" aria-label="تصغير">
              <ZoomOut size={15} />
            </button>
            <button type="button" className="text-xs tabular-nums text-slate-400 w-11 text-center" onClick={() => setZoom(1)} title="ملاءمة العرض">
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" className="etq-icon-btn" onClick={() => setZoom((z) => clamp(round1(z + 0.15), 0.4, 2.5))} title="تكبير" aria-label="تكبير">
              <ZoomIn size={15} />
            </button>
            <span className="etq-divider hidden sm:block" />
            <button
              type="button"
              className={`etq-tool ${confirmClear ? "etq-tool-danger" : ""}`}
              onClick={clearAll}
              disabled={!sheet.labels.length && sheet.pages === 1}
              title="مسح الكل"
            >
              <Trash2 size={15} />{" "}
              <span className={confirmClear ? "" : "hidden sm:inline"}>
                {confirmClear ? "تأكيد المسح؟" : "مسح الكل"}
              </span>
            </button>
          </div>
        </div>

        {/* Sheets */}
        <div
          ref={canvasRef}
          className="etq-canvas flex-1 min-h-0 overflow-auto"
          onPointerDown={() => {
            setSelectedId(null);
            setKbField(null);
          }}
        >
          <div
            className={`flex flex-col items-center gap-6 py-6 px-4 ${selected ? "max-lg:pb-[50vh]" : ""}`}
            style={{ minWidth: PAGE_W * s + 32 }}
          >
            {pages.map((p) => {
              const onPage = sheet.labels.filter((l) => l.page === p);
              return (
                <div key={p} id={`etq-page-${p}`} className="flex flex-col gap-2" dir="rtl">
                  <div className="flex items-center justify-between text-xs text-slate-400" style={{ width: PAGE_W * s }}>
                    <span className={`font-semibold ${activePage === p ? "text-indigo-300" : ""}`}>
                      صفحة {p + 1} <span className="text-slate-500 font-normal">— {onPage.length} ملصق</span>
                    </span>
                    {sheet.pages > 1 && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-slate-500 hover:text-rose-300"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => deletePage(p)}
                      >
                        <Trash2 size={13} /> حذف الصفحة
                      </button>
                    )}
                  </div>
                  <div
                    className={`etq-sheet ${activePage === p ? "etq-sheet-active" : ""}`}
                    style={{ width: PAGE_W * s, height: PAGE_H * s }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelectedId(null);
                      setKbField(null);
                      setActivePage(p);
                    }}
                  >
                    {/* printable-area hint (not printed) */}
                    <div
                      className="etq-margin"
                      style={{ inset: MARGIN * s }}
                    />

                    {onPage.length === 0 && (
                      <div className="absolute inset-0 grid place-items-center pointer-events-none">
                        <div className="text-center text-slate-400 px-6">
                          <Scissors size={Math.max(24, 9 * s)} className="mx-auto mb-3 text-slate-300" />
                          <p className="text-sm font-semibold text-slate-500">صفحة فارغة</p>
                          <p className="text-xs text-slate-400 mt-1">اضغط «ملصق جديد» لإضافة ملصق</p>
                        </div>
                      </div>
                    )}

                    {onPage.map((l) => {
                      const lay = layouts.get(l.id)!;
                      const S = lay.pt * PT;
                      const isSel = l.id === selectedId;
                      return (
                        <div
                          key={l.id}
                          className={`etq-label ${isSel ? "etq-label-selected" : ""} ${overlapIds.has(l.id) ? "etq-label-overlap" : ""}`}
                          style={{ left: l.x * s, top: l.y * s, width: l.w * s, height: l.h * s }}
                          onPointerDown={(e) => startInteraction(e, l, "move")}
                          onDoubleClick={() => setKbField(null)}
                        >
                          {/* cut line — drawn in screen pixels, at least 1.5 px and
                              without anti-aliasing blur, so it looks as dark and
                              sharp as the dashed line of the generated PDF */}
                          <svg
                            className="absolute inset-0 w-full h-full overflow-visible pointer-events-none"
                            width={l.w * s}
                            height={l.h * s}
                          >
                            <rect
                              x={0}
                              y={0}
                              width={l.w * s}
                              height={l.h * s}
                              fill="none"
                              stroke={CUT_INK}
                              strokeWidth={Math.max(1.5, CUT_W * s)}
                              strokeDasharray={`${CUT_DASH * s} ${CUT_GAP * s}`}
                              shapeRendering="crispEdges"
                            />
                          </svg>

                          {/* text — drawn in a 10 px/mm layer then scaled down, so
                              tiny sizes are never enlarged by a browser minimum
                              font size (phones) and match the PDF exactly */}
                          <div className="absolute inset-0 overflow-hidden pointer-events-none">
                            <div
                              className="absolute left-0 top-0"
                              style={{
                                width: l.w * TEXT_U,
                                height: l.h * TEXT_U,
                                transform: `scale(${s / TEXT_U})`,
                                transformOrigin: "0 0",
                                fontFamily: `"${FONT_FAMILY}", "Noto Sans Arabic", Arial, sans-serif`,
                              }}
                            >
                              {lay.lines.map((ln, i) => (
                                <div
                                  key={i}
                                  className="etq-line"
                                  style={{
                                    right: PAD * TEXT_U,
                                    top: (ln.baseline - ASC * S) * TEXT_U,
                                    fontSize: S * TEXT_U,
                                    lineHeight: `${(ASC + DESC) * S * TEXT_U}px`,
                                  }}
                                >
                                  {ln.text}
                                </div>
                              ))}
                              {lay.care && (
                                <CareSymbols
                                  className="absolute text-black"
                                  style={{
                                    left: lay.care.x * TEXT_U,
                                    top: lay.care.y * TEXT_U,
                                    width: lay.care.w * TEXT_U,
                                    height: lay.care.h * TEXT_U,
                                  }}
                                />
                              )}
                            </div>
                          </div>

                          {lay.overflow && (
                            <span className="etq-warn" title="النص أكبر من الملصق">
                              <AlertTriangle size={12} />
                            </span>
                          )}

                          {isSel &&
                            (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as Handle[]).map((hd) => (
                              <span
                                key={hd}
                                className={`etq-handle etq-handle-${hd}`}
                                onPointerDown={(e) => startInteraction(e, l, "resize", hd)}
                              />
                            ))}
                        </div>
                      );
                    })}

                    {/* snapping guides */}
                    {guides && guides.page === p && (
                      <>
                        {guides.xs.map((gx, i) => (
                          <div key={`gx${i}`} className="etq-guide-v" style={{ left: gx * s }} />
                        ))}
                        {guides.ys.map((gy, i) => (
                          <div key={`gy${i}`} className="etq-guide-h" style={{ top: gy * s }} />
                        ))}
                      </>
                    )}
                  </div>
                </div>
              );
            })}

            <button type="button" className="etq-add-page" style={{ width: PAGE_W * s }} onPointerDown={(e) => e.stopPropagation()} onClick={addPage}>
              <FilePlus2 size={16} /> إضافة صفحة
            </button>

            <p className="text-[11px] text-slate-500 text-center max-w-md leading-relaxed">
              اسحب الملصق لتحريكه • اسحب النقاط لتغيير الحجم • الأسهم لتحريك دقيق • Delete للحذف • Ctrl+D للنسخ • Ctrl+Z للتراجع.
              <br />
              الإطار الرمادي الخفيف يُظهر حدود الطباعة الآمنة ولا يُطبع.
            </p>
          </div>
        </div>
      </section>

      {/* ── Inspector as a bottom sheet (phones / tablets) ─────────────── */}
      {selected && (
        <div className="etq-sheet-mobile lg:hidden" onPointerDown={(e) => e.stopPropagation()}>
          <div className="mx-auto -mt-1 mb-3 h-1 w-10 rounded-full bg-slate-600" />
          {inspector}
        </div>
      )}
    </div>
  );
}
