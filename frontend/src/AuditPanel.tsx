import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { CopyButton, Icon, clock, friendly, type Notify } from './ui';

interface Entry {
  seq: string; at: string; actor_name: string; action: string;
  entity: string | null; entity_id: string | null; detail: Record<string, unknown>;
}
interface Verify {
  valid: boolean; checked: number; head: { seq: string; hash: string } | null;
  brokenAtSeq?: string; reason?: string;
}

const SUGGESTIONS = [
  'case.transition', 'case.create', 'evidence.upload', 'evidence.verify_failed', 'sla.breach',
  'alert.case_created', 'report.export', 'ioc.removed',
];

export default function AuditPanel({ notify }: { notify: Notify }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState('');
  const [result, setResult] = useState<Verify | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ limit: '100' });
    if (applied) p.set('action', applied);
    setEntries((await api<{ entries: Entry[] }>(`/api/audit?${p.toString()}`)).entries);
  }, [applied]);

  useEffect(() => { load().catch((e) => notify('error', friendly(e))); }, [load, notify]);

  const verify = async () => {
    setBusy(true);
    try { setResult(await api<Verify>('/api/audit/verify')); }
    catch (e) { notify('error', friendly(e)); }
    finally { setBusy(false); }
  };

  const filter = (e: FormEvent) => { e.preventDefault(); setApplied(action.trim()); };

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2>Audit log</h2>
          <p className="muted">Every record is chained to the one before it, so any edit or deletion is detected.</p>
        </div>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void verify()}>
          <Icon name="check" size={16} /> Verify chain
        </button>
      </div>

      {result && (
        <div className={`banner banner--${result.valid ? 'ok' : 'bad'}`} role="status">
          {result.valid ? (
            <>
              <strong>Chain verified.</strong>
              <span>{result.checked} records checked.</span>
              {result.head && (
                <>
                  <span>Latest record hash <code className="mono">{result.head.hash.slice(0, 20)}…</code></span>
                  <CopyButton text={result.head.hash} label="Copy hash" />
                </>
              )}
            </>
          ) : (
            <>
              <strong>The chain is broken at record {result.brokenAtSeq}.</strong>
              <span>{result.reason}</span>
            </>
          )}
        </div>
      )}

      <form className="inline-form" onSubmit={filter}>
        <label className="field field--grow">
          <span className="sr">Filter by action</span>
          <input type="text" list="audit-actions" value={action} onChange={(e) => setAction(e.target.value)}
            placeholder="Filter by action, for example case.transition" />
          <datalist id="audit-actions">{SUGGESTIONS.map((s) => <option key={s} value={s} />)}</datalist>
        </label>
        <button type="submit" className="btn">Apply filter</button>
        {applied && <button type="button" className="btn btn--quiet" onClick={() => { setAction(''); setApplied(''); }}>Clear</button>}
      </form>

      {entries === null && <p className="muted">Loading the audit log…</p>}
      {entries?.length === 0 && <p className="muted">No records match.</p>}
      {entries && entries.length > 0 && (
        <div className="scroll-x">
          <table className="mini">
            <thead><tr><th>Record</th><th>Time</th><th>Who</th><th>Action</th><th>Item</th><th>Result</th></tr></thead>
            <tbody>
              {entries.map((e) => {
                const outcome = String(e.detail.outcome ?? '');
                return (
                  <tr key={e.seq}>
                    <td className="mono">{e.seq}</td>
                    <td>{clock(e.at)}</td>
                    <td>{e.actor_name}</td>
                    <td className="mono">{e.action}</td>
                    <td>{e.entity ? `${e.entity} ${e.entity_id?.slice(0, 8) ?? ''}` : '-'}</td>
                    <td className={outcome && outcome !== 'ok' ? 'warn-text' : ''}>{outcome || '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}