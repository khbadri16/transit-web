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
"""

import json
import os
import re
import urllib.error
import urllib.request
from typing import Dict, List, Tuple, Union

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


def record(line: Dict) -> Tuple[str, str]:
    """Send the line. Returns (status, reason):
    ("added" | "updated", "") on success, ("off", "") when not configured,
    ("failed", short reason) otherwise."""
    url = (os.environ.get("COVER_SHEET_URL") or "").strip()
    if not url:
        return "off", ""
    body = json.dumps(
        {"secret": (os.environ.get("COVER_SHEET_SECRET") or "").strip(), **line},
        ensure_ascii=False,
    ).encode("utf-8")
    try:
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
    except ValueError:  # e.g. pasted without https://
        return "failed", "COVER_SHEET_URL is not a full link (it must start with https:// and end with /exec)"
    try:
        # Apps Script answers with a redirect to the result: urllib follows it
        # as a GET, which is what Google expects.
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        print(f"[cover-sheet] HTTP {exc.code}")
        return "failed", f"Google answered HTTP {exc.code}"
    except TimeoutError:
        print("[cover-sheet] timeout")
        return "failed", "Google did not answer in time (the line may still have been added)"
    except Exception as exc:  # DNS, connection reset...
        print(f"[cover-sheet] {exc!r}")
        return "failed", "Google Sheets could not be reached"
    try:
        answer = json.loads(raw)
    except ValueError:
        # an HTML page: usually the web app is not shared with "Anyone"
        print(f"[cover-sheet] not JSON: {raw[:200]!r}")
        return "failed", "the sheet link did not answer (check the deployment: Who has access = Anyone)"
    if not isinstance(answer, dict) or not answer.get("ok"):
        reason = str((answer.get("error") if isinstance(answer, dict) else "") or "").strip() or "unknown error"
        print(f"[cover-sheet] refused: {reason}")
        return "failed", reason[:200]
    return ("updated" if answer.get("action") == "updated" else "added"), ""
