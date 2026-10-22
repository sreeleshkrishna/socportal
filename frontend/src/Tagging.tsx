import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { Empty, friendly, type Notify } from './ui';

interface Ioc { id: string; type: string; value: string; source: string; note: string; other_cases: number }
interface Tech { id: string; name: string; tactics: string[]; source: string }
interface Catalog { id: string; name: string; tactics: string[] }

export default function Tagging({ caseId, canEdit, notify }: { caseId: string; canEdit: boolean; notify: Notify }) {
  const [iocs, setIocs] = useState<Ioc[] | null>(null);
  const [techs, setTechs] = useState<Tech[] | null>(null);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [catalog, setCatalog] = useState<Catalog[] | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/cases/${caseId}`;

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      api<{ iocs: Ioc[] }>(`${base}/iocs`),
      api<{ techniques: Tech[] }>(`${base}/techniques`),
    ]);
    setIocs(a.iocs);
    setTechs(b.techniques);
  }, [base]);

  useEffect(() => {
    setIocs(null); setTechs(null); setCatalog(null);
    load().catch((e) => notify('error', friendly(e)));
  }, [load, notify]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { notify('error', friendly(e)); } finally { setBusy(false); }
  };

  const addIoc = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    void act(async () => {
      await api(`${base}/iocs`, 'POST', { value: value.trim(), note: note.trim() || undefined });
      setValue(''); setNote('');
      await load();
    });
  };
  const removeIoc = (i: Ioc) => act(async () => { await api(`${base}/iocs/${i.id}`, 'DELETE'); await load(); });

  const searchTech = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      setCatalog((await api<{ techniques: Catalog[] }>(`/api/attack/techniques?q=${encodeURIComponent(q.trim())}`)).techniques);
    });
  };
  const addTech = (id: string) => act(async () => { await api(`${base}/techniques`, 'POST', { id }); await load(); });
  const removeTech = (id: string) => act(async () => { await api(`${base}/techniques/${id}`, 'DELETE'); await load(); });

  return (
    <>
      <section>
        <h3>Indicators of compromise</h3>
        {iocs === null && <p className="muted">Loading indicators…</p>}
        {iocs?.length === 0 && (
          <Empty title="No indicators yet" hint="Add the IPs, domains, URLs, email addresses and file hashes you find. Defanged values such as hxxp and [.] are accepted." />
        )}
        <ul className="rows">
          {iocs?.map((i) => (
            <li key={i.id}>
              <span className="tag">{i.type}</span>
              <code className="mono grow">{i.value}</code>
              {i.source === 'siem' && <span className="tag">From SIEM</span>}
              {i.other_cases > 0 && <span className="warn-text">Also in {i.other_cases} other case{i.other_cases === 1 ? '' : 's'}</span>}
              {i.note && <span className="muted">{i.note}</span>}
              {canEdit && (
                <button type="button" className="btn btn--quiet btn--small" disabled={busy} onClick={() => void removeIoc(i)}>Remove</button>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <form className="inline-form" onSubmit={addIoc}>
            <label className="field field--grow">
              <span className="sr">Indicator</span>
              <input type="text" value={value} onChange={(e) => setValue(e.target.value)} placeholder="IP, domain, URL, email or hash" />
            </label>
            <label className="field field--grow">
              <span className="sr">Note</span>
              <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
            </label>
            <button type="submit" className="btn" disabled={busy || !value.trim()}>Add indicator</button>
          </form>
        )}
      </section>

      <section>
        <h3>MITRE ATT&amp;CK techniques</h3>
        {techs === null && <p className="muted">Loading techniques…</p>}
        {techs?.length === 0 && <Empty title="No techniques tagged" hint="Tag the techniques you observed so similar cases can be found later." />}
        <ul className="rows">
          {techs?.map((t) => (
            <li key={t.id}>
              <strong>{t.id}</strong>
              <span className="grow">{t.name}</span>
              {t.tactics.map((x) => <span key={x} className="tag">{x}</span>)}
              {t.source === 'siem' && <span className="tag">From SIEM</span>}
              {canEdit && (
                <button type="button" className="btn btn--quiet btn--small" disabled={busy} onClick={() => void removeTech(t.id)}>Remove</button>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <>
            <form className="inline-form" onSubmit={searchTech}>
              <label className="field field--grow">
                <span className="sr">Search techniques</span>
                <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or ID, for example brute or T1566" />
              </label>
              <button type="submit" className="btn" disabled={busy}>Search</button>
            </form>
            {catalog && catalog.length === 0 && <p className="muted">No technique matches that search.</p>}
            <ul className="rows">
              {catalog?.map((c) => (
                <li key={c.id}>
                  <button type="button" className="btn btn--small" disabled={busy} onClick={() => void addTech(c.id)}>Add</button>
                  <strong>{c.id}</strong>
                  <span className="grow">{c.name}</span>
                  {c.tactics.map((x) => <span key={x} className="tag">{x}</span>)}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}