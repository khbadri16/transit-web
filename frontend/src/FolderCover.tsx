import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ClipboardCopy, FileDown, FolderOpen, KeyRound, Loader2, Lock, Plus, Trash2, X } from "lucide-react";
import { SIZES, SIZE_ACTIVE, SIZE_STYLES, marqueFor, type Size } from "./containerSizes";

/* ==========================================================================
 * Folder cover — one A4 page glued on the front of the client's folder.
 *
 * Simple French + Arabic titles, big values, black & white printer friendly.
 * The PDF is drawn by the server (api/folder_cover_pdf.py); the shipping line
 * logo comes from api/logos/<line>.png when that file exists.
 * ======================================================================== */

const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

/* Personal section: locked by a code (COVER_CODE in Vercel, checked by the
   server). Typed once, remembered on this PC until Lock. */
const COVER_CODE_KEY = "cover_code_v1";
const readCode = () => {
  try {
    return localStorage.getItem(COVER_CODE_KEY) || "";
  } catch {
    return "";
  }
};
const saveCode = (v: string) => {
  try {
    if (v) localStorage.setItem(COVER_CODE_KEY, v);
    else localStorage.removeItem(COVER_CODE_KEY);
  } catch {
    /* private window: the code lives for this visit only */
  }
};

const LINES = ["HMM", "CMA CGM", "MSC", "MAERSK", "AKKON", "WHITE LINE", "COSCO", "ARKAS"] as const;
const OTHER = "OTHER";

const GOODS = [
  "Vêtements",
  "Chaussures",
  "Tissus",
  "Sacs",
  "Accessoires",
  "Jouets",
  "Cosmétiques",
  "Électroménager",
  "Électronique",
  "Pièces auto",
  "Meubles",
  "Alimentaire",
  "Matériel",
];

/** What the Documents form above already knows (used by "Fill from the form"). */
export type CoverSource = {
  client: string;
  line: string;
  bl: string;
  containers: { number: string; size: Size }[];
  weight: string;
  goods: string;
  packages: string;
};

/** One row of the list — same as the Containers section above (number + 20/40/45). */
type CoverContainer = { id: string; number: string; size: Size };

const newRow = (number = "", size: Size = "20"): CoverContainer => ({ id: crypto.randomUUID(), number, size });

type Cover = {
  lineChoice: string; // one of LINES | OTHER | ""
  lineOther: string;
  client: string;
  owner: string;
  destination: string;
  bl: string;
  containers: CoverContainer[];
  packages: string;
  weight: string;
  goods: string;
  belongsTo: string; // "Appartient à / ملك ل" — printed alone at the top
  depotOn: boolean;
  depot: string; // "SNTR" -> "Dépôt-SNTR" next to the BL
};

const EMPTY: Cover = {
  lineChoice: "",
  lineOther: "",
  client: "",
  owner: "",
  destination: "",
  bl: "",
  containers: [],
  packages: "",
  weight: "",
  goods: "",
  belongsTo: "",
  depotOn: false,
  depot: "",
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const lineSlug = (s: string) => (slug(s) === "cma" ? "cma-cgm" : slug(s));

const CONTAINER_RE = /[A-Za-z]{4}\s*-?\s*\d{6}\s*-?\s*\d/g;

function lineFromSource(line: string): Pick<Cover, "lineChoice" | "lineOther"> {
  const up = line.trim().toUpperCase();
  if (!up) return { lineChoice: "", lineOther: "" };
  if (up === "CMA" || up === "CMA CGM") return { lineChoice: "CMA CGM", lineOther: "" };
  if ((LINES as readonly string[]).includes(up)) return { lineChoice: up, lineOther: "" };
  return { lineChoice: OTHER, lineOther: line.trim() };
}

export default function FolderCover({ source }: { source: CoverSource }) {
  const [c, setC] = useState<Cover>(EMPTY);
  const [logos, setLogos] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [code, setCode] = useState(readCode);
  const [codeInput, setCodeInput] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  const lock = (message = "") => {
    saveCode("");
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
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data?.detail === "string" ? data.detail : `Server error (HTTP ${res.status})`);
      }
      saveCode(typed);
      setCode(typed);
      setCodeInput("");
    } catch (err) {
      setUnlockError(err instanceof TypeError ? "Could not reach the server." : err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setUnlocking(false);
    }
  };

  useEffect(() => {
    fetch(`${API_URL}/api/folder-cover/logos`)
      .then((r) => (r.ok ? r.json() : { logos: [] }))
      .then((d) => setLogos(new Set(Array.isArray(d.logos) ? d.logos : [])))
      .catch(() => undefined);
  }, []);

  const set = <K extends keyof Cover>(k: K, v: Cover[K]) => setC((prev) => ({ ...prev, [k]: v }));

  const line = c.lineChoice === OTHER ? c.lineOther.trim() : c.lineChoice;
  const filled = useMemo(() => c.containers.filter((r) => r.number.trim()), [c.containers]);
  /* what the cover prints: one "XXTC<size>" line per size */
  const perSize = useMemo(() => SIZES.map((s) => ({ s, n: filled.filter((r) => r.size === s).length })).filter((x) => x.n), [filled]);

  const addRow = () => setC((prev) => ({ ...prev, containers: [...prev.containers, newRow()] }));
  const removeRow = (id: string) => setC((prev) => ({ ...prev, containers: prev.containers.filter((r) => r.id !== id) }));
  const setSize = (id: string, size: Size) =>
    setC((prev) => ({ ...prev, containers: prev.containers.map((r) => (r.id === id ? { ...r, size } : r)) }));
  /** Typing goes in the row; pasting several numbers at once makes one row each (same size). */
  const setNumber = (id: string, value: string) =>
    setC((prev) => {
      const i = prev.containers.findIndex((r) => r.id === id);
      if (i < 0) return prev;
      const row = prev.containers[i];
      const found = value.match(CONTAINER_RE) ?? [];
      const rows =
        found.length < 2
          ? [{ ...row, number: value }]
          : found.map((n, k) => ({ ...newRow(n.replace(/[\s-]+/g, "").toUpperCase(), row.size), ...(k === 0 ? { id: row.id } : {}) }));
      return { ...prev, containers: [...prev.containers.slice(0, i), ...rows, ...prev.containers.slice(i + 1)] };
    });
  const hasSource = !!(source.client || source.line || source.bl || source.containers.length || source.weight || source.goods || source.packages);

  const fillFromForm = () => {
    const patch: Partial<Cover> = {};
    if (source.client.trim()) patch.client = source.client.trim();
    if (source.line.trim()) Object.assign(patch, lineFromSource(source.line));
    if (source.bl.trim()) patch.bl = source.bl.trim().toUpperCase();
    if (source.containers.length) patch.containers = source.containers.map((x) => newRow(x.number, x.size));
    if (source.weight.trim()) patch.weight = source.weight.trim();
    if (source.goods.trim()) patch.goods = source.goods.trim();
    if (source.packages.trim()) patch.packages = source.packages.trim();
    setC((prev) => ({ ...prev, ...patch }));
    const n = Object.keys(patch).length;
    setNote(n ? "Filled from the form above — check and complete the rest." : "The form above is empty.");
    window.setTimeout(() => setNote(""), 4000);
  };

  const generate = async () => {
    setError("");
    if (!c.lineChoice) return setError("Choose the shipping line.");
    if (c.lineChoice === OTHER && !c.lineOther.trim()) return setError("Type the name of the shipping line.");
    if (!c.client.trim()) return setError("Type the client name.");
    if (c.depotOn && !c.depot.trim()) return setError("Type the depot name, or turn Dépôt off.");
    if (filled.length > 60) return setError(`The cover holds up to 60 containers (you have ${filled.length}).`);
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/folder-cover`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cover-Code": code },
        body: JSON.stringify({
          line,
          client: c.client,
          owner: c.owner,
          destination: c.destination,
          bl: c.bl,
          containers: filled.map((r) => ({ number: r.number.trim(), size: r.size })),
          packages: c.packages,
          weight: c.weight,
          goods: c.goods,
          depot: c.depotOn ? c.depot : "",
          belongs_to: c.belongsTo,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const detail = typeof data?.detail === "string" ? data.detail : `Server error (HTTP ${res.status})`;
        if (res.status === 401) return lock(`${detail} The code was changed — type the new one.`);
        throw new Error(detail);
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || "couverture.pdf";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      setError(
        err instanceof TypeError
          ? "Could not reach the server. In local dev, start: uvicorn api.index:app --reload --port 8000"
          : err instanceof Error
            ? err.message
            : "Unexpected error."
      );
    } finally {
      setBusy(false);
    }
  };

  const label = (text: string, ar: string, required = false, optional = false) => (
    <span className="flex items-baseline justify-between gap-2 text-sm font-medium text-slate-300">
      <span>
        {text}
        {required && <span className="text-indigo-400"> *</span>}
        {optional && <span className="text-xs text-slate-500 font-normal"> (optional)</span>}
      </span>
      <span className="text-xs text-slate-500" dir="rtl">
        {ar}
      </span>
    </span>
  );

  return (
    <fieldset className="group-box mt-8" id="folder-cover">
      <legend className="group-title">Folder cover</legend>
      <div className="group-body">
        <section className="card">
          <div className="flex flex-wrap items-start gap-3 mb-1">
            <h2 className="section-title flex-1 !mb-0 flex items-center gap-2">
              <FolderOpen size={17} className="text-indigo-300" /> Folder cover <span className="text-slate-500 font-normal text-sm">غلاف الملف</span>
            </h2>
            {code && (
              <>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={fillFromForm}
                  disabled={!hasSource}
                  title="Copy client, line, BL, containers, weight and goods from the form above"
                >
                  <ClipboardCopy size={15} /> Fill from the form above
                </button>
                <button type="button" className="btn-ghost" onClick={() => lock()} title="Lock the folder cover on this computer" aria-label="Lock the folder cover">
                  <Lock size={15} />
                </button>
              </>
            )}
          </div>
          <p className="text-xs text-slate-400 mb-5">
            One A4 page to glue on the front of the client's folder — simple French + Arabic, for a black &amp; white printer.
            Arrival date, date, N° déclaration and taxes stay empty for the pen.
          </p>

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
                This section is private — type your code to use it on this computer.
              </span>
              <input
                type="password"
                autoComplete="off"
                className="input !w-44 !py-2"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder="Code"
                aria-label="Folder cover code"
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

          {/* who the folder belongs to: the name alone, at the top of the cover */}
          <label className="flex flex-col gap-1.5 mb-4 max-w-md">
            {label("Appartient à", "ملك ل", false, true)}
            <input className="input" dir="auto" value={c.belongsTo} onChange={(e) => set("belongsTo", e.target.value)} placeholder="e.g. شكيب" />
          </label>

          {/* shipping line */}
          <div className="mb-4">
            {label("Shipping line", "الشركة البحرية", true)}
            <div className="mt-2 flex flex-wrap gap-2">
              {[...LINES, OTHER].map((l) => {
                const active = c.lineChoice === l;
                const hasLogo = l !== OTHER && logos.has(lineSlug(l));
                return (
                  <button
                    key={l}
                    type="button"
                    onClick={() => set("lineChoice", active ? "" : l)}
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-bold tracking-wide transition-colors ${
                      active
                        ? "bg-indigo-500/25 border-indigo-400/70 text-indigo-100"
                        : "border-slate-700 text-slate-400 hover:border-indigo-500/40 hover:text-slate-200"
                    }`}
                  >
                    {hasLogo && (
                      <img
                        src={`${API_URL}/api/folder-cover/logo/${lineSlug(l)}`}
                        alt=""
                        className="h-4 max-w-[3.5rem] object-contain rounded-sm bg-white px-0.5"
                      />
                    )}
                    {l === OTHER ? "Other" : l}
                  </button>
                );
              })}
            </div>
            {c.lineChoice === OTHER && (
              <input
                className="input mt-2 max-w-xs uppercase"
                value={c.lineOther}
                onChange={(e) => set("lineOther", e.target.value)}
                placeholder="e.g. TURKON"
              />
            )}
            {line && !logos.has(lineSlug(line)) && (
              <p className="mt-1.5 text-[11px] text-slate-500">
                No logo file for {line} yet — the name is printed alone. Add <code className="text-slate-400">api/logos/{lineSlug(line) || "name"}.png</code> to show its logo.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5 md:col-span-2">
              {label("Client", "الزبون", true)}
              <input className="input uppercase" dir="auto" value={c.client} onChange={(e) => set("client", e.target.value)} placeholder="e.g. BENSALEM TEXTILE" />
            </label>
            <label className="flex flex-col gap-1.5">
              {label("Owner", "المالك", false, true)}
              <input className="input" dir="auto" value={c.owner} onChange={(e) => set("owner", e.target.value)} placeholder="e.g. Karim Bensalem" />
            </label>
            <label className="flex flex-col gap-1.5">
              {label("Destination", "الوجهة", false, true)}
              <input className="input" dir="auto" value={c.destination} onChange={(e) => set("destination", e.target.value)} placeholder="e.g. Sétif" />
            </label>
            <p className="md:col-span-2 -mt-2 text-[11px] text-slate-500">Owner and destination: leave empty and they are not printed on the cover.</p>
            <label className="flex flex-col gap-1.5">
              {label("BL number", "رقم بوليصة الشحن")}
              <input className="input font-mono uppercase" value={c.bl} onChange={(e) => set("bl", e.target.value.replace(/\s+/g, ""))} placeholder="e.g. HDMUNBOA7731250" />
            </label>
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <span className="relative shrink-0" dir="ltr">
                  <input type="checkbox" checked={c.depotOn} onChange={(e) => set("depotOn", e.target.checked)} className="peer sr-only" />
                  <span className="block w-8 h-5 rounded-full bg-slate-700 peer-checked:bg-indigo-500 transition-colors" />
                  <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform peer-checked:translate-x-3" />
                </span>
                <span className="flex-1">{label("Dépôt", "المستودع", false, true)}</span>
              </label>
              <input
                className="input uppercase placeholder:normal-case disabled:opacity-40 disabled:cursor-not-allowed"
                dir="auto"
                value={c.depot}
                onChange={(e) => set("depot", e.target.value)}
                disabled={!c.depotOn}
                placeholder={c.depotOn ? "e.g. SNTR" : "Turn on if at a depot"}
              />
              {c.depotOn && c.depot.trim() && (
                <span className="text-[11px] text-slate-500">
                  Printed next to the BL: <b className="text-slate-300">Dépôt-{c.depot.trim().replace(/^d[ée]p[ôo]t\b[\s\-:]*/i, "").toUpperCase()}</b>
                </span>
              )}
            </div>
            {/* containers — same rows as the Containers section above */}
            <div className="flex flex-col gap-2 md:col-span-2">
              <div className="flex items-center gap-3">
                <span className="flex-1">{label(`Containers${filled.length ? ` (${filled.length})` : ""}`, "الحاويات")}</span>
                <button type="button" onClick={addRow} className="btn-ghost shrink-0">
                  <Plus size={16} /> <span className="hidden sm:inline">Add container</span>
                  <span className="sm:hidden">Add</span>
                </button>
              </div>
              {perSize.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {perSize.map(({ s, n }) => (
                    <span key={s} className={`text-xs font-mono font-semibold px-2.5 py-1 rounded-lg border ${SIZE_STYLES[s]}`}>
                      {String(n).padStart(2, "0")}TC{s}
                    </span>
                  ))}
                  <span className="text-[11px] text-slate-500">— one line per size on the cover</span>
                </div>
              )}
              {c.containers.length === 0 ? (
                <button
                  type="button"
                  onClick={addRow}
                  className="w-full text-center py-6 rounded-xl border border-dashed border-slate-700 text-slate-500 hover:border-indigo-500/60 hover:text-slate-300 transition-colors"
                >
                  No containers yet — click to add the first one.
                </button>
              ) : (
                <div className="space-y-2.5">
                  {c.containers.map((r, index) => (
                    <div
                      key={r.id}
                      className="container-row flex flex-wrap sm:flex-nowrap items-center gap-2.5 sm:gap-3 p-2.5 rounded-xl bg-slate-900/50 border border-slate-700/70 hover:border-indigo-500/40 transition-colors"
                    >
                      <span className="grid place-items-center w-7 h-7 shrink-0 rounded-lg bg-slate-800 text-slate-400 text-xs font-mono">{index + 1}</span>
                      <span
                        className={`hidden md:inline-block shrink-0 text-[11px] font-mono font-semibold px-2 py-1 rounded-md border ${SIZE_STYLES[r.size]}`}
                        title="Size (TC20 / TC40 / TC45)"
                      >
                        {marqueFor(r.size)}
                      </span>
                      <input
                        type="text"
                        placeholder="Container number (e.g. CMAU9753972)"
                        value={r.number}
                        onChange={(e) => setNumber(r.id, e.target.value)}
                        className="flex-1 min-w-0 basis-full sm:basis-auto order-last sm:order-none bg-transparent px-1 py-1.5 font-mono text-sm text-white uppercase placeholder:normal-case placeholder-slate-600 focus:outline-none"
                      />
                      <div className="seg shrink-0 ml-auto sm:ml-0" role="group" aria-label="Container size">
                        {SIZES.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setSize(r.id, s)}
                            className={`seg-btn ${r.size === s ? `seg-active ${SIZE_ACTIVE[s]}` : ""}`}
                          >
                            {s}'
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeRow(r.id)}
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
            </div>
            <div className="grid grid-cols-2 gap-4 md:col-span-2 md:grid-cols-3">
              <label className="flex flex-col gap-1.5">
                {label("Packages (all)", "عدد الطرود")}
                <input className="input" inputMode="numeric" value={c.packages} onChange={(e) => set("packages", e.target.value)} placeholder="e.g. 1250" />
              </label>
              <label className="flex flex-col gap-1.5">
                {label("Weight, kg (all)", "الوزن")}
                <input className="input" inputMode="decimal" value={c.weight} onChange={(e) => set("weight", e.target.value)} placeholder="e.g. 18540" />
              </label>
              <label className="flex flex-col gap-1.5 col-span-2 md:col-span-1">
                {label("Goods", "السلعة")}
                <input className="input" dir="auto" list="cover-goods" value={c.goods} onChange={(e) => set("goods", e.target.value)} placeholder="e.g. Vêtements" />
                <datalist id="cover-goods">
                  {GOODS.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </label>
            </div>
          </div>

          {error && (
            <p className="mt-4 flex items-start gap-2 text-sm text-rose-300">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" /> {error}
            </p>
          )}
          {note && <p className="mt-4 text-sm text-emerald-300">{note}</p>}

          <div className="mt-5 flex flex-col sm:flex-row gap-3">
            <button type="button" className="btn-primary flex-1 min-h-12" onClick={() => void generate()} disabled={busy}>
              {busy ? <Loader2 size={18} className="animate-spin" /> : <FileDown size={18} />} Generate cover PDF
            </button>
            <button type="button" className="btn-secondary min-h-12" onClick={() => { setC(EMPTY); setError(""); }}>
              <X size={16} className="me-1" /> Clear
            </button>
          </div>
          </>
          )}
        </section>
      </div>
    </fieldset>
  );
}
