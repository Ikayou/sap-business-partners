import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
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
  granularity: "day" | "month";
  byPeriod: { period: string; total: number; count: number }[];
  byCustomer: { customer: string; name: string; total: number }[];
  basis: number;
  total: number;
  limit: number;
  ignoredOtherCurrency: number;
};
type Order = {
  id: string; customer: string; customerName: string; date: string; amount: number; currency: string; status: string; blocked: boolean;
};
type OrderItem = {
  item: string; material: string; text: string; quantity: number; unit: string; amount: number; currency: string;
};
type OrdersPage = { items: Order[]; total: number; page: number; pageSize: number };
type Currency = { code: string; count: number };
type PeriodStats = {
  from: string; to: string; total: number; count: number; average: number; blocked: number; truncated: boolean;
};
type Kpi = {
  currency: string; days: number; current: PeriodStats; previous: PeriodStats; defaultPeriod: boolean;
};
type ProductSummary = {
  currency: string;
  items: { material: string; text: string; amount: number; lines: number; quantity: number | null; unit: string | null }[];
  basis: number;
  total: number;
  limit: number;
  ignoredOtherCurrency: number;
  sum: number;
};
type PartnerSearchResult = { items: BusinessPartner[]; total: number; limit: number };

/**
 * Gemeinsamer Zustand: Auftragsübersicht UND Auswertung lesen dieselben Filter.
 * Partner-Suche und Diagramm können sie setzen (Verknüpfung der drei Bereiche).
 */
type OrderFilters = {
  status: string;
  currency: string;
  dateFrom: string;
  dateTo: string;
  customerInput: string; // Eingabefeld (sofort)
  customer: string;      // Kundenname, entprellt (wird an SAP geschickt)
  customerId: string;    // exakter Kunde, z. B. aus Partner-Suche oder Diagramm
  customerLabel: string;
  page: number;
  selected: string | null; // geöffneter Auftrag
};
const INITIAL_FILTERS: OrderFilters = {
  status: "", currency: "", dateFrom: "", dateTo: "", customerInput: "", customer: "",
  customerId: "", customerLabel: "", page: 1, selected: null,
};
type SetFilters = Dispatch<SetStateAction<OrderFilters>>;

/** Filter, die Liste und Auswertung gemeinsam nutzen (ohne Seite/Auswahl). */
function filterQuery(f: OrderFilters) {
  const q = new URLSearchParams();
  if (f.status) q.set("status", f.status);
  if (f.currency) q.set("currency", f.currency);
  if (f.dateFrom) q.set("date_from", f.dateFrom);
  if (f.dateTo) q.set("date_to", f.dateTo);
  if (f.customer) q.set("customer", f.customer);
  if (f.customerId) q.set("customer_id", f.customerId);
  return q;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) {
    // Das Backend liefert bei SAP-Fehlern eine lesbare Meldung in "detail"
    const body = await res.json().catch(() => null);
    throw new Error(typeof body?.detail === "string" ? body.detail : `HTTP ${res.status}`);
  }
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

const fmt = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 0 });
const money = (n: number, cur: string) =>
  n.toLocaleString("de-DE", { style: "currency", currency: cur });

function PartnerDetail({ id, name, onShowOrders }: {
  id: string; name?: string; onShowOrders?: () => void;
}) {
  const { data, error, loading } = useFetch<Detail>(`/business-partners/${encodeURIComponent(id)}`);
  if (loading) return <div className="detail">Lädt...</div>;
  if (error) return <div className="detail error">Fehler: {error}</div>;
  if (!data) return null;
  const a = data.address;
  return (
    <div className="detail">
      <strong>Kunde / Partner: {name ? `${name} (${id})` : id}</strong>
      <div>
        Adresse:{" "}
        {a
          ? [a.street, [a.postalCode, a.city].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ")
          : "–"}
      </div>
      <div>E-Mail: {data.emails.length ? data.emails.join(", ") : "–"}</div>
      {onShowOrders && (
        <button className="link" onClick={onShowOrders}>Aufträge dieses Partners anzeigen →</button>
      )}
    </div>
  );
}

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

const PAGE_SIZE = 20;
const EXPORT_LIMIT = 5000; // wie EXPORT_LIMIT im Backend

function Orders({ f, setF }: { f: OrderFilters; setF: SetFilters }) {
  // Jede Filteränderung: zurück auf Seite 1 und Auswahl schließen
  const change = (patch: Partial<OrderFilters>) =>
    setF((p) => ({ ...p, ...patch, page: 1, selected: null }));

  // Debounce: erst 0,4 s nach der letzten Eingabe wird SAP abgefragt
  useEffect(() => {
    const t = setTimeout(() => {
      const value = f.customerInput.trim();
      setF((p) => (p.customer === value ? p : { ...p, customer: value, page: 1, selected: null }));
    }, 400);
    return () => clearTimeout(t);
  }, [f.customerInput, setF]);

  const query = filterQuery(f);
  query.set("page", String(f.page));
  query.set("page_size", String(PAGE_SIZE));
  const { data, error, loading } = useFetch<OrdersPage>(`/sales-orders?${query}`);

  const { data: currencies } = useFetch<Currency[]>("/currencies");
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const invalidRange = !!f.dateFrom && !!f.dateTo && f.dateFrom > f.dateTo;
  const selectedOrder = data?.items.find((o) => o.id === f.selected);

  return (
    <section className="card" id="orders">
      <h2>Auftragsübersicht</h2>
      <div className="toolbar wrap">
        <input
          type="search"
          placeholder="Nach Kundenname suchen (z. B. Specialty)..."
          value={f.customerInput}
          onChange={(e) => setF((p) => ({ ...p, customerInput: e.target.value }))}
        />
        <label>
          Von{" "}
          <input type="date" value={f.dateFrom} max={f.dateTo || undefined}
            onChange={(e) => change({ dateFrom: e.target.value })} />
        </label>
        <label>
          Bis{" "}
          <input type="date" value={f.dateTo} min={f.dateFrom || undefined}
            onChange={(e) => change({ dateTo: e.target.value })} />
        </label>
        <label>
          Status:{" "}
          <select value={f.status} onChange={(e) => change({ status: e.target.value })}>
            <option value="">Alle</option>
            <option value="A">Offen</option>
            <option value="B">In Bearbeitung</option>
            <option value="C">Abgeschlossen</option>
          </select>
        </label>
        <label>
          Währung:{" "}
          <select value={f.currency} onChange={(e) => change({ currency: e.target.value })}>
            <option value="">Alle</option>
            {currencies?.map((c) => (
              <option key={c.code} value={c.code}>{c.code} ({c.count.toLocaleString("de-DE")})</option>
            ))}
          </select>
        </label>
      </div>
      {f.customerId && (
        <div className="chip">
          Kunde: <strong>{f.customerLabel || f.customerId}</strong> ({f.customerId})
          <button aria-label="Kundenfilter entfernen" onClick={() => change({ customerId: "", customerLabel: "" })}>✕</button>
        </div>
      )}
      {invalidRange && <p className="status error">„Von“ liegt nach „Bis“.</p>}
      {loading && <p className="status">Lädt...</p>}
      {error && <p className="status error">Fehler: {error}</p>}
      {data && (
        <>
          <table>
            <thead>
              <tr><th>Auftrag</th><th>Datum</th><th>Kunde</th><th>Nettowert</th><th>Status</th></tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr
                  key={o.id}
                  className={o.id === f.selected ? "selected" : ""}
                  onClick={() => setF((p) => ({ ...p, selected: o.id === p.selected ? null : o.id }))}
                >
                  <td>{o.id}</td><td>{o.date}</td><td>{o.customerName || o.customer}</td>
                  <td>{money(o.amount, o.currency)}</td>
                  <td>
                    <span className="badge">{o.status}</span>
                    {o.blocked && <span className="badge blocked">Liefersperre</span>}
                  </td>
                </tr>
              ))}
              {data.items.length === 0 && <tr><td colSpan={5} className="status">Keine Aufträge</td></tr>}
            </tbody>
          </table>
          <div className="pager">
            <button onClick={() => setF((p) => ({ ...p, page: p.page - 1, selected: null }))} disabled={f.page <= 1}>← Zurück</button>
            <span>
              Seite {f.page.toLocaleString("de-DE")} von {totalPages.toLocaleString("de-DE")}
              {" "}({data.total.toLocaleString("de-DE")} Aufträge)
            </span>
            <button onClick={() => setF((p) => ({ ...p, page: p.page + 1, selected: null }))} disabled={f.page >= totalPages}>Weiter →</button>
          </div>
          {data.total > 0 && (
            <p className="export">
              <a className="btn" href={`${API}/sales-orders/export.csv?${filterQuery(f)}`}>⬇ CSV exportieren</a>
              <span className="hint">
                {data.total > EXPORT_LIMIT
                  ? `die neuesten ${EXPORT_LIMIT.toLocaleString("de-DE")} von ${data.total.toLocaleString("de-DE")} Aufträgen (aktuelle Filter)`
                  : `${data.total.toLocaleString("de-DE")} Aufträge (aktuelle Filter)`}
              </span>
            </p>
          )}
        </>
      )}
      {selectedOrder && (
        <>
          <OrderItems key={selectedOrder.id} id={selectedOrder.id} />
          {/* Verknüpfung: Auftrag -> Kunde (Adresse, E-Mail) */}
          <PartnerDetail
            key={selectedOrder.customer}
            id={selectedOrder.customer}
            name={selectedOrder.customerName}
            onShowOrders={f.customerId === selectedOrder.customer ? undefined : () =>
              change({ customerId: selectedOrder.customer, customerLabel: selectedOrder.customerName, customer: "", customerInput: "" })}
          />
        </>
      )}
    </section>
  );
}

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

function presets(): { label: string; from: string; to: string }[] {
  const today = new Date();
  const daysAgo = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
  const firstThis = new Date(today.getFullYear(), today.getMonth(), 1);
  const firstLast = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastLast = new Date(today.getFullYear(), today.getMonth(), 0);
  return [
    { label: "Letzte 7 Tage", from: isoDay(daysAgo(6)), to: isoDay(today) },
    { label: "Letzte 30 Tage", from: isoDay(daysAgo(29)), to: isoDay(today) },
    { label: "Dieser Monat", from: isoDay(firstThis), to: isoDay(today) },
    { label: "Letzter Monat", from: isoDay(firstLast), to: isoDay(lastLast) },
  ];
}

/** Veränderung zur Vorperiode. goodWhenUp=false: mehr ist schlechter (z. B. Liefersperren). */
function Delta({ cur, prev, goodWhenUp = true }: { cur: number; prev: number; goodWhenUp?: boolean }) {
  if (prev === 0) return <span className="delta flat">{cur === 0 ? "keine Veränderung" : "Vorperiode: 0"}</span>;
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.05) return <span className="delta flat">± 0 % ggü. Vorperiode</span>;
  const good = pct > 0 === goodWhenUp;
  return (
    <span className={`delta ${good ? "good" : "bad"}`}>
      {pct > 0 ? "▲" : "▼"} {Math.abs(pct).toLocaleString("de-DE", { maximumFractionDigits: 1 })} % ggü. Vorperiode
    </span>
  );
}

function Kpis({ f, setF }: { f: OrderFilters; setF: SetFilters }) {
  const { data, error, loading } = useFetch<Kpi>(`/sales-orders/kpi?${filterQuery(f)}`);
  const applyPreset = (from: string, to: string) =>
    setF((p) => ({ ...p, dateFrom: from, dateTo: to, page: 1, selected: null }));
  const partial = !!data && (data.current.truncated || data.previous.truncated);

  return (
    <section className="card">
      <h2>Kennzahlen{data?.currency ? ` (${data.currency})` : ""}</h2>
      <div className="presets">
        {presets().map((p) => (
          <button key={p.label} className={f.dateFrom === p.from && f.dateTo === p.to ? "active" : ""}
            onClick={() => applyPreset(p.from, p.to)}>{p.label}</button>
        ))}
        <button className={!f.dateFrom && !f.dateTo ? "active" : ""} onClick={() => applyPreset("", "")}>
          Standard (30 Tage)
        </button>
      </div>
      {loading && <p className="status">Lädt...</p>}
      {error && <p className="status error">Fehler: {error}</p>}
      {data && (
        <>
          <p className="hint">
            Zeitraum {shortDate(data.current.from)} – {shortDate(data.current.to)} ({data.days} Tage)
            im Vergleich zu {shortDate(data.previous.from)} – {shortDate(data.previous.to)}. Gilt für dieselben Filter wie oben.
          </p>
          <div className="kpis">
            <div className="kpi">
              <span className="label">Nettowert{partial ? " (Teilsumme)" : ""}</span>
              <strong>{money(data.current.total, data.currency || "USD")}</strong>
              {partial ? <span className="delta flat">Vergleich nicht möglich</span>
                : <Delta cur={data.current.total} prev={data.previous.total} />}
            </div>
            <div className="kpi">
              <span className="label">Aufträge</span>
              <strong>{fmt(data.current.count)}</strong>
              <Delta cur={data.current.count} prev={data.previous.count} />
            </div>
            <div className="kpi">
              <span className="label">Ø Auftragswert{partial ? " (Teilsumme)" : ""}</span>
              <strong>{money(data.current.average, data.currency || "USD")}</strong>
              {partial ? <span className="delta flat">Vergleich nicht möglich</span>
                : <Delta cur={data.current.average} prev={data.previous.average} />}
            </div>
            <div className="kpi">
              <span className="label">Mit Liefersperre</span>
              <strong>{fmt(data.current.blocked)}</strong>
              <Delta cur={data.current.blocked} prev={data.previous.blocked} goodWhenUp={false} />
            </div>
          </div>
          {partial && (
            <p className="hint">
              Der Zeitraum enthält mehr als {fmt(5000)} Aufträge: Nettowert und Durchschnitt beruhen nur auf den neuesten {fmt(5000)}.
              Die Anzahlen sind exakt. Für genaue Werte den Zeitraum verkürzen.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function SalesCharts({ f, onPickCustomer }: {
  f: OrderFilters; onPickCustomer: (id: string, name: string) => void;
}) {
  // Gleiche Filter wie die Auftragsübersicht -> gleiche Aufträge
  const { data, error, loading } = useFetch<Summary>(`/sales-orders/summary?${filterQuery(f)}`);
  return (
    <section className="card">
      <h2>Auswertung{data?.currency ? ` (${data.currency})` : ""}</h2>
      <p className="hint">Gilt für dieselben Filter wie die Auftragsübersicht.</p>
      {loading && <p className="status">Lädt...</p>}
      {error && <p className="status error">Fehler: {error}</p>}
      {data && data.basis === 0 && <p className="status">Keine Aufträge für diese Filter.</p>}
      {data && data.basis > 0 && (
        <>
          <p className="hint">
            {data.total > data.basis + data.ignoredOtherCurrency
              ? `Basis: die neuesten ${fmt(data.basis)} von ${fmt(data.total)} Aufträgen – Zeitraum oder Kunde eingrenzen für genauere Werte.`
              : `Basis: alle ${fmt(data.basis)} Aufträge.`}
            {data.ignoredOtherCurrency > 0 && ` ${fmt(data.ignoredOtherCurrency)} Aufträge in anderer Währung wurden nicht mitgezählt.`}
          </p>
          <div className="charts">
            <div>
              <h3>Nettowert pro {data.granularity === "day" ? "Tag" : "Monat"}</h3>
              <div className="chart-box">
                <ResponsiveContainer>
                  <LineChart data={data.byPeriod}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={fmt} width={80} />
                    <Tooltip formatter={(v) => fmt(Number(v))} />
                    <Line type="monotone" dataKey="total" name="Nettowert" stroke="#0a6ed1" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div>
              <h3>Top-Kunden nach Nettowert <span className="hint">(Balken anklicken = Aufträge des Kunden)</span></h3>
              <div className="chart-box">
                <ResponsiveContainer>
                  <BarChart data={data.byCustomer} layout="vertical" margin={{ left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" tickFormatter={fmt} />
                    <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => fmt(Number(v))} />
                    <Bar
                      dataKey="total"
                      name="Nettowert"
                      fill="#0a6ed1"
                      style={{ cursor: "pointer" }}
                      onClick={(_, i) => {
                        const c = data.byCustomer[i];
                        if (c) onPickCustomer(c.customer, c.name);
                      }}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function Products({ f }: { f: OrderFilters }) {
  // Gleiche Filter wie Liste und Auswertung (Positionen der passenden Aufträge)
  const { data, error, loading } = useFetch<ProductSummary>(`/sales-orders/products?${filterQuery(f)}`);
  const max = data?.items[0]?.amount || 1;
  return (
    <section className="card">
      <h2>Umsatz nach Produkt{data?.currency ? ` (${data.currency})` : ""}</h2>
      <p className="hint">Top 10 Materialien nach Nettowert, aus den Auftragspositionen. Gilt für dieselben Filter wie oben.</p>
      {loading && <p className="status">Lädt...</p>}
      {error && <p className="status error">Fehler: {error}</p>}
      {data && data.basis === 0 && <p className="status">Keine Positionen für diese Filter.</p>}
      {data && data.basis > 0 && (
        <>
          <p className="hint">
            {data.total > data.basis + data.ignoredOtherCurrency
              ? `Basis: die neuesten ${fmt(data.basis)} von ${fmt(data.total)} Positionen.`
              : `Basis: alle ${fmt(data.basis)} Positionen.`}
            {data.ignoredOtherCurrency > 0 && ` ${fmt(data.ignoredOtherCurrency)} Positionen in anderer Währung wurden nicht mitgezählt.`}
          </p>
          <table className="products">
            <thead>
              <tr><th>#</th><th>Produkt</th><th>Positionen</th><th>Menge</th><th>Nettowert</th><th>Anteil</th></tr>
            </thead>
            <tbody>
              {data.items.map((p, i) => (
                <tr key={p.material} style={{ cursor: "default" }}>
                  <td>{i + 1}</td>
                  <td>{p.text || p.material} <span className="hint">{p.material}</span></td>
                  <td>{fmt(p.lines)}</td>
                  <td>{p.quantity !== null ? `${fmt(p.quantity)} ${p.unit}` : "–"}</td>
                  <td>{money(p.amount, data.currency)}</td>
                  <td>
                    <div className="share">
                      <span className="bar" style={{ width: `${(p.amount / max) * 100}%` }} />
                      <span>{((p.amount / data.sum) * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} %</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function PartnerResults({ term, onShowOrders }: {
  term: string; onShowOrders: (id: string, name: string) => void;
}) {
  const { data, error, loading } = useFetch<PartnerSearchResult>(
    `/business-partners?q=${encodeURIComponent(term)}`,
  );
  const [selected, setSelected] = useState<string | null>(null);

  if (loading) return <p className="status">Lädt...</p>;
  if (error) return <p className="status error">Fehler: {error}</p>;
  if (!data) return null;
  const selectedPartner = data.items.find((r) => r.id === selected);
  return (
    <>
      <p className="count">
        {data.total === 0
          ? "Keine Treffer"
          : data.total > data.items.length
            ? `${data.items.length} von ${data.total.toLocaleString("de-DE")} Treffern – bitte Suche verfeinern`
            : `${data.total} Treffer`}
      </p>
      {data.items.length > 0 && (
        <table>
          <thead>
            <tr><th>ID</th><th>Name</th><th>Kategorie</th></tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
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
          </tbody>
        </table>
      )}
      {selectedPartner && (
        <PartnerDetail
          key={selectedPartner.id}
          id={selectedPartner.id}
          name={selectedPartner.name}
          onShowOrders={() => onShowOrders(selectedPartner.id, selectedPartner.name)}
        />
      )}
    </>
  );
}

function PartnerSearch({ onShowOrders }: { onShowOrders: (id: string, name: string) => void }) {
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");

  // Debounce: erst 0,4 s nach der letzten Eingabe wird SAP abgefragt
  useEffect(() => {
    const t = setTimeout(() => setTerm(input.trim()), 400);
    return () => clearTimeout(t);
  }, [input]);

  return (
    <section className="card">
      <h2>Geschäftspartner</h2>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Name oder Nummer eingeben (z. B. Bank oder 1000160)..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </div>
      {term ? (
        <PartnerResults term={term} onShowOrders={onShowOrders} />
      ) : (
        <p className="status">Geben Sie einen Namen oder eine Partnernummer ein, um Geschäftspartner zu suchen.</p>
      )}
    </section>
  );
}

export default function App() {
  const [f, setF] = useState<OrderFilters>(INITIAL_FILTERS);

  // Aus Partner-Suche oder Diagramm: Aufträge dieses Kunden zeigen
  const showOrdersOf = (id: string, name: string) => {
    setF((p) => ({
      ...p, customerId: id, customerLabel: name, customer: "", customerInput: "", page: 1, selected: null,
    }));
    document.getElementById("orders")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <main className="app">
      <h1>SAP Business Partners</h1>
      <p className="subtitle">React · FastAPI · SAP S/4HANA Cloud (OData)</p>
      <PartnerSearch onShowOrders={showOrdersOf} />
      <Orders f={f} setF={setF} />
      <Kpis f={f} setF={setF} />
      <SalesCharts f={f} onPickCustomer={showOrdersOf} />
      <Products f={f} />
    </main>
  );
}
