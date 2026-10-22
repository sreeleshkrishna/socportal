export type SlaState = 'ok' | 'warning' | 'breached' | 'met';
export interface SlaPart { due: string; state: SlaState; done_at: string | null }
export interface Sla { respond: SlaPart; resolve: SlaPart; overall: SlaState }

export interface CaseRow {
  id: string;
  case_number: string;
  title: string;
  severity: string;
  status: string;
  assigned_to: string | null;
  source: string;
  alert_count?: number;
  created_at: string;
  sla?: Sla | null;
}

export interface Task {
  id: string;
  position: number;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'done' | 'skipped';
  assignee: string | null;
  completed_by: string | null;
}

export interface TimelineEvent {
  id: number;
  type: string;
  actor: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface Note { id: string; body: string; author: string | null; created_at: string }

export interface AlertRow {
  id: string;
  source: string;
  rule_name: string;
  severity: string;
  host: string | null;
  src_ip: string | null;
  received_at: string;
}

export interface Transition { to: string; requires: 'reason' | 'summary' | null }

export interface Detail extends CaseRow {
  description: string;
  resolution_summary?: string | null;
  closure_reason?: string | null;
  playbook: { key: string; name: string } | null;
  tasks: Task[];
  notes: Note[];
  events: TimelineEvent[];
  alerts?: AlertRow[];
  allowedTransitions: Transition[];
}

export interface Playbook { key: string; name: string; task_count: number }