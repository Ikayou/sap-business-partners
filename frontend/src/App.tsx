import { useEffect, useMemo, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

const API = "http://localhost:8000/api";

type BusinessPartner = { id: string; name: string; category: string };
type Detail = {
  address: { street: string; postalCode: string; city: string; country: string } | null;
  emails: string[];
};
type Summary = {
  currency: string;
  byMonth: { month: string; total: number; count: number }[];
  byCustomer: { customer: string; total: number }[];
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function useFetch<T>(path: string) {
  const [state, setState] = useState<{ path: string | null; data?: T; error?: string }>({ path: null });
  useEffect(() => {
    let cancelled = false;
    getJson<T>(path)
      .then((data) => !cancelled && setState({ path, data }))
      .catch((e: Error) => !cancelled && setState({ path, error: e.message }));
    return () => { cancelled = true; };
  }, [path]);
  const ready = state.path === path;
  return {
    data: ready ? state.data : undefined,
    error: ready ? state.error : undefined,
    loading: !ready,
  };
}

function PartnerDetail({ id }: { id: string }) {
  const { data, error, loading } = useFetch<Detail>(`/business-partners/${encodeURIComponent(id)}`);
  if (loading) return <div className="detail">Lädt...</div>;
  if (error) return <div className="detail error">Fehler: {error}</div>;
  if (!data) return null;
  const a = data.address;
  return (
    <div className="detail">
      <strong>Details zu Partner {id}</strong>
      <div>
        Adresse:{" "}
        {a
          ? [a.street, [a.postalCode, a.city].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ")
          : "–"}
      </div>
      <div>E-Mail: {data.emails.length ? data.emails.join(", ") : "–"}</div>
    </div>
  );
}

const fmt = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 0 });

function SalesCharts() {
  const { data, error, loading } = useFetch<Summary>("/sales-orders/summary");
  return (
    <section className="card">
      <h2>Aufträge{data ? ` (${data.currency})` : ""}</h2>
      {loading && <p className="status">Lädt...</p>}
      {error && <p className="status error">Fehler: {error}</p>}
      {data && (
        <div className="charts">
          <div>
            <h3>Nettowert pro Monat</h3>
            <div className="chart-box">
              <ResponsiveContainer>
                <LineChart data={data.byMonth}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="month" />
                  <YAxis tickFormatter={fmt} width={80} />
                  <Tooltip formatter={(v) => fmt(Number(v))} />
                  <Line type="monotone" dataKey="total" name="Nettowert" stroke="#0a6ed1" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div>
            <h3>Top-Kunden nach Nettowert</h3>
            <div className="chart-box">
              <ResponsiveContainer>
                <BarChart data={data.byCustomer}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="customer" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={fmt} width={80} />
                  <Tooltip formatter={(v) => fmt(Number(v))} />
                  <Bar dataKey="total" name="Nettowert" fill="#0a6ed1" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

type Order = {
  id: string; customer: string; customerName: string; date: string; amount: number; currency: string; status: string; blocked: boolean;
};
type OrderItem = {
  item: string; material: string; text: string; quantity: number; unit: string; amount: number; currency: string;
};

const money = (n: number, cur: string) =>
  n.toLocaleString("de-DE", { style: "currency", currency: cur });

function OrderItems({ id }: { id: string }) {
  const { data, error, loading } = useFetch<OrderItem[]>(`/sales-orders/${encodeURIComponent(id)}/items`);
  if (loading) return <div className="detail">Lädt...</div>;
  if (error) return <div className="detail error">Fehler: {error}</div>;
  if (!data?.length) return <div className="detail">Keine Positionen</div>;
  return (
    <div className="detail">
      <strong>Positionen zu Auftrag {id}</strong>
      <table>
        <thead>
          <tr><th>Pos.</th><th>Material</th><th>Bezeichnung</th><th>Menge</th><th>Nettowert</th></tr>
        </thead>
        <tbody>
          {data.map((i) => (
            <tr key={i.item} style={{ cursor: "default" }}>
              <td>{i.item}</td><td>{i.material}</td><td>{i.text}</td>
              <td>{i.quantity} {i.unit}</td><td>{money(i.amount, i.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Orders() {
  const [status, setStatus] = useState("");
  const [customerInput, setCustomerInput] = useState("");
  const [customer, setCustomer] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  // Debounce: erst 0,4 s nach der letzten Eingabe wird SAP abgefragt
  useEffect(() => {
    const t = setTimeout(() => { setCustomer(customerInput.trim()); setSelected(null); }, 400);
    return () => clearTimeout(t);
  }, [customerInput]);

  const query = new URLSearchParams({ top: "30" });
  if (status) query.set("status", status);
  if (customer) query.set("customer", customer);
  const { data, error, loading } = useFetch<Order[]>(`/sales-orders?${query}`);

  return (
    <section className="card">
      <h2>Auftragsübersicht (neueste 30)</h2>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Nach Kundenname suchen (z. B. Specialty)..."
          value={customerInput}
          onChange={(e) => setCustomerInput(e.target.value)}
        />
        <label>
          Status:{" "}
          <select value={status} onChange={(e) => { setStatus(e.target.value); setSelected(null); }}>
            <option value="">Alle</option>
            <option value="A">Offen</option>
            <option value="B">In Bearbeitung</option>
            <option value="C">Abgeschlossen</option>
          </select>
        </label>
      </div>
      {loading && <p className="status">Lädt...</p>}
      {error && <p className="status error">Fehler: {error}</p>}
      {data && (
        <table>
          <thead>
            <tr><th>Auftrag</th><th>Datum</th><th>Kunde</th><th>Nettowert</th><th>Status</th></tr>
          </thead>
          <tbody>
            {data.map((o) => (
              <tr
                key={o.id}
                className={o.id === selected ? "selected" : ""}
                onClick={() => setSelected(o.id === selected ? null : o.id)}
              >
                <td>{o.id}</td><td>{o.date}</td><td>{o.customerName || o.customer}</td>
                <td>{money(o.amount, o.currency)}</td>
                <td>
                  <span className="badge">{o.status}</span>
                  {o.blocked && <span className="badge blocked">Liefersperre</span>}
                </td>
              </tr>
            ))}
            {data.length === 0 && <tr><td colSpan={5} className="status">Keine Aufträge</td></tr>}
          </tbody>
        </table>
      )}
      {selected && <OrderItems key={selected} id={selected} />}
    </section>
  );
}

export default function App() {
  const { data, error, loading } = useFetch<BusinessPartner[]>("/business-partners?top=100");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const rows = data ?? [];
    const q = query.trim().toLowerCase();
    return q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.id.includes(q)) : rows;
  }, [data, query]);

  return (
    <main className="app">
      <h1>SAP Business Partners</h1>
      <p className="subtitle">React · FastAPI · SAP S/4HANA Cloud (OData)</p>

      <section className="card">
        <h2>Geschäftspartner</h2>
        <div className="toolbar">
          <input
            type="search"
            placeholder="Nach Name oder ID suchen..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="count">{filtered.length} Treffer</span>
        </div>
        {loading && <p className="status">Lädt...</p>}
        {error && <p className="status error">Fehler: {error}</p>}
        {data && (
          <table>
            <thead>
              <tr><th>ID</th><th>Name</th><th>Kategorie</th></tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className={r.id === selected ? "selected" : ""}
                  onClick={() => setSelected(r.id === selected ? null : r.id)}
                >
                  <td>{r.id}</td>
                  <td>{r.name}</td>
                  <td><span className="badge">{r.category}</span></td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={3} className="status">Keine Treffer</td></tr>
              )}
            </tbody>
          </table>
        )}
        {selected && <PartnerDetail key={selected} id={selected} />}
      </section>

      <Orders />
      <SalesCharts />
    </main>
  );
}
