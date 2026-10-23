import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, KeyRound, Loader2, Lock, RefreshCw, Stamp, Undo2 } from "lucide-react";
import { useCoverCode } from "./coverCode";

/* ==========================================================================
 * Papers / Stamps — who took or gave back an important paper (ENDI,
 * Autorisation, ...) or a client's stamp (Cachet), so nothing gets lost.
 *
 * Every movement is one line in the clients Google Sheet ("Documents" or
 * "Stamps" table, written by the server — api/cover_sheet.py, Code.gs v2).
 * The page shows what is still out (latest movement = أخذ) and the last
 * movements. Same private code as the Folder cover.
 * ======================================================================== */

const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");
const SCRIPT_LINK = "https://github.com/khbadri16/transit-web/blob/main/cover-sheet/Code.gs";
const REFRESH = "papers-refresh";

type Table = "documents" | "stamps";
type Movement = "took" | "returned";

type Line = {
  at: string;
  client: string;
  document: string;
  person: string;
  movement: Movement | "";
  label: string;
  days?: number | null;
};

type Answer = {
  ready: boolean;
  code: string; // "not_configured" | "old_script" when not ready
  error: string;
  added: boolean;
  out: Line[];
  recent: Line[];
};

const DOCUMENTS = ["ENDI", "Autorisation"];
const OTHER = "OTHER";
const STAMP = "Cachet";
const MOVES: { v: Movement; ar: string }[] = [
  { v: "took", ar: "أخذ" },
  { v: "returned", ar: "أرجع" },
];

const SETUP = {
  documents: {
    title: "Papers",
    ar: "الوثائق",
    Icon: FileText,
    intro: "Write down every ENDI, Autorisation or other paper that someone takes or gives back — it goes in the clients sheet (Documents table).",
    owner: "صاحب الوثيقة",
  },
  stamps: {
    title: "Stamps",
    ar: "الأختام",
    Icon: Stamp,
    intro: "Write down every client stamp (Cachet) that someone takes or gives back — it goes in the clients sheet (Stamps table).",
    owner: "صاحب الختم",
  },
} as const;

const EMPTY_FORM = { client: "", docChoice: "", docOther: "", person: "", movement: "" as Movement | "" };

const since = (l: Line) =>
  l.days === null || l.days === undefined ? "" : l.days === 0 ? "today" : l.days === 1 ? "1 day" : `${l.days} days`;

export default function PaperTracker({ table }: { table: Table }) {
  const setup = SETUP[table];
  const [code, setCode] = useCoverCode();
  const [codeInput, setCodeInput] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  const [data, setData] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [f, setF] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const noteTimer = useRef<number | undefined>(undefined);
  const personRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const showNote = (text: string) => {
    window.clearTimeout(noteTimer.current);
    setNote(text);
    noteTimer.current = text ? window.setTimeout(() => setNote(""), 6000) : undefined;
  };
  useEffect(() => () => window.clearTimeout(noteTimer.current), []);

  const lock = (message = "") => {
    setCode("");
    setUnlockError(message);
  };

  const unlock = async () => {
    const typed = codeInput.trim();
    if (!typed) return setUnlockError("Type the code.");
    setUnlocking(true);
    setUnlockError("");
    try {
      const res = await fetch(`${API_URL}/api/folder-cover/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: typed }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(typeof d?.detail === "string" ? d.detail : `Server error (HTTP ${res.status})`);
      }
      setCode(typed);
      setCodeInput("");
    } catch (err) {
      setUnlockError(err instanceof TypeError ? "Could not reach the server." : err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setUnlocking(false);
    }
  };

  /** GET (list) or POST (add one movement). Throws an Error with a message for the page. */
  const call = async (body?: object): Promise<Answer> => {
    const res = await fetch(`${API_URL}/api/papers/${table}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", "X-Cover-Code": code },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      const detail = typeof d?.detail === "string" ? d.detail : `Server error (HTTP ${res.status})`;
      if (res.status === 401) {
        lock(`${detail} The code was changed — type the new one.`);
        throw new Error("");
      }
      throw new Error(detail);
    }
    return (await res.json()) as Answer;
  };

  const load = async () => {
    setLoading(true);
    setLoadError("");
    try {
      setData(await call());
    } catch (err) {
      setLoadError(err instanceof TypeError ? "Could not reach the server." : err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (code) void load();
    else setData(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, table]);

  /* Refresh in one section reads both tables again; while not ready (old
     script in the office), check again whenever the page comes back to the front */
  useEffect(() => {
    if (!code) return;
    const again = () => void load();
    window.addEventListener(REFRESH, again);
    if (data && !data.ready) window.addEventListener("focus", again);
    return () => {
      window.removeEventListener(REFRESH, again);
      window.removeEventListener("focus", again);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, data]);

  const set = <K extends keyof typeof EMPTY_FORM>(k: K, v: (typeof EMPTY_FORM)[K]) => setF((p) => ({ ...p, [k]: v }));
  const docName = table === "stamps" ? STAMP : f.docChoice === OTHER ? f.docOther.trim() : f.docChoice;

  const save = async () => {
    setError("");
    showNote("");
    if (!f.client.trim()) return setError("Type the client name.");
    if (!docName) return setError(f.docChoice === OTHER ? "Type the name of the document." : "Choose the document.");
    if (!f.person.trim()) return setError("Type the name of the person.");
    if (!f.movement) return setError("Choose أخذ or أرجع.");
    setSaving(true);
    try {
      const answer = await call({ client: f.client, document: docName, person: f.person, movement: f.movement });
      setData(answer);
      const saved = answer.recent[0]; // the line just written, as the sheet keeps it
      showNote(saved ? `Saved in the sheet — ${saved.person} ${saved.label} ${saved.document} (${saved.client}).` : "Saved in the sheet.");
      setF(EMPTY_FORM);
    } catch (err) {
      if (err instanceof Error && !err.message) return; // locked (wrong code)
      setError(err instanceof TypeError ? "Could not reach the server." : err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setSaving(false);
    }
  };

  /** "أرجع" on a line still out: the form is filled, only the person may change. */
  const prefillReturn = (l: Line) => {
    setError("");
    const known = DOCUMENTS.find((d) => d.toUpperCase() === l.document.toUpperCase());
    setF({
      client: l.client,
      docChoice: table === "stamps" ? "" : known ?? OTHER,
      docOther: table === "stamps" || known ? "" : l.document,
      person: l.person,
      movement: "returned",
    });
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => {
      personRef.current?.focus();
      personRef.current?.select();
    }, 300);
  };

  const clients = useMemo(
    () => [...new Set([...(data?.out ?? []), ...(data?.recent ?? [])].map((l) => l.client).filter(Boolean))],
    [data]
  );
  const ready = !data || data.ready;

  const label = (text: string, ar: string) => (
    <span className="flex items-baseline justify-between gap-2 text-sm font-medium text-slate-300">
      <span>
        {text}
        <span className="text-indigo-400"> *</span>
      </span>
      <span className="text-xs text-slate-500" dir="rtl">
        {ar}
      </span>
    </span>
  );

  const moveBadge = (l: Line) => (
    <span
      dir="rtl"
      className={`shrink-0 px-2 py-0.5 rounded-md text-xs font-bold border ${
        l.movement === "took"
          ? "bg-amber-500/15 border-amber-400/40 text-amber-200"
          : l.movement === "returned"
            ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-200"
            : "border-slate-600 text-slate-300"
      }`}
    >
      {l.label || "—"}
    </span>
  );

  return (
    <fieldset className="group-box mt-8" id={`papers-${table}`}>
      <legend className="group-title">{setup.title}</legend>
      <div className="group-body">
        <section className="card">
          <div className="flex flex-wrap items-start gap-3 mb-1">
            <h2 className="section-title flex-1 !mb-0 flex items-center gap-2">
              <setup.Icon size={17} className="text-indigo-300" /> {setup.title}{" "}
              <span className="text-slate-500 font-normal text-sm">{setup.ar}</span>
            </h2>
            {code && (
              <>
                <button type="button" className="btn-ghost" onClick={() => window.dispatchEvent(new Event(REFRESH))} disabled={loading} title="Read the sheet again">
                  <RefreshCw size={15} className={loading ? "animate-spin" : ""} /> Refresh
                </button>
                <button type="button" className="btn-ghost" onClick={() => lock()} title="Lock on this computer" aria-label={`Lock ${setup.title}`}>
                  <Lock size={15} />
                </button>
              </>
            )}
          </div>
          <p className="text-xs text-slate-400 mb-5">{setup.intro}</p>

          {!code ? (
            <form
              className="flex flex-wrap items-center gap-3 p-4 rounded-xl border border-slate-700/70 bg-slate-900/40"
              onSubmit={(e) => {
                e.preventDefault();
                void unlock();
              }}
            >
              <span className="grid place-items-center w-10 h-10 rounded-xl bg-indigo-500/15 border border-indigo-400/30 shrink-0">
                <KeyRound size={18} className="text-indigo-200" />
              </span>
              <span className="text-sm text-slate-300 flex-1 min-w-[12rem]">
                This section is private — type the Folder cover code to use it on this computer.
              </span>
              <input
                type="password"
                autoComplete="off"
                className="input !w-44 !py-2"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder="Code"
                aria-label={`${setup.title} code`}
              />
              <button type="submit" className="btn-primary !py-2 !px-4 !text-sm" disabled={unlocking}>
                {unlocking ? <Loader2 size={15} className="animate-spin" /> : <Lock size={15} />} Unlock
              </button>
              {unlockError && (
                <p className="basis-full text-sm text-rose-300 flex items-center gap-1.5">
                  <AlertTriangle size={14} className="shrink-0" /> {unlockError}
                </p>
              )}
            </form>
          ) : (
            <>
              {data && !data.ready && (
                <div className="mb-5 p-4 rounded-xl border border-amber-400/40 bg-amber-500/10 text-sm text-amber-100">
                  <p className="font-semibold flex items-center gap-2">
                    <AlertTriangle size={16} className="shrink-0" /> Not ready yet — nothing can be saved for now.
                  </p>
                  {data.code === "old_script" ? (
                    <ol className="mt-2 ml-5 list-decimal space-y-1 text-amber-100/90">
                      <li>
                        The sheet script in the office must be updated once. At the office, open the clients sheet →
                        Extensions → Apps Script.
                      </li>
                      <li>
                        Replace all the code with the new{" "}
                        <a className="underline" href={SCRIPT_LINK} target="_blank" rel="noopener noreferrer">
                          Code.gs
                        </a>{" "}
                        and put <strong>your secret word</strong> back in <code>SECRET</code> (the same as before). Save.
                      </li>
                      <li>Deploy → Manage deployments → ✏️ → Version: New version → Deploy.</li>
                      <li>The link stays the same — nothing to change in Vercel. Then click Refresh (or come back to this page).</li>
                    </ol>
                  ) : (
                    <p className="mt-1 text-amber-100/90">{data.error}</p>
                  )}
                </div>
              )}
              {loadError && (
                <p className="mb-4 text-sm text-rose-300 flex items-center gap-1.5">
                  <AlertTriangle size={14} className="shrink-0" /> The sheet could not be read: {loadError}
                </p>
              )}

              <form
                ref={formRef}
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <fieldset disabled={!ready || saving} className="grid grid-cols-1 md:grid-cols-2 gap-4 disabled:opacity-60">
                  <label className="flex flex-col gap-1.5">
                    {label("Client", setup.owner)}
                    <input
                      className="input"
                      dir="auto"
                      list={`papers-${table}-clients`}
                      value={f.client}
                      onChange={(e) => set("client", e.target.value)}
                      placeholder="e.g. BENSALEM TEXTILE"
                    />
                    <datalist id={`papers-${table}-clients`}>
                      {clients.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                  </label>

                  {table === "stamps" ? (
                    <label className="flex flex-col gap-1.5">
                      {label("Item", "الختم")}
                      <input className="input" value={`${STAMP} — ختم`} readOnly tabIndex={-1} aria-readonly="true" />
                    </label>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <label className="flex flex-col gap-1.5">
                        {label("Document", "نوع الوثيقة")}
                        <select className="input" value={f.docChoice} onChange={(e) => set("docChoice", e.target.value)}>
                          <option value="">— Choose —</option>
                          {DOCUMENTS.map((d) => (
                            <option key={d} value={d}>
                              {d}
                            </option>
                          ))}
                          <option value={OTHER}>Other…</option>
                        </select>
                      </label>
                      {f.docChoice === OTHER && (
                        <input
                          className="input"
                          dir="auto"
                          value={f.docOther}
                          onChange={(e) => set("docOther", e.target.value)}
                          placeholder="Name of the document"
                          aria-label="Name of the document"
                          autoFocus
                        />
                      )}
                    </div>
                  )}

                  <label className="flex flex-col gap-1.5">
                    {label("Person", "الشخص")}
                    <input
                      ref={personRef}
                      className="input"
                      dir="auto"
                      value={f.person}
                      onChange={(e) => set("person", e.target.value)}
                      placeholder="Who took it / gave it back"
                    />
                  </label>

                  <label className="flex flex-col gap-1.5">
                    {label("Movement", "الحركة")}
                    <select
                      className="input"
                      dir="rtl"
                      value={f.movement}
                      onChange={(e) => set("movement", e.target.value as Movement | "")}
                    >
                      <option value="">— اختر —</option>
                      {MOVES.map((m) => (
                        <option key={m.v} value={m.v}>
                          {m.ar}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="md:col-span-2 flex flex-wrap items-center gap-3">
                    <button type="submit" className="btn-primary">
                      {saving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} Save in the sheet
                    </button>
                    {(f.client || f.docChoice || f.person || f.movement) && (
                      <button type="button" className="btn-ghost" onClick={() => setF(EMPTY_FORM)}>
                        Clear
                      </button>
                    )}
                  </div>
                </fieldset>
              </form>
              {error && (
                <p className="mt-4 text-sm text-rose-300 flex items-start gap-1.5">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5" /> {error}
                </p>
              )}
              {note && <p className="mt-4 text-sm text-emerald-300">{note}</p>}

              {data?.ready && (
                <div className="mt-7 grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* still out: the latest movement of that client + document is أخذ */}
                  <div>
                    <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
                      Still out <span className="text-xs text-slate-500 font-normal" dir="rtl">لم يُرجع بعد</span>
                      <span className="ml-auto text-xs px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-200 border border-amber-400/30">
                        {data.out.length}
                      </span>
                    </h3>
                    {data.out.length === 0 ? (
                      <p className="text-sm text-slate-500">Nothing is out — everything was given back.</p>
                    ) : (
                      <ul className="space-y-2">
                        {data.out.map((l) => (
                          <li
                            key={`${l.client}|${l.document}`}
                            className={`p-3 rounded-xl border bg-slate-900/40 flex flex-wrap items-center gap-x-3 gap-y-1.5 ${
                              (l.days ?? 0) >= 7 ? "border-rose-400/40" : "border-amber-400/30"
                            }`}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-semibold text-slate-100 break-words" dir="auto">
                                {l.client}
                              </span>
                              <span className="block text-xs text-slate-400 break-words">
                                <span dir="auto">{l.document}</span> — with <span dir="auto" className="text-slate-200">{l.person}</span>
                              </span>
                              <span className={`block text-xs ${(l.days ?? 0) >= 7 ? "text-rose-300" : "text-slate-500"}`}>
                                since {l.at}
                                {since(l) && ` · ${since(l)}`}
                              </span>
                            </span>
                            <button
                              type="button"
                              className="btn-ghost !text-emerald-200"
                              onClick={() => prefillReturn(l)}
                              title="Fill the form to write down that it was given back"
                            >
                              <Undo2 size={15} /> <span dir="rtl">أرجع</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* the last movements, newest first */}
                  <div>
                    <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
                      Last movements <span className="text-xs text-slate-500 font-normal" dir="rtl">آخر الحركات</span>
                    </h3>
                    {data.recent.length === 0 ? (
                      <p className="text-sm text-slate-500">No movement written yet.</p>
                    ) : (
                      <ul className="divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-slate-900/30">
                        {data.recent.map((l, i) => (
                          <li key={i} className="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                            {moveBadge(l)}
                            <span className="min-w-0 flex-1 break-words">
                              <span className="text-slate-100" dir="auto">{l.person}</span>
                              <span className="text-slate-500"> · </span>
                              <span className="text-slate-300" dir="auto">{l.document}</span>
                              <span className="text-slate-500"> · </span>
                              <span className="text-slate-300" dir="auto">{l.client}</span>
                            </span>
                            <span className="text-xs text-slate-500 shrink-0">{l.at}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
              {loading && !data && (
                <p className="mt-6 text-sm text-slate-400 flex items-center gap-2">
                  <Loader2 size={15} className="animate-spin" /> Reading the sheet…
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </fieldset>
  );
}
