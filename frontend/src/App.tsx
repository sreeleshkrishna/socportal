import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import AuditPanel from './AuditPanel';
import CaseView from './CaseView';
import Dashboard from './Dashboard';
import IocSearch from './IocSearch';
import { keycloak } from './keycloak';
import type { CaseRow, Detail, Playbook } from './types';
import {
  Empty, Icon, Modal, SeverityTag, SlaChip, StatusPill, Toast, friendly, span, statusLabel, useDebounced, useNow,
  type IconName, type Notice, type Notify,
} from './ui';

type View = 'cases' | 'dashboard' | 'audit';
const TITLES: Record<View, string> = { cases: 'Cases', dashboard: 'Dashboard', audit: 'Audit log' };
const STATUSES = ['new', 'triage', 'in_progress', 'escalated', 'contained', 'resolved', 'closed'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const PAGE = 25;
const CAN_CREATE = ['tier1_analyst', 'tier2_analyst', 'soc_manager'];
const MANAGEMENT = ['auditor', 'soc_manager'];
const ROLE_NAME: Record<string, string> = {
  tier1_analyst: 'Tier 1 analyst',
  tier2_analyst: 'Tier 2 analyst',
  incident_responder: 'Incident responder',
  soc_manager: 'SOC manager',
  auditor: 'Auditor',
};

function NewCaseDialog({ playbooks, onClose, onCreated, notify }: {
  playbooks: Playbook[];
  onClose: () => void;
  onCreated: (id: string) => void;
  notify: Notify;
}) {
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [playbook, setPlaybook] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = title.trim().length >= 3;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      const c = await api<{ id: string; case_number: string }>('/api/cases', 'POST', {
        title: title.trim(), severity, playbook: playbook || undefined,
      });
      notify('ok', `Case #${c.case_number} created`);
      onCreated(c.id);
    } catch (err) {
      notify('error', friendly(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="New case" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          <span className="label">Title</span>
          <input type="text" autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="What happened? For example: Suspicious invoice email" />
        </label>
        <label>
          <span className="label">Severity</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>
          <span className="label">Playbook (optional)</span>
          <select value={playbook} onChange={(e) => setPlaybook(e.target.value)}>
            <option value="">No playbook</option>
            {playbooks.map((p) => <option key={p.key} value={p.key}>{p.name} ({p.task_count} tasks)</option>)}
          </select>
        </label>
        <p className="muted">Response and resolution deadlines start as soon as the case is created.</p>
        <div className="form__actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!valid || busy}>Create case</button>
        </div>
      </form>
    </Modal>
  );
}

export default function App() {
  useNow(15000); // keeps the deadline countdowns moving

  const roles: string[] = keycloak.tokenParsed?.realm_access?.roles ?? [];
  const sub = keycloak.tokenParsed?.sub;
  const username: string = keycloak.tokenParsed?.preferred_username ?? 'unknown user';
  const roleKey = Object.keys(ROLE_NAME).find((r) => roles.includes(r));
  const canCreate = roles.some((r) => CAN_CREATE.includes(r));
  const seesManagement = roles.some((r) => MANAGEMENT.includes(r));

  const [view, setView] = useState<View>('cases');
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [offset, setOffset] = useState(0);
  const [qInput, setQInput] = useState('');
  const q = useDebounced(qInput.trim(), 300);
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [mine, setMine] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dark, setDark] = useState(document.documentElement.dataset.theme === 'dark');
  const selRef = useRef<string | null>(null);
  const lastError = useRef('');
  selRef.current = selId;

  const notify: Notify = useCallback((kind, text) => setNotice({ kind, text }), []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.kind === 'error' ? 9000 : 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // background loads show an error once, not every 5 seconds
  const guarded = useCallback(async (fn: () => Promise<void>) => {
    try {
      await fn();
      lastError.current = '';
    } catch (e) {
      const m = friendly(e);
      if (m !== lastError.current) { lastError.current = m; notify('error', m); }
    }
  }, [notify]);

  const refreshList = useCallback(async () => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (q) p.set('q', q);
    if (status) p.set('status', status);
    if (severity) p.set('severity', severity);
    if (mine && sub) p.set('assignee', sub);
    const r = await api<{ cases: CaseRow[]; total: number }>(`/api/cases?${p.toString()}`);
    setCases(r.cases);
    setTotal(r.total);
    setLoaded(true);
  }, [offset, q, status, severity, mine, sub]);

  const refreshDetail = useCallback(async () => {
    const id = selRef.current;
    if (!id) return;
    const d = await api<Detail>(`/api/cases/${id}`);
    if (selRef.current === id) setDetail(d);
  }, []);

  const refresh = useCallback(
    () => guarded(async () => { await Promise.all([refreshList(), refreshDetail()]); }),
    [guarded, refreshList, refreshDetail],
  );

  useEffect(() => {
    if (view !== 'cases') return;
    void refresh();
    const t = setInterval(() => void refresh(), 5000); // new alerts and automatic escalations appear on their own
    return () => clearInterval(t);
  }, [view, refresh]);

  useEffect(() => {
    if (selId) void guarded(refreshDetail);
    else setDetail(null);
  }, [selId, guarded, refreshDetail]);

  useEffect(() => { setOffset(0); }, [q]);

  useEffect(() => {
    void guarded(async () => {
      setPlaybooks((await api<{ playbooks: Playbook[] }>('/api/playbooks')).playbooks);
    });
  }, [guarded]);

  const openCase = (id: string) => { setSelId(id); setDetail(null); };
  const closeCase = () => { setSelId(null); setDetail(null); };
  const openFromSearch = (id: string) => { setView('cases'); openCase(id); };
  const filtersActive = !!(q || status || severity || mine);
  const clearFilters = () => { setQInput(''); setStatus(''); setSeverity(''); setMine(false); setOffset(0); };
  const toggleTheme = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    setDark(!dark);
  };

  const navButton = (id: View, icon: IconName, label: string) => (
    <li>
      <button type="button" className="nav" aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>
        <Icon name={icon} /> {label}
      </button>
    </li>
  );

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE, total);

  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>

      <nav className="rail" aria-label="Main">
        <div className="brand">
          <span className="brand__mark"><Icon name="shield" size={20} /></span>
          <div><strong>SOC Case Portal</strong><small>Incident response</small></div>
        </div>
        <ul className="rail__list">
          {navButton('cases', 'cases', 'Cases')}
          {seesManagement && navButton('dashboard', 'chart', 'Dashboard')}
          {seesManagement && navButton('audit', 'shield', 'Audit log')}
        </ul>
        <div className="rail__foot">
          <div className="who">
            <span className="who__name">{username}</span>
            <span className="who__role">{roleKey ? ROLE_NAME[roleKey] : 'No SOC role'}</span>
          </div>
          <button type="button" className="btn btn--quiet" onClick={toggleTheme}>
            <Icon name={dark ? 'sun' : 'moon'} size={16} /> {dark ? 'Light mode' : 'Dark mode'}
          </button>
          <button type="button" className="btn btn--quiet"
            onClick={() => void keycloak.logout({ redirectUri: window.location.origin })}>
            <Icon name="logout" size={16} /> Sign out
          </button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <h1 className="topbar__title">{TITLES[view]}</h1>
          <IocSearch onOpen={openFromSearch} notify={notify} />
        </header>

        <main id="main" className="view">
          {view === 'cases' && (
            <div className={`split${selId ? ' has-case' : ''}`}>
              <section className="pane pane--queue" aria-label="Case queue">
                <div className="toolbar">
                  <label className="field field--grow">
                    <span className="sr">Search case titles</span>
                    <input type="search" placeholder="Search case titles" value={qInput}
                      onChange={(e) => setQInput(e.target.value)} />
                  </label>
                  <label className="field">
                    <span className="sr">Status</span>
                    <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
                      <option value="">All statuses</option>
                      {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span className="sr">Severity</span>
                    <select value={severity} onChange={(e) => { setSeverity(e.target.value); setOffset(0); }}>
                      <option value="">All severities</option>
                      {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                  <button type="button" className={`chip${mine ? ' is-on' : ''}`} aria-pressed={mine}
                    onClick={() => { setMine(!mine); setOffset(0); }}>
                    Assigned to me
                  </button>
                  {canCreate && (
                    <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
                      <Icon name="plus" size={16} /> New case
                    </button>
                  )}
                </div>

                {!loaded && <p className="pane-note">Loading cases…</p>}
                {loaded && cases.length === 0 && (
                  filtersActive
                    ? <Empty title="No cases match these filters" hint="Try a different search, or clear the filters."
                        action={<button type="button" className="btn" onClick={clearFilters}>Clear filters</button>} />
                    : <Empty title="No cases yet" hint="Cases appear here when a SIEM alert arrives or when someone creates one." />
                )}
                {cases.length > 0 && (
                  <>
                    <table className="queue">
                      <thead>
                        <tr>
                          <th scope="col">Case</th>
                          <th scope="col">Status</th>
                          <th scope="col">Deadline</th>
                          <th scope="col">Age</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cases.map((c) => (
                          <tr key={c.id} className={`row row--${c.severity}${c.id === selId ? ' is-selected' : ''}`}
                            onClick={() => openCase(c.id)}>
                            <td>
                              <button type="button" className="row-link" aria-current={c.id === selId ? 'true' : undefined}>
                                <span className="case-no">#{c.case_number}</span>
                                <span className="case-title">{c.title}</span>
                              </button>
                              <span className="row-sub">
                                <SeverityTag severity={c.severity} />
                                {c.source !== 'manual' && (
                                  <span className="tag">{c.source}{c.alert_count && c.alert_count > 1 ? ` x${c.alert_count}` : ''}</span>
                                )}
                                {c.assigned_to && <span className="tag">{c.assigned_to === sub ? 'Yours' : 'Assigned'}</span>}
                              </span>
                            </td>
                            <td><StatusPill status={c.status} /></td>
                            <td><SlaChip sla={c.sla} createdAt={c.created_at} /></td>
                            <td className="muted">{span((Date.now() - new Date(c.created_at).getTime()) / 1000)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="pager">
                      <span>Showing {from} to {to} of {total}</span>
                      <span>
                        <button type="button" className="btn btn--small" disabled={offset === 0}
                          onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>{' '}
                        <button type="button" className="btn btn--small" disabled={offset + PAGE >= total}
                          onClick={() => setOffset(offset + PAGE)}>Next</button>
                      </span>
                    </div>
                  </>
                )}
              </section>

              <section className="pane pane--case" aria-label="Case workspace">
                {detail ? (
                  <CaseView detail={detail} roles={roles} sub={sub} playbooks={playbooks}
                    notify={notify} onChanged={refresh} onBack={closeCase} />
                ) : selId ? (
                  <p className="pane-note">Loading case…</p>
                ) : (
                  <Empty title="Select a case"
                    hint="Pick a case from the queue to see its progress, deadlines, checklist, evidence and timeline." />
                )}
              </section>
            </div>
          )}

          {view === 'dashboard' && seesManagement && <Dashboard notify={notify} />}
          {view === 'audit' && seesManagement && <AuditPanel notify={notify} />}
        </main>
      </div>

      {creating && (
        <NewCaseDialog playbooks={playbooks} notify={notify} onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); openCase(id); void refresh(); }} />
      )}
      <Toast notice={notice} onClose={() => setNotice(null)} />
    </div>
  );
}