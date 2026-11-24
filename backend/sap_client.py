import os, requests
from dotenv import load_dotenv

load_dotenv()
BASE = "https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap"
HEADERS = {"APIKey": os.environ["SAP_API_KEY"], "Accept": "application/json"}

def get(service: str, entity: str, params: dict | None = None) -> list[dict]:
    res = requests.get(f"{BASE}/{service}/{entity}", headers=HEADERS, params=params, timeout=30)
    res.raise_for_status()
    return res.json()["d"]["results"]