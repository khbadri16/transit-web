"""
Clients sheet — every folder cover adds one line to a Google Sheet
------------------------------------------------------------------
One table, one line per client, written by the server so a cover made on any
computer lands in the same sheet. A cover printed again for the same BL
updates that client's line instead of adding a second one (the sheet side
does the matching — see cover-sheet/Code.gs at the root of the repository).

Columns: Date added · Client · Appartient à · Shipping line · BL · Containers
· Packages · Weight (kg) · Goods · Depot. The values are the ones printed on
the cover (same normalisation as folder_cover_pdf.normalize).

Vercel environment variables:
    COVER_SHEET_URL     the Apps Script web app link (…/exec)
    COVER_SHEET_SECRET  the same word as SECRET in Code.gs
Without COVER_SHEET_URL nothing is sent and covers work as before.

The sheet never blocks a cover: on any error the PDF is still returned and
the page shows a warning.

The same sheet also tracks the papers and stamps that leave the office (see
"Papers & stamps" below).
"""

import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple, Union

TIMEOUT = 20                               # seconds — Apps Script can be slow to wake up

Number = Union[int, float]


def _number(v: str) -> Union[Number, str]:
    """'18540' -> 18540, '18 540,5' -> 18540.5 ; anything else is kept as typed."""
    t = re.sub(r"[\s  ]+", "", str(v or ""))
    if re.fullmatch(r"\d+", t):
        return int(t)
    m = re.fullmatch(r"(\d+)[.,](\d+)", t)
    if m:
        return float(f"{m.group(1)}.{m.group(2)}")
    return re.sub(r"\s+", " ", str(v or "")).strip()


def _containers(groups: List[Tuple[str, List[str]]]) -> str:
    """Same lines as the cover: '02TC20 : HMMU6458810 TGHU6123457', one per size."""
    return "\n".join(
        (f"{len(numbers):02d}TC{size} : " if size else "") + " ".join(numbers)
        for size, numbers in groups
    )


def row(data: Dict, printed: Dict) -> Dict:
    """The line sent to the sheet. `data` is the request, `printed` the cover's
    normalize() output (what is actually printed)."""
    return {
        "client": printed["client"],
        "belongs_to": printed["belongs_to"],
        "line": printed["line"],
        "bl": printed["bl"],
        "containers": _containers(printed["containers"]),
        "packages": _number(data.get("packages", "")),
        "weight": _number(data.get("weight", "")),
        "goods": printed["goods"],
        "depot": printed["depot"],
    }


def _send(url: str, payload: Dict) -> Tuple[object, str]:
    """POST the payload to the Apps Script. Returns (answer, "") when it answered
    with JSON, (None, short reason) otherwise."""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
    except ValueError:  # e.g. pasted without https://
        return None, "COVER_SHEET_URL is not a full link (it must start with https:// and end with /exec)"
    try:
        # Apps Script answers with a redirect to the result: urllib follows it
        # as a GET, which is what Google expects.
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        print(f"[cover-sheet] HTTP {exc.code}")
        return None, f"Google answered HTTP {exc.code}"
    except TimeoutError:
        print("[cover-sheet] timeout")
        return None, "Google did not answer in time (the line may still have been added)"
    except Exception as exc:  # DNS, connection reset...
        print(f"[cover-sheet] {exc!r}")
        return None, "Google Sheets could not be reached"
    try:
        return json.loads(raw), ""
    except ValueError:
        # an HTML page: usually the web app is not shared with "Anyone"
        print(f"[cover-sheet] not JSON: {raw[:200]!r}")
        return None, "the sheet link did not answer (check the deployment: Who has access = Anyone)"


def _refusal(answer: object) -> str:
    reason = str((answer.get("error") if isinstance(answer, dict) else "") or "").strip() or "unknown error"
    print(f"[cover-sheet] refused: {reason}")
    return reason[:200]


def record(line: Dict) -> Tuple[str, str]:
    """Send the line. Returns (status, reason):
    ("added" | "updated", "") on success, ("off", "") when not configured,
    ("failed", short reason) otherwise."""
    url = (os.environ.get("COVER_SHEET_URL") or "").strip()
    if not url:
        return "off", ""
    answer, reason = _send(url, {"secret": (os.environ.get("COVER_SHEET_SECRET") or "").strip(), **line})
    if answer is None:
        return "failed", reason
    if not isinstance(answer, dict) or not answer.get("ok"):
        return "failed", _refusal(answer)
    return ("updated" if answer.get("action") == "updated" else "added"), ""


# --------------------------------------------------------------------------
# Papers & stamps that leave the office (Code.gs version 2)
#
# Two more tables in the same sheet: "Documents" (ENDI, Autorisation, ...)
# and "Stamps" (the client's Cachet). One line per movement: date, client,
# document, person, أخذ (took) / أرجع (gave back). The sheet keeps every
# line; what is still out is worked out here from the latest movement of
# each client + document, so this logic can change without touching Code.gs.
#
# These requests carry the secret as "key", never as "secret": a version 1
# Code.gs (covers only) refuses them instead of writing a client line, and
# its answer has no "v": the page then says the script must be updated.
# --------------------------------------------------------------------------

TABLES = ("documents", "stamps")
STAMP = "Cachet"                          # the fixed "document" of the Stamps table
MOVEMENTS = {"took": "أخذ", "returned": "أرجع"}
DZ = timezone(timedelta(hours=1))          # Africa/Algiers — no DST
RECENT = 20
LIMITS = {"client": 120, "document": 60, "person": 80}


def _clean(v, limit: int = 200) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()[:limit]


def _key(v) -> str:
    return _clean(v).upper()


def paper_entry(table: str, data: Dict) -> Dict:
    """The line to add, checked. Raises ValueError with a message for the page."""
    client = _clean(data.get("client"), LIMITS["client"])
    if not re.search(r"[؀-ۿ]", client):
        client = client.upper()             # like the cover: Latin names in capitals
    document = STAMP if table == "stamps" else _clean(data.get("document"), LIMITS["document"])
    person = _clean(data.get("person"), LIMITS["person"])
    movement = MOVEMENTS.get(str(data.get("movement") or ""))
    if not client:
        raise ValueError("Type the client name.")
    if not document:
        raise ValueError("Choose the document (or type its name).")
    if not person:
        raise ValueError("Type the name of the person.")
    if not movement:
        raise ValueError("Choose أخذ or أرجع.")
    return {"client": client, "document": document, "person": person, "movement": movement}


def _movement(v) -> str:
    """'أخذ' -> took, 'أرجع' -> returned (also typed by hand without hamza)."""
    t = _clean(v).replace("أ", "ا").replace("إ", "ا").replace("آ", "ا")
    if t.startswith("اخذ"):
        return "took"
    if t.startswith(("ارجع", "رجع")):
        return "returned"
    return ""


def _when(v) -> Optional[datetime]:
    """The sheet sends the exact time (ISO, UTC); a date typed by hand in the
    sheet comes as dd/mm/yyyy [hh:mm] (Algerian time)."""
    t = _clean(v)
    try:
        dt = datetime.fromisoformat(t.replace("Z", "+00:00"))
        return (dt if dt.tzinfo else dt.replace(tzinfo=DZ)).astimezone(DZ)
    except ValueError:
        pass
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?", t)
    if m:
        try:
            d, mo, y, h, mi = (int(x or 0) for x in m.groups())
            return datetime(y, mo, d, h, mi, tzinfo=DZ)
        except ValueError:
            return None
    return None


def summarize(rows: List, now: Optional[datetime] = None) -> Tuple[List[Dict], List[Dict]]:
    """(still out, last movements) from the table rows
    [time, client, document, person, movement]."""
    now = now or datetime.now(DZ)
    items = []
    for i, row in enumerate(rows or []):
        cells = (list(row) if isinstance(row, (list, tuple)) else []) + [""] * 5
        client, document, person, label = (_clean(c) for c in cells[1:5])
        if not client and not document:
            continue                        # an empty line in the sheet
        when = _when(cells[0])
        items.append({
            "i": i, "when": when,
            "at": when.strftime("%d/%m/%Y %H:%M") if when else _clean(cells[0]),
            "client": client, "document": document, "person": person,
            "movement": _movement(label), "label": label,
        })
    # by time (the table may have been sorted by hand), then by line
    floor = datetime.min.replace(tzinfo=DZ)
    items.sort(key=lambda it: (it["when"] or floor, it["i"]))
    latest: Dict[Tuple[str, str], Dict] = {}
    for it in items:
        latest[(_key(it["client"]), _key(it["document"]))] = it
    out = sorted((it for it in latest.values() if it["movement"] == "took"),
                 key=lambda it: (it["when"] or floor, it["i"]))
    for it in out:
        it["days"] = max(0, (now - it["when"]).days) if it["when"] else None

    def public(it: Dict) -> Dict:
        return {k: v for k, v in it.items() if k not in ("i", "when")}

    return [public(it) for it in out], [public(it) for it in reversed(items[-RECENT:])]


def papers(table: str, entry: Optional[Dict] = None) -> Dict:
    """List the table (entry None) or add one movement first. Returns
    {"ready", "code", "error", "added", "out", "recent"}:
    ready False -> the sheet can't take papers yet ("code": not_configured |
    old_script); "error" -> it could not be done this time."""
    result = {"ready": True, "code": "", "error": "", "added": False, "out": [], "recent": []}
    url = (os.environ.get("COVER_SHEET_URL") or "").strip()
    if not url:
        return {**result, "ready": False, "code": "not_configured",
                "error": "COVER_SHEET_URL is not set in Vercel."}
    payload = {**(entry or {}), "kind": "paper_add" if entry else "paper_list", "table": table,
               "key": (os.environ.get("COVER_SHEET_SECRET") or "").strip()}
    answer, reason = _send(url, payload)
    if answer is None:
        return {**result, "error": reason}
    if not isinstance(answer, dict) or not isinstance(answer.get("v"), int) or answer["v"] < 2:
        return {**result, "ready": False, "code": "old_script",
                "error": "The sheet script in the office is the old version: update it once (steps on the page)."}
    if not answer.get("ok"):
        return {**result, "error": _refusal(answer)}
    out, recent = summarize(answer.get("rows") or [])
    return {**result, "added": bool(answer.get("added")), "out": out, "recent": recent}
