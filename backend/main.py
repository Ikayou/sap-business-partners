import re
from collections import defaultdict
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sap_client import get

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  
    allow_methods=["*"], allow_headers=["*"],
)
CATEGORY = {"1": "Person", "2": "Organisation", "3": "Gruppe"}

@app.get("/api/business-partners")
def business_partners(top: int = Query(20, le=100)):
    rows = get("API_BUSINESS_PARTNER", "A_BusinessPartner", {
        "$top": top,
        "$select": "BusinessPartner,BusinessPartnerFullName,BusinessPartnerCategory",
    })
    return [
        {"id": r["BusinessPartner"], "name": r["BusinessPartnerFullName"], "category": CATEGORY.get(r["BusinessPartnerCategory"], "Unbekannt")}
        for r in rows
    ]

def _first_address(pid: str):
    return get("API_BUSINESS_PARTNER", f"A_BusinessPartner('{pid}')/to_BusinessPartnerAddress", {
        "$top": 1,
        "$select": "AddressID,StreetName,HouseNumber,PostalCode,CityName,Country",
    })


@app.get("/api/business-partners/{pid}")
def business_partner_detail(pid: str):
    if not pid.isalnum():
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


@app.get("/api/sales-orders/summary")
def sales_orders_summary(top: int = Query(1000, le=5000)):
    rows = get("API_SALES_ORDER_SRV", "A_SalesOrder", {
        "$top": top,
        "$select": "TotalNetAmount,TransactionCurrency,CreationDate,SoldToParty",
    })
    by_month: dict[str, dict] = defaultdict(lambda: {"total": 0.0, "count": 0})
    by_customer: dict[str, float] = defaultdict(float)
    currency = rows[0]["TransactionCurrency"] if rows else "EUR"
    for r in rows:
        if r["TransactionCurrency"] != currency:
            continue  # keine Währungsumrechnung: nur die Hauptwährung zählen
        ms = int(re.search(r"\d+", r["CreationDate"]).group())
        month = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m")
        amount = float(r["TotalNetAmount"] or 0)
        by_month[month]["total"] += amount
        by_month[month]["count"] += 1
        by_customer[r["SoldToParty"]] += amount
    top_customers = sorted(by_customer.items(), key=lambda kv: kv[1], reverse=True)[:8]
    return {
        "currency": currency,
        "byMonth": [{"month": m, "total": round(v["total"], 2), "count": v["count"]} for m, v in sorted(by_month.items())],
        "byCustomer": [{"customer": c, "total": round(t, 2)} for c, t in top_customers],
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
    if not ids:
        return {}
    rows = get("API_BUSINESS_PARTNER", "A_BusinessPartner", {
        "$filter": _or("BusinessPartner", sorted(ids)),
        "$select": "BusinessPartner,BusinessPartnerFullName",
    })
    return {r["BusinessPartner"]: r["BusinessPartnerFullName"] for r in rows}


@app.get("/api/sales-orders")
def sales_orders(top: int = Query(30, le=100), status: str | None = None,
                 customer: str | None = Query(None, max_length=50)):
    filters = []
    if status:
        if status not in STATUS:
            raise HTTPException(400, "Ungültiger Status")
        filters.append(f"OverallSDProcessStatus eq '{status}'")
    if customer and customer.strip():
        ids = _customer_ids(customer.strip())
        if not ids:
            return []  # kein Kunde mit diesem Namen
        filters.append(_or("SoldToParty", ids))
    params = {
        "$top": top,
        "$orderby": "CreationDate desc",
        "$select": "SalesOrder,SoldToParty,TotalNetAmount,TransactionCurrency,CreationDate,OverallSDProcessStatus,DeliveryBlockReason",
    }
    if filters:
        params["$filter"] = " and ".join(filters)  # Filter läuft auf dem SAP-Server
    rows = get("API_SALES_ORDER_SRV", "A_SalesOrder", params)
    names = _customer_names({r["SoldToParty"] for r in rows})
    return [
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


@app.get("/api/sales-orders/{order_id}/items")
def sales_order_items(order_id: str):
    if not order_id.isalnum():
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
