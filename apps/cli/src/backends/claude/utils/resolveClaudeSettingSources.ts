export type ClaudeSettingSource = 'user' | 'project' | 'local';

export function normalizeClaudeSettingSourcesV2(raw: unknown): ClaudeSettingSource[] | null {
  if (!Array.isArray(raw)) return null;
  const selected = new Set(raw.filter((value): value is string => typeof value === 'string'));
  return (['user', 'project', 'local'] as const).filter((source) => selected.has(source));
}

export function resolveClaudeSettingSources(settings: Readonly<{
  claudeRemoteSettingSourcesV2?: unknown;
  claudeRemoteSettingSources?: unknown;
}>): ClaudeSettingSource[] {
  const explicit = normalizeClaudeSettingSourcesV2(settings.claudeRemoteSettingSourcesV2);
  // An explicit empty array disables every source; it must not widen to defaults.
  if (explicit !== null) return explicit;
  if (settings.claudeRemoteSettingSources === 'user_project') return ['user', 'project'];
  if (settings.claudeRemoteSettingSources === 'project') return ['project'];
  if (settings.claudeRemoteSettingSources === 'none') return [];
  // Agent SDK defaults vary by version, so pass the native launch default explicitly.
  return ['user', 'project', 'local'];
}
