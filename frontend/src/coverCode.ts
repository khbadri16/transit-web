import { useEffect, useState } from "react";

/* The code of the private sections (COVER_CODE in Vercel, checked by the
   server): Folder cover, Papers, Stamps. Typed once, remembered on this PC
   until Lock — unlocking or locking one section does it for all of them. */
const COVER_CODE_KEY = "cover_code_v1";
const CHANGED = "cover-code-change";

let memory = ""; // private window: the code lives for this visit only

export const readCode = () => {
  try {
    return localStorage.getItem(COVER_CODE_KEY) || "";
  } catch {
    return memory;
  }
};

const saveCode = (v: string) => {
  memory = v;
  try {
    if (v) localStorage.setItem(COVER_CODE_KEY, v);
    else localStorage.removeItem(COVER_CODE_KEY);
  } catch {
    /* kept in memory */
  }
  window.dispatchEvent(new Event(CHANGED));
};

/** [code, setCode] shared by every private section ("" = locked). */
export function useCoverCode(): [string, (v: string) => void] {
  const [code, setCode] = useState(readCode);
  useEffect(() => {
    const sync = () => setCode(readCode());
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);
  return [code, saveCode];
}
