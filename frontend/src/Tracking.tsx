import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Anchor,
  Bookmark,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Container,
  Copy,
  Download,
  ExternalLink,
  Info,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
  Zap,
} from "lucide-react";

/* ==========================================================================
 * Tracking containers — the BLs you follow, in one list.
 *
 *  - AKKON is checked automatically by our server (api/akkon_tracking.py):
 *    vessel, transhipment, ETA and final ETA come straight from Akkon.
 *  - MSC, MAERSK, COSCO open their own tracking page with the BL already
 *    searched (their pages accept it in the link).
 *  - CMA CGM and HMM don't accept a BL in a link: the BL is copied to the
 *    clipboard, and the "⚡ Fill BL" bookmark fills + searches it on their
 *    page in one click.
 *  - HMM also has an "Arrival notice" page (Noatum Maritime / Marmedsa) with
 *    the arrival date at Annaba. It asks for a "type the characters" code, so
 *    our server can't read it: you type the code, ⚡ Fill BL searches the BL,
 *    and a second click on ⚡ Fill BL sends the arrival date + vessel back here.
 *
 * The list is saved in this browser (localStorage). Export / Import moves it
 * to another computer.
 * ======================================================================== */

const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");
const STORAGE_KEY = "tracking_v1";
const AUTO_CHECK_AFTER_H = 6; // Akkon rows older than this are re-checked on open

type CarrierId = "MSC" | "CMA" | "MAERSK" | "COSCO" | "HMM" | "AKKON";
type Status = "transit" | "arrived" | "done";

type AkkonRow = {
  bl?: string;
  container?: string;
  vessel?: string;
  voyage?: string;
  pol?: string;
  ets?: string;
  pod?: string;
  eta?: string;
  ts_vessel?: string;
  ts_voyage?: string;
  final_destination?: string;
  final_eta?: string;
};

type Shipment = {
  id: string;
  bl: string;
  carrier: CarrierId;
  client: string;
  note: string;
  /** dd/mm/yyyy — typed by hand, or filled by the Akkon check */
  eta: string;
  etaSource: "manual" | "auto" | "";
  vessel: string;
  status: Status;
  /** Akkon port-of-loading country (dropdown value); "" = find it automatically */
  akkonCountry: string;
  auto?: {
    checkedAt: string;
    ok: boolean;
    found?: boolean;
    error?: string;
    rows?: AkkonRow[];
  };
  /** last answer of the HMM arrival notice page (sent by ⚡ Fill BL) */
  notice?: {
    checkedAt: string;
    /** as shown on their page, e.g. "Actual 21-JUL-2026" */
    arrival: string;
    departure: string;
    actual: boolean;
  };
  createdAt: string;
};

/* ---- shipping lines ------------------------------------------------------ */

type CarrierDef = {
  label: string;
  /** how the "Track" button works */
  mode: "auto" | "link" | "fill";
  url: (bl: string, s?: Shipment) => string;
  badge: string;
};

const b64 = (s: string) => {
  try {
    return btoa(s);
  } catch {
    return "";
  }
};

const CARRIERS: Record<CarrierId, CarrierDef> = {
  MSC: {
    label: "MSC",
    mode: "link",
    url: (bl) =>
      `https://www.msc.com/en/track-a-shipment?agencyPath=msc&params=${encodeURIComponent(
        b64(`trackingNumber=${bl}&trackingMode=0`)
      )}`,
    badge: "bg-amber-400/15 text-amber-200 border-amber-400/40",
  },
  CMA: {
    label: "CMA CGM",
    mode: "fill",
    url: (bl) => `https://www.cma-cgm.com/ebusiness/tracking#trk=${encodeURIComponent(bl)}`,
    badge: "bg-sky-400/15 text-sky-200 border-sky-400/40",
  },
  MAERSK: {
    label: "MAERSK",
    mode: "link",
    url: (bl) => `https://www.maersk.com/tracking/${encodeURIComponent(bl)}`,
    badge: "bg-cyan-400/15 text-cyan-200 border-cyan-400/40",
  },
  COSCO: {
    label: "COSCO",
    mode: "link",
    url: (bl) =>
      `https://elines.coscoshipping.com/ebusiness/cargotracking?trackingType=BILLOFLADING&number=${encodeURIComponent(bl)}`,
    badge: "bg-blue-400/15 text-blue-200 border-blue-400/40",
  },
  HMM: {
    label: "HMM",
    mode: "fill",
    url: (bl) =>
      `https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do#trk=${encodeURIComponent(bl)}`,
    badge: "bg-orange-400/15 text-orange-200 border-orange-400/40",
  },
  AKKON: {
    label: "AKKON",
    mode: "auto",
    url: (bl, s) =>
      `https://sap.akkonlines.com/index.aspx#trk=${encodeURIComponent(bl)}${
        s?.akkonCountry ? `&c=${encodeURIComponent(s.akkonCountry)}` : ""
      }`,
    badge: "bg-emerald-400/15 text-emerald-200 border-emerald-400/40",
  },
};
const CARRIER_IDS = Object.keys(CARRIERS) as CarrierId[];

/* ---- HMM arrival notice (Noatum Maritime / Marmedsa) ----------------------
 * Opened in a tab NAMED "trk=<BL>": the name survives their code page, so
 * ⚡ Fill BL still knows the BL after it. The tab keeps a link back to this
 * page (window.opener) so ⚡ Fill BL can send the result here. */
const NOTICE_ORIGIN = "https://arrivals-notice.marmedsabemarine.com";
const NOTICE_URL =
  `${NOTICE_ORIGIN}/ords/r/wksmmexp/arrival-noatum/arrivals-notice2` +
  "?p10_bl_booking=&p10_carrier=&cs=1sPmowFa1ijMOqZyUJlg1fzJYIfp7bMvq7UtfOjwE3mEGNAS7VRuYn_vULyz-mcnqBAtCR9GTZTsnM76pXyvwfg";
const noticeUrl = (bl: string) => `${NOTICE_URL}#trk=${encodeURIComponent(bl)}`;

const MONTHS: [string, number][] = [
  ["JAN", 1], ["FEB", 2], ["FEV", 2], ["MAR", 3], ["APR", 4], ["AVR", 4],
  ["MAY", 5], ["MAI", 5], ["JUIN", 6], ["JUN", 6], ["JUIL", 7], ["JUL", 7],
  ["AUG", 8], ["AOU", 8], ["SEP", 9], ["OCT", 10], ["NOV", 11], ["DEC", 12],
];

/** "Actual 21-JUL-2026" / "Estimé 05-AOÛT-2026" / "21/07/2026" -> "21/07/2026" ("" if no date). */
function noticeDate(text: string): string {
  const t = (text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const num = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(t);
  let d: number, m: number, y: number;
  if (num) {
    [d, m, y] = [Number(num[1]), Number(num[2]), Number(num[3])];
  } else {
    const named = /(\d{1,2})[\s/.-]+([A-Z]{3,5})\.?[\s/.-]+(\d{4})/.exec(t);
    if (!named) return "";
    const hit = MONTHS.find(([p]) => named[2].startsWith(p));
    if (!hit) return "";
    [d, m, y] = [Number(named[1]), hit[1], Number(named[3])];
  }
  if (d < 1 || d > 31 || m < 1 || m > 12) return "";
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

/** Guess the line from well-known BL prefixes (the user can always change it). */
function detectCarrier(bl: string): CarrierId | null {
  const b = bl.toUpperCase();
  if (/^(MEDU|MSCU)/.test(b)) return "MSC";
  if (/^(CMDU|CMAU)/.test(b)) return "CMA";
  if (/^MAEU/.test(b) || /^\d{9}$/.test(b)) return "MAERSK";
  if (/^COSU/.test(b)) return "COSCO";
  if (/^HDMU/.test(b)) return "HMM";
  if (/^AKKN/.test(b)) return "AKKON";
  return null;
}

/** Akkon's port-of-loading countries (same values as their page). */
const AKKON_COUNTRIES: { value: string; label: string }[] = [
  "CHINA|SBOAKKONCHINA",
  "TURKIYE|SBOAKKON",
  "IBERIA / SPAIN|SBOIBERIALIVE",
  "ITALY|SBOAKKONITALY",
  "INDIA|AKKONINDIAINT",
  "BELGIUM|SBOAKKONBELGIUM",
  "UNITED ARAB EMIRATES|SBOAKKON",
  "TUNISIA|SBOAKKONTUNISIA",
  "MOROCCO|SBOAKKONMOROCCO",
  "ROMANIA|SBOAKKONROMANIA",
  "BULGARIA|SBOAKKONBULGARIA",
  "UKRAINE|SBOAKKONUKRAINE",
  "UNITED KINGDOM|SBOAKKONUK",
  "ALGERIA|SBOAKKONALGERIA",
  "PAKISTAN|SBOAKKON",
  "SAUDI ARABIA|SBOAKKON",
  "JORDAN|SBOAKKON",
  "LIBYA|SBOAKKON",
  "DJIBOUTI|SBOAKKON",
  "KENYA|SBOAKKON",
  "TANZANIA|SBOAKKON",
].map((value) => ({ value, label: value.split("|")[0] }));
const countryLabel = (v: string) => v.split("|")[0] || "";

/* ---- "⚡ Fill BL" bookmark ------------------------------------------------
 * Runs on the CMA CGM / HMM / Akkon page opened by the Track button: reads the
 * BL from the link (#trk=...), types it into their search box and presses
 * their search button — exactly what you would do by hand.
 * On the HMM arrival notice page (after YOU typed their code) it searches the
 * BL; clicked again on the result, it sends vessel + dates back to this page.
 * No "%" anywhere: browsers URL-decode bookmarks before running them. */
const FILL_BL_BOOKMARKLET =
  "javascript:(function(){var p={};location.hash.slice(1).split('&').forEach(function(kv){var i=kv.indexOf('=');if(i>0)p[kv.slice(0,i)]=decodeURIComponent(kv.slice(i+1));});" +
  "var ss='';try{ss=sessionStorage.getItem('trkBL')||'';}catch(x){}" +
  "var n=p.trk||(window.name.indexOf('trk=')===0?window.name.slice(4):'')||ss;" +
  "if(!n){alert('Open this page with the Track or Arrival notice button of your Tracking page first.');return;}" +
  "function set(e,v){if(!e)return false;e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;}" +
  "var h=location.hostname,e;" +
  "if(h.indexOf('cma-cgm')>=0){e=document.getElementById('Reference');if(set(e,n))e.form.querySelector('[type=submit]').click();}" +
  "else if(h.indexOf('hmm21')>=0){e=document.querySelector('input[name=srchBlNo1]');if(set(e,n)&&typeof search==='function')search();}" +
  "else if(h.indexOf('akkonlines')>=0){if(p.c)set(document.getElementById('ddlCountry'),p.c);if(set(document.getElementById('TextBox1'),n))document.getElementById('Button1').click();}" +
  "else if(h.indexOf('marmedsabemarine')>=0){e=document.getElementById('P10_BL_BOOKING');" +
  "if(!e){alert('First type the code and press I am not a robot, then click Fill BL again.');return;}" +
  "try{sessionStorage.setItem('trkBL',n);}catch(x){}" +
  "var r=null;function col(hd,c,re,d){for(var k=0;k<hd.length;k++)if(re.test(hd[k]))return c[k]||'';return c[d]||'';}" +
  "[].forEach.call(document.querySelectorAll('table'),function(t){var hd=null;[].forEach.call(t.rows,function(row){" +
  "var c=[].map.call(row.cells,function(x){return x.textContent.replace(/\\s+/g,' ').trim();});" +
  "if(!hd){if(/arrival date|date d.arriv/i.test(c.join('|')))hd=c;return;}" +
  "if(!r&&c.indexOf(n)>=0)r={type:'trk-notice',bl:n,vessel:col(hd,c,/^vessel|navire/i,4),departure:col(hd,c,/departure date|date de d.part/i,9),arrival:col(hd,c,/arrival date|date d.arriv/i,10)};});});" +
  "if(r){var o=window.opener,txt=n+' - arrival: '+(r.arrival||'no date yet')+(r.vessel?' - vessel: '+r.vessel:'');" +
  "if(o&&!o.closed){o.postMessage(r,'*');alert('Sent to your Tracking page. '+txt);}" +
  "else alert(txt+' (open this page with the Arrival notice button of your Tracking page to save it there automatically)');return;}" +
  "if(set(e,n)){var b=[].filter.call(document.querySelectorAll('button'),function(x){return x.id==='filter-search'&&x.offsetParent!==null;})[0];if(b)b.click();}}" +
  "else{alert('This page is not supported by Fill BL.');}})();";

/* ---- dates (dd/mm/yyyy) ------------------------------------------------- */

const maskDate = (value: string) => {
  const d = value.replace(/\D/g, "").slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
};

const parseDMY = (s: string): Date | null => {
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec((s || "").trim());
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d;
};

const daysUntil = (s: string): number | null => {
  const d = parseDMY(s);
  if (!d) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
};

const timeAgo = (iso?: string) => {
  if (!iso) return "";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
};

/* ---- storage ------------------------------------------------------------- */

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const normalize = (raw: Partial<Shipment>): Shipment | null => {
  if (!raw || typeof raw.bl !== "string" || !raw.bl.trim()) return null;
  const carrier = (CARRIER_IDS as string[]).includes(raw.carrier as string)
    ? (raw.carrier as CarrierId)
    : detectCarrier(raw.bl) ?? "MSC";
  return {
    id: typeof raw.id === "string" ? raw.id : uid(),
    bl: raw.bl.trim().toUpperCase(),
    carrier,
    client: raw.client ?? "",
    note: raw.note ?? "",
    eta: raw.eta ?? "",
    etaSource: raw.etaSource ?? (raw.eta ? "manual" : ""),
    vessel: raw.vessel ?? "",
    status: raw.status === "arrived" || raw.status === "done" ? raw.status : "transit",
    akkonCountry: raw.akkonCountry ?? "",
    auto: raw.auto,
    notice:
      raw.notice && typeof raw.notice.arrival === "string" && typeof raw.notice.checkedAt === "string"
        ? raw.notice
        : undefined,
    createdAt: raw.createdAt ?? new Date().toISOString(),
  };
};

function loadShipments(): Shipment[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr.map(normalize).filter(Boolean) as Shipment[]) : [];
  } catch {
    return [];
  }
}

function saveShipments(list: Shipment[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable — the list lives for this visit only */
  }
}

/** What the Akkon answer says about the arrival (last leg). */
function akkonSummary(rows?: AkkonRow[]) {
  const r = rows?.[0];
  if (!r) return null;
  const eta = r.final_eta || r.eta || "";
  const destination = r.final_destination || r.pod || "";
  const vessel = r.ts_vessel || r.vessel || "";
  return { eta, destination, vessel, via: r.ts_vessel ? r.pod || "" : "" };
}

const STATUS_LABEL: Record<Status, string> = {
  transit: "In transit",
  arrived: "Arrived",
  done: "Done",
};

type Filter = "all" | Status;

/* ==========================================================================
 * Page
 * ======================================================================== */

export default function Tracking({ active }: { active: boolean }) {
  const [list, setList] = useState<Shipment[]>(loadShipments);
  const listRef = useRef(list);
  listRef.current = list;

  // add form
  const [bl, setBl] = useState("");
  const [carrier, setCarrier] = useState<CarrierId | "">("");
  const [carrierTouched, setCarrierTouched] = useState(false);
  const [client, setClient] = useState("");
  const [eta, setEta] = useState("");
  const [akkonCountry, setAkkonCountry] = useState("");

  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const bookmarkRef = useRef<HTMLAnchorElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const autoChecked = useRef(false);

  const flash = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 3800);
  };

  useEffect(() => saveShipments(list), [list]);

  // React refuses "javascript:" links in JSX — set the bookmark's href by hand
  useEffect(() => {
    bookmarkRef.current?.setAttribute("href", FILL_BL_BOOKMARKLET);
  }, [showHelp]);

  const update = useCallback((id: string, patch: Partial<Shipment> | ((s: Shipment) => Partial<Shipment>)) => {
    setList((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...(typeof patch === "function" ? patch(s) : patch) } : s))
    );
  }, []);

  /* ---- HMM arrival notice: result sent by ⚡ Fill BL ---------------------- */
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== NOTICE_ORIGIN) return;
      const d = e.data as Record<string, unknown> | null;
      if (!d || typeof d !== "object" || d.type !== "trk-notice") return;
      const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 120) : "");
      const blNo = str(d.bl).toUpperCase().replace(/\s+/g, "");
      if (!blNo) return;
      if (!listRef.current.some((s) => s.bl === blNo)) {
        flash(`Arrival notice: ${blNo} is not in your list.`, "error");
        return;
      }
      const arrival = str(d.arrival);
      const vessel = str(d.vessel);
      const etaDmy = noticeDate(arrival);
      const actual = /actual|r[ée]el/i.test(arrival);
      const arrived = actual && etaDmy !== "" && (daysUntil(etaDmy) ?? 1) <= 0;
      setList((prev) =>
        prev.map((s) =>
          s.bl !== blNo
            ? s
            : {
                ...s,
                notice: { checkedAt: new Date().toISOString(), arrival, departure: str(d.departure), actual },
                ...(etaDmy ? { eta: etaDmy, etaSource: "auto" as const } : {}),
                ...(vessel ? { vessel } : {}),
                ...(arrived && s.status === "transit" ? { status: "arrived" as const } : {}),
              }
        )
      );
      flash(
        etaDmy
          ? `${blNo}: arrival ${etaDmy} (${actual ? "actual" : "estimated"}) saved${arrived ? " — marked Arrived" : ""}.`
          : `${blNo}: the arrival notice has no arrival date yet.`
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- Akkon automatic check -------------------------------------------- */
  const checkAkkon = useCallback(
    async (id: string, quiet = false) => {
      const s = listRef.current.find((x) => x.id === id);
      if (!s || s.carrier !== "AKKON") return;
      setChecking((prev) => new Set(prev).add(id));
      try {
        const res = await fetch(`${API_URL}/api/tracking/akkon`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bl: s.bl, country: s.akkonCountry }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof data?.detail === "string" ? data.detail : `Server error (HTTP ${res.status})`);
        const rows: AkkonRow[] = Array.isArray(data.rows) ? data.rows : [];
        update(id, (cur) => {
          const sum = akkonSummary(rows);
          const patch: Partial<Shipment> = {
            auto: { checkedAt: new Date().toISOString(), ok: true, found: !!data.found, rows },
          };
          if (data.found) {
            if (data.country) patch.akkonCountry = data.country;
            if (sum?.eta && cur.etaSource !== "manual") {
              patch.eta = sum.eta;
              patch.etaSource = "auto";
            }
            if (sum?.vessel) patch.vessel = sum.vessel;
          }
          return patch;
        });
        if (!quiet) {
          flash(data.found ? `Akkon: ${s.bl} updated.` : `Akkon: ${s.bl} not found — check the BL or the loading country.`, data.found ? "success" : "error");
        }
      } catch (err) {
        const message =
          err instanceof TypeError
            ? "Could not reach the server. In local dev, start: uvicorn api.index:app --reload --port 8000"
            : err instanceof Error
              ? err.message
              : "Unexpected error.";
        update(id, { auto: { checkedAt: new Date().toISOString(), ok: false, error: message } });
        if (!quiet) flash(message, "error");
      } finally {
        setChecking((prev) => {
          const n = new Set(prev);
          n.delete(id);
          return n;
        });
      }
    },
    [update]
  );

  const checkAllAkkon = async (onlyStale = false) => {
    const ids = listRef.current
      .filter((s) => s.carrier === "AKKON" && s.status === "transit")
      .filter(
        (s) =>
          !onlyStale ||
          !s.auto?.checkedAt ||
          Date.now() - new Date(s.auto.checkedAt).getTime() > AUTO_CHECK_AFTER_H * 3600000
      )
      .map((s) => s.id);
    for (const id of ids) await checkAkkon(id, true); // one at a time — polite
    if (!onlyStale && ids.length) flash(`Akkon: ${ids.length} BL checked.`);
  };

  // when the page is opened, refresh Akkon BLs not checked for a while
  useEffect(() => {
    if (!active || autoChecked.current) return;
    autoChecked.current = true;
    void checkAllAkkon(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /* ---- add / edit / delete ------------------------------------------------ */
  const onBlChange = (v: string) => {
    const clean = v.toUpperCase().replace(/\s+/g, "");
    setBl(clean);
    if (!carrierTouched) setCarrier(detectCarrier(clean) ?? "");
  };

  const addShipment = () => {
    const b = bl.trim().toUpperCase();
    if (!b) return flash("Type a BL number.", "error");
    if (!carrier) return flash("Choose the shipping line.", "error");
    if (list.some((s) => s.bl === b && s.carrier === carrier)) return flash(`${b} is already in your list.`, "error");
    const s: Shipment = {
      id: uid(),
      bl: b,
      carrier,
      client: client.trim(),
      note: "",
      eta: eta.trim(),
      etaSource: eta.trim() ? "manual" : "",
      vessel: "",
      status: "transit",
      akkonCountry: carrier === "AKKON" ? akkonCountry : "",
      createdAt: new Date().toISOString(),
    };
    setList((prev) => [s, ...prev]);
    listRef.current = [s, ...listRef.current];
    setBl("");
    setClient("");
    setEta("");
    setCarrierTouched(false);
    setCarrier("");
    setFilter((f) => (f === "transit" || f === "all" ? f : "all"));
    if (s.carrier === "AKKON") void checkAkkon(s.id);
    else flash(`${b} added.`);
  };

  const removeShipment = (id: string) => {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      window.setTimeout(() => setConfirmDelete((c) => (c === id ? null : c)), 3000);
      return;
    }
    setList((prev) => prev.filter((s) => s.id !== id));
    setConfirmDelete(null);
  };

  const copyBl = (b: string, quiet = false) => {
    navigator.clipboard?.writeText(b).then(
      () => !quiet && flash(`${b} copied.`),
      () => undefined
    );
  };

  /* ---- export / import ------------------------------------------------------ */
  const exportList = () => {
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tracking_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const importList = async (file: File | null) => {
    if (!file) return;
    try {
      const arr = JSON.parse(await file.text());
      if (!Array.isArray(arr)) throw new Error();
      const incoming = arr.map(normalize).filter(Boolean) as Shipment[];
      const keys = new Set(listRef.current.map((s) => `${s.carrier}:${s.bl}`));
      const fresh = incoming
        .filter((s) => !keys.has(`${s.carrier}:${s.bl}`))
        .map((s) => ({ ...s, id: uid() }));
      setList((prev) => [...prev, ...fresh]);
      flash(fresh.length ? `${fresh.length} BL imported.` : "Nothing new in this file.");
    } catch {
      flash("This file is not a Tracking export.", "error");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  /* ---- view ------------------------------------------------------------------ */
  const counts = useMemo(() => {
    const c = { all: list.length, transit: 0, arrived: 0, done: 0 };
    for (const s of list) c[s.status]++;
    return c;
  }, [list]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const order: Record<Status, number> = { transit: 0, arrived: 1, done: 2 };
    return list
      .filter((s) => (filter === "all" ? s.status !== "done" || q !== "" : s.status === filter))
      .filter(
        (s) =>
          !q ||
          [s.bl, s.client, s.note, s.vessel, CARRIERS[s.carrier].label].some((v) => v.toLowerCase().includes(q))
      )
      .sort((a, b) => {
        if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
        const da = parseDMY(a.eta)?.getTime() ?? Infinity;
        const db = parseDMY(b.eta)?.getTime() ?? Infinity;
        if (da !== db) return da - db;
        return b.createdAt.localeCompare(a.createdAt);
      });
  }, [list, filter, query]);

  const hasAkkon = list.some((s) => s.carrier === "AKKON" && s.status === "transit");
  const anyChecking = checking.size > 0;

  return (
    <div className="app-shell h-full overflow-y-auto">
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

      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
        {/* Header */}
        <header className="mb-6 flex items-center gap-3 sm:gap-4">
          <div className="grid place-items-center w-11 h-11 sm:w-12 sm:h-12 shrink-0 rounded-2xl bg-gradient-to-br from-indigo-500 to-blue-600 shadow-lg shadow-indigo-500/30">
            <Container size={24} className="text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg sm:text-2xl font-bold tracking-tight text-white leading-tight">
              Tracking containers
            </h1>
            <p className="text-slate-400 text-xs sm:text-sm">
              All your BLs in one list — Akkon is checked automatically, the other lines open with the BL ready.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowHelp((v) => !v)}
            className={`btn-ghost shrink-0 ${showHelp ? "!bg-indigo-500/20 !text-white" : ""}`}
            title="Fill BL bookmark"
          >
            <Zap size={16} /> <span className="hidden sm:inline">Fill BL</span>
          </button>
        </header>

        {/* ⚡ Fill BL helper */}
        {showHelp && (
          <section className="card mb-5 border-indigo-500/30">
            <h2 className="section-title flex items-center gap-2">
              <Zap size={16} className="text-amber-300" /> One-click search on CMA CGM, HMM (+ arrival notice) and Akkon
            </h2>
            <div className="grid gap-4 md:grid-cols-[1fr_auto] items-start text-sm text-slate-300">
              <ol className="space-y-1.5 list-decimal ps-5">
                <li>
                  Show your bookmarks bar (<kbd className="trk-kbd">Ctrl</kbd>+<kbd className="trk-kbd">Shift</kbd>+<kbd className="trk-kbd">B</kbd>).
                </li>
                <li>
                  <strong>Drag</strong> the yellow button onto the bookmarks bar — once, it stays there.
                </li>
                <li>
                  Click <strong>Track</strong> on a CMA CGM / HMM / Akkon BL here, then click <strong>⚡ Fill BL</strong> in your
                  bookmarks bar: the BL is typed and searched for you.
                </li>
                <li>
                  <strong>HMM arrival notice:</strong> click <strong>Arrival notice</strong>, type their code and press
                  “I'm not a robot”, then <strong>⚡ Fill BL</strong> — it searches the BL. Click <strong>⚡ Fill BL</strong> again
                  on the result: the arrival date and the vessel come back to this list.
                </li>
                <li className="text-slate-400">
                  Without the bookmark it still works: the BL is copied, just press <kbd className="trk-kbd">Ctrl</kbd>+<kbd className="trk-kbd">V</kbd> and Search.
                </li>
              </ol>
              <a
                ref={bookmarkRef}
                className="trk-bookmarklet"
                onClick={(e) => {
                  e.preventDefault();
                  flash("Drag this button to your bookmarks bar (don't click it here).", "error");
                }}
                title="Drag me to your bookmarks bar"
              >
                <Bookmark size={15} /> ⚡ Fill BL
              </a>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              MSC, MAERSK and COSCO don't need it — their page opens with the search already done. Already have the
              bookmark? Drag this one again to replace it (it learned the arrival notice).
            </p>
          </section>
        )}

        {/* Add a BL */}
        <section className="card mb-5">
          <h2 className="section-title">Add a BL</h2>
          <div className="grid gap-3 md:grid-cols-[1.4fr_1fr_0.8fr] items-end">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-slate-300">
                BL number <span className="text-indigo-400">*</span>
              </span>
              <input
                className="input font-mono tracking-wide uppercase"
                value={bl}
                onChange={(e) => onBlChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addShipment()}
                placeholder="e.g. MEDU12345678"
                spellCheck={false}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-slate-300">Client</span>
              <input
                className="input"
                value={client}
                onChange={(e) => setClient(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addShipment()}
                placeholder="optional"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-slate-300">ETA</span>
              <input
                className="input"
                inputMode="numeric"
                value={eta}
                onChange={(e) => setEta(maskDate(e.target.value))}
                onKeyDown={(e) => e.key === "Enter" && addShipment()}
                placeholder={carrier === "AKKON" ? "automatic" : "dd/mm/yyyy"}
                disabled={carrier === "AKKON"}
              />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-slate-300 me-1">
              Line <span className="text-indigo-400">*</span>
            </span>
            {CARRIER_IDS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setCarrier(c);
                  setCarrierTouched(true);
                }}
                className={`px-3 py-1.5 rounded-lg border text-xs font-bold tracking-wide transition-colors ${
                  carrier === c
                    ? "bg-indigo-500/25 border-indigo-400/70 text-indigo-100"
                    : "border-slate-700 text-slate-400 hover:border-indigo-500/40 hover:text-slate-200"
                }`}
              >
                {CARRIERS[c].label}
                {CARRIERS[c].mode === "auto" && <span className="ms-1 text-emerald-300">●</span>}
              </button>
            ))}
            {carrier === "AKKON" && (
              <select
                className="input !w-auto !py-1.5 text-xs"
                value={akkonCountry}
                onChange={(e) => setAkkonCountry(e.target.value)}
                title="Akkon port-of-loading country"
              >
                <option value="">Loading country: find automatically</option>
                {AKKON_COUNTRIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    Loading country: {c.label}
                  </option>
                ))}
              </select>
            )}
            <button type="button" onClick={addShipment} className="btn-primary !py-2 !px-4 ms-auto">
              <Plus size={16} /> Add
            </button>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            <span className="text-emerald-300">●</span> AKKON: vessel and ETA are fetched automatically. Other lines: open
            their page with <strong>Track</strong> and type the ETA here (HMM: <strong>Arrival notice</strong> + ⚡ Fill BL
            brings it back for you).
          </p>
        </section>

        {/* Toolbar */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1.5">
            {(["all", "transit", "arrived", "done"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`trk-tab ${filter === f ? "trk-tab-active" : ""}`}
              >
                {f === "all" ? "Active" : STATUS_LABEL[f]}
                <span className="trk-tab-count">{f === "all" ? counts.transit + counts.arrived : counts[f]}</span>
              </button>
            ))}
          </div>
          <div className="relative flex-1 min-w-[10rem] max-w-xs ms-auto">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input className="input !pl-9 !py-2 text-sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search BL, client, vessel…" />
          </div>
          {hasAkkon && (
            <button type="button" className="btn-ghost" onClick={() => checkAllAkkon(false)} disabled={anyChecking} title="Check every Akkon BL now">
              <RefreshCw size={15} className={anyChecking ? "animate-spin" : ""} /> <span className="hidden sm:inline">Check Akkon</span>
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={exportList} disabled={!list.length} title="Save the list to a file (backup / another PC)">
            <Download size={15} /> <span className="hidden sm:inline">Export</span>
          </button>
          <button type="button" className="btn-ghost" onClick={() => importRef.current?.click()} title="Load a list exported from another PC">
            <Upload size={15} /> <span className="hidden sm:inline">Import</span>
          </button>
          <input ref={importRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => importList(e.target.files?.[0] ?? null)} />
        </div>

        {/* List */}
        {visible.length === 0 ? (
          <div className="card text-center py-12 text-slate-400">
            <Container size={34} className="mx-auto mb-3 text-slate-500" />
            <p className="text-sm font-semibold text-slate-300">
              {list.length === 0 ? "No BL yet" : "Nothing here"}
            </p>
            <p className="text-xs mt-1">
              {list.length === 0 ? "Add your first BL above." : "Try another tab or clear the search."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map((s) => (
              <ShipmentCard
                key={s.id}
                s={s}
                editing={editing === s.id}
                expanded={expanded.has(s.id)}
                checking={checking.has(s.id)}
                confirmDelete={confirmDelete === s.id}
                onEdit={() => setEditing(editing === s.id ? null : s.id)}
                onSave={(patch) => {
                  update(s.id, patch);
                  setEditing(null);
                }}
                onToggleDetails={() =>
                  setExpanded((prev) => {
                    const n = new Set(prev);
                    if (n.has(s.id)) n.delete(s.id);
                    else n.add(s.id);
                    return n;
                  })
                }
                onStatus={(st) => update(s.id, { status: st })}
                onCheck={() => checkAkkon(s.id)}
                onDelete={() => removeShipment(s.id)}
                onCopy={() => copyBl(s.bl)}
                onTrack={() => {
                  copyBl(s.bl, true);
                  if (CARRIERS[s.carrier].mode === "fill" || s.carrier === "AKKON") {
                    flash(`${s.bl} copied — on their page press Ctrl+V and Search, or click ⚡ Fill BL.`);
                  }
                }}
                onNotice={() => {
                  copyBl(s.bl, true);
                  flash(`${s.bl} copied — type their code, then click ⚡ Fill BL (once to search, again to bring the arrival date here).`);
                }}
              />
            ))}
          </div>
        )}

        <p className="mt-6 flex items-start gap-2 text-xs text-slate-500">
          <Info size={14} className="mt-0.5 shrink-0" />
          The list is saved in this browser. Use Export / Import to move it to another computer or keep a backup.
        </p>
      </div>
    </div>
  );
}

/* ==========================================================================
 * One BL
 * ======================================================================== */

function EtaBadge({ s }: { s: Shipment }) {
  if (s.status === "arrived")
    return <span className="trk-badge trk-badge-green"><Check size={12} /> Arrived</span>;
  if (s.status === "done") return <span className="trk-badge trk-badge-grey">Done</span>;
  const d = daysUntil(s.eta);
  if (d === null) return <span className="trk-badge trk-badge-grey">No ETA</span>;
  if (d < 0)
    return (
      <span className="trk-badge trk-badge-red">
        ETA passed {-d} day{d === -1 ? "" : "s"} ago
      </span>
    );
  if (d === 0) return <span className="trk-badge trk-badge-amber">Arrives today</span>;
  if (d <= 3) return <span className="trk-badge trk-badge-amber">In {d} day{d === 1 ? "" : "s"}</span>;
  return <span className="trk-badge trk-badge-blue">In {d} days</span>;
}

function ShipmentCard({
  s,
  editing,
  expanded,
  checking,
  confirmDelete,
  onEdit,
  onSave,
  onToggleDetails,
  onStatus,
  onCheck,
  onDelete,
  onCopy,
  onTrack,
  onNotice,
}: {
  s: Shipment;
  editing: boolean;
  expanded: boolean;
  checking: boolean;
  confirmDelete: boolean;
  onEdit: () => void;
  onSave: (patch: Partial<Shipment>) => void;
  onToggleDetails: () => void;
  onStatus: (st: Status) => void;
  onCheck: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onTrack: () => void;
  onNotice: () => void;
}) {
  const def = CARRIERS[s.carrier];
  const sum = s.carrier === "AKKON" ? akkonSummary(s.auto?.rows) : null;
  const rows = s.auto?.rows ?? [];
  const d = daysUntil(s.eta);

  return (
    <article className={`card !p-4 sm:!p-5 ${s.status === "done" ? "opacity-60" : ""}`}>
      <div className="flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-5">
        {/* BL + client */}
        <div className="min-w-0 lg:w-[34%]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-2 py-0.5 rounded-md border text-[11px] font-bold tracking-wide ${def.badge}`}>{def.label}</span>
            <span className="font-mono text-[15px] font-semibold text-white tracking-wide break-all">{s.bl}</span>
            <button type="button" onClick={onCopy} className="text-slate-500 hover:text-white" title="Copy BL" aria-label="Copy BL">
              <Copy size={14} />
            </button>
          </div>
          {(s.client || s.note) && (
            <p className="mt-1 text-xs text-slate-400 truncate">
              {s.client}
              {s.client && s.note ? " — " : ""}
              {s.note}
            </p>
          )}
        </div>

        {/* ETA */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <CalendarClock size={15} className="text-indigo-300 shrink-0" />
            <span className="text-sm font-semibold text-slate-100 tabular-nums">{s.eta || "—"}</span>
            <EtaBadge s={s} />
            {s.status === "transit" && d !== null && d < 0 && (
              <button type="button" className="text-xs text-emerald-300 hover:text-emerald-200 underline underline-offset-2" onClick={() => onStatus("arrived")}>
                mark arrived
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {s.vessel ? <>Vessel: <span className="text-slate-300">{s.vessel}</span></> : null}
            {sum?.via ? <> · via {sum.via}</> : null}
            {sum?.destination ? <> · to {sum.destination}</> : null}
            {s.carrier === "AKKON" && s.auto && (
              <span className={s.auto.ok && s.auto.found ? "text-slate-500" : "text-amber-300"}>
                {" "}
                · {s.auto.ok ? (s.auto.found ? `checked ${timeAgo(s.auto.checkedAt)}` : "not found on Akkon") : `check failed: ${s.auto.error}`}
              </span>
            )}
            {s.notice && (
              <span className="text-slate-500">
                {" "}
                · notice: {s.notice.arrival ? (s.notice.actual ? "actual" : "estimated") : "no date yet"}, {timeAgo(s.notice.checkedAt)}
              </span>
            )}
          </p>
        </div>

        {/* status + actions */}
        <div className="flex items-center gap-2 flex-wrap lg:justify-end">
          <select
            className={`trk-status trk-status-${s.status}`}
            value={s.status}
            onChange={(e) => onStatus(e.target.value as Status)}
            aria-label="Status"
          >
            {(["transit", "arrived", "done"] as Status[]).map((st) => (
              <option key={st} value={st}>
                {STATUS_LABEL[st]}
              </option>
            ))}
          </select>
          {s.carrier === "AKKON" && (
            <button type="button" className="etq-icon-btn" onClick={onCheck} disabled={checking} title="Check on Akkon now" aria-label="Check on Akkon now">
              {checking ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            </button>
          )}
          <a
            href={def.url(s.bl, s)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onTrack}
            className="btn-primary !py-2 !px-3.5 !text-sm"
            title={def.mode === "fill" ? "Opens their page — BL copied (Ctrl+V) or ⚡ Fill BL" : "Opens their page with the BL searched"}
          >
            Track <ExternalLink size={14} />
          </a>
          {s.carrier === "HMM" && (
            <a
              href={noticeUrl(s.bl)}
              target={`trk=${s.bl}`}
              onClick={onNotice}
              className="btn-ghost !py-2 !px-3 !text-sm"
              title="HMM arrival notice (Noatum) — type their code, then ⚡ Fill BL"
            >
              <Anchor size={14} /> Arrival notice
            </a>
          )}
          <button type="button" className="etq-icon-btn" onClick={onEdit} title="Edit" aria-label="Edit">
            {editing ? <X size={15} /> : <Pencil size={15} />}
          </button>
          <button
            type="button"
            className={`etq-icon-btn ${confirmDelete ? "!bg-rose-500/25 !text-rose-100 !border-rose-400/60 !w-auto px-2 text-xs font-semibold" : ""}`}
            onClick={onDelete}
            title="Delete"
            aria-label="Delete"
          >
            {confirmDelete ? "Delete?" : <Trash2 size={15} />}
          </button>
        </div>
      </div>

      {/* Akkon details */}
      {s.carrier === "AKKON" && rows.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={onToggleDetails} className="text-xs font-semibold text-indigo-300 hover:text-indigo-200 inline-flex items-center gap-1">
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {rows.length} container{rows.length > 1 ? "s" : ""} — details from Akkon
          </button>
          {expanded && (
            <div className="mt-2 overflow-x-auto rounded-lg border border-slate-700/60">
              <table className="trk-table">
                <thead>
                  <tr>
                    <th>Container</th>
                    <th>Vessel / voyage</th>
                    <th>Loading</th>
                    <th>ETS</th>
                    <th>Discharge</th>
                    <th>ETA</th>
                    <th>Transhipment</th>
                    <th>Final dest.</th>
                    <th>Final ETA</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td className="font-mono">{r.container}</td>
                      <td>{[r.vessel, r.voyage].filter(Boolean).join(" · ")}</td>
                      <td>{r.pol}</td>
                      <td>{r.ets}</td>
                      <td>{r.pod}</td>
                      <td>{r.eta}</td>
                      <td>{[r.ts_vessel, r.ts_voyage].filter(Boolean).join(" · ")}</td>
                      <td>{r.final_destination}</td>
                      <td className="font-semibold text-white">{r.final_eta}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {editing && <EditForm s={s} onSave={onSave} onCancel={onEdit} />}
    </article>
  );
}

function EditForm({ s, onSave, onCancel }: { s: Shipment; onSave: (p: Partial<Shipment>) => void; onCancel: () => void }) {
  const [f, setF] = useState({
    bl: s.bl,
    carrier: s.carrier,
    client: s.client,
    note: s.note,
    eta: s.eta,
    vessel: s.vessel,
    akkonCountry: s.akkonCountry,
  });
  const save = () => {
    const bl = f.bl.trim().toUpperCase().replace(/\s+/g, "");
    if (!bl) return;
    const etaChanged = f.eta.trim() !== s.eta;
    onSave({
      ...f,
      bl,
      eta: f.eta.trim(),
      etaSource: etaChanged ? (f.eta.trim() ? "manual" : "") : s.etaSource,
      akkonCountry: f.carrier === "AKKON" ? f.akkonCountry : "",
      ...(bl !== s.bl || f.carrier !== s.carrier ? { auto: undefined } : {}),
    });
  };
  return (
    <div className="mt-4 pt-4 border-t border-slate-800 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-400">BL number</span>
        <input className="input font-mono uppercase" value={f.bl} onChange={(e) => setF({ ...f, bl: e.target.value.toUpperCase() })} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-400">Line</span>
        <select className="input" value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value as CarrierId })}>
          {CARRIER_IDS.map((c) => (
            <option key={c} value={c}>
              {CARRIERS[c].label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-400">Client</span>
        <input className="input" value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-400">ETA {s.etaSource === "auto" ? "(from Akkon)" : ""}</span>
        <input className="input" inputMode="numeric" placeholder="dd/mm/yyyy" value={f.eta} onChange={(e) => setF({ ...f, eta: maskDate(e.target.value) })} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-400">Vessel</span>
        <input className="input" value={f.vessel} onChange={(e) => setF({ ...f, vessel: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 sm:col-span-1 lg:col-span-2">
        <span className="text-xs text-slate-400">Note</span>
        <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. 2 × 40', documents received" />
      </label>
      {f.carrier === "AKKON" ? (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">Loading country (Akkon)</span>
          <select className="input" value={f.akkonCountry} onChange={(e) => setF({ ...f, akkonCountry: e.target.value })}>
            <option value="">Find automatically</option>
            {AKKON_COUNTRIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span className="hidden lg:block" />
      )}
      <div className="sm:col-span-2 lg:col-span-4 flex gap-2 justify-end">
        <button type="button" className="btn-secondary !py-2" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn-primary !py-2" onClick={save}>
          <Check size={16} /> Save
        </button>
      </div>
      {s.carrier === "AKKON" && s.akkonCountry && (
        <p className="sm:col-span-2 lg:col-span-4 text-[11px] text-slate-500">
          Found under loading country: {countryLabel(s.akkonCountry)}.
        </p>
      )}
    </div>
  );
}
