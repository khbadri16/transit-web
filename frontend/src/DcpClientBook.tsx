import { useEffect, useMemo, useRef, useState } from "react";
import { BookUser, Download, Keyboard, Trash2, Upload, X } from "lucide-react";
import { ArabicKeyboard } from "./ArabicKeyboard";

/* ==========================================================================
 * DCP — saved importers (المستوردون المحفوظون)
 *
 * The four lines that never change for a client — المستورد, رقم السجل
 * التجاري (س ت), تاريخ س ت, العنوان — are remembered IN THIS BROWSER ONLY
 * (localStorage, never sent to the server or shared with other visitors).
 * Pick a client to fill them; edit anything (e.g. a renewed س ت date) and the
 * client is updated automatically the next time the documents are generated.
 * Export / Import moves the list to another browser.
 * ======================================================================== */

const STORAGE_KEY = "dcp_clients_v1";
const CHANGED_EVENT = "dcp-clients-changed";

/** DCP form keys (placeholders of the DCP) this book fills. */
const K = {
  name: "المستورد",
  rc1: "رقم_س_ت_1",
  rc2: "رقم_س_ت_2",
  rc3: "رقم_س_ت_3",
  rcLetter: "رقم_س_ت_حرف",
  rc4: "رقم_س_ت_4",
  rcDate: "تاريخ_الاستراد", // the "تاريخ س ت" field
  address: "العنوان",
} as const;
type Field = keyof typeof K;
const FIELDS = Object.keys(K) as Field[];

export type DcpClient = Record<Field, string> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const nameKey = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();
const rcKey = (c: Pick<DcpClient, "rc1" | "rc2" | "rc3" | "rcLetter" | "rc4">) =>
  c.rc3 ? [c.rc1, c.rc2, c.rc3, c.rcLetter, c.rc4].join("|") : "";

export const formatRc = (c: Pick<DcpClient, "rc1" | "rc2" | "rc3" | "rcLetter" | "rc4">) =>
  c.rc3 || c.rc1 ? `${c.rc1}/${c.rc2}-${c.rc3}${c.rcLetter}${c.rc4}` : "";

function normalize(raw: Partial<DcpClient>): DcpClient | null {
  if (!raw || typeof raw !== "object") return null;
  const c = Object.fromEntries(FIELDS.map((f) => [f, clean(raw[f])])) as Record<Field, string>;
  if (!c.name && !c.rc3) return null;
  const now = new Date().toISOString();
  return {
    ...c,
    id: typeof raw.id === "string" ? raw.id : uid(),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

export function loadClients(): DcpClient[] {
  try {
    const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(arr) ? (arr.map(normalize).filter(Boolean) as DcpClient[]) : [];
  } catch {
    return [];
  }
}

function storeClients(list: DcpClient[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable — nothing is remembered this time */
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

/** Same client = same س ت number, or the same name. */
function upsert(list: DcpClient[], c: DcpClient): DcpClient[] {
  const rk = rcKey(c);
  const nk = nameKey(c.name);
  const i = list.findIndex((x) => (rk && rcKey(x) === rk) || (nk && nameKey(x.name) === nk));
  if (i < 0) return [c, ...list];
  const merged = { ...list[i], ...Object.fromEntries(FIELDS.map((f) => [f, c[f]])), updatedAt: c.updatedAt };
  return [merged, ...list.filter((_, j) => j !== i)]; // most recent first
}

/** Called after a successful generation: remember / update this importer. */
export function rememberDcpClient(dcp: Record<string, string>): boolean {
  const c = normalize(
    Object.fromEntries(FIELDS.map((f) => [f, dcp[K[f]] ?? ""])) as Partial<DcpClient>
  );
  if (!c || !c.name) return false;
  c.updatedAt = new Date().toISOString();
  storeClients(upsert(loadClients(), c));
  return true;
}

/** The DCP form values for a saved client. */
const toDcp = (c: DcpClient): Record<string, string> =>
  Object.fromEntries(FIELDS.map((f) => [K[f], c[f]]));

/* --------------------------------------------------------------------------
 * Component
 * ------------------------------------------------------------------------ */

export function DcpClientBook({
  dcp,
  onApply,
}: {
  dcp: Record<string, string>;
  onApply: (patch: Record<string, string>) => void;
}) {
  const [clients, setClients] = useState<DcpClient[]>(loadClients);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  // keep in sync with saves made on generate (and other tabs)
  useEffect(() => {
    const reload = () => setClients(loadClients());
    window.addEventListener(CHANGED_EVENT, reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener(CHANGED_EVENT, reload);
      window.removeEventListener("storage", reload);
    };
  }, []);

  // close the list when clicking elsewhere
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setKbOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const flashNote = (text: string, ok = true) => {
    setNote({ text, ok });
    window.setTimeout(() => setNote(null), 3500);
  };

  const results = useMemo(() => {
    const q = query.replace(/\s+/g, " ").trim().toUpperCase();
    const list = q
      ? clients.filter((c) =>
          [c.name, c.address, formatRc(c), c.rc3].some((v) => v.toUpperCase().includes(q))
        )
      : clients;
    return list.slice(0, 8);
  }, [clients, query]);

  /** Which saved client the form currently shows (same name or same س ت). */
  const current = useMemo(() => {
    const nk = nameKey(dcp[K.name] ?? "");
    const rk = rcKey({
      rc1: dcp[K.rc1] ?? "",
      rc2: dcp[K.rc2] ?? "",
      rc3: (dcp[K.rc3] ?? "").trim(),
      rcLetter: dcp[K.rcLetter] ?? "",
      rc4: dcp[K.rc4] ?? "",
    });
    return clients.find((c) => (nk && nameKey(c.name) === nk) || (rk && rcKey(c) === rk)) ?? null;
  }, [clients, dcp]);

  const changedFromSaved =
    current && FIELDS.some((f) => (dcp[K[f]] ?? "").trim() !== current[f]);

  const pick = (c: DcpClient) => {
    onApply(toDcp(c));
    setQuery("");
    setOpen(false);
    setKbOpen(false);
    flashNote(`تم ملء بيانات: ${c.name}`);
  };

  const remove = (id: string) => {
    if (confirmDel !== id) {
      setConfirmDel(id);
      window.setTimeout(() => setConfirmDel((v) => (v === id ? null : v)), 3000);
      return;
    }
    const next = clients.filter((c) => c.id !== id);
    storeClients(next);
    setClients(next);
    setConfirmDel(null);
  };

  const exportClients = () => {
    const blob = new Blob([JSON.stringify(clients, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dcp_clients_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const importClients = async (file: File | null) => {
    if (!file) return;
    try {
      const arr = JSON.parse(await file.text());
      if (!Array.isArray(arr)) throw new Error();
      const incoming = arr.map(normalize).filter(Boolean) as DcpClient[];
      if (!incoming.length) throw new Error();
      let next = loadClients();
      for (const c of incoming) next = upsert(next, { ...c, id: uid() });
      storeClients(next);
      setClients(next);
      flashNote(`تم استيراد ${incoming.length} مستورد.`);
    } catch {
      flashNote("هذا الملف ليس قائمة مستوردين.", false);
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  /* on-screen Arabic keyboard for the search box */
  const kbInsert = (ch: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? query.length;
    const end = el?.selectionEnd ?? query.length;
    setQuery(query.slice(0, start) + ch + query.slice(end));
    setOpen(true);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + ch.length, start + ch.length);
    });
  };
  const kbBackspace = () => {
    const el = inputRef.current;
    let start = el?.selectionStart ?? query.length;
    const end = el?.selectionEnd ?? query.length;
    if (start === end) {
      if (start === 0) return;
      start -= 1;
    }
    setQuery(query.slice(0, start) + query.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start, start);
    });
  };

  return (
    <div ref={boxRef} className="dcp-book" dir="rtl">
      <div className="flex items-center gap-2 flex-wrap">
        <BookUser size={17} className="text-indigo-300 shrink-0" />
        <span className="text-sm font-bold text-slate-200">المستوردون المحفوظون</span>
        <span className="dcp-book-count">{clients.length}</span>
        <span className="ms-auto flex items-center gap-1.5">
          <button type="button" className="dcp-book-btn" onClick={exportClients} disabled={!clients.length} title="حفظ القائمة في ملف (نسخة احتياطية / متصفح آخر)">
            <Download size={14} /> تصدير
          </button>
          <button type="button" className="dcp-book-btn" onClick={() => importRef.current?.click()} title="تحميل قائمة مصدّرة من متصفح آخر">
            <Upload size={14} /> استيراد
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => importClients(e.target.files?.[0] ?? null)}
          />
        </span>
      </div>

      <div className="relative mt-2.5">
        <input
          ref={inputRef}
          className="input !pl-10"
          dir="auto"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              setKbOpen(false);
            }
            if (e.key === "Enter" && results[0]) {
              e.preventDefault();
              pick(results[0]);
            }
          }}
          placeholder={
            clients.length
              ? "ابحث عن مستورد بالاسم أو برقم السجل التجاري…"
              : "لا يوجد مستورد محفوظ بعد — يُحفظ تلقائيًا عند توليد الوثائق"
          }
          aria-label="البحث عن مستورد محفوظ"
        />
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setKbOpen((v) => !v);
            setOpen(true);
            inputRef.current?.focus();
          }}
          className={`kb-toggle ${kbOpen ? "kb-toggle-active" : ""}`}
          title="لوحة مفاتيح عربية"
          aria-label="لوحة مفاتيح عربية"
        >
          <Keyboard size={15} />
        </button>

        {open && clients.length > 0 && (
          <div className="dcp-book-list">
            {results.length === 0 ? (
              <p className="px-3 py-2.5 text-xs text-slate-400">لا توجد نتيجة.</p>
            ) : (
              results.map((c) => (
                <div key={c.id} className="dcp-book-item">
                  <button type="button" className="flex-1 min-w-0 text-right" onClick={() => pick(c)}>
                    <span className="block text-sm font-semibold text-slate-100 truncate">{c.name || "—"}</span>
                    <span className="block text-[11px] text-slate-400 truncate">
                      {formatRc(c) && (
                        <span dir="ltr" className="font-mono" style={{ unicodeBidi: "isolate" }}>
                          {c.rc1}/{c.rc2}-{c.rc3}
                          <bdi>{c.rcLetter}</bdi>
                          {c.rc4}
                        </span>
                      )}
                      {c.rcDate && <> · بتاريخ <span dir="ltr">{c.rcDate}</span></>}
                      {c.address && <> · {c.address}</>}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`dcp-book-del ${confirmDel === c.id ? "dcp-book-del-confirm" : ""}`}
                    onClick={() => remove(c.id)}
                    title="حذف من القائمة"
                    aria-label="حذف من القائمة"
                  >
                    {confirmDel === c.id ? "حذف؟" : <Trash2 size={14} />}
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {kbOpen && (
        <ArabicKeyboard
          onKey={kbInsert}
          onBackspace={kbBackspace}
          onClear={() => setQuery("")}
          onClose={() => setKbOpen(false)}
        />
      )}

      <p className={`mt-2 text-[11px] ${note ? (note.ok ? "text-emerald-300" : "text-rose-300") : "text-slate-500"}`}>
        {note
          ? note.text
          : current
            ? changedFromSaved
              ? `«${current.name}» — تم تعديل بعض البيانات، ستُحفظ التعديلات عند توليد الوثائق.`
              : `«${current.name}» محفوظ — بياناته مطابقة.`
            : "يملأ: المستورد، رقم س ت، تاريخ س ت، العنوان. القائمة محفوظة في هذا المتصفح فقط."}
        {current && !note && (
          <button
            type="button"
            className="ms-2 inline-flex items-center gap-0.5 text-slate-400 hover:text-white"
            onClick={() =>
              onApply(Object.fromEntries(FIELDS.map((f) => [K[f], f === "rcLetter" ? "ب" : ""])))
            }
            title="إفراغ الحقول الأربعة"
          >
            <X size={12} /> إفراغ
          </button>
        )}
      </p>
    </div>
  );
}
