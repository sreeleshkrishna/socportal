import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, apiFile } from './api';
import Evidence from './Evidence';
import Tagging from './Tagging';
import type { Detail, Playbook, Task, TimelineEvent, Transition } from './types';
import {
  Icon, Modal, SeverityTag, SlaMeter, StatusPill, StatusTrack, ago, clock, friendly, statusLabel,
  type Notify,
} from './ui';

const EDITORS = ['tier1_analyst', 'tier2_analyst', 'incident_responder', 'soc_manager'];
const ASSIGNERS = ['tier2_analyst', 'incident_responder', 'soc_manager'];

const MOVE_LABEL: Record<string, string> = {
  'new>triage': 'Start triage',
  'triage>in_progress': 'Begin investigation',
  'triage>closed': 'Close as false positive',
  'in_progress>escalated': 'Escalate',
  'in_progress>contained': 'Mark contained',
  'escalated>in_progress': 'De-escalate',
  'escalated>contained': 'Mark contained',
  'contained>resolved': 'Resolve',
  'contained>in_progress': 'Containment failed',
  'resolved>closed': 'Close case',
  'resolved>in_progress': 'Reopen',
};
const FORWARD: Record<string, string> = {
  new: 'triage', triage: 'in_progress', in_progress: 'contained',
  escalated: 'contained', contained: 'resolved', resolved: 'closed',
};
const REQUIRE_LABEL = { reason: 'Reason', summary: 'Resolution summary' } as const;

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'checklist', label: 'Checklist' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'indicators', label: 'Indicators and ATT&CK' },
  { id: 'timeline', label: 'Timeline' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const BAD_EVENTS = new Set(['sla_breached', 'evidence_verify_failed']);

function describeEvent(e: TimelineEvent): string {
  const d = e.detail ?? {};
  const s = (k: string) => String(d[k] ?? '');
  switch (e.type) {
    case 'case_created': return `Opened the case with ${s('severity')} severity`;
    case 'case_created_from_alert': return `Opened automatically from a ${s('source')} alert (rule ${s('ruleId')})`;
    case 'alert_merged': return `Another ${s('source')} alert was merged in${d.severityRaised ? ' and raised the severity' : ''}`;
    case 'case_updated': return 'Edited the case details';
    case 'assigned': return 'Assigned the case';
    case 'reassigned': return 'Reassigned the case';
    case 'unassigned': return 'Removed the owner';
    case 'status_changed':
      return `Moved from ${statusLabel(s('from'))} to ${statusLabel(s('to'))}${d.auto ? ' automatically' : ''}`
        + `${s('reason') ? `. Reason: ${s('reason')}` : ''}${s('summary') ? `. Summary: ${s('summary')}` : ''}`;
    case 'note_added': return 'Added a note';
    case 'playbook_applied': return `Applied the ${s('key')} playbook (${s('tasks')} tasks)`;
    case 'task_added': return `Added the task "${s('title')}"`;
    case 'task_updated': return `Updated the task "${s('title')}"${d.status ? ` to ${s('status')}` : ''}`;
    case 'sla_warning': return `Deadline warning: the ${s('target')} deadline is close`;
    case 'sla_breached': return `Deadline missed: the ${s('target')} deadline passed`;
    case 'evidence_uploaded': return `Uploaded evidence "${s('name')}" version ${s('version')}`;
    case 'evidence_downloaded': return `Downloaded evidence "${s('name')}" version ${s('version')}`;
    case 'evidence_verified': return `Verified evidence "${s('name')}" version ${s('version')}: the hash matches`;
    case 'evidence_verify_failed': return `Integrity check failed for "${s('name')}" version ${s('version')} (${s('reason')})`;
    case 'ioc_added': return `Added the ${s('type')} indicator ${s('value')}`;
    case 'ioc_removed': return `Removed the ${s('type')} indicator ${s('value')}`;
    case 'technique_added': return `Tagged ATT&CK technique ${s('id')} ${s('name')}`;
    case 'technique_removed': return `Removed ATT&CK technique ${s('id')}`;
    case 'report_exported': return 'Exported the PDF report';
    default: return e.type.replace(/_/g, ' ');
  }
}

const send = async (path: string, method: string, body?: unknown) => { await api(path, method, body); };

export default function CaseView({ detail, roles, sub, playbooks, notify, onChanged, onBack }: {
  detail: Detail;
  roles: string[];
  sub: string | undefined;
  playbooks: Playbook[];
  notify: Notify;
  onChanged: () => void | Promise<void>;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<TabId>('overview');
  const [pending, setPending] = useState<Transition | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [applyKey, setApplyKey] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setTab('overview'); setPending(null); setNote(''); setApplyKey(''); }, [detail.id]);

  const closed = detail.status === 'closed';
  const canEdit = !closed && roles.some((r) => EDITORS.includes(r));
  const canAssign = !closed && roles.some((r) => ASSIGNERS.includes(r));
  const mine = !!sub && detail.assigned_to === sub;
  const tasksDone = detail.tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
  const moveName = (to: string) => MOVE_LABEL[`${detail.status}>${to}`] ?? `Move to ${statusLabel(to).toLowerCase()}`;

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) notify('ok', ok);
      await onChanged();
    } catch (e) {
      notify('error', friendly(e));
    } finally {
      setBusy(false);
    }
  };

  const startMove = (t: Transition) => {
    if (t.requires) { setPending(t); setText(''); return; }
    void run(() => send(`/api/cases/${detail.id}/transition`, 'POST', { to: t.to }), `Case moved to ${statusLabel(t.to).toLowerCase()}`);
  };

  const submitMove = (e: FormEvent) => {
    e.preventDefault();
    if (!pending?.requires || text.trim().length < 3) return;
    const t = pending;
    const field = pending.requires;
    void run(async () => {
      await send(`/api/cases/${detail.id}/transition`, 'POST', { to: t.to, [field]: text.trim() });
      setPending(null);
    }, `Case moved to ${statusLabel(t.to).toLowerCase()}`);
  };

  const assignToMe = () => run(() => send(`/api/cases/${detail.id}/assign`, 'POST', { assigneeId: sub }), 'Case assigned to you');

  const exportPdf = () => run(async () => {
    const f = await apiFile(`/api/cases/${detail.id}/report`);
    const url = URL.createObjectURL(f.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `case-${detail.case_number}-report.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    notify('ok', f.sha256 ? `Report downloaded. SHA-256 ${f.sha256.slice(0, 16)}…` : 'Report downloaded');
  });

  const addNote = (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    void run(async () => { await send(`/api/cases/${detail.id}/notes`, 'POST', { body: note.trim() }); setNote(''); }, 'Note added');
  };

  const applyPlaybook = (e: FormEvent) => {
    e.preventDefault();
    if (!applyKey) return;
    void run(async () => { await send(`/api/cases/${detail.id}/playbook`, 'POST', { key: applyKey }); setApplyKey(''); }, 'Checklist added');
  };

  const setTask = (t: Task, status: Task['status']) =>
    run(() => send(`/api/cases/${detail.id}/tasks/${t.id}`, 'PATCH', { status }));

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let n: number;
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
    else return;
    e.preventDefault();
    setTab(TABS[n].id);
    document.getElementById(`tab-${TABS[n].id}`)?.focus();
  };

  return (
    <article className="case">
      <header className="case-head">
        <button type="button" className="btn btn--quiet back" onClick={onBack}>Back to cases</button>
        <div className="case-head__title">
          <span className="case-no">#{detail.case_number}</span>
          <h2>{detail.title}</h2>
        </div>
        <dl className="facts">
          <div><dt>Severity</dt><dd><SeverityTag severity={detail.severity} /></dd></div>
          <div><dt>Status</dt><dd><StatusPill status={detail.status} /></dd></div>
          <div><dt>Opened</dt><dd title={clock(detail.created_at)}>{ago(detail.created_at)}</dd></div>
          <div>
            <dt>Source</dt>
            <dd>{detail.source}{detail.alert_count ? ` (${detail.alert_count} alert${detail.alert_count === 1 ? '' : 's'})` : ''}</dd>
          </div>
          <div><dt>Owner</dt><dd>{detail.assigned_to ? (mine ? 'You' : 'Assigned') : 'Unassigned'}</dd></div>
        </dl>
        <div className="case-actions">
          {detail.allowedTransitions.map((t) => (
            <button key={t.to} type="button" disabled={busy}
              className={`btn${t.to === FORWARD[detail.status] ? ' btn--primary' : ''}`} onClick={() => startMove(t)}>
              {moveName(t.to)}
            </button>
          ))}
          {canAssign && !mine && (
            <button type="button" className="btn" disabled={busy} onClick={() => void assignToMe()}>Assign to me</button>
          )}
          <button type="button" className="btn" disabled={busy} onClick={() => void exportPdf()}>
            <Icon name="download" size={16} /> Export PDF report
          </button>
        </div>
      </header>

      <section className="lifecycle" aria-label="Progress and deadlines">
        <StatusTrack status={detail.status} />
        {detail.sla && (
          <div className="meters">
            <SlaMeter label="Respond" part={detail.sla.respond} createdAt={detail.created_at} />
            <SlaMeter label="Resolve" part={detail.sla.resolve} createdAt={detail.created_at} />
          </div>
        )}
      </section>

      <div className="tabs" role="tablist" aria-label="Case sections" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button key={t.id} id={`tab-${t.id}`} type="button" role="tab" className="tab"
            aria-selected={tab === t.id} aria-controls="case-panel" tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'checklist' && detail.tasks.length > 0 && <span className="tab__count">{tasksDone}/{detail.tasks.length}</span>}
            {t.id === 'timeline' && <span className="tab__count">{detail.events.length}</span>}
          </button>
        ))}
      </div>

      <div className="panel" role="tabpanel" id="case-panel" aria-labelledby={`tab-${tab}`}>
        {tab === 'overview' && (
          <>
            <section>
              <h3>Description</h3>
              <p className="prose">{detail.description || 'No description was added.'}</p>
            </section>
            {detail.resolution_summary && (
              <section><h3>Resolution summary</h3><p className="prose">{detail.resolution_summary}</p></section>
            )}
            {detail.closure_reason && (
              <section><h3>Closure reason</h3><p className="prose">{detail.closure_reason}</p></section>
            )}
            {!!detail.alerts?.length && (
              <section>
                <h3>Alerts ({detail.alerts.length})</h3>
                <div className="scroll-x">
                  <table className="mini">
                    <thead><tr><th>Received</th><th>Source</th><th>Rule</th><th>Severity</th><th>Host</th><th>Source IP</th></tr></thead>
                    <tbody>
                      {detail.alerts.map((a) => (
                        <tr key={a.id}>
                          <td>{ago(a.received_at)}</td><td>{a.source}</td><td>{a.rule_name}</td>
                          <td><SeverityTag severity={a.severity} /></td>
                          <td>{a.host ?? '-'}</td><td className="mono">{a.src_ip ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            <section>
              <h3>Notes ({detail.notes.length})</h3>
              {detail.notes.length === 0 && <p className="muted">No notes yet. Write down what you checked and what you found.</p>}
              <ul className="rows">
                {detail.notes.map((n) => (
                  <li key={n.id}>
                    <span className="grow">{n.body}</span>
                    <span className="muted">{n.author ?? 'unknown'}, {ago(n.created_at)}</span>
                  </li>
                ))}
              </ul>
              {canEdit && (
                <form className="inline-form" onSubmit={addNote}>
                  <label className="field field--grow">
                    <span className="sr">New note</span>
                    <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Write a note for the next analyst" />
                  </label>
                  <button type="submit" className="btn" disabled={busy || !note.trim()}>Add note</button>
                </form>
              )}
            </section>
          </>
        )}

        {tab === 'checklist' && (
          <section>
            <h3>{detail.playbook ? `${detail.playbook.name} playbook` : 'Checklist'}</h3>
            {!detail.playbook && canEdit && (
              <form className="inline-form" onSubmit={applyPlaybook}>
                <label className="field field--grow">
                  <span className="sr">Playbook</span>
                  <select value={applyKey} onChange={(e) => setApplyKey(e.target.value)}>
                    <option value="">Choose a playbook</option>
                    {playbooks.map((p) => <option key={p.key} value={p.key}>{p.name} ({p.task_count} tasks)</option>)}
                  </select>
                </label>
                <button type="submit" className="btn" disabled={busy || !applyKey}>Add checklist</button>
              </form>
            )}
            {detail.tasks.length === 0 && detail.playbook === null && !canEdit && (
              <p className="muted">This case has no checklist.</p>
            )}
            {detail.tasks.length > 0 && (
              <>
                <p className="muted">{tasksDone} of {detail.tasks.length} steps finished. A case can only be resolved when every step is done or skipped.</p>
                <div className="progress" aria-hidden="true"><i style={{ width: `${Math.round((tasksDone / detail.tasks.length) * 100)}%` }} /></div>
                <ul className="rows">
                  {detail.tasks.map((t) => (
                    <li key={t.id} className={t.status === 'done' ? 'task--done' : ''}>
                      <label className="grow">
                        <input type="checkbox" checked={t.status === 'done'}
                          disabled={busy || !canEdit || t.status === 'skipped'}
                          onChange={() => void setTask(t, t.status === 'done' ? 'todo' : 'done')} />{' '}
                        <span className="task__title">{t.title}</span>
                        {t.description && <span className="muted block">{t.description}</span>}
                      </label>
                      {t.status === 'skipped' && <span className="tag">Skipped</span>}
                      {t.completed_by && <span className="muted">{t.completed_by}</span>}
                      {canEdit && t.status !== 'done' && t.status !== 'skipped' && (
                        <button type="button" className="btn btn--quiet btn--small" disabled={busy}
                          onClick={() => void setTask(t, 'skipped')}>Skip</button>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

        {tab === 'evidence' && <Evidence caseId={detail.id} canEdit={canEdit} notify={notify} />}
        {tab === 'indicators' && <Tagging caseId={detail.id} canEdit={canEdit} notify={notify} />}

        {tab === 'timeline' && (
          <section>
            <h3>Timeline</h3>
            <ol className="timeline">
              {[...detail.events].reverse().map((e) => (
                <li key={e.id} className={BAD_EVENTS.has(e.type) ? 'tl--bad' : ''}>
                  <div>{describeEvent(e)}</div>
                  <div className="tl__meta">{e.actor ?? 'System'}, {clock(e.created_at)}</div>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      {pending?.requires && (
        <Modal title={moveName(pending.to)} onClose={() => setPending(null)}>
          <form className="form" onSubmit={submitMove}>
            <label>
              <span className="label">{REQUIRE_LABEL[pending.requires]}</span>
              <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)}
                placeholder={pending.requires === 'summary' ? 'What happened and what was done about it?' : 'Why is this change needed?'} />
            </label>
            <p className="muted">This is written to the case timeline and the audit log.</p>
            <div className="form__actions">
              <button type="button" className="btn" onClick={() => setPending(null)}>Cancel</button>
              <button type="submit" className="btn btn--primary" disabled={busy || text.trim().length < 3}>{moveName(pending.to)}</button>
            </div>
          </form>
        </Modal>
      )}
    </article>
  );
}