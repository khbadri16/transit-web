"""
Visit day — the shared list of customs visit days (la visite / المعاينة)
------------------------------------------------------------------------
Stored on the server (Upstash Redis, REST API) so everyone in the office sees
the same list. Every request must carry the office access code (Vercel
environment variable VISIT_DAY_CODE) — without it nothing can be read or
written.

Redis keys (all start with "vd:"):

    vd:items    HASH  id -> JSON {id, client, declaration, place,
                                  visit_date "YYYY-MM-DD" | "",
                                  visited  true once "Confirm visit" was pressed,
                                  delays   [{date, at}]: one per "Delay visit",
                                           the day that was planned (oldest first),
                                  created_at, updated_at}
    vd:dated    ZSET  ids with a visit date, not confirmed yet,
                      score = date as YYYYMMDD
    vd:done     ZSET  ids whose visit was confirmed, score = date as YYYYMMDD
    vd:nodate   ZSET  ids with no visit date yet, score = time added (ms)
    vd:created  ZSET  every id, score = time added (ms)  -> PDF period
    vd:decl     HASH  normalised declaration number -> id (duplicate check)
    vd:ver      INT   +1 on every change: the page polls it (1 command) and
                      reloads the list only when it moved
    vd:schema   INT   2 once the visits that had passed before Confirm / Delay
                      existed were moved to vd:done (see _upgrade)
    vd:fail:<ip>      wrong-code counter, expires after 15 minutes

The sections of the page come from three sorted sets:
    to confirm = vd:dated, score <  today   (the day passed: visited or not?)
    today      = vd:dated, score == today
    no date    = vd:nodate (all)
    upcoming   = vd:dated, score >  today
    passed     = vd:done                    (newest first, 10 per page)

"Confirm visit" (to confirm / today): the client was visited -> passed.
"Delay visit": it was not. The date is removed (kept in "delays") and the
client waits in "no date" again until a new date is typed; the page stamps it
"Delayed" in every section from then on. Both can be undone right after.

Dates are Algerian dates (UTC+1 all year, no daylight saving).
"""

import hmac
import json
import os
import re
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

DZ = timezone(timedelta(hours=1))          # Africa/Algiers — no DST
TIMEOUT = 10                               # seconds per Redis call
MAX_FAILS = 8                              # wrong codes per IP ...
FAIL_WINDOW_S = 15 * 60                    # ... per 15 minutes
PAGE_MAX = 50

K_ITEMS, K_DATED, K_NODATE, K_DONE = "vd:items", "vd:dated", "vd:nodate", "vd:done"
K_CREATED, K_DECL, K_VER, K_SCHEMA = "vd:created", "vd:decl", "vd:ver", "vd:schema"
SCHEMA = 2                                 # data layout this file reads and writes

LIMITS = {"client": 120, "declaration": 60, "place": 120}


# --------------------------------------------------------------------------
# Errors (mapped to HTTP status codes in index.py)
# --------------------------------------------------------------------------


class VisitError(Exception):
    status = 400

    def __init__(self, message: str, extra: Optional[dict] = None):
        super().__init__(message)
        self.extra = extra or {}


class NotConfigured(VisitError):
    status = 503


class StoreError(VisitError):
    status = 502


class BadCode(VisitError):
    status = 401


class TooManyTries(VisitError):
    status = 429


class NotFound(VisitError):
    status = 404


class Conflict(VisitError):
    """Changed by someone else meanwhile, or duplicate declaration number."""
    status = 409


# --------------------------------------------------------------------------
# Upstash Redis REST (standard library only)
# --------------------------------------------------------------------------


def _config() -> Tuple[str, str]:
    url = os.environ.get("UPSTASH_REDIS_REST_URL") or os.environ.get("KV_REST_API_URL")
    token = os.environ.get("UPSTASH_REDIS_REST_TOKEN") or os.environ.get("KV_REST_API_TOKEN")
    if not url or not token:
        raise NotConfigured(
            "The database is not configured (UPSTASH_REDIS_REST_URL / "
            "UPSTASH_REDIS_REST_TOKEN missing in Vercel)."
        )
    return url.rstrip("/"), token


def _post(path: str, body) -> object:
    url, token = _config()
    req = urllib.request.Request(
        url + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            msg = json.loads(exc.read().decode("utf-8")).get("error") or str(exc)
        except Exception:
            msg = str(exc)
        raise StoreError(f"Database error: {msg}") from exc
    except Exception as exc:
        raise StoreError(f"The database could not be reached ({exc}).") from exc


def _args(cmd) -> List[str]:
    return [str(a) for a in cmd]


def _results(data) -> list:
    if not isinstance(data, list):
        raise StoreError(f"Database error: {data}")
    out = []
    for r in data:
        if isinstance(r, dict) and "error" in r:
            raise StoreError(f"Database error: {r['error']}")
        out.append(r.get("result") if isinstance(r, dict) else r)
    return out


def pipeline(cmds: List[list]) -> list:
    """Several commands in one HTTP round trip (not atomic)."""
    return _results(_post("/pipeline", [_args(c) for c in cmds])) if cmds else []


def transaction(cmds: List[list]) -> list:
    """MULTI/EXEC — all commands or none."""
    return _results(_post("/multi-exec", [_args(c) for c in cmds])) if cmds else []


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def today_dz() -> date:
    return datetime.now(DZ).date()


def date_key(d: date) -> int:
    return d.year * 10000 + d.month * 100 + d.day


def now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def now_iso() -> str:
    return datetime.now(DZ).isoformat(timespec="seconds")


def _space(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


def norm_decl(s: str) -> str:
    return re.sub(r"\s+", "", s or "").upper()


def parse_date(s: str) -> Optional[date]:
    """'' -> None ; 'YYYY-MM-DD' -> date ; anything else -> ValueError."""
    s = (s or "").strip()
    if not s:
        return None
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", s)
    if not m:
        raise VisitError("Visit date must look like 2026-10-25.")
    try:
        d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError as exc:
        raise VisitError("This visit date does not exist.") from exc
    if not 2000 <= d.year <= 2100:
        raise VisitError("Visit date out of range.")
    return d


def clean_fields(data: dict) -> dict:
    out = {k: _space(data.get(k))[:n] for k, n in LIMITS.items()}
    if not out["client"]:
        raise VisitError("Client name is required.")
    if not out["declaration"]:
        raise VisitError("Declaration number is required.")
    d = parse_date(data.get("visit_date") or "")
    out["visit_date"] = d.isoformat() if d else ""
    return out


def _loads(raw) -> Optional[dict]:
    if not raw:
        return None
    try:
        item = json.loads(raw)
        return item if isinstance(item, dict) and item.get("id") else None
    except (TypeError, ValueError):
        return None


def _get_items(ids: List[str]) -> List[dict]:
    if not ids:
        return []
    raw = pipeline([["HMGET", K_ITEMS, *ids]])[0] or []
    return [it for it in (_loads(r) for r in raw) if it]


def _created_ms(item: dict) -> int:
    try:
        return int(datetime.fromisoformat(item["created_at"]).timestamp() * 1000)
    except Exception:
        return now_ms()


def _delays(item: dict) -> List[dict]:
    return [d for d in item.get("delays") or [] if isinstance(d, dict) and d.get("date")]


def _index_cmds(item: dict) -> List[list]:
    """(Re)place an item in the right sorted set."""
    cmds = [["ZREM", K_DATED, item["id"]], ["ZREM", K_NODATE, item["id"]], ["ZREM", K_DONE, item["id"]]]
    if item["visit_date"]:
        key = K_DONE if item.get("visited") else K_DATED
        cmds.append(["ZADD", key, date_key(date.fromisoformat(item["visit_date"])), item["id"]])
    else:
        cmds.append(["ZADD", K_NODATE, _created_ms(item), item["id"]])
    return cmds


def _save(item: dict) -> dict:
    transaction([
        ["HSET", K_ITEMS, item["id"], json.dumps(item, ensure_ascii=False)],
        *_index_cmds(item),
        ["INCR", K_VER],
    ])
    return item


def _upgrade() -> None:
    """Once, the first time this version reads the list: before "Confirm
    visit" existed, every visit whose day had passed was in "Passed visits".
    They count as visited (-> vd:done); only the visits from today on wait to
    be confirmed. Running it twice (two calls at the same moment) does no harm."""
    tk = date_key(today_dz())
    ids = pipeline([["ZRANGEBYSCORE", K_DATED, "-inf", f"({tk}"]])[0] or []
    items = [it for it in _get_items(list(ids)) if it.get("visit_date")]
    cmds: List[list] = []
    if items:
        hset, zadd = ["HSET", K_ITEMS], ["ZADD", K_DONE]
        for it in items:
            it["visited"] = True
            hset += [it["id"], json.dumps(it, ensure_ascii=False)]
            zadd += [date_key(date.fromisoformat(it["visit_date"])), it["id"]]
        cmds += [hset, zadd, ["ZREM", K_DATED, *(it["id"] for it in items)], ["INCR", K_VER]]
    transaction([*cmds, ["SET", K_SCHEMA, SCHEMA]])


def _read(cmds: List[list]) -> list:
    """pipeline() for the readers: checks in the same round trip that the
    data has the current layout, and upgrades it first when it has not."""
    *out, schema = pipeline([*cmds, ["GET", K_SCHEMA]])
    if int(schema or 0) >= SCHEMA:
        return out
    _upgrade()
    return pipeline(cmds)


# --------------------------------------------------------------------------
# Access code
# --------------------------------------------------------------------------


def check_code(code: str, ip: str) -> None:
    """Raise unless the code is right AND this IP is not locked out.
    Costs 1 Redis command when the code is right, 2 when it is wrong."""
    expected = (os.environ.get("VISIT_DAY_CODE") or "").strip()
    if not expected:
        raise NotConfigured("No access code is set yet: add VISIT_DAY_CODE in Vercel → Settings → Environment Variables, then redeploy.")
    if not (code or "").strip():
        raise BadCode("Type the access code.")
    fail_key = f"vd:fail:{ip or 'unknown'}"
    if hmac.compare_digest((code or "").strip().encode("utf-8"), expected.encode("utf-8")):
        fails = pipeline([["GET", fail_key]])[0]
        if fails and int(fails) >= MAX_FAILS:
            raise TooManyTries("Too many wrong codes from this network. Try again in 15 minutes.")
        return
    fails, _ = pipeline([["INCR", fail_key], ["EXPIRE", fail_key, FAIL_WINDOW_S]])
    if int(fails or 0) >= MAX_FAILS:
        raise TooManyTries("Too many wrong codes from this network. Try again in 15 minutes.")
    raise BadCode("Wrong access code.")


# --------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------


def version() -> dict:
    v = pipeline([["GET", K_VER]])[0]
    return {"version": int(v or 0), "today": today_dz().isoformat()}


def board() -> dict:
    """Every section in full except the passed visits (only how many)."""
    today = today_dz()
    no_date_ids, dated_ids, passed_total, ver = _read([
        ["ZRANGE", K_NODATE, 0, -1],                  # oldest first
        ["ZRANGE", K_DATED, 0, -1],                   # by visit date
        ["ZCARD", K_DONE],
        ["GET", K_VER],
    ])
    items = {it["id"]: it for it in _get_items(list(no_date_ids or []) + list(dated_ids or []))}
    today_s = today.isoformat()
    no_date = [items[i] for i in no_date_ids or [] if i in items]
    dated = [items[i] for i in dated_ids or [] if i in items and items[i].get("visit_date")]
    return {
        "today": today_s,
        "version": int(ver or 0),
        "no_date": no_date,
        "to_confirm": [it for it in dated if it["visit_date"] < today_s],
        "today_visits": [it for it in dated if it["visit_date"] == today_s],
        "upcoming": [it for it in dated if it["visit_date"] > today_s],
        "passed_total": int(passed_total or 0),
    }


def passed(offset: int = 0, limit: int = 10) -> dict:
    """Confirmed visits, newest visit date first, one page."""
    offset = max(0, int(offset))
    limit = max(1, min(PAGE_MAX, int(limit)))
    ids, total = _read([
        ["ZREVRANGE", K_DONE, offset, offset + limit - 1],
        ["ZCARD", K_DONE],
    ])
    by_id = {it["id"]: it for it in _get_items(list(ids or []))}
    return {
        "items": [by_id[i] for i in ids or [] if i in by_id],
        "offset": offset,
        "limit": limit,
        "total": int(total or 0),
    }


def added_between(start: Optional[date], end: Optional[date]) -> List[dict]:
    """Every item ADDED between two Algerian dates (inclusive). None = open."""
    lo = "-inf" if start is None else int(datetime(start.year, start.month, start.day, tzinfo=DZ).timestamp() * 1000)
    if end is None:
        hi = "+inf"
    else:
        nxt = end + timedelta(days=1)
        hi = f"({int(datetime(nxt.year, nxt.month, nxt.day, tzinfo=DZ).timestamp() * 1000)}"
    ids = _read([["ZRANGEBYSCORE", K_CREATED, lo, hi]])[0] or []
    return _get_items(list(ids))


# --------------------------------------------------------------------------
# Writing
# --------------------------------------------------------------------------


def _duplicate(decl_norm: str, self_id: str = "") -> Optional[dict]:
    other_id = pipeline([["HGET", K_DECL, decl_norm]])[0]
    if not other_id or other_id == self_id:
        return None
    return _loads(pipeline([["HGET", K_ITEMS, other_id]])[0])


def create(data: dict, force: bool = False) -> dict:
    fields = clean_fields(data)
    dn = norm_decl(fields["declaration"])
    if not force:
        other = _duplicate(dn)
        if other:
            raise Conflict(
                f"Declaration {other['declaration']} is already in the list ({other['client']}).",
                {"duplicate": other},
            )
    stamp = now_iso()
    item = {"id": uuid.uuid4().hex[:12], **fields, "visited": False, "delays": [],
            "created_at": stamp, "updated_at": stamp}
    transaction([
        ["HSET", K_ITEMS, item["id"], json.dumps(item, ensure_ascii=False)],
        ["ZADD", K_CREATED, _created_ms(item), item["id"]],
        *_index_cmds(item),
        ["HSET", K_DECL, dn, item["id"]],
        ["INCR", K_VER],
    ])
    return item


def _current(item_id: str, expected_updated_at: str, changed: str) -> dict:
    """The item as stored; NotFound / Conflict when it is gone or was
    changed since the page read it (`changed`: the message then)."""
    cur = _loads(pipeline([["HGET", K_ITEMS, item_id]])[0])
    if not cur:
        raise NotFound("This client was deleted meanwhile.")
    if expected_updated_at and cur.get("updated_at") != expected_updated_at:
        raise Conflict(changed, {"current": cur})
    return cur


def update(item_id: str, data: dict, expected_updated_at: str = "", force: bool = False) -> dict:
    cur = _current(item_id, expected_updated_at,
                   "Someone else changed this client meanwhile — the list was reloaded, check and edit again.")
    fields = clean_fields(data)
    old_dn, new_dn = norm_decl(cur.get("declaration", "")), norm_decl(fields["declaration"])
    if new_dn != old_dn and not force:
        other = _duplicate(new_dn, item_id)
        if other:
            raise Conflict(
                f"Declaration {other['declaration']} is already in the list ({other['client']}).",
                {"duplicate": other},
            )
    item = {**cur, **fields, "updated_at": now_iso()}
    if item.get("visited") and not (item["visit_date"] and item["visit_date"] <= today_dz().isoformat()):
        item["visited"] = False   # no date now, or a day still to come: it can't have been visited
    cmds = [["HSET", K_ITEMS, item_id, json.dumps(item, ensure_ascii=False)], *_index_cmds(item)]
    if new_dn != old_dn:
        if pipeline([["HGET", K_DECL, old_dn]])[0] == item_id:
            cmds.append(["HDEL", K_DECL, old_dn])
        cmds.append(["HSET", K_DECL, new_dn, item_id])
    cmds.append(["INCR", K_VER])
    transaction(cmds)
    return item


def delete(item_id: str) -> None:
    cur = _loads(pipeline([["HGET", K_ITEMS, item_id]])[0])
    if not cur:
        return  # already gone
    dn = norm_decl(cur.get("declaration", ""))
    cmds = [
        ["HDEL", K_ITEMS, item_id],
        ["ZREM", K_DATED, item_id],
        ["ZREM", K_NODATE, item_id],
        ["ZREM", K_DONE, item_id],
        ["ZREM", K_CREATED, item_id],
    ]
    if pipeline([["HGET", K_DECL, dn]])[0] == item_id:
        cmds.append(["HDEL", K_DECL, dn])
    cmds.append(["INCR", K_VER])
    transaction(cmds)


# --------------------------------------------------------------------------
# Confirm visit / Delay visit — once the visit day has come (to confirm,
# today). Each one is undone by its pair (the page offers it right after).
# --------------------------------------------------------------------------

_CHANGED = "Someone else changed this client meanwhile — the list was reloaded, check it again."


def _scheduled(item_id: str, expected_updated_at: str) -> dict:
    """The item, if it still has a visit date that is not confirmed yet."""
    cur = _current(item_id, expected_updated_at, _CHANGED)
    if cur.get("visited"):
        raise Conflict("This visit is already confirmed — the list was reloaded.")
    if not cur.get("visit_date"):
        raise Conflict("This client has no visit date any more — the list was reloaded.")
    return cur


def confirm(item_id: str, expected_updated_at: str = "") -> dict:
    """The client was visited: -> passed visits."""
    cur = _scheduled(item_id, expected_updated_at)
    if cur["visit_date"] > today_dz().isoformat():
        raise VisitError("This visit day has not come yet.")
    return _save({**cur, "visited": True, "updated_at": now_iso()})


def delay(item_id: str, expected_updated_at: str = "") -> dict:
    """The client was not visited: the date is removed (kept in "delays") and
    the client waits in "no date" again, stamped Delayed."""
    cur = _scheduled(item_id, expected_updated_at)
    stamp = now_iso()
    delays = [*_delays(cur), {"date": cur["visit_date"], "at": stamp}]
    return _save({**cur, "visit_date": "", "delays": delays, "updated_at": stamp})


def unconfirm(item_id: str, expected_updated_at: str = "") -> dict:
    """Undo "Confirm visit"."""
    cur = _current(item_id, expected_updated_at, _CHANGED)
    if not cur.get("visited"):
        return cur
    return _save({**cur, "visited": False, "updated_at": now_iso()})


def undelay(item_id: str, expected_updated_at: str = "") -> dict:
    """Undo "Delay visit": the planned day comes back, the last delay goes."""
    cur = _current(item_id, expected_updated_at, _CHANGED)
    delays = _delays(cur)
    if cur.get("visit_date") or not delays:
        raise Conflict("This can no longer be undone — the list was reloaded.")
    return _save({**cur, "visit_date": delays[-1]["date"], "delays": delays[:-1], "updated_at": now_iso()})


ACTIONS = {"confirm": confirm, "delay": delay, "unconfirm": unconfirm, "undelay": undelay}
