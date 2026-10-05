export function resolveCodexStartingMode(params: Readonly<{
  explicitStartingMode?: 'local' | 'remote';
  startedBy: 'daemon' | 'cli';
  hasTtyForLocal: boolean;
  hasHostedTerminal?: boolean;
  localControlEnabled: boolean;
}>): 'local' | 'remote' {
  if (params.startedBy === 'daemon') {
    if (params.explicitStartingMode === 'local' && (params.hasTtyForLocal || params.hasHostedTerminal) && params.localControlEnabled) {
      return 'local';
    }
    return 'remote';
  }

  if (params.explicitStartingMode) {
    return params.explicitStartingMode;
  }

  if (params.localControlEnabled && params.hasTtyForLocal) {
    return 'local';
  }

  return 'remote';
}
