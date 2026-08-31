// Preflight
// ---------------------------------------------------------------------------

export type PreflightSeverity = 'error' | 'warning' | 'info';

export interface PreflightCheck {
  key: string;
  severity: PreflightSeverity;
  message: string;
}

export interface PreflightSection {
  key: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  label: string;
  checks: PreflightCheck[];
}

export interface PreflightReport {
  id: string;
  shotId: string;
  promptVersionId: string | null;
  providerId?: string | null;
  basic: PreflightSection[];
  semantic: PreflightSection[] | null; // null when AI not run
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  blocked: boolean;
  aiSemanticRun: boolean;
  createdAt: string;
}
