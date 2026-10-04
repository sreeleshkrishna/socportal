import { useEffect, useState } from 'react';
import { api } from './api';
import { keycloak } from './keycloak';

interface CaseRow {
  id: string; case_number: string; title: string; severity: string; status: string;
  assigned_to: string | null; source: string; alert_count?: number; created_at: string;
}
interface Detail extends CaseRow {
  description: string;
  notes: { id: string; body: string; author: string | null; created_at: string }[];
  events: { id: number; type: string; actor: string | null; detail: Record<string, unknown>; created_at: string }[];
  alerts?: { id: string; source: string; rule_name: string; severity: string; host: string | null; src_ip: string | null; received_at: string }[];
  allowedTransitions: { to: string; requires: 'reason' | 'summary' | null }[];
}

const th = { textAlign: 'left' as const, borderBottom: '1px solid #ccc', padding: 4 };
const td = { padding: 4, borderBottom: '1px solid #eee' };

export default function App() {
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [sel, setSel] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ title: '', severity: 'medium', description: '' });
  const [note, setNote] = useState('');

  const run = async (fn: () => Promise<void>) => {
    try { setErr(''); await fn(); } catch (e) { setErr((e as Error).message); }
  };
  const loadList = async () => setCases((await api<{ cases: CaseRow[] }>('/api/cases')).cases);
  const open = async (id: string) => setSel(await api<Detail>(`/api/cases/${id}`));

  useEffect(() => {
    void run(loadList);
    const t = setInterval(() => void run(loadList), 5000); // new SIEM cases appear on their own
    return () => clearInterval(t);
  }, []);

  const create = () => run(async () => {
    await api('/api/cases', 'POST', { ...form, description: form.description || undefined });
    setForm({ title: '', severity: 'medium', description: '' });
    await loadList();
  });

  const move = (t: { to: string; requires: 'reason' | 'summary' | null }) => run(async () => {
    const body: Record<string, string> = { to: t.to };
    if (t.requires) {
      const v = window.prompt(`Enter ${t.requires} for ${t.to}`);
      if (!v) return;
      body[t.requires] = v;
    }
    await api(`/api/cases/${sel!.id}/transition`, 'POST', body);
    await open(sel!.id);
    await loadList();
  });

  const addNote = () => run(async () => {
    await api(`/api/cases/${sel!.id}/notes`, 'POST', { body: note });
    setNote('');
    await open(sel!.id);
  });

  return (
    <div style={{ fontFamily: 'sans-serif', padding: 24 }}>
      <h1>SOC Case Management Portal</h1>
      <p>
        {keycloak.tokenParsed?.preferred_username}{' '}
        <button onClick={() => keycloak.logout({ redirectUri: window.location.origin })}>Log out</button>
      </p>
      {err && <p style={{ color: 'crimson' }}>{err}</p>}

      <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <h3>New case</h3>
          <input placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />{' '}
          <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
            {['low', 'medium', 'high', 'critical'].map((s) => <option key={s}>{s}</option>)}
          </select>{' '}
          <button onClick={create}>Create</button>

          <h3>Cases</h3>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr><th style={th}>#</th><th style={th}>Title</th><th style={th}>Sev</th><th style={th}>Status</th><th style={th}>Src</th></tr></thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id} onClick={() => void run(() => open(c.id))} style={{ cursor: 'pointer' }}>
                  <td style={td}>{c.case_number}</td><td style={td}>{c.title}</td>
                  <td style={td}>{c.severity}</td><td style={td}>{c.status}</td>
                  <td style={td}>{c.source}{c.alert_count ? ` x${c.alert_count}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {sel && (
          <div style={{ flex: 1 }}>
            <h3>#{sel.case_number} {sel.title}</h3>
            <p>{sel.severity} / <b>{sel.status}</b> / {sel.source}</p>
            <p>{sel.description}</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {sel.allowedTransitions.map((t) => <button key={t.to} onClick={() => void move(t)}>{t.to}</button>)}
            </div>

            {!!sel.alerts?.length && (<>
              <h4>Alerts ({sel.alerts.length})</h4>
              <ul>{sel.alerts.map((a) => (
                <li key={a.id}>{a.received_at.slice(11, 19)} [{a.source}] {a.rule_name} {a.host} {a.src_ip}</li>
              ))}</ul>
            </>)}

            <h4>Notes</h4>
            <ul>{sel.notes.map((n) => <li key={n.id}><b>{n.author}</b>: {n.body}</li>)}</ul>
            <input placeholder="Add note" value={note} onChange={(e) => setNote(e.target.value)} />{' '}
            <button onClick={addNote}>Add</button>

            <h4>Timeline</h4>
            <ul>{sel.events.map((e) => (
              <li key={e.id}>{e.created_at.slice(11, 19)} {e.actor ?? 'system'}: {e.type} {JSON.stringify(e.detail)}</li>
            ))}</ul>
          </div>
        )}
      </div>
    </div>
  );
}