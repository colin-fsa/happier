import { banner, dim, helpFormatter, sectionTitle } from '@happier-dev/cli-common/output';

import { listRootHelpCommands } from './commandSurfaceManifest';

const HELP_LABEL_WIDTH = 27;

const EXAMPLES = [
  { label: 'happier', description: 'Start session' },
  { label: 'happier session create --help', description: 'Create a scripted session with a model, title, and prompt' },
  { label: 'happier --refresh-settings', description: 'Force-refresh account settings before starting' },
  { label: 'happier --launch-profile <id-or-name>', description: 'Start with a launch profile from your settings' },
  { label: 'happier --auth cs:<id>', description: 'Start with an exact Connected Services profile or pool' },
  { label: 'happier --auth native', description: 'Start with native provider authentication' },
  { label: 'happier opencode --auto', description: 'Automatically approve reads and edits', detail: 'Alias for --permission-mode auto; other tools may still require approval. Use --yolo for full access.' },
  { label: 'happier --yolo', description: 'Start with bypassing permissions', detail: 'happier sugar for --dangerously-skip-permissions' },
  { label: 'happier --chrome', description: 'Enable Chrome browser access for this session' },
  { label: 'happier --no-chrome', description: 'Disable Chrome even if default is on' },
  { label: 'happier --js-runtime bun', description: 'Use bun instead of node to spawn JavaScript-backed CLIs' },
  { label: 'happier auth login --force', description: 'Authenticate' },
  { label: 'happier profiles list', description: 'List available backend profiles' },
  { label: 'happier doctor', description: 'Run diagnostics' },
] as const;

export function buildRootHelpText(): string {
  const helpEntries = listRootHelpCommands();
  const usage = helpFormatter.renderRows(
    helpEntries.map((entry) => ({
      label: entry.rootHelpLabel ?? '',
      description: entry.rootHelpDescription ?? '',
      ...(entry.rootHelpDetail ? { detail: entry.rootHelpDetail } : {}),
    })),
    { labelWidth: HELP_LABEL_WIDTH },
  );
  const examples = helpFormatter.renderRows(EXAMPLES, { labelWidth: HELP_LABEL_WIDTH });
  return `
${banner('Happier', { subtitle: 'Run, watch and steer your coding agents from any device.' })}

${sectionTitle('Usage')}
${usage}

${sectionTitle('Examples')}
${examples}

${sectionTitle('Server selection')} ${dim('(global flags; prefix-only; no persistence)')}
  happier --server <name-or-id> ...
  happier --server-url <url> [--webapp-url <url>] [--public-server-url <url>] ...
`;
}
