import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import { Icon, SeverityTag, StatusPill, friendly, type Notify } from './ui';

interface Result {
  id: string; type: string; value: string;
  cases: { id: string; case_number: string; title: string; status: string; severity: string }[];
}

export default function IocSearch({ onOpen, notify }: { onOpen: (caseId: string) => void; notify: Notify }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setResults(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setResults(null); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 3 || busy) return;
    setBusy(true);
    try {
      setResults((await api<{ results: Result[] }>(`/api/search/iocs?q=${encodeURIComponent(q.trim())}`)).results);
    } catch (err) {
      notify('error', friendly(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form ref={box} className="iocsearch" role="search" onSubmit={(e) => void submit(e)}>
      <label className="field field--grow">
        <span className="sr">Find cases by indicator</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Find cases by IP, domain, URL, email or hash" />
      </label>
      <button type="submit" className="btn" disabled={busy || q.trim().length < 3} aria-label="Search indicators">
        <Icon name="search" size={16} />
      </button>

      {results && (
        <div className="popover">
          {results.length === 0 && <p>No case has that indicator.</p>}
          {results.map((r) => (
            <div key={r.id}>
              <p><code className="mono">{r.value}</code> <span className="tag">{r.type}</span></p>
              <ul>
                {r.cases.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="btn btn--quiet"
                      onClick={() => { onOpen(c.id); setResults(null); }}>
                      #{c.case_number} {c.title}
                    </button>{' '}
                    <SeverityTag severity={c.severity} /> <StatusPill status={c.status} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </form>
  );
}