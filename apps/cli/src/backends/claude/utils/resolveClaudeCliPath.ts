import { resolveProviderCliCommand } from '@happier-dev/cli-common/providers';
import { ProviderCliNotFoundError } from '@/runtime/managedTools/requireProviderCliCommand';

let cachedResolvedClaudeCliPath: string | null = null;

export function resolveClaudeCliPath(): string {
  if (cachedResolvedClaudeCliPath) {
    return cachedResolvedClaudeCliPath;
  }

  const resolved = resolveProviderCliCommand('claude', {
    processEnv: process.env,
    currentExecPath: process.execPath,
  });
  if (!resolved) {
    throw new ProviderCliNotFoundError('claude');
  }

  cachedResolvedClaudeCliPath = resolved.command;
  return cachedResolvedClaudeCliPath;
}

export function isClaudeCliJavaScriptFile(cliPath: string): boolean {
  const normalized = typeof cliPath === 'string' ? cliPath.trim() : '';
  return normalized.endsWith('.js') || normalized.endsWith('.cjs') || normalized.endsWith('.mjs');
}
