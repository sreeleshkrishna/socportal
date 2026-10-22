import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Icon, friendly, statusLabel, type Notify } from './ui';

interface SlaStat { met: number; missed: number; compliancePercent: number | null }
interface Dash {
  periodDays: number;
  generatedAt: string;
  kpis: {
    created: number; resolved: number; mttrSeconds: number | null; mttaSeconds: number | null;
    mttdSeconds: number | null; mttdSamples: number;
  };
  sla: { respond: SlaStat; resolve: SlaStat };
  backlog: {
    open: number; unassigned: number; overdue: number; oldestSeconds: number | null;
    byStatus: { status: string; count: number }[];
    bySeverity: { severity: string; count: number }[];
  };
  workload: { username: string; open: number; openHigh: number; overdue: number; resolvedInPeriod: number }[];
  trend: { day: string; created: number; resolved: number }[];
  topTechniques: { id: string; name: string; count: number }[];
}

const dur = (s: number | null) => {
  if (s === null) return '-';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`;
};
const pct = (s: SlaStat) => (s.compliancePercent === null ? '-' : `${s.compliancePercent}%`);
const tone = (s: SlaStat) =>
  s.compliancePercent === null ? '' : s.compliancePercent >= 90 ? 'stat--ok' : s.compliancePercent >= 70 ? 'stat--warn' : 'stat--bad';

function Stat({ label, value, sub, cls = '' }: { label: string; value: string | number; sub?: string; cls?: string }) {
  return (
    <div className={`stat ${cls}`}>
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      {sub && <div className="stat__sub">{sub}</div>}
    </div>
  );
}

function Bars({ rows, bad = false }: { rows: { label: string; count: number }[]; bad?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="bars">
      {rows.map((r) => (
        <div key={r.label} className={`bar-row${bad ? ' bar-row--bad' : ''}`}>
          <span className="bar-row__label" title={r.label}>{r.label}</span>
          <span className="bar-row__track"><i style={{ width: `${(r.count / max) * 100}%` }} /></span>
          <span>{r.count}</span>
        </div>
      ))}
    </div>
  );
}

function Trend({ data }: { data: Dash['trend'] }) {
  const max = Math.max(1, ...data.flatMap((d) => [d.created, d.resolved]));
  const w = 640, h = 110, step = w / Math.max(1, data.length), bw = Math.max(1, step / 2 - 1);
  return (
    <svg className="trend" viewBox={`0 0 ${w} ${h + 16}`} role="img" aria-label="Cases created and resolved per day">
      {data.map((d, i) => (
        <g key={d.day}>
          <title>{`${d.day}: ${d.created} created, ${d.resolved} resolved`}</title>
          <rect className="created" x={i * step} y={h - (d.created / max) * h} width={bw} height={(d.created / max) * h} />
          <rect className="resolved" x={i * step + bw + 1} y={h - (d.resolved / max) * h} width={bw} height={(d.resolved / max) * h} />
        </g>
      ))}
      <text x={0} y={h + 12}>{data[0]?.day}</text>
      <text x={w} y={h + 12} textAnchor="end">{data[data.length - 1]?.day}</text>
    </svg>
  );
}

export default function Dashboard({ notify }: { notify: Notify }) {
  const [days, setDays] = useState(30);
  const [d, setD] = useState<Dash | null>(null);

  const load = useCallback(async () => {
    try { setD(await api<Dash>(`/api/dashboard?days=${days}`)); } catch (e) { notify('error', friendly(e)); }
  }, [days, notify]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="page">
      <div className="page__head">
        <h2>Performance of the last {days} days</h2>
        <div className="page__tools">
          <label>
            <span className="sr">Period</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 30, 90].map((n) => <option key={n} value={n}>Last {n} days</option>)}
            </select>
          </label>
          <button type="button" className="btn" onClick={() => void load()}><Icon name="refresh" size={16} /> Refresh</button>
        </div>
      </div>

      {!d && <p className="muted">Loading figures…</p>}
      {d && (
        <>
          <div className="stats">
            <Stat label="Cases created" value={d.kpis.created} sub={`${d.kpis.resolved} resolved`} />
            <Stat label="Open backlog" value={d.backlog.open} sub={`${d.backlog.unassigned} unassigned`} />
            <Stat label="Overdue" value={d.backlog.overdue} cls={d.backlog.overdue ? 'stat--bad' : ''}
              sub={`oldest open case ${dur(d.backlog.oldestSeconds)}`} />
            <Stat label="Time to detect" value={dur(d.kpis.mttdSeconds)} sub={`${d.kpis.mttdSamples} SIEM case${d.kpis.mttdSamples === 1 ? '' : 's'}`} />
            <Stat label="Time to respond" value={dur(d.kpis.mttaSeconds)} sub="average" />
            <Stat label="Time to resolve" value={dur(d.kpis.mttrSeconds)} sub="average" />
            <Stat label="SLA respond" value={pct(d.sla.respond)} cls={tone(d.sla.respond)}
              sub={`${d.sla.respond.met} met, ${d.sla.respond.missed} missed`} />
            <Stat label="SLA resolve" value={pct(d.sla.resolve)} cls={tone(d.sla.resolve)}
              sub={`${d.sla.resolve.met} met, ${d.sla.resolve.missed} missed`} />
          </div>

          <div className="grid3">
            <section className="section">
              <h3>Open cases by status</h3>
              <Bars rows={d.backlog.byStatus.map((s) => ({ label: statusLabel(s.status), count: s.count }))} />
            </section>
            <section className="section">
              <h3>Open cases by severity</h3>
              <Bars bad rows={d.backlog.bySeverity.map((s) => ({ label: s.severity, count: s.count }))} />
            </section>
            <section className="section">
              <h3>Most tagged ATT&amp;CK techniques</h3>
              {d.topTechniques.length === 0
                ? <p className="muted">No techniques have been tagged in this period.</p>
                : <Bars rows={d.topTechniques.map((t) => ({ label: `${t.id} ${t.name}`, count: t.count }))} />}
            </section>
          </div>

          <section className="section">
            <h3>Workload per analyst</h3>
            {d.workload.length === 0
              ? <p className="muted">No cases are assigned yet.</p>
              : (
                <div className="scroll-x">
                  <table className="mini">
                    <thead><tr><th>Analyst</th><th>Open</th><th>High or critical</th><th>Overdue</th><th>Resolved in period</th></tr></thead>
                    <tbody>
                      {d.workload.map((w) => (
                        <tr key={w.username}>
                          <td>{w.username}</td><td>{w.open}</td><td>{w.openHigh}</td>
                          <td className={w.overdue ? 'warn-text' : ''}>{w.overdue}</td><td>{w.resolvedInPeriod}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </section>

          <section className="section">
            <h3>Cases created and resolved per day</h3>
            <Trend data={d.trend} />
            <div className="legend">
              <span><i className="swatch" style={{ background: 'var(--accent)' }} />Created</span>
              <span><i className="swatch" style={{ background: 'var(--ok)' }} />Resolved</span>
            </div>
          </section>
        </>
      )}
    </div>
  );
}