import { SESSION_MACHINE_WORKSPACE_PATH_ENV } from '@/agent/runtime/sessionWorkspaceLocation';

const DAEMON_OWNED_CHILD_ENV_KEYS = new Set<string>([
  'HAPPIER_HOME_DIR',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
  'HAPPIER_DAEMON_SERVICE_SERVER_URL',
  SESSION_MACHINE_WORKSPACE_PATH_ENV,
]);

export function stripDaemonOwnedChildEnvOverrides(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    if (DAEMON_OWNED_CHILD_ENV_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}
