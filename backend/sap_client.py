import json
import os
import threading
import time

import requests
from dotenv import load_dotenv

load_dotenv()
BASE = "https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap"
HEADERS = {"APIKey": os.environ["SAP_API_KEY"], "Accept": "application/json"}

# Die API-Business-Hub-Sandbox begrenzt Anfragen:
#  - "Spike arrest": max. 30 Anfragen/s, Burst 3  -> Anfragen takten, bei Fehler kurz warten
#  - "Rate limit quota": Kontingent aufgebraucht   -> nicht wiederholen, verständlich melden
MAX_ATTEMPTS = 3
MIN_INTERVAL = 0.05      # Sekunden zwischen zwei Anfrage-Starts (max. 20/s)
MAX_PARALLEL = 3
CACHE_TTL = 60.0         # Sekunden: gleiche Anfrage nicht erneut an SAP schicken

_slots = threading.Semaphore(MAX_PARALLEL)
_pace_lock = threading.Lock()
_next_start = 0.0

_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
_key_locks: dict[str, threading.Lock] = {}


class SapQuotaError(requests.RequestException):
    """SAP-Sandbox: Anfrage-Kontingent erschöpft."""


def _pace() -> None:
    global _next_start
    with _pace_lock:
        now = time.monotonic()
        wait = _next_start - now
        _next_start = max(now, _next_start) + MIN_INTERVAL
    if wait > 0:
        time.sleep(wait)


def _fault_text(res: requests.Response) -> str:
    try:
        return json.dumps(res.json())[:400].lower()
    except ValueError:
        return res.text[:400].lower()


def _fetch(service: str, entity: str, params: dict | None) -> dict:
    last: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        with _slots:
            _pace()
            try:
                res = requests.get(f"{BASE}/{service}/{entity}", headers=HEADERS, params=params, timeout=30)
            except (requests.ConnectionError, requests.Timeout) as exc:
                last, res = exc, None
        if res is not None:
            if res.ok:
                return res.json()["d"]
            text = _fault_text(res)
            if "quota" in text:
                raise SapQuotaError("SAP-Sandbox: Anfragelimit (Quota) erreicht – bitte später erneut versuchen.",
                                    response=res)
            transient = res.status_code in (429, 502, 503, 504) or "spike arrest" in text
            if not transient:
                res.raise_for_status()
            last = requests.HTTPError(f"HTTP {res.status_code}", response=res)
        if attempt < MAX_ATTEMPTS:
            time.sleep(1.0 * attempt)  # Spike arrest: kurz warten, dann erneut
    assert last is not None
    raise last


def _request(service: str, entity: str, params: dict | None) -> dict:
    """GET mit Takt, Wiederholung und kurzem Cache (gleiche Anfrage gleichzeitig = nur ein SAP-Aufruf)."""
    key = f"{service}/{entity}?{json.dumps(params, sort_keys=True, default=str)}"
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.monotonic() - hit[0] < CACHE_TTL:
            return hit[1]
        lock = _key_locks.setdefault(key, threading.Lock())
    with lock:  # zweiter gleichzeitiger Aufruf wartet und liest dann den Cache
        with _cache_lock:
            hit = _cache.get(key)
            if hit and time.monotonic() - hit[0] < CACHE_TTL:
                return hit[1]
        data = _fetch(service, entity, params)
        with _cache_lock:
            _cache[key] = (time.monotonic(), data)
            if len(_cache) > 500:  # einfache Begrenzung
                for old in sorted(_cache, key=lambda k: _cache[k][0])[:100]:
                    _cache.pop(old, None)
                    _key_locks.pop(old, None)
        return data


def get(service: str, entity: str, params: dict | None = None) -> list[dict]:
    return _request(service, entity, params)["results"]


def get_page(service: str, entity: str, params: dict) -> tuple[list[dict], int]:
    """Wie get(), liefert zusätzlich die Gesamtzahl der Treffer ($inlinecount)."""
    d = _request(service, entity, {**params, "$inlinecount": "allpages"})
    return d["results"], int(d.get("__count", len(d["results"])))
