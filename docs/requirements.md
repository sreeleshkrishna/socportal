# Requirements

## 1. Purpose and scope
The SOC Case Management Portal gives security analysts one place to turn SIEM alerts into cases, work them under enforced response times, keep evidence with a provable chain of custody, and show a complete record of who did what and when. It addresses five problems from the project brief: scattered case data, unclear ownership and escalation, SLA breaches noticed too late, evidence that cannot be proven, and no performance metrics.

Out of scope: multi-tenancy, automated response actions (SOAR) and AI case summaries (stretch goals). Only lab-generated or public data is used.

## 2. Roles
Tier 1 analyst, Tier 2 analyst, Incident responder, SOC manager, Auditor (see rbac-matrix.md).

## 3. Functional requirements

| ID | Requirement | Priority | Acceptance criterion | Status | Evidence |
|---|---|---|---|---|---|
| FR-01 | Login with OIDC (Keycloak), MFA supported | Must | The portal is reachable only after a Keycloak login (PKCE); TOTP can be required per user | Done | Login demo, OTP setup screenshot |
| FR-02 | Role-based access control for 5 roles, enforced in the backend | Must | Every endpoint answers 403 to a role without the permission | Done | rbac.test.ts (every route x every role) |
| FR-03 | Create, assign, reassign, escalate and close cases | Must | Each action works for the permitted roles and appears in the case timeline | Done | cases.api.test.ts |
| FR-04 | Enforce the case lifecycle state machine | Must | An invalid transition returns 409 and changes nothing; a missing reason or summary returns 400 | Done | stateMachine.test.ts (all state pairs) |
| FR-05 | Receive alerts by webhook and create or merge cases | Must | A valid alert creates a case in under 3 s; the same alert id is ignored; a similar open alert merges | Done | alerts.test.ts, live Wazuh demo |
| FR-06 | Severity-based SLA timers, warning, auto-escalation | Must | Timers start at creation; a warning is sent before the deadline; a breach escalates the case without a user | Done | sla.test.ts, breach demo |
| FR-07 | Playbook templates that generate task checklists | Must | Applying a playbook creates its tasks; a case cannot be resolved with open tasks | Done | playbooks.test.ts |
| FR-08 | Evidence upload with SHA-256 and chain-of-custody log | Must | The hash is stored; every download and verification is logged; an altered object blocks the download | Done | evidence.test.ts, tamper demo |
| FR-09 | Append-only, hash-chained audit log with a verify function | Must | Edited, deleted or forged records are detected by the verify endpoint | Done | audit.test.ts, tamper demo |
| FR-10 | IOC and MITRE ATT&CK tagging with search | Must | Indicators and techniques can be added and removed; cases can be found by indicator | Done | tagging.test.ts |
| FR-11 | Dashboard: MTTD, MTTR, SLA compliance, backlog, workload | Should | All metrics shown for 7, 30 or 90 days with values matching test data | Done | dashboard.test.ts |
| FR-12 | Case report export to PDF | Should | The PDF contains case data, evidence hashes, timeline and audit status | Done | report.test.ts |
| FR-13 | Notifications by email and Slack or Teams | Should | SLA warnings and breaches are queued, retried and delivered | Partly | Email verified through Mailpit; Slack implemented but tested only against a mocked endpoint |
| FR-14 | Real-time updates on the case page (WebSockets) | Should | The case page updates without reloading | Not done | The UI polls every 5 s; WebSockets are future work |

## 4. Non-functional requirements
- Security: input validation, parameterised queries, secure headers, rate limiting, CSRF-safe design (bearer tokens in a header, no cookies); see security-test-report.md.
- Performance: 50 concurrent users and 10,000 cases without slowdown.
- Data protection: evidence encrypted at rest (AES-256-GCM); the portal never stores passwords (Keycloak does).
- Reliability: daily database backup and a tested restore.
- Deployability: the whole stack starts with one `docker compose up`.

## 5. Success targets

| Target | Result | Evidence |
|---|---|---|
| Alert-to-case creation time <= 3 s | (p95 from the k6 run) ms | k6 alert_to_case |
| API permission checks covered by tests | 100% of routes | rbac.test.ts loops over the route list |
| Audit tamper detection | edit, delete and forged records detected | audit.test.ts |
| SLA warning before breach | 100% in test scenarios | sla.test.ts |
| OWASP scan: 0 high or critical | (ZAP counts) | ZAP reports |
| Case list (1,000+ cases) <= 2 s | (p95 from the k6 run) ms | k6 case_list, browser load time |
| 50 users, 10,000 cases | (error rate) % | k6 summary |