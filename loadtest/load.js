// k6 load test: 50 concurrent analysts plus a steady stream of SIEM alerts.
import http from 'k6/http';
import { check, sleep } from 'k6';

const API = __ENV.API_URL || 'http://api:4000';
const KC = __ENV.KC_URL || 'http://keycloak:8080';
const PASSWORD = __ENV.USER_PASSWORD || 'Passw0rd!dev';
const WEBHOOK_SECRET = __ENV.WEBHOOK_SECRET || '';
const USERS = ['t1.alice', 't2.bob', 'ir.carol', 'mgr.dave'];

export const options = {
  scenarios: {
    analysts: { executor: 'constant-vus', vus: 50, duration: '2m', exec: 'analyst' },
    siem_alerts: {
      executor: 'constant-arrival-rate', rate: 5, timeUnit: '1s', duration: '2m',
      preAllocatedVUs: 10, maxVUs: 40, exec: 'alert',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    'http_req_duration{name:case_list}': ['p(95)<2000'],
    'http_req_duration{name:case_detail}': ['p(95)<2000'],
    'http_req_duration{name:dashboard}': ['p(95)<2000'],
    'http_req_duration{name:alert_to_case}': ['p(95)<3000'],
  },
};

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const jsonOpts = (token, name) => ({
  headers: { ...auth(token), 'Content-Type': 'application/json' },
  tags: { name },
});

export function setup() {
  const tokens = {};
  for (const u of USERS) {
    const res = http.post(`${KC}/realms/soc/protocol/openid-connect/token`, {
      client_id: 'soc-portal', grant_type: 'password', username: u, password: PASSWORD,
    });
    if (res.status !== 200) throw new Error(`cannot get a token for ${u}: HTTP ${res.status}`);
    tokens[u] = res.json('access_token');
    http.get(`${API}/api/me`, { headers: auth(tokens[u]) }); // registers the user
  }
  return tokens;
}

export function analyst(tokens) {
  const user = USERS[(__VU - 1) % USERS.length];
  const token = tokens[user];

  const list = http.get(`${API}/api/cases?limit=50`, { headers: auth(token), tags: { name: 'case_list' } });
  check(list, { 'case list is 200': (r) => r.status === 200 });
  const cases = list.status === 200 ? list.json('cases') : [];

  if (cases.length) {
    const c = cases[Math.floor(Math.random() * cases.length)];
    const detail = http.get(`${API}/api/cases/${c.id}`, { headers: auth(token), tags: { name: 'case_detail' } });
    check(detail, { 'case detail is 200': (r) => r.status === 200 });
  }

  const roll = Math.random();
  if (roll < 0.1 && user !== 'ir.carol') { // incident responders may not create cases
    const created = http.post(`${API}/api/cases`,
      JSON.stringify({ title: `Load test case ${__VU}-${__ITER}`, severity: 'low' }), jsonOpts(token, 'case_create'));
    check(created, { 'create is 201': (r) => r.status === 201 });
    if (created.status === 201) {
      const note = http.post(`${API}/api/cases/${created.json('id')}/notes`,
        JSON.stringify({ body: 'load test note' }), jsonOpts(token, 'case_note'));
      check(note, { 'note is 201': (r) => r.status === 201 });
    }
  } else if (roll < 0.25 && user === 'mgr.dave') {
    const dash = http.get(`${API}/api/dashboard?days=30`, { headers: auth(token), tags: { name: 'dashboard' } });
    check(dash, { 'dashboard is 200': (r) => r.status === 200 });
  } else if (roll < 0.35) {
    const found = http.get(`${API}/api/search/iocs?q=203.0.113`, { headers: auth(token), tags: { name: 'ioc_search' } });
    check(found, { 'search is 200': (r) => r.status === 200 });
  }
  sleep(1 + Math.random() * 2);
}

export function alert() {
  const n = __ITER;
  const payload = {
    id: `k6-${__VU}-${n}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    rule: { id: String(5700 + (n % 20)), level: 10, description: `k6 load rule ${n % 20}`, mitre: { id: ['T1110'] } },
    agent: { id: '001', name: `host-${n % 40}` },
    data: { srcip: `203.0.113.${1 + (n % 250)}` },
  };
  const res = http.post(`${API}/webhooks/alerts/wazuh`, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Token': WEBHOOK_SECRET },
    tags: { name: 'alert_to_case' },
  });
  check(res, { 'alert accepted': (r) => r.status === 200 || r.status === 201 });
}