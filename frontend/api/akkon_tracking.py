"""
Akkon Lines — automatic BL tracking
-----------------------------------
Akkon's public tracking page (https://sap.akkonlines.com/index.aspx) is a
plain ASP.NET WebForms form with no captcha: GET the page once for its
hidden form fields, then POST them back with the BL number and the port-of-
loading country, exactly like the page's own "Search" button does.

The country matters: each country is a separate Akkon database, so a BL is
only found under its port-of-loading country. When the country is unknown
("auto"), the likely ones are tried first, a few at a time, and the search
stops at the first hit (the Tracking page then remembers that country).

The answer is the page's "GridView1" table — one row per container:
  Akkon BL No | Container No | Vessel Name | Voyage | Port Of Loading | ETS |
  Port Of Discharge | ETA | Transhipment Vessel | Transhipment Voyage |
  Final Destination | Final ETA
"""

import re
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from typing import Dict, List, Optional, Tuple

AKKON_URL = "https://sap.akkonlines.com/index.aspx"
TIMEOUT = 20  # seconds per request
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TransitDocGen-Tracking/1.0"

# Dropdown values of the page ("LABEL|DATABASE"), most likely first.
COUNTRIES: List[str] = [
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
]

HIDDEN_FIELDS = (
    "__EVENTTARGET", "__EVENTARGUMENT", "__VIEWSTATE",
    "__VIEWSTATEGENERATOR", "__EVENTVALIDATION",
)

# GridView1 header -> key used by the frontend
COLUMN_KEYS = {
    "akkon bl no": "bl",
    "container no": "container",
    "vessel name": "vessel",
    "voyage": "voyage",
    "port of loading": "pol",
    "ets": "ets",
    "port of discharge": "pod",
    "eta": "eta",
    "transhipment vessel": "ts_vessel",
    "transhipment voyage": "ts_voyage",
    "final destination": "final_destination",
    "final eta": "final_eta",
}

BL_RE = re.compile(r"^[A-Z0-9\-]{4,20}$")


class AkkonError(Exception):
    """Akkon could not be reached or answered something unexpected."""


# --------------------------------------------------------------------------
# HTML parsing (standard library only)
# --------------------------------------------------------------------------


class _PageParser(HTMLParser):
    """Collects the hidden form fields and the GridView1 table."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hidden: Dict[str, str] = {}
        self.headers: List[str] = []
        self.rows: List[List[str]] = []
        self._in_grid = 0          # nesting depth inside GridView1
        self._row: Optional[List[str]] = None
        self._cell: Optional[List[str]] = None
        self._cell_is_th = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "input" and a.get("type") == "hidden" and a.get("name") in HIDDEN_FIELDS:
            self.hidden[a["name"]] = a.get("value") or ""
        if tag == "table":
            if self._in_grid:
                self._in_grid += 1
            elif a.get("id") == "GridView1":
                self._in_grid = 1
            return
        if not self._in_grid:
            return
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
            self._cell_is_th = tag == "th"
        elif tag == "br" and self._cell is not None:
            self._cell.append(" ")

    def handle_endtag(self, tag):
        if not self._in_grid:
            return
        if tag == "table":
            self._in_grid -= 1
        elif tag in ("td", "th") and self._cell is not None and self._row is not None:
            text = re.sub(r"\s+", " ", "".join(self._cell)).strip()
            self._row.append(text)
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                if self._cell_is_th and not self.headers:
                    self.headers = self._row
                else:
                    self.rows.append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def parse_page(html: str) -> Tuple[Dict[str, str], List[str], List[List[str]]]:
    p = _PageParser()
    p.feed(html)
    return p.hidden, p.headers, p.rows


def rows_to_dicts(headers: List[str], rows: List[List[str]]) -> List[Dict[str, str]]:
    keys = [COLUMN_KEYS.get(h.strip().lower(), re.sub(r"\W+", "_", h.strip().lower()))
            for h in headers]
    out = []
    for r in rows:
        if len(r) < len(keys):
            r = r + [""] * (len(keys) - len(r))
        out.append({k: (v if v not in ("&nbsp;", "\xa0") else "") for k, v in zip(keys, r)})
    return out


def modal_message(html: str) -> Optional[str]:
    """The page answers errors with showModal('Title', 'Message', 'type')."""
    m = re.search(r"showModal\('([^']*)',\s*'([^']*)'", html)
    return f"{m.group(1)}: {m.group(2)}" if m else None


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


def _request(data: Optional[bytes] = None) -> str:
    req = urllib.request.Request(
        AKKON_URL,
        data=data,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en",
            **({"Content-Type": "application/x-www-form-urlencoded"} if data else {}),
        },
        method="POST" if data else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception as exc:  # network error, timeout, HTTP error
        raise AkkonError(f"Akkon Lines could not be reached ({exc}).") from exc


def _search(hidden: Dict[str, str], country: str, bl: str) -> Optional[dict]:
    """One POST. Returns the result dict, or None when 'not found'."""
    form = dict(hidden)
    form.update({"ddlCountry": country, "TextBox1": bl, "TextBox2": "", "Button1": "Search"})
    html = _request(urllib.parse.urlencode(form).encode())
    _, headers, rows = parse_page(html)
    if rows:
        return {"country": country, "headers": headers, "rows": rows_to_dicts(headers, rows)}
    msg = modal_message(html) or ""
    if "not found" in msg.lower() or "could not be found" in msg.lower():
        return None
    if msg:
        raise AkkonError(msg)
    return None


def track_akkon(bl: str, country: str = "") -> dict:
    """Look a BL up on Akkon. `country` = a dropdown value, or "" for auto.

    Returns {"found": bool, "country": str, "headers": [...], "rows": [...]}.
    """
    bl = re.sub(r"\s+", "", bl or "").upper()
    if not BL_RE.match(bl):
        raise ValueError("Invalid BL number.")
    if country and country not in COUNTRIES:
        raise ValueError("Unknown port-of-loading country.")

    hidden, _, _ = parse_page(_request())
    if "__VIEWSTATE" not in hidden:
        raise AkkonError("Akkon's tracking page changed — automatic check unavailable.")

    if country:
        res = _search(hidden, country, bl)
        return {"found": bool(res), "country": country, **(res or {"headers": [], "rows": []})}

    # auto: a few countries at a time, likely ones first; stop at the first hit
    batch = 4
    last_error: Optional[Exception] = None
    with ThreadPoolExecutor(max_workers=batch) as pool:
        for i in range(0, len(COUNTRIES), batch):
            chunk = COUNTRIES[i:i + batch]
            futures = [pool.submit(_search, hidden, c, bl) for c in chunk]
            for fut in futures:
                try:
                    res = fut.result()
                except Exception as exc:  # keep trying the other countries
                    last_error = exc
                    continue
                if res:
                    return {"found": True, **res}
    if last_error and isinstance(last_error, AkkonError) and "reached" in str(last_error):
        raise last_error
    return {"found": False, "country": "", "headers": [], "rows": []}
