import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { api, apiBlob, apiForm } from './api';
import { CopyButton, Empty, Icon, clock, fmtBytes, friendly, type Notify } from './ui';

interface Version {
  version: number; original_filename: string; size_bytes: string; sha256: string;
  uploaded_at: string; uploaded_by: string | null;
}
interface Item { id: string; name: string; description: string; versions: Version[] }
interface Custody { id: number; version: number; action: string; actor_name: string; at: string }
interface Result { valid: boolean; reason: string | null }

const REASON: Record<string, string> = {
  decrypt_failed: 'the stored data was altered',
  hash_mismatch: 'the hash does not match',
  object_missing: 'the stored file is missing',
};
const ACTION: Record<string, string> = {
  uploaded: 'Uploaded', downloaded: 'Downloaded', verified: 'Verified', verify_failed: 'Integrity check failed',
};

export default function Evidence({ caseId, canEdit, notify }: { caseId: string; canEdit: boolean; notify: Notify }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [custody, setCustody] = useState<{ itemId: string; rows: Custody[] } | null>(null);
  const base = `/api/cases/${caseId}/evidence`;

  const load = useCallback(async () => {
    setItems((await api<{ evidence: Item[] }>(base)).evidence);
  }, [base]);

  useEffect(() => {
    setItems(null); setCustody(null); setResults({});
    load().catch((e) => notify('error', friendly(e)));
  }, [load, notify]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { notify('error', friendly(e)); } finally { setBusy(false); }
  };

  const upload = () => act(async () => {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    await apiForm(base, form);
    notify('ok', `Uploaded ${file.name}`);
    setFile(null);
    setFileKey((k) => k + 1);
    await load();
  });

  const download = (item: Item, v: Version) => act(async () => {
    const blob = await apiBlob(`${base}/${item.id}/versions/${v.version}/download`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = v.original_filename;
    a.click();
    URL.revokeObjectURL(url);
  });

  const verify = (item: Item, v: Version) => act(async () => {
    const r = await api<Result>(`${base}/${item.id}/versions/${v.version}/verify`, 'POST');
    setResults((m) => ({ ...m, [`${item.id}:${v.version}`]: r }));
    notify(r.valid ? 'ok' : 'error', r.valid
      ? `${item.name} version ${v.version}: the hash matches`
      : `${item.name} version ${v.version}: integrity check failed (${REASON[r.reason ?? ''] ?? r.reason})`);
  });

  const toggleCustody = (item: Item) => act(async () => {
    if (custody?.itemId === item.id) { setCustody(null); return; }
    const r = await api<{ custody: Custody[] }>(`${base}/${item.id}/custody`);
    setCustody({ itemId: item.id, rows: r.custody });
  });

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  };

  return (
    <section>
      <h3>Evidence</h3>
      {canEdit && (
        <div className="upload">
          <label className={`drop${over ? ' is-over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)} onDrop={onDrop}>
            <input key={fileKey} type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <Icon name="file" />
            <span>{file ? file.name : 'Drop a file here or choose one'}</span>
            {file && <span className="muted">{fmtBytes(file.size)}</span>}
          </label>
          <button type="button" className="btn btn--primary" disabled={!file || busy} onClick={() => void upload()}>Upload</button>
        </div>
      )}
      {canEdit && <p className="muted">Files are hashed with SHA-256 and stored encrypted. Uploading the same name again adds a new version.</p>}

      {items === null && <p className="muted">Loading evidence…</p>}
      {items?.length === 0 && (
        <Empty title="No evidence stored" hint={canEdit ? 'Upload a file to start its chain of custody.' : 'Nothing has been uploaded for this case.'} />
      )}
      {items?.map((item) => (
        <div key={item.id} className="evidence">
          <div className="evidence__head">
            <strong>{item.name}</strong>
            <button type="button" className="btn btn--quiet btn--small" disabled={busy} onClick={() => void toggleCustody(item)}>
              {custody?.itemId === item.id ? 'Hide chain of custody' : 'Chain of custody'}
            </button>
          </div>
          <div className="scroll-x">
            <table className="mini">
              <thead><tr><th>Version</th><th>File</th><th>Size</th><th>Uploaded</th><th>SHA-256</th><th>Actions</th></tr></thead>
              <tbody>
                {item.versions.map((v) => {
                  const r = results[`${item.id}:${v.version}`];
                  return (
                    <tr key={v.version}>
                      <td>{v.version}</td>
                      <td>{v.original_filename}</td>
                      <td>{fmtBytes(Number(v.size_bytes))}</td>
                      <td>{v.uploaded_by ?? 'unknown'}<span className="muted block">{clock(v.uploaded_at)}</span></td>
                      <td><code className="mono" title={v.sha256}>{v.sha256.slice(0, 16)}…</code> <CopyButton text={v.sha256} /></td>
                      <td>
                        <button type="button" className="btn btn--small" disabled={busy} onClick={() => void download(item, v)}>
                          <Icon name="download" size={14} /> Download
                        </button>{' '}
                        <button type="button" className="btn btn--small" disabled={busy} onClick={() => void verify(item, v)}>Verify</button>
                        {r && <span className={`result result--${r.valid ? 'ok' : 'bad'}`}> {r.valid ? 'Verified' : 'Failed'}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {custody?.itemId === item.id && (
            <ol className="custody" aria-label={`Chain of custody for ${item.name}`}>
              {custody.rows.map((c) => (
                <li key={c.id}>
                  {clock(c.at)}: version {c.version} {(ACTION[c.action] ?? c.action).toLowerCase()} by {c.actor_name}
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </section>
  );
}