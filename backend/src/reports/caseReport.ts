import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import type { Pool } from 'pg';
import { appendAudit, verifyChain } from '../audit/service.js';
import type { AuthUser } from '../auth/authenticate.js';
import { addEvent } from '../cases/events.js';
import { getCase } from '../cases/service.js';
import { withTx } from '../db/tx.js';
import { listCustody, listEvidence } from '../evidence/service.js';
import { listCaseIocs, listCaseTechniques } from '../tagging/service.js';

type Doc = InstanceType<typeof PDFDocument>;
type Row = Record<string, any>;

export interface ReportData {
  generatedAt: string;
  generatedBy: string;
  detail: Awaited<ReturnType<typeof getCase>>;
  createdBy: string | null;
  assignedTo: string | null;
  iocs: Row[];
  techniques: Row[];
  evidence: Array<{ name: string; versions: Row[]; custody: Row[] }>;
  audit: { valid: boolean; checked: number; headHash: string | null; brokenAtSeq?: string };
  caseAudit: Row[];
}

const who = (a: AuthUser) => a.username || a.id;

export async function collectReport(db: Pool, actor: AuthUser, caseId: string): Promise<ReportData> {
  const detail = await getCase(db, caseId);
  const ids = [detail.assigned_to, detail.created_by].filter((x): x is string => !!x);
  const [people, iocs, techniques, evidence, chain, caseAudit] = await Promise.all([
    db.query('select id, username from users where id = any($1::uuid[])', [ids]),
    listCaseIocs(db, caseId),
    listCaseTechniques(db, caseId),
    listEvidence(db, caseId),
    verifyChain(db),
    db.query(
      `select seq, at, actor_name, action from audit_log
       where entity = 'case' and entity_id = $1 order by seq desc limit 200`, [caseId]),
  ]);
  const nameOf = (id: string | null) => (id ? (people.rows.find((p) => p.id === id)?.username as string | undefined) ?? null : null);
  const custody = await Promise.all(evidence.evidence.map((e: Row) => listCustody(db, caseId, e.id)));
  return {
    generatedAt: new Date().toISOString(),
    generatedBy: who(actor),
    detail,
    createdBy: nameOf(detail.created_by),
    assignedTo: nameOf(detail.assigned_to),
    iocs: iocs.iocs,
    techniques: techniques.techniques,
    evidence: evidence.evidence.map((e: Row, i: number) => ({ name: e.name, versions: e.versions, custody: custody[i].custody })),
    audit: { valid: chain.valid, checked: chain.checked, headHash: chain.head?.hash ?? null, brokenAtSeq: chain.brokenAtSeq },
    caseAudit: caseAudit.rows,
  };
}

/* ---------------- rendering ---------------- */

const L = 50;
const W = 495;

// The built-in PDF fonts only cover Latin-1: anything else becomes "?", and control characters are dropped
const t = (v: unknown, max = 800) => String(v ?? '').replace(/[^\t\n\x20-\x7E\xA0-\xFF]/g, '?').slice(0, max);
const when = (d: unknown) => (d ? `${new Date(d as string).toISOString().replace('T', ' ').slice(0, 19)} UTC` : '-');

function ensure(doc: Doc, need: number) {
  if (doc.y + need > doc.page.height - 60) doc.addPage();
}

function h2(doc: Doc, text: string) {
  ensure(doc, 70);
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a3d7c').text(text, L, doc.y, { width: W });
  const y = doc.y + 2;
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.5).strokeColor('#bbbbbb').stroke();
  doc.y = y + 6;
  doc.fillColor('#111111');
}

function para(doc: Doc, text: string) {
  ensure(doc, 40);
  doc.font('Helvetica').fontSize(9.5).fillColor('#111111').text(t(text, 6000), L, doc.y, { width: W });
}

function kv(doc: Doc, pairs: Array<[string, unknown]>) {
  for (const [k, v] of pairs) {
    ensure(doc, 16);
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#444444').text(k, L, y, { width: 110 });
    const afterLabel = doc.y;
    doc.font('Helvetica').fontSize(9.5).fillColor('#111111').text(t(v, 600), L + 115, y, { width: W - 115 });
    doc.y = Math.max(afterLabel, doc.y) + 2;
  }
}

function table(doc: Doc, headers: string[], widths: number[], rows: unknown[][], emptyText = 'None.') {
  const draw = (cells: string[], bold: boolean) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor('#111111');
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: widths[i] - 6 }))) + 6;
    ensure(doc, h);
    const y = doc.y;
    let x = L;
    cells.forEach((c, i) => { doc.text(c, x + 3, y + 3, { width: widths[i] - 6 }); x += widths[i]; });
    doc.y = y + h;
    doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.5).strokeColor('#dddddd').stroke();
  };
  draw(headers.map((h) => t(h)), true);
  if (!rows.length) { para(doc, emptyText); return; }
  for (const r of rows) draw(r.map((c) => t(c, 300)), false);
}

export function renderReport(data: ReportData, opts: { compress?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const d = data.detail;
    const doc = new PDFDocument({
      size: 'A4', margin: 50, bufferPages: true, compress: opts.compress ?? true,
      info: {
        Title: t(`Case #${d.case_number} - ${d.title}`, 200),
        Author: t(data.generatedBy, 100),
        Creator: 'SOC Case Management Portal',
        Subject: 'Incident case report',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#111111').text(`Case #${d.case_number}`, L, 50, { width: W });
      doc.font('Helvetica').fontSize(13).text(t(d.title, 200), L, doc.y, { width: W });
      doc.moveDown(0.8);
      kv(doc, [
        ['Status', d.status],
        ['Severity', d.severity],
        ['Source', `${d.source}${d.alert_count ? ` (${d.alert_count} alerts)` : ''}`],
        ['Created', `${when(d.created_at)} by ${data.createdBy ?? 'system'}`],
        ['Owner', data.assignedTo ?? 'unassigned'],
        ['Closed', when(d.closed_at)],
        ['Playbook', d.playbook?.name ?? 'none'],
      ]);

      h2(doc, 'Description');
      para(doc, d.description || '(none)');
      if (d.resolution_summary) { h2(doc, 'Resolution summary'); para(doc, d.resolution_summary); }
      if (d.closure_reason) { h2(doc, 'Closure reason'); para(doc, d.closure_reason); }

      h2(doc, 'SLA');
      table(doc, ['Target', 'Due', 'State', 'Completed'], [90, 160, 70, 175],
        d.sla ? [
          ['Respond', when(d.sla.respond.due), d.sla.respond.state, when(d.sla.respond.done_at)],
          ['Resolve', when(d.sla.resolve.due), d.sla.resolve.state, when(d.sla.resolve.done_at)],
        ] : [], 'No SLA recorded.');

      h2(doc, 'Playbook checklist');
      table(doc, ['#', 'Task', 'Status', 'Done by', 'When'], [25, 240, 60, 100, 70],
        d.tasks.map((x: Row) => [x.position, x.title, x.status, x.completed_by ?? '', x.completed_at ? when(x.completed_at).slice(0, 10) : '']),
        'No checklist.');

      h2(doc, 'Indicators of compromise');
      table(doc, ['Type', 'Indicator', 'Source', 'Seen in', 'Added by'], [55, 250, 50, 60, 80],
        data.iocs.map((r) => [r.type, r.value, r.source, `${r.other_cases} other case(s)`, r.added_by ?? 'SIEM']));

      h2(doc, 'MITRE ATT&CK techniques');
      table(doc, ['ID', 'Technique', 'Tactics', 'Source'], [65, 190, 160, 80],
        data.techniques.map((r) => [r.id, r.name, (r.tactics as string[]).join(', '), r.source]));

      h2(doc, 'Alerts');
      table(doc, ['Received', 'Source', 'Rule', 'Severity', 'Host', 'Source IP'], [105, 50, 160, 45, 65, 70],
        d.alerts.slice(0, 50).map((a: Row) => [when(a.received_at), a.source, a.rule_name, a.severity, a.host ?? '', a.src_ip ?? '']),
        'No alerts.');

      h2(doc, 'Evidence');
      if (!data.evidence.length) para(doc, 'No evidence stored.');
      for (const e of data.evidence) {
        ensure(doc, 60);
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111').text(t(e.name, 200), L, doc.y + 4, { width: W });
        doc.moveDown(0.3);
        table(doc, ['Ver', 'File', 'Size', 'Uploaded', 'SHA-256'], [30, 100, 55, 105, 205],
          e.versions.map((v) => [
            v.version, v.original_filename, `${Number(v.size_bytes).toLocaleString('en-US')} B`,
            `${when(v.uploaded_at).slice(0, 16)} ${v.uploaded_by ?? ''}`,
            `${String(v.sha256).slice(0, 32)}\n${String(v.sha256).slice(32)}`,
          ]));
        doc.moveDown(0.3);
        table(doc, ['Custody event', 'Ver', 'Action', 'By'], [150, 40, 120, 185],
          e.custody.map((c) => [when(c.at), c.version, c.action, c.actor_name]));
      }

      h2(doc, 'Notes');
      if (!d.notes.length) para(doc, 'No notes.');
      for (const n of d.notes) {
        ensure(doc, 40);
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#444444').text(`${t(n.author ?? 'unknown', 80)} - ${when(n.created_at)}`, L, doc.y + 3, { width: W });
        para(doc, n.body);
      }

      h2(doc, 'Timeline');
      table(doc, ['Time', 'Actor', 'Event', 'Details'], [115, 85, 105, 190],
        d.events.slice(0, 300).map((e: Row) => [when(e.created_at), e.actor ?? 'system', e.type, JSON.stringify(e.detail ?? {}).slice(0, 160)]));

      h2(doc, 'Audit integrity');
      kv(doc, [
        ['Audit chain', data.audit.valid
          ? `VALID - ${data.audit.checked} records verified when this report was generated`
          : `BROKEN at record ${data.audit.brokenAtSeq ?? '?'} - treat this report as untrusted`],
        ['Chain head hash', data.audit.headHash ?? '-'],
        ['This document', 'Its SHA-256 is recorded in the audit log (action report.export) and returned in the X-Report-SHA256 header.'],
      ]);
      doc.moveDown(0.5);
      table(doc, ['Seq', 'Time', 'Actor', 'Action'], [50, 130, 130, 185],
        data.caseAudit.slice(0, 40).map((r) => [r.seq, when(r.at), r.actor_name, r.action]),
        'No case-level audit entries.');

      // page footers
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0; // otherwise text this low adds a blank page
        doc.font('Helvetica').fontSize(8).fillColor('#666666').text(
          `Case #${d.case_number} - generated ${when(data.generatedAt)} by ${t(data.generatedBy, 60)} - Page ${i - range.start + 1} of ${range.count}`,
          L, doc.page.height - 35, { width: W, align: 'center', lineBreak: false });
        doc.page.margins.bottom = bottom;
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

export async function buildCaseReport(
  db: Pool, actor: AuthUser, caseId: string, ip: string | null, opts: { compress?: boolean } = {},
) {
  const data = await collectReport(db, actor, caseId);
  const pdf = await renderReport(data, opts);
  const sha256 = createHash('sha256').update(pdf).digest('hex');
  await withTx(db, async (c) => {
    await addEvent(c, caseId, actor.id, 'report_exported', { sha256, bytes: pdf.length });
    await appendAudit(c, {
      actorId: actor.id, actorName: who(actor), action: 'report.export',
      entity: 'case', entityId: caseId, ip,
      detail: { sha256, bytes: pdf.length, caseNumber: String(data.detail.case_number) },
    });
  });
  return { pdf, sha256, filename: `case-${data.detail.case_number}-report.pdf` };
}