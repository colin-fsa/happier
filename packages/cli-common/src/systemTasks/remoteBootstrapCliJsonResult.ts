import { SystemTaskExecutionError } from './runSystemTask.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only the CLI's expected signed-out exit may be admitted after a failed process. */
export function isRemoteBootstrapUnauthenticatedCliResult(value: unknown, exitStatus?: number): boolean {
  return (exitStatus === undefined || exitStatus === 1)
    && isRecord(value)
    && value.v === 1
    && value.ok === false
    && value.kind === 'auth_status'
    && isRecord(value.error)
    && value.error.code === 'not_authenticated';
}

export function normalizeRemoteBootstrapCliJsonResult(value: unknown, authStatus = false): Readonly<{
  ok: boolean;
  data: Record<string, unknown>;
}> {
  if (!isRecord(value)) {
    throw new SystemTaskExecutionError('invalid_cli_response', 'Remote bootstrap command returned invalid JSON.');
  }
  if (authStatus) {
    if (value.v !== 1 || typeof value.ok !== 'boolean' || value.kind !== 'auth_status'
      || (value.ok
        ? !isRecord(value.data) || typeof value.data.authenticated !== 'boolean'
        : !isRecord(value.error) || typeof value.error.code !== 'string' || !value.error.code.trim())) {
      throw new SystemTaskExecutionError('invalid_cli_response', 'Remote bootstrap command returned an invalid auth status envelope.');
    }
    if (isRemoteBootstrapUnauthenticatedCliResult(value)) return { ok: true, data: { authenticated: false } };
  }
  // Released daemon/service commands also produce raw objects, not CLI envelopes.
  return { ok: value.ok !== false, data: isRecord(value.data) ? value.data : value };
}
