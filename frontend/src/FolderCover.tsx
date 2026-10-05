import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ClipboardCopy, FileDown, FolderOpen, KeyRound, Loader2, Lock, X } from "lucide-react";

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
  containers: string[];
  weight: string;
  goods: string;
  packages: string;
};

type Cover = {
  lineChoice: string; // one of LINES | OTHER | ""
  lineOther: string;
  client: string;
  owner: string;
  destination: string;
  bl: string;
  containers: string;
  packages: string;
  weight: string;
  goods: string;
};

const EMPTY: Cover = {
  lineChoice: "",
  lineOther: "",
  client: "",
  owner: "",
  destination: "",
  bl: "",
  containers: "",
  packages: "",
  weight: "",
  goods: "",
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const lineSlug = (s: string) => (slug(s) === "cma" ? "cma-cgm" : slug(s));

const CONTAINER_RE = /[A-Za-z]{4}\s*-?\s*\d{6}\s*-?\s*\d/g;

/** Same rules as the server: one per line, or pasted on one line. */
function splitContainers(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.split(/[\n,;]+/)) {
    const found = chunk.match(CONTAINER_RE) ?? [];
    out.push(...found);
    for (const tok of chunk.replace(CONTAINER_RE, " ").split(/\s+/)) {
      if (tok.replace(/[^A-Za-z0-9]/g, "").length >= 4) out.push(tok);
    }
  }
  return out.map((c) => {
    const t = c.toUpperCase().replace(/[\s\-./]+/g, "");
    return /^[A-Z]{4}\d{7}$/.test(t) ? `${t.slice(0, 4)} ${t.slice(4)}` : t;
  });
}

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
  const containers = useMemo(() => splitContainers(c.containers), [c.containers]);
  const hasSource = !!(source.client || source.line || source.bl || source.containers.length || source.weight || source.goods || source.packages);

  const fillFromForm = () => {
    const patch: Partial<Cover> = {};
    if (source.client.trim()) patch.client = source.client.trim();
    if (source.line.trim()) Object.assign(patch, lineFromSource(source.line));
    if (source.bl.trim()) patch.bl = source.bl.trim().toUpperCase();
    if (source.containers.length) patch.containers = source.containers.join("\n");
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
          containers,
          packages: c.packages,
          weight: c.weight,
          goods: c.goods,
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
            <label className="flex flex-col gap-1.5 md:col-span-2">
              {label("BL number", "رقم بوليصة الشحن")}
              <input className="input font-mono uppercase" value={c.bl} onChange={(e) => set("bl", e.target.value.replace(/\s+/g, ""))} placeholder="e.g. HDMUNBOA7731250" />
            </label>
            <label className="flex flex-col gap-1.5 md:col-span-2">
              {label(`Containers${containers.length ? ` (${containers.length})` : ""}`, "الحاويات")}
              <textarea
                className="input font-mono uppercase min-h-[5.5rem] resize-y"
                value={c.containers}
                onChange={(e) => set("containers", e.target.value)}
                placeholder={"One per line, or paste them all:\nHMMU6458810 TGHU6123457 SEGU7701234"}
              />
            </label>
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
