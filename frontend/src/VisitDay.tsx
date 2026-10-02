import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarX,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileDown,
  KeyRound,
  Loader2,
  Lock,
  MapPin,
  Pencil,
  Pin,
  Plus,
  Printer,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";

/* ==========================================================================
 * Visit day — the customs visit days of our clients, shared by the office.
 *
 * Saved on the server (Upstash Redis, see api/visit_days.py), so everyone
 * sees the same list. Every call carries the office access code; this PC
 * remembers it until someone presses Lock.
 *
 *   Today (pinned first)   — visit date = today
 *   1. No visit date yet   — still to check on ALCES / not programmed yet
 *   2. Waiting             — visit date after today, soonest first
 *   3. Passed              — visit date before today, 10 per page
 *
 * The page asks the server every minute "did anything change?" (1 tiny
 * call) and reloads the list only when it did.
 * ======================================================================== */

const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");
const CODE_KEY = "visit_code_v1";
const POLL_MS = 60_000;
const PAGE = 10;

type Visit = {
  id: string;
  client: string;
  declaration: string;
  place: string;
  /** "YYYY-MM-DD" or "" */
  visit_date: string;
  created_at: string;
  updated_at: string;
};

type Board = {
  today: string;
  version: number;
  no_date: Visit[];
  today_visits: Visit[];
  upcoming: Visit[];
  passed_total: number;
};

type PassedPage = { items: Visit[]; offset: number; total: number };

type Kind = "no_date" | "upcoming" | "today" | "passed";

class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function call<T>(path: string, code: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/visits${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "X-Visit-Code": code, ...(init.headers || {}) },
    });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check the internet connection.");
  }
  if (res.ok) return (await res.json()) as T;
  const data = await res.json().catch(() => ({}));
  throw new ApiError(res.status, typeof data?.detail === "string" ? data.detail : `Server error (HTTP ${res.status})`, data);
}

/* ---- storage (the code only — the list lives on the server) -------------- */

const loadCode = () => {
  try {
    return localStorage.getItem(CODE_KEY) || "";
  } catch {
    return "";
  }
};
const saveCode = (c: string) => {
  try {
    if (c) localStorage.setItem(CODE_KEY, c);
    else localStorage.removeItem(CODE_KEY);
  } catch {
    /* private window: the code lives for this visit only */
  }
};

/* ---- dates ---------------------------------------------------------------- */

const maskDate = (value: string) => {
  const d = value.replace(/\D/g, "").slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
};

/** "02/10/2026" -> "2026-10-02"; "" -> ""; invalid -> null */
const dmyToIso = (s: string): string | null => {
  const t = s.trim();
  if (!t) return "";
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

const isoToDmy = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
};

const dayNum = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
const daysBetween = (fromIso: string, toIso: string) => Math.round(dayNum(toIso) - dayNum(fromIso));

const addDays = (iso: string, n: number) => {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
};
const addMonths = (iso: string, n: number) => {
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7) - 1 + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(y, m, Math.min(+iso.slice(8, 10), last)));
  return d.toISOString().slice(0, 10);
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekday = (iso: string) => WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()];

/* ---- PDF periods ----------------------------------------------------------- */

type Period = "week" | "month" | "3months" | "6months" | "year" | "all" | "custom";
const PERIODS: { id: Period; label: string }[] = [
  { id: "week", label: "Past week" },
  { id: "month", label: "Past month" },
  { id: "3months", label: "Past 3 months" },
  { id: "6months", label: "Past 6 months" },
  { id: "year", label: "Past year" },
  { id: "all", label: "Everything" },
  { id: "custom", label: "Custom dates" },
];

function periodRange(p: Period, today: string): { start: string; end: string } {
  switch (p) {
    case "week":
      return { start: addDays(today, -7), end: today };
    case "month":
      return { start: addMonths(today, -1), end: today };
    case "3months":
      return { start: addMonths(today, -3), end: today };
    case "6months":
      return { start: addMonths(today, -6), end: today };
    case "year":
      return { start: addMonths(today, -12), end: today };
    default:
      return { start: "", end: "" };
  }
}

/* ==========================================================================
 * Page
 * ======================================================================== */

export default function VisitDay({ active }: { active: boolean }) {
  const [code, setCode] = useState(loadCode);
  const [codeInput, setCodeInput] = useState("");
  const [lockError, setLockError] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  const [board, setBoard] = useState<Board | null>(null);
  const [passed, setPassed] = useState<PassedPage | null>(null);
  const [passedOffset, setPassedOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [passedLoading, setPassedLoading] = useState(false);

  // add form
  const [client, setClient] = useState("");
  const [declaration, setDeclaration] = useState("");
  const [place, setPlace] = useState("");
  const [visitDate, setVisitDate] = useState("");
  const [adding, setAdding] = useState(false);
  const [addDup, setAddDup] = useState<Visit | null>(null);

  const [editing, setEditing] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Visit | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showPrint, setShowPrint] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const codeRef = useRef(code);
  codeRef.current = code;
  const offsetRef = useRef(passedOffset);
  offsetRef.current = passedOffset;
  const boardRef = useRef(board);
  boardRef.current = board;

  const flash = useCallback((message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    window.setTimeout(() => setToast((t) => (t?.message === message ? null : t)), 4200);
  }, []);

  const lock = useCallback((message = "") => {
    saveCode("");
    setCode("");
    setBoard(null);
    setPassed(null);
    setEditing(null);
    setToDelete(null);
    setShowPrint(false);
    setLockError(message);
  }, []);

  /** Turn an API error into the right reaction. */
  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return lock("The access code changed — type the new one.");
      if (err instanceof ApiError && err.status === 429) return lock(err.message);
      flash(err instanceof Error ? err.message : "Unexpected error.", "error");
    },
    [flash, lock]
  );

  /* ---- loading ------------------------------------------------------------ */
  const loadPassed = useCallback(
    async (offset: number, c = codeRef.current) => {
      setPassedLoading(true);
      try {
        const p = await call<PassedPage>(`/passed?offset=${offset}&limit=${PAGE}`, c);
        if (p.total > 0 && offset >= p.total) {
          // the page we were on is gone (items deleted) — go to the last one
          const last = Math.floor((p.total - 1) / PAGE) * PAGE;
          setPassedOffset(last);
          setPassed(await call<PassedPage>(`/passed?offset=${last}&limit=${PAGE}`, c));
        } else {
          setPassed(p);
        }
      } finally {
        setPassedLoading(false);
      }
    },
    []
  );

  const loadAll = useCallback(
    async (c = codeRef.current) => {
      if (!c) return;
      setLoading(true);
      try {
        const [b] = await Promise.all([call<Board>("/board", c), loadPassed(offsetRef.current, c)]);
        setBoard(b);
      } catch (err) {
        fail(err);
      } finally {
        setLoading(false);
      }
    },
    [fail, loadPassed]
  );

  // first time the page is opened (and the code is known): load
  const loadedOnce = useRef(false);
  useEffect(() => {
    if (!active || !code || loadedOnce.current) return;
    loadedOnce.current = true;
    void loadAll(code);
  }, [active, code, loadAll]);

  // every minute (and when the window gets the focus back): changed? -> reload
  useEffect(() => {
    if (!active || !code || !board) return;
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const v = await call<{ version: number; today: string }>("/version", codeRef.current);
        const b = boardRef.current;
        if (!b || v.version !== b.version || v.today !== b.today) await loadAll();
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 429)) fail(err);
      } finally {
        busy = false;
      }
    };
    const id = window.setInterval(check, POLL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [active, code, board, loadAll, fail]);

  /* ---- unlock ------------------------------------------------------------- */
  const unlock = async () => {
    const c = codeInput.trim();
    if (!c) return setLockError("Type the access code.");
    setUnlocking(true);
    setLockError("");
    try {
      const b = await call<Board>("/board", c);
      saveCode(c);
      setCode(c);
      setCodeInput("");
      setBoard(b);
      loadedOnce.current = true;
      setPassedOffset(0);
      await loadPassed(0, c);
    } catch (err) {
      setLockError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setUnlocking(false);
    }
  };

  /* ---- add / edit / delete -------------------------------------------------- */
  const addVisit = async (force = false) => {
    const iso = dmyToIso(visitDate);
    if (!client.trim()) return flash("Type the client name.", "error");
    if (!declaration.trim()) return flash("Type the declaration number.", "error");
    if (iso === null) return flash("Visit date: use dd/mm/yyyy (or leave it empty).", "error");
    setAdding(true);
    try {
      const v = await call<Visit>("", code, {
        method: "POST",
        body: JSON.stringify({ client, declaration, place, visit_date: iso, force }),
      });
      setClient("");
      setDeclaration("");
      setPlace("");
      setVisitDate("");
      setAddDup(null);
      flash(`${v.client} added.`);
      await loadAll();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data.duplicate) setAddDup(err.data.duplicate as Visit);
      else fail(err);
    } finally {
      setAdding(false);
    }
  };

  /** Returns a duplicate (to confirm) or null when saved / handled. */
  const saveVisit = async (v: Visit, patch: Omit<Visit, "id" | "created_at" | "updated_at">, force = false): Promise<Visit | null> => {
    try {
      await call<Visit>(`/${v.id}`, code, {
        method: "PUT",
        body: JSON.stringify({ ...patch, expected_updated_at: v.updated_at, force }),
      });
      setEditing(null);
      flash(`${patch.client} saved.`);
      await loadAll();
      return null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data.duplicate) return err.data.duplicate as Visit;
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        setEditing(null);
        flash(err.message, "error");
        await loadAll();
        return null;
      }
      fail(err);
      return null;
    }
  };

  /** Called by the confirmation panel only. Removes the client everywhere
   *  (it is one record on the server, whatever its section). */
  const deleteVisit = async (v: Visit) => {
    setDeleting(true);
    try {
      await call(`/${v.id}`, code, { method: "DELETE" });
      setToDelete(null);
      setEditing((e) => (e === v.id ? null : e));
      flash(`${v.client} deleted.`);
      await loadAll();
    } catch (err) {
      setToDelete(null);
      fail(err);
    } finally {
      setDeleting(false);
    }
  };

  const goPassed = async (offset: number) => {
    setPassedOffset(offset);
    try {
      await loadPassed(offset);
    } catch (err) {
      fail(err);
    }
  };

  /* ---- view ------------------------------------------------------------------ */
  const places = useMemo(() => {
    const all = [
      ...(board?.no_date ?? []),
      ...(board?.upcoming ?? []),
      ...(board?.today_visits ?? []),
      ...(passed?.items ?? []),
    ];
    return Array.from(new Set(all.map((v) => v.place.trim()).filter(Boolean))).sort();
  }, [board, passed]);

  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const toastEl = toast && (
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
  );

  const header = (
    <header className="mb-6 flex items-center gap-3 sm:gap-4">
      <div className="grid place-items-center w-11 h-11 sm:w-12 sm:h-12 shrink-0 rounded-2xl bg-gradient-to-br from-indigo-500 to-blue-600 shadow-lg shadow-indigo-500/30">
        <CalendarDays size={24} className="text-white" />
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="text-lg sm:text-2xl font-bold tracking-tight text-white leading-tight">Visit day</h1>
        <p className="text-slate-400 text-xs sm:text-sm">Customs visit days of our clients — shared with the office, saved on the server.</p>
      </div>
      {code && board && (
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" className={`btn-ghost ${showPrint ? "!bg-indigo-500/20 !text-white" : ""}`} onClick={() => setShowPrint((v) => !v)} title="Print a PDF">
            <Printer size={16} /> <span className="hidden sm:inline">Print PDF</span>
          </button>
          <button type="button" className="btn-ghost" onClick={() => void loadAll()} disabled={loading} title="Reload the list">
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>
          <button type="button" className="btn-ghost" onClick={() => lock()} title="Lock this page on this computer">
            <Lock size={16} /> <span className="hidden sm:inline">Lock</span>
          </button>
        </div>
      )}
    </header>
  );

  /* ---- locked ---------------------------------------------------------------- */
  if (!code || !board) {
    return (
      <div className="app-shell h-full overflow-y-auto">
        {toastEl}
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
          {header}
          {code && !board ? (
            <div className="card text-center py-14 text-slate-400">
              {loading ? (
                <>
                  <Loader2 size={28} className="mx-auto mb-3 animate-spin text-indigo-300" />
                  <p className="text-sm">Loading the visit days…</p>
                </>
              ) : (
                <>
                  <p className="text-sm mb-4">The list could not be loaded.</p>
                  <button type="button" className="btn-primary mx-auto" onClick={() => void loadAll()}>
                    <RefreshCw size={16} /> Try again
                  </button>
                </>
              )}
            </div>
          ) : (
            <form
              className="card max-w-md mx-auto text-center !py-10"
              onSubmit={(e) => {
                e.preventDefault();
                void unlock();
              }}
            >
              <div className="grid place-items-center w-14 h-14 mx-auto mb-4 rounded-2xl bg-indigo-500/15 border border-indigo-400/30">
                <KeyRound size={26} className="text-indigo-200" />
              </div>
              <h2 className="text-lg font-bold text-white">This page is protected</h2>
              <p className="text-sm text-slate-400 mt-1 mb-5">Type the office access code to see and edit the visit days.</p>
              <input
                className="input text-center tracking-widest"
                type="password"
                autoComplete="current-password"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder="Access code"
                aria-label="Access code"
              />
              {lockError && (
                <p className="mt-3 text-sm text-rose-300 flex items-center justify-center gap-1.5">
                  <AlertTriangle size={15} className="shrink-0" /> {lockError}
                </p>
              )}
              <button type="submit" className="btn-primary w-full justify-center mt-4" disabled={unlocking}>
                {unlocking ? <Loader2 size={16} className="animate-spin" /> : <Lock size={16} />} Unlock
              </button>
              <p className="mt-4 text-xs text-slate-500">This computer remembers the code until someone presses Lock.</p>
            </form>
          )}
        </div>
      </div>
    );
  }

  /* ---- unlocked -------------------------------------------------------------- */
  const today = board.today;
  const passedTotal = passed?.total ?? board.passed_total;
  const counts: { id: string; label: string; n: number; cls: string }[] = [
    { id: "vd-today", label: "Today", n: board.today_visits.length, cls: "vd-dot-green" },
    { id: "vd-nodate", label: "No date", n: board.no_date.length, cls: "vd-dot-amber" },
    { id: "vd-waiting", label: "Waiting", n: board.upcoming.length, cls: "vd-dot-blue" },
    { id: "vd-passed", label: "Passed", n: passedTotal, cls: "vd-dot-grey" },
  ];

  const rowProps = (v: Visit, kind: Kind) => ({
    v,
    kind,
    today,
    editing: editing === v.id,
    onEdit: () => setEditing(editing === v.id ? null : v.id),
    onSave: (patch: Omit<Visit, "id" | "created_at" | "updated_at">, force: boolean) => saveVisit(v, patch, force),
    onDelete: () => setToDelete(v),
  });

  return (
    <div className="app-shell h-full overflow-y-auto">
      {toastEl}
      {toDelete && (
        <DeleteConfirm v={toDelete} busy={deleting} onCancel={() => setToDelete(null)} onConfirm={() => void deleteVisit(toDelete)} />
      )}
      <datalist id="vd-places">
        {places.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
        {header}

        {showPrint && <PrintCard code={code} today={today} onClose={() => setShowPrint(false)} onError={fail} />}

        {/* Today — pinned first: the most important list */}
        <Section
          id="vd-today"
          tone="green"
          icon={<CalendarCheck size={18} />}
          title="Today's visits"
          pinned
          sub={`${weekday(today)} ${isoToDmy(today)}`}
          count={board.today_visits.length}
          empty="No visit today."
        >
          {board.today_visits.map((v) => (
            <VisitRow key={v.id} {...rowProps(v, "today")} />
          ))}
        </Section>

        {/* Add */}
        <section className="card mb-5">
          <h2 className="section-title">Add a client</h2>
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_0.8fr_auto] items-end"
            onSubmit={(e) => {
              e.preventDefault();
              void addVisit(false);
            }}
          >
            <Field label="Client" required>
              <input className="input" dir="auto" value={client} onChange={(e) => setClient(e.target.value)} placeholder="Client name" />
            </Field>
            <Field label="Declaration no." required>
              <input
                className="input font-mono"
                value={declaration}
                onChange={(e) => {
                  setDeclaration(e.target.value);
                  setAddDup(null);
                }}
                placeholder="e.g. 12345/2026"
              />
            </Field>
            <Field label="Place">
              <input className="input" dir="auto" list="vd-places" value={place} onChange={(e) => setPlace(e.target.value)} placeholder="optional" />
            </Field>
            <Field label="Visit day">
              <input className="input" inputMode="numeric" value={visitDate} onChange={(e) => setVisitDate(maskDate(e.target.value))} placeholder="dd/mm/yyyy" />
            </Field>
            <button type="submit" className="btn-primary justify-center sm:col-span-2 lg:col-span-1" disabled={adding}>
              {adding ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Add
            </button>
          </form>
          {addDup && (
            <DuplicateNote
              dup={addDup}
              onConfirm={() => void addVisit(true)}
              onCancel={() => setAddDup(null)}
              confirmLabel="Add anyway"
            />
          )}
          <p className="mt-3 text-xs text-slate-500">No visit date yet? Leave it empty — the client waits in “No visit date yet” until you add it.</p>
        </section>

        {/* Counts */}
        <div className="flex flex-wrap gap-2 mb-5">
          {counts.map((c) => (
            <button key={c.id} type="button" className="trk-tab" onClick={() => scrollTo(c.id)}>
              <span className={`vd-dot ${c.cls}`} />
              {c.label} <span className="trk-tab-count">{c.n}</span>
            </button>
          ))}
        </div>

        {/* 1 — no date */}
        <Section
          id="vd-nodate"
          tone="amber"
          icon={<CalendarX size={18} />}
          title="No visit date yet"
          sub="Check the visit day on ALCES, or the visit is not programmed yet."
          count={board.no_date.length}
          empty="Every client has a visit date."
        >
          {board.no_date.map((v) => (
            <VisitRow key={v.id} {...rowProps(v, "no_date")} />
          ))}
        </Section>

        {/* 2 — waiting */}
        <Section
          id="vd-waiting"
          tone="blue"
          icon={<CalendarClock size={18} />}
          title="Waiting for the visit day"
          sub="Soonest first."
          count={board.upcoming.length}
          empty="No upcoming visit."
        >
          {board.upcoming.map((v) => (
            <VisitRow key={v.id} {...rowProps(v, "upcoming")} />
          ))}
        </Section>

        {/* 3 — passed */}
        <Section
          id="vd-passed"
          tone="grey"
          icon={<Clock size={18} />}
          title="Passed visits"
          sub="Latest first."
          count={passedTotal}
          empty="No passed visit yet."
          footer={
            passedTotal > PAGE && (
              <div className="flex items-center justify-between gap-3 pt-3">
                <button
                  type="button"
                  className="btn-ghost !py-1.5"
                  disabled={passedOffset === 0 || passedLoading}
                  onClick={() => void goPassed(Math.max(0, passedOffset - PAGE))}
                >
                  <ChevronLeft size={15} /> Newer
                </button>
                <span className="text-xs text-slate-400 tabular-nums">
                  {passedLoading ? <Loader2 size={14} className="inline animate-spin" /> : null}{" "}
                  {passedOffset + 1}–{Math.min(passedOffset + PAGE, passedTotal)} of {passedTotal}
                </span>
                <button
                  type="button"
                  className="btn-ghost !py-1.5"
                  disabled={passedOffset + PAGE >= passedTotal || passedLoading}
                  onClick={() => void goPassed(passedOffset + PAGE)}
                >
                  Older <ChevronRight size={15} />
                </button>
              </div>
            )
          }
        >
          {(passed?.items ?? []).map((v) => (
            <VisitRow key={v.id} {...rowProps(v, "passed")} />
          ))}
        </Section>
      </div>
    </div>
  );
}

/* ==========================================================================
 * Pieces
 * ======================================================================== */

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 min-w-0">
      <span className="text-sm font-medium text-slate-300">
        {label} {required ? <span className="text-indigo-400">*</span> : <span className="text-slate-500 text-xs">(optional)</span>}
      </span>
      {children}
    </label>
  );
}

function Section({
  id,
  tone,
  icon,
  title,
  sub,
  count,
  empty,
  footer,
  pinned,
  children,
}: {
  id: string;
  tone: "amber" | "blue" | "green" | "grey";
  icon: ReactNode;
  title: string;
  sub: string;
  count: number;
  empty: string;
  footer?: ReactNode;
  pinned?: boolean;
  children: ReactNode;
}) {
  const hasRows = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <section id={id} className={`card mb-5 vd-section vd-section-${tone} scroll-mt-4`}>
      <div className="flex items-center gap-3 mb-3">
        <span className={`vd-icon vd-icon-${tone}`}>{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className={`${pinned ? "text-lg" : "text-base"} font-bold text-white leading-tight`}>
            {title} <span className="text-slate-400 font-semibold">({count})</span>
          </h2>
          <p className="text-xs text-slate-400">{sub}</p>
        </div>
        {pinned && (
          <span className="trk-badge trk-badge-green shrink-0" title="Always first on this page">
            <Pin size={12} /> Pinned
          </span>
        )}
      </div>
      {hasRows ? <div className="divide-y divide-slate-800/80">{children}</div> : <p className="text-sm text-slate-500 py-3">{empty}</p>}
      {footer}
    </section>
  );
}

function DuplicateNote({
  dup,
  onConfirm,
  onCancel,
  confirmLabel,
}: {
  dup: Visit;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel: string;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-amber-400/40 bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-100">
      <AlertTriangle size={16} className="shrink-0 text-amber-300" />
      <span className="flex-1 min-w-[12rem]">
        Declaration <bdi className="font-mono font-semibold">{dup.declaration}</bdi> is already in the list —{" "}
        <bdi className="font-semibold">{dup.client}</bdi>
        {dup.visit_date ? `, visit ${isoToDmy(dup.visit_date)}` : ", no visit date yet"}.
      </span>
      <button type="button" className="btn-ghost !py-1.5" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="btn-primary !py-1.5 !px-3 !text-sm" onClick={onConfirm}>
        {confirmLabel}
      </button>
    </div>
  );
}

function DateBadge({ v, kind, today }: { v: Visit; kind: Kind; today: string }) {
  if (kind === "no_date") {
    const added = v.created_at ? daysBetween(v.created_at.slice(0, 10), today) : 0;
    return (
      <span className={`trk-badge ${added >= 3 ? "trk-badge-amber" : "trk-badge-grey"}`}>
        {added <= 0 ? "Added today" : added === 1 ? "Added yesterday" : `Added ${added} days ago`}
      </span>
    );
  }
  const d = daysBetween(today, v.visit_date);
  if (kind === "today" || d === 0) return <span className="trk-badge trk-badge-green">Today</span>;
  if (d > 0) return <span className={`trk-badge ${d <= 2 ? "trk-badge-amber" : "trk-badge-blue"}`}>{d === 1 ? "Tomorrow" : `In ${d} days`}</span>;
  return <span className="trk-badge trk-badge-grey">{d === -1 ? "Yesterday" : `${-d} days ago`}</span>;
}

type Patch = Omit<Visit, "id" | "created_at" | "updated_at">;

function VisitRow({
  v,
  kind,
  today,
  editing,
  onEdit,
  onSave,
  onDelete,
}: {
  v: Visit;
  kind: Kind;
  today: string;
  editing: boolean;
  onEdit: () => void;
  onSave: (patch: Patch, force: boolean) => Promise<Visit | null>;
  onDelete: () => void;
}) {
  return (
    <div className="py-3 first:pt-1">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-100 break-words">
            <bdi>{v.client}</bdi>
          </p>
          <p className="mt-0.5 text-xs text-slate-400 flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span>
              N° <bdi className="font-mono text-slate-300">{v.declaration}</bdi>
            </span>
            {v.place && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={12} className="shrink-0" /> <bdi className="text-slate-300">{v.place}</bdi>
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap sm:justify-end">
          {v.visit_date && (
            <span className="text-sm font-semibold text-slate-100 tabular-nums">
              <span className="text-slate-400 font-normal me-1.5 hidden md:inline">{weekday(v.visit_date).slice(0, 3)}</span>
              {isoToDmy(v.visit_date)}
            </span>
          )}
          <DateBadge v={v} kind={kind} today={today} />
          <button type="button" className="etq-icon-btn" onClick={onEdit} title={kind === "no_date" ? "Edit / set the visit day" : "Edit"} aria-label="Edit">
            {editing ? <X size={15} /> : <Pencil size={15} />}
          </button>
          <button type="button" className="etq-icon-btn vd-delete-btn" onClick={onDelete} title="Delete this client" aria-label="Delete">
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      {editing && <EditForm v={v} onSave={onSave} onCancel={onEdit} onDelete={onDelete} />}
    </div>
  );
}

function EditForm({
  v,
  onSave,
  onCancel,
  onDelete,
}: {
  v: Visit;
  onSave: (p: Patch, force: boolean) => Promise<Visit | null>;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [f, setF] = useState({
    client: v.client,
    declaration: v.declaration,
    place: v.place,
    date: isoToDmy(v.visit_date),
  });
  const [saving, setSaving] = useState(false);
  const [dup, setDup] = useState<Visit | null>(null);
  const [error, setError] = useState("");

  const save = async (force = false) => {
    const iso = dmyToIso(f.date);
    if (!f.client.trim()) return setError("Client name is required.");
    if (!f.declaration.trim()) return setError("Declaration number is required.");
    if (iso === null) return setError("Visit day: use dd/mm/yyyy (or leave it empty).");
    setError("");
    setSaving(true);
    const d = await onSave({ client: f.client, declaration: f.declaration, place: f.place, visit_date: iso }, force);
    setSaving(false);
    setDup(d);
  };

  return (
    <form
      className="mt-3 p-3 rounded-xl border border-slate-700/70 bg-slate-900/40 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-400">Client</span>
        <input className="input" dir="auto" value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-400">Declaration no.</span>
        <input className="input font-mono" value={f.declaration} onChange={(e) => setF({ ...f, declaration: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-400">Place</span>
        <input className="input" dir="auto" list="vd-places" value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })} placeholder="optional" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-400">Visit day (empty = no date yet)</span>
        <input className="input" inputMode="numeric" placeholder="dd/mm/yyyy" value={f.date} onChange={(e) => setF({ ...f, date: maskDate(e.target.value) })} />
      </label>
      {error && <p className="sm:col-span-2 lg:col-span-4 text-sm text-rose-300">{error}</p>}
      {dup && (
        <div className="sm:col-span-2 lg:col-span-4 -mt-3">
          <DuplicateNote dup={dup} onConfirm={() => void save(true)} onCancel={() => setDup(null)} confirmLabel="Save anyway" />
        </div>
      )}
      <div className="sm:col-span-2 lg:col-span-4 flex flex-wrap gap-2 justify-end">
        <button type="button" className="btn-secondary vd-btn-danger-ghost !py-2 me-auto" onClick={onDelete}>
          <Trash2 size={15} /> Delete client
        </button>
        <button type="button" className="btn-secondary !py-2" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary !py-2" disabled={saving}>
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Save
        </button>
      </div>
    </form>
  );
}

/* ---- Delete confirmation -------------------------------------------------- */

function DeleteConfirm({ v, busy, onCancel, onConfirm }: { v: Visit; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const close = useRef(onCancel);
  close.current = busy ? () => undefined : onCancel;
  useEffect(() => {
    cancelRef.current?.focus(); // Enter on the keyboard = Cancel, never Delete
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center p-4 bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div role="alertdialog" aria-modal="true" aria-labelledby="vd-del-title" className="card w-full max-w-md !p-6 border-rose-500/40">
        <div className="flex items-start gap-3">
          <span className="grid place-items-center w-11 h-11 shrink-0 rounded-xl bg-rose-500/15 border border-rose-400/40 text-rose-300">
            <Trash2 size={20} />
          </span>
          <div className="min-w-0">
            <h2 id="vd-del-title" className="text-lg font-bold text-white">
              Delete this client?
            </h2>
            <p className="text-sm text-slate-400 mt-0.5">Check it is the right one.</p>
          </div>
        </div>
        <dl className="mt-4 rounded-xl border border-slate-700/70 bg-slate-900/50 px-4 py-3 text-sm grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-slate-400">Client</dt>
          <dd className="font-semibold text-white break-words">
            <bdi>{v.client}</bdi>
          </dd>
          <dt className="text-slate-400">Declaration</dt>
          <dd className="font-mono text-slate-200">
            <bdi>{v.declaration}</bdi>
          </dd>
          {v.place && (
            <>
              <dt className="text-slate-400">Place</dt>
              <dd className="text-slate-200">
                <bdi>{v.place}</bdi>
              </dd>
            </>
          )}
          <dt className="text-slate-400">Visit day</dt>
          <dd className="text-slate-200">{v.visit_date ? `${weekday(v.visit_date)} ${isoToDmy(v.visit_date)}` : "No visit date yet"}</dd>
        </dl>
        <p className="mt-4 text-sm text-rose-200/90 flex gap-2">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          It is removed from every section and from the PDFs, for everyone in the office. This cannot be undone.
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button ref={cancelRef} type="button" className="btn-secondary !py-2.5" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary vd-btn-danger !py-2.5" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />} Yes, delete
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---- Print PDF ------------------------------------------------------------- */

function PrintCard({
  code,
  today,
  onClose,
  onError,
}: {
  code: string;
  today: string;
  onClose: () => void;
  onError: (err: unknown) => void;
}) {
  const [period, setPeriod] = useState<Period>("month");
  const [from, setFrom] = useState(isoToDmy(addMonths(today, -1)));
  const [to, setTo] = useState(isoToDmy(today));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const range = (): { start: string; end: string } | null => {
    if (period !== "custom") return periodRange(period, today);
    const s = dmyToIso(from);
    const e = dmyToIso(to);
    if (s === null || e === null) return null;
    return { start: s, end: e };
  };
  const r = range();

  const download = async () => {
    if (!r) return setError("Dates: use dd/mm/yyyy.");
    setError("");
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/visits/pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Visit-Code": code },
        body: JSON.stringify(r),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new ApiError(res.status, typeof data?.detail === "string" ? data.detail : `Server error (HTTP ${res.status})`, data);
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || `jours_de_visite_${today}.pdf`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 429)) onError(err);
      else setError(err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  let summary = "Every client in the list.";
  if (r && r.start && r.end) summary = `Clients added from ${isoToDmy(r.start)} to ${isoToDmy(r.end)}.`;
  else if (r && r.start) summary = `Clients added since ${isoToDmy(r.start)}.`;
  else if (r && r.end) summary = `Clients added until ${isoToDmy(r.end)}.`;

  return (
    <section className="card mb-5 border-indigo-500/30">
      <div className="flex items-start gap-3">
        <h2 className="section-title flex-1 flex items-center gap-2">
          <Printer size={16} className="text-indigo-300" /> Print the list (PDF)
        </h2>
        <button type="button" className="etq-icon-btn" onClick={onClose} aria-label="Close" title="Close">
          <X size={15} />
        </button>
      </div>
      <p className="text-sm text-slate-400 -mt-1 mb-3">Which clients? By the day they were added to the list.</p>
      <div className="flex flex-wrap gap-2">
        {PERIODS.map((p) => (
          <button key={p.id} type="button" className={`trk-tab ${period === p.id ? "trk-tab-active" : ""}`} onClick={() => setPeriod(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      {period === "custom" && (
        <div className="mt-3 grid grid-cols-2 gap-3 max-w-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-400">From</span>
            <input className="input" inputMode="numeric" placeholder="dd/mm/yyyy" value={from} onChange={(e) => setFrom(maskDate(e.target.value))} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-400">To</span>
            <input className="input" inputMode="numeric" placeholder="dd/mm/yyyy" value={to} onChange={(e) => setTo(maskDate(e.target.value))} />
          </label>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" onClick={() => void download()} disabled={busy || !r}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <FileDown size={16} />} Download PDF
        </button>
        <p className="text-xs text-slate-400">
          {summary} Sections: no visit date yet, waiting, passed — today's visits are not printed.
        </p>
      </div>
      {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
    </section>
  );
}
