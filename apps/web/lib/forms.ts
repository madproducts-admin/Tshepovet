import { ApiProblem } from './api';

/**
 * Small, explicit form validation: each rule carries the sentence the person reads, in plain
 * words that say what to do (WCAG 3.3.3). The API checks everything again; its field errors
 * are mapped back onto the same fields.
 */
export type Errors<K extends string> = Partial<Record<K, string>>;

export const rules = {
  required: (v: string, message: string) => (v.trim() ? undefined : message),
  email: (v: string) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? undefined : 'Enter an email address like name@company.co.za.'),
  registration: (v: string) =>
    /^(CK)?\s*\d{4}\s*[/\-.]?\s*\d{1,6}\s*[/\-.]?\s*\d{2}$/i.test(v.trim()) ? undefined : 'Enter the CIPC registration number, for example 2019/123456/07.',
  minLength: (v: string, n: number, message: string) => (v.length >= n ? undefined : message),
  totp: (v: string) => (/^\d{6}$/.test(v.replace(/\s/g, '')) ? undefined : 'Enter the 6-digit code from your authenticator app.'),
};

/** Runs every check; returns the errors that apply (empty when the form can be sent). */
export function check<K extends string>(checks: Record<K, (string | undefined)[]>): Errors<K> {
  const out: Errors<K> = {};
  for (const [k, list] of Object.entries(checks) as Array<[K, (string | undefined)[]]>) {
    const first = list.find(Boolean);
    if (first) out[k] = first;
  }
  return out;
}

/** The API's field errors for this form, plus a message for the summary. */
export function fromProblem<K extends string>(err: unknown, fields: readonly K[]): { errors: Errors<K>; message: string } {
  if (!(err instanceof ApiProblem)) return { errors: {}, message: 'TshepoVet could not be reached. Check your connection and try again.' };
  const errors: Errors<K> = {};
  for (const [path, msg] of Object.entries(err.fieldErrors)) {
    const k = fields.find((f) => path === f || path.startsWith(`${f}.`));
    if (k) errors[k] = msg;
  }
  if (err.code === 'weak_password') {
    const problems = (err.details.problems as string[] | undefined) ?? [];
    const k = fields.find((f) => f === 'password' || f === 'new_password');
    if (k) errors[k] = problems.join(' ');
  }
  return { errors, message: err.code === 'validation_error' && Object.keys(errors).length ? 'Check the highlighted fields.' : err.message };
}

export const summary = <K extends string>(errors: Errors<K>, ids: Record<K, string>) =>
  (Object.entries(errors) as Array<[K, string]>).map(([k, message]) => ({ field: ids[k], message }));
