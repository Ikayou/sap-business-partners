import copy
import csv
import io
import re
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from datetime import date, datetime, timedelta, timezone
import requests
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from sap_client import SapQuotaError, get, get_page

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  
    allow_methods=["*"], allow_headers=["*"],
)


@app.exception_handler(requests.RequestException)
def sap_error(_: Request, exc: requests.RequestException):
    """SAP-Fehler als 502 mit Meldung zurückgeben (statt unklarem 500 ohne CORS-Header)."""
    detail = "SAP-API nicht erreichbar"
    resp = getattr(exc, "response", None)
    if isinstance(exc, SapQuotaError):
        detail = str(exc)
    elif resp is not None:
        try:
            body = resp.json()
            detail = body["error"]["message"]["value"]
        except (ValueError, KeyError, TypeError):
            detail = f"SAP-Fehler (HTTP {resp.status_code})"
            if "spike arrest" in resp.text.lower():
                detail = "SAP-Sandbox: zu viele gleichzeitige Anfragen – bitte erneut versuchen."
    return JSONResponse(status_code=502, content={"detail": detail})


CATEGORY = {"1": "Person", "2": "Organisation", "3": "Gruppe"}

PARTNER_LIMIT = 50


@app.get("/api/business-partners")
def business_partners(q: str = Query(..., min_length=1, max_length=50)):
    """Suche nach Name oder Nummer. Ohne Suchbegriff werden bewusst keine Partner geliefert."""
    text = q.strip()
    if not text:
        raise HTTPException(400, "Suchbegriff fehlt")
    # substringof unterscheidet Groß-/Kleinschreibung, tolower() wird nicht unterstützt
    variants = {text, text.lower(), text.upper(), text.capitalize(), text.title()}
    parts = [f"substringof('{_q(v)}',BusinessPartnerFullName)" for v in variants]
    # SAP lehnt Leerzeichen/Sonderzeichen im Nummernfeld ab; Nummern haben max. 10 Zeichen
    if len(text) <= 10 and _valid_id(text):
        parts.append(f"substringof('{_q(text)}',BusinessPartner)")
    rows, total = get_page("API_BUSINESS_PARTNER", "A_BusinessPartner", {
        "$top": PARTNER_LIMIT,
        "$orderby": "BusinessPartner",
        "$filter": " or ".join(parts),
        "$select": "BusinessPartner,BusinessPartnerFullName,BusinessPartnerCategory",
    })
    return {
        "items": [
            {"id": r["BusinessPartner"], "name": r["BusinessPartnerFullName"],
             "category": CATEGORY.get(r["BusinessPartnerCategory"], "Unbekannt")}
            for r in rows
        ],
        "total": total,
        "limit": PARTNER_LIMIT,
    }


ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,20}$")


def _valid_id(value: str) -> bool:
    """SAP-Nummern wie 1000160 oder USCU_S17: nur Buchstaben, Ziffern, _ und -."""
    return bool(ID_RE.match(value))


def _first_address(pid: str):
    return get("API_BUSINESS_PARTNER", f"A_BusinessPartner('{pid}')/to_BusinessPartnerAddress", {
        "$top": 1,
        "$select": "AddressID,StreetName,HouseNumber,PostalCode,CityName,Country",
    })


@app.get("/api/business-partners/{pid}")
def business_partner_detail(pid: str):
    if not _valid_id(pid):
        raise HTTPException(400, "Ungültige ID")
    addrs = _first_address(pid)
    if not addrs:
        return {"id": pid, "address": None, "emails": []}
    a = addrs[0]
    emails = get("API_BUSINESS_PARTNER",
                 f"A_BusinessPartnerAddress(BusinessPartner='{pid}',AddressID='{a['AddressID']}')/to_EmailAddress",
                 {"$select": "EmailAddress"})
    street = f"{a['StreetName']} {a['HouseNumber']}".strip()
    return {
        "id": pid,
        "address": {
            "street": street, "postalCode": a["PostalCode"],
            "city": a["CityName"], "country": a["Country"],
        },
        "emails": [e["EmailAddress"] for e in emails],
    }


STATUS = {"A": "Offen", "B": "In Bearbeitung", "C": "Abgeschlossen"}


def _odata_date(value: str) -> str:
    ms = int(re.search(r"\d+", value).group())
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def _q(value: str) -> str:
    """Wert für OData-Stringliteral absichern (' wird verdoppelt)."""
    return value.replace("'", "''")


def _or(field: str, values) -> str:
    return "(" + " or ".join(f"{field} eq '{_q(v)}'" for v in values) + ")"


def _customer_ids(text: str) -> list[str]:
    # substringof unterscheidet Groß-/Kleinschreibung, tolower() wird nicht unterstützt
    variants = {text, text.lower(), text.upper(), text.capitalize(), text.title()}
    flt = " or ".join(f"substringof('{_q(v)}',BusinessPartnerFullName)" for v in variants)
    rows = get("API_BUSINESS_PARTNER", "A_BusinessPartner", {
        "$top": 20, "$filter": flt, "$select": "BusinessPartner",
    })
    return [r["BusinessPartner"] for r in rows]


def _customer_names(ids: set[str]) -> dict[str, str]:
    """Kundennummer -> Name. Lange ID-Listen werden in Blöcke geteilt (URL-Länge)."""
    ordered = sorted(ids)
    chunks = [ordered[i:i + 40] for i in range(0, len(ordered), 40)]

    def one(chunk: list[str]) -> dict[str, str]:
        rows = get("API_BUSINESS_PARTNER", "A_BusinessPartner", {
            "$filter": _or("BusinessPartner", chunk),
            "$select": "BusinessPartner,BusinessPartnerFullName",
        })
        return {r["BusinessPartner"]: r["BusinessPartnerFullName"] for r in rows}

    names: dict[str, str] = {}
    if chunks:
        with ThreadPoolExecutor(max_workers=4) as pool:
            for part in pool.map(one, chunks):
                names.update(part)
    return names


def _parse_day(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(400, "Ungültiges Datum (JJJJ-MM-TT)")


NO_MATCH = "NO_MATCH"


class OrderQuery:
    """Gemeinsame Filter für Liste, Auswertung, Produkte und CSV-Export (dieselben Aufträge)."""

    def __init__(self, status: str | None = None,
                 customer: str | None = Query(None, max_length=50),
                 customer_id: str | None = Query(None, max_length=20),
                 date_from: str | None = None, date_to: str | None = None,
                 currency: str | None = Query(None, pattern=r"^[A-Z]{3}$")):
        self.status, self.customer, self.customer_id = status, customer, customer_id
        self.date_from, self.date_to, self.currency = date_from, date_to, currency

    def with_period(self, date_from: date, date_to: date, currency: str | None = None) -> "OrderQuery":
        """Kopie mit anderem Zeitraum (für den Vorperiodenvergleich)."""
        other = copy.copy(self)
        other.date_from, other.date_to = date_from.isoformat(), date_to.isoformat()
        if currency:
            other.currency = currency
        return other

    def odata_filter(self, prefix: str = "") -> str | None:
        """$filter-Ausdruck. prefix="to_SalesOrder/" für Positionen (Felder des Auftragskopfs).

        Gibt None zurück (kein Filter) oder NO_MATCH, wenn kein Kunde zum Namen passt.
        """
        filters = []
        if self.status:
            if self.status not in STATUS:
                raise HTTPException(400, "Ungültiger Status")
            filters.append(f"{prefix}OverallSDProcessStatus eq '{self.status}'")
        if self.date_from:
            filters.append(f"{prefix}CreationDate ge datetime'{_parse_day(self.date_from).isoformat()}T00:00:00'")
        if self.date_to:  # inklusive: bis zum Beginn des Folgetags
            nxt = _parse_day(self.date_to) + timedelta(days=1)
            filters.append(f"{prefix}CreationDate lt datetime'{nxt.isoformat()}T00:00:00'")
        if self.customer_id:
            if not _valid_id(self.customer_id):
                raise HTTPException(400, "Ungültige Kundennummer")
            filters.append(f"{prefix}SoldToParty eq '{self.customer_id}'")
        if self.customer and self.customer.strip():
            ids = _customer_ids(self.customer.strip())
            if not ids:
                return NO_MATCH
            filters.append(_or(f"{prefix}SoldToParty", ids))
        if self.currency:  # Feld heißt bei Kopf und Position gleich
            filters.append(f"TransactionCurrency eq '{self.currency}'")
        return " and ".join(filters) or None


ORDER_SELECT = "SalesOrder,SoldToParty,TotalNetAmount,TransactionCurrency,CreationDate,OverallSDProcessStatus,DeliveryBlockReason"


def _fetch_orders(oq: OrderQuery, top: int, skip: int = 0) -> tuple[list[dict], int]:
    flt = oq.odata_filter()
    if flt == NO_MATCH:
        return [], 0
    params = {
        "$top": top,
        "$skip": skip,
        # SalesOrder als zweiter Sortierschlüssel: stabile Reihenfolge beim Blättern
        "$orderby": "CreationDate desc,SalesOrder desc",
        "$select": ORDER_SELECT,
    }
    if flt:
        params["$filter"] = flt  # Filter läuft auf dem SAP-Server
    rows, total = get_page("API_SALES_ORDER_SRV", "A_SalesOrder", params)
    names = _customer_names({r["SoldToParty"] for r in rows})
    items = [
        {
            "id": r["SalesOrder"],
            "customer": r["SoldToParty"],
            "customerName": names.get(r["SoldToParty"], ""),
            "date": _odata_date(r["CreationDate"]),
            "amount": float(r["TotalNetAmount"] or 0),
            "currency": r["TransactionCurrency"],
            "status": STATUS.get(r["OverallSDProcessStatus"], "Unbekannt"),
            "blocked": bool(r["DeliveryBlockReason"]),
        }
        for r in rows
    ]
    return items, total


@app.get("/api/sales-orders")
def sales_orders(oq: OrderQuery = Depends(),
                 page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
    items, total = _fetch_orders(oq, page_size, (page - 1) * page_size)
    return {"items": items, "total": total, "page": page, "pageSize": page_size}


# --- Währungen -------------------------------------------------------------

CURRENCY_CANDIDATES = ["USD", "EUR", "AUD", "GBP", "CAD", "JPY", "CHF", "CNY"]


@lru_cache(maxsize=1)
def _currency_counts() -> tuple[tuple[str, int], ...]:
    def count(cur: str) -> tuple[str, int]:
        _, total = get_page("API_SALES_ORDER_SRV", "A_SalesOrder", {
            "$top": 1, "$select": "SalesOrder", "$filter": f"TransactionCurrency eq '{cur}'",
        })
        return cur, total

    with ThreadPoolExecutor(max_workers=3) as pool:
        counts = list(pool.map(count, CURRENCY_CANDIDATES))
    return tuple(sorted((c for c in counts if c[1] > 0), key=lambda c: -c[1]))


@app.get("/api/currencies")
def currencies():
    """Währungen mit Anzahl Aufträge (nur Kandidatenliste; SAP bietet keine Gruppierung an)."""
    return [{"code": c, "count": n} for c, n in _currency_counts()]


# --- Auswertung nach Zeit und Kunde ------------------------------------------

SUMMARY_LIMIT = 5000


@app.get("/api/sales-orders/summary")
def sales_orders_summary(oq: OrderQuery = Depends()):
    """Auswertung zu denselben Filtern wie die Auftragsliste (neueste SUMMARY_LIMIT Aufträge)."""
    empty = {"currency": oq.currency or "", "granularity": "month", "byPeriod": [], "byCustomer": [],
             "basis": 0, "total": 0, "limit": SUMMARY_LIMIT, "ignoredOtherCurrency": 0}
    flt = oq.odata_filter()
    if flt == NO_MATCH:
        return empty
    params = {
        "$top": SUMMARY_LIMIT,
        "$orderby": "CreationDate desc,SalesOrder desc",
        "$select": "TotalNetAmount,TransactionCurrency,CreationDate,SoldToParty",
    }
    if flt:
        params["$filter"] = flt
    rows, total = get_page("API_SALES_ORDER_SRV", "A_SalesOrder", params)
    if not rows:
        return empty
    currency = oq.currency or rows[0]["TransactionCurrency"]
    used = [r for r in rows if r["TransactionCurrency"] == currency]  # keine Währungsumrechnung
    days = [(r, _odata_date(r["CreationDate"])) for r in used]
    # Wenige Monate in den Daten -> nach Tag gruppieren, sonst wäre das Diagramm fast leer
    granularity = "day" if len({d[:7] for _, d in days}) < 3 else "month"
    cut = 10 if granularity == "day" else 7
    by_period: dict[str, dict] = defaultdict(lambda: {"total": 0.0, "count": 0})
    by_customer: dict[str, float] = defaultdict(float)
    for r, d in days:
        amount = float(r["TotalNetAmount"] or 0)
        p = by_period[d[:cut]]
        p["total"] += amount
        p["count"] += 1
        by_customer[r["SoldToParty"]] += amount
    top_customers = sorted(by_customer.items(), key=lambda kv: kv[1], reverse=True)[:8]
    names = _customer_names({c for c, _ in top_customers})
    return {
        "currency": currency,
        "granularity": granularity,
        "byPeriod": [{"period": k, "total": round(v["total"], 2), "count": v["count"]}
                     for k, v in sorted(by_period.items())],
        "byCustomer": [{"customer": c, "name": names.get(c, c), "total": round(t, 2)}
                       for c, t in top_customers],
        "basis": len(used),
        "total": total,
        "limit": SUMMARY_LIMIT,
        "ignoredOtherCurrency": len(rows) - len(used),
    }


# --- Kennzahlen mit Vorperiodenvergleich ---------------------------------------

KPI_DEFAULT_DAYS = 30
KPI_LIMIT = 5000


def _period_stats(oq: OrderQuery) -> dict:
    """Nettowert-Summe, Anzahl, Ø und gesperrte Aufträge für die Filter in oq."""
    empty = {"total": 0.0, "count": 0, "average": 0.0, "blocked": 0, "truncated": False}
    flt = oq.odata_filter()
    if flt == NO_MATCH:
        return empty
    base = [flt] if flt else []
    rows, count = get_page("API_SALES_ORDER_SRV", "A_SalesOrder", {
        "$top": KPI_LIMIT, "$select": "TotalNetAmount",
        "$orderby": "CreationDate desc,SalesOrder desc",
        **({"$filter": " and ".join(base)} if base else {}),
    })
    _, blocked = get_page("API_SALES_ORDER_SRV", "A_SalesOrder", {
        "$top": 1, "$select": "SalesOrder",
        "$filter": " and ".join(base + ["DeliveryBlockReason ne ''"]),
    })
    total = sum(float(r["TotalNetAmount"] or 0) for r in rows)
    truncated = count > len(rows)  # Summe nur über die ersten KPI_LIMIT Aufträge
    return {
        "total": round(total, 2), "count": count, "blocked": blocked, "truncated": truncated,
        "average": round(total / len(rows), 2) if rows else 0.0,
    }


@app.get("/api/sales-orders/kpi")
def sales_orders_kpi(oq: OrderQuery = Depends()):
    """Kennzahlen des gewählten Zeitraums im Vergleich zum gleich langen Zeitraum davor.

    Ohne Datum: letzte 30 Tage bis heute. Alle anderen Filter gelten für beide Zeiträume.
    """
    end = _parse_day(oq.date_to) if oq.date_to else date.today()
    start = _parse_day(oq.date_from) if oq.date_from else end - timedelta(days=KPI_DEFAULT_DAYS - 1)
    if start > end:
        raise HTTPException(400, "„Von“ liegt nach „Bis“")
    days = (end - start).days + 1
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=days - 1)

    current_q = oq.with_period(start, end)
    currency = oq.currency
    if not currency:  # Summen verschiedener Währungen sind nicht addierbar -> eine Währung festlegen
        flt = current_q.odata_filter()
        if flt != NO_MATCH:
            sample, _ = get_page("API_SALES_ORDER_SRV", "A_SalesOrder", {
                "$top": 1, "$select": "TransactionCurrency",
                **({"$filter": flt} if flt else {}),
            })
            currency = sample[0]["TransactionCurrency"] if sample else None
    current_q = oq.with_period(start, end, currency)
    previous_q = oq.with_period(prev_start, prev_end, currency)
    with ThreadPoolExecutor(max_workers=2) as pool:
        cur_f = pool.submit(_period_stats, current_q)
        prev_f = pool.submit(_period_stats, previous_q)
        current, previous = cur_f.result(), prev_f.result()
    return {
        "currency": currency or "",
        "days": days,
        "current": {"from": start.isoformat(), "to": end.isoformat(), **current},
        "previous": {"from": prev_start.isoformat(), "to": prev_end.isoformat(), **previous},
        "defaultPeriod": not (oq.date_from or oq.date_to),
    }


# --- Umsatz nach Produkt (Auftragspositionen) --------------------------------

PRODUCT_LIMIT = 5000
PRODUCT_TOP = 10


@app.get("/api/sales-orders/products")
def sales_order_products(oq: OrderQuery = Depends()):
    """Top-Produkte nach Nettowert aus den Positionen (A_SalesOrderItem), gleiche Filter wie die Liste."""
    empty = {"currency": oq.currency or "", "items": [], "basis": 0, "total": 0,
             "limit": PRODUCT_LIMIT, "ignoredOtherCurrency": 0, "sum": 0.0}
    flt = oq.odata_filter(prefix="to_SalesOrder/")  # Filter auf Felder des Auftragskopfs
    if flt == NO_MATCH:
        return empty
    params = {
        "$top": PRODUCT_LIMIT,
        "$orderby": "SalesOrder desc,SalesOrderItem",
        "$select": "Material,SalesOrderItemText,NetAmount,RequestedQuantity,RequestedQuantityUnit,TransactionCurrency",
    }
    if flt:
        params["$filter"] = flt
    rows, total = get_page("API_SALES_ORDER_SRV", "A_SalesOrderItem", params)
    if not rows:
        return empty
    currency = oq.currency or rows[0]["TransactionCurrency"]
    used = [r for r in rows if r["TransactionCurrency"] == currency]
    groups: dict[str, dict] = {}
    for r in used:
        key = r["Material"] or r["SalesOrderItemText"] or "–"
        g = groups.setdefault(key, {"material": key, "text": r["SalesOrderItemText"], "amount": 0.0,
                                    "lines": 0, "units": defaultdict(float)})
        g["amount"] += float(r["NetAmount"] or 0)
        g["lines"] += 1
        g["units"][r["RequestedQuantityUnit"]] += float(r["RequestedQuantity"] or 0)
    ranked = sorted(groups.values(), key=lambda g: g["amount"], reverse=True)[:PRODUCT_TOP]
    items = []
    for g in ranked:
        # Mengen nur ausweisen, wenn alle Positionen dieselbe Einheit haben
        unit_qty = dict(g["units"])
        single = len(unit_qty) == 1
        items.append({
            "material": g["material"], "text": g["text"], "amount": round(g["amount"], 2), "lines": g["lines"],
            "quantity": round(next(iter(unit_qty.values())), 3) if single else None,
            "unit": next(iter(unit_qty)) if single else None,
        })
    return {
        "currency": currency, "items": items, "basis": len(used), "total": total, "limit": PRODUCT_LIMIT,
        "ignoredOtherCurrency": len(rows) - len(used),
        "sum": round(sum(float(r["NetAmount"] or 0) for r in used), 2),
    }


# --- CSV-Export ------------------------------------------------------------------

EXPORT_LIMIT = 5000


def _csv_text(value) -> str:
    """CSV-Injection verhindern: Zellen, die mit = + - @ beginnen, würde Excel als Formel auswerten."""
    text = str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


@app.get("/api/sales-orders/export.csv")
def export_orders_csv(oq: OrderQuery = Depends()):
    items, total = _fetch_orders(oq, EXPORT_LIMIT)
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";", lineterminator="\r\n")  # Semikolon: deutsches Excel
    writer.writerow(["Auftrag", "Datum", "Kundennummer", "Kunde", "Nettowert", "Währung", "Status", "Liefersperre"])
    for o in items:
        writer.writerow([
            o["id"], o["date"], _csv_text(o["customer"]), _csv_text(o["customerName"]),
            f"{o['amount']:.2f}".replace(".", ","), o["currency"], o["status"], "ja" if o["blocked"] else "nein",
        ])
    body = "\ufeff" + buf.getvalue()  # BOM: Excel erkennt UTF-8 (Umlaute)
    return Response(
        content=body.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="auftraege_{date.today().isoformat()}.csv"',
            "X-Total-Count": str(total),
            "X-Exported-Count": str(len(items)),
        },
    )


@app.get("/api/sales-orders/{order_id}/items")
def sales_order_items(order_id: str):
    if not _valid_id(order_id):
        raise HTTPException(400, "Ungültige ID")
    rows = get("API_SALES_ORDER_SRV", f"A_SalesOrder('{order_id}')/to_Item", {
        "$select": "SalesOrderItem,Material,SalesOrderItemText,RequestedQuantity,RequestedQuantityUnit,NetAmount,TransactionCurrency",
    })
    return [
        {
            "item": r["SalesOrderItem"], "material": r["Material"], "text": r["SalesOrderItemText"],
            "quantity": float(r["RequestedQuantity"] or 0), "unit": r["RequestedQuantityUnit"],
            "amount": float(r["NetAmount"] or 0), "currency": r["TransactionCurrency"],
        }
        for r in rows
    ]
