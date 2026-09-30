import { Delete, Eraser, X } from "lucide-react";

/** Arabic on-screen keyboard layout. */
export const AR_KB_ROWS: string[][] = [
  ["ض", "ص", "ث", "ق", "ف", "غ", "ع", "ه", "خ", "ح", "ج", "د", "ذ"],
  ["ش", "س", "ي", "ب", "ل", "ا", "ت", "ن", "م", "ك", "ط"],
  ["ئ", "ء", "ؤ", "ر", "لا", "ى", "ة", "و", "ز", "ظ"],
  ["أ", "إ", "آ", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
  ["،", "؛", ":", "/", "-", ".", "(", ")", "٪"],
];

/* --- Arabic on-screen keyboard --------------------------------------------- */
export function ArabicKeyboard({
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
