import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  extractFirstScannedSshKnownHostLine,
  buildRemoteBootstrapCommand,
  isRemoteBootstrapUnauthenticatedCliResult,
  normalizeRemoteBootstrapCliJsonResult,
  resolveSshKnownHostTrust,
  RemoteBootstrapMachineParams,
  RemoteHostTrustResolution,
  SystemTaskSshConnectionConfig,
} from '@happier-dev/cli-common/systemTasks';

import { runLocalHappierJsonCommand } from './happierCli.js';
import { scopeProcessEnvToTargetRelay } from './localDaemonCli.js';
import { buildSshCommand, redactSshText } from '../ssh/index.js';
import { extractSshHost, normalizeBootstrapChannel, parseFirstJsonObject, resolveDefaultKnownHostsPath, runCommandCapture, type CommandExecutionResult } from './taskRuntime.js';
import { installOrUpdateRelayRuntimeDefault } from './relayRuntimeTasks.js';
import { installRemoteFirstPartyComponent } from './remoteFirstPartyPayloadInstaller.js';

type SshConnectionConfig = SystemTaskSshConnectionConfig;

function normalizeKnownHostsText(text: string): string {
  const normalized = String(text ?? '').trim();
  return normalized ? `${normalized}\n` : '';
}

async function writeKnownHostsText(path: string, text: string): Promise<void> {
  const normalizedPath = String(path ?? '').trim();
  if (!normalizedPath) {
    return;
  }
  const slashIndex = Math.max(normalizedPath.lastIndexOf('/'), normalizedPath.lastIndexOf('\\'));
  if (slashIndex > 0) {
    await mkdir(normalizedPath.slice(0, slashIndex), { recursive: true });
  }
  await writeFile(normalizedPath, normalizeKnownHostsText(text), 'utf8');
}

export async function resolveRemoteSshHostTrustDefault(params: Readonly<{
  ssh: SshConnectionConfig;
  knownHostsMode: 'app' | 'system';
}>): Promise<RemoteHostTrustResolution> {
  if (params.knownHostsMode === 'system') {
    return { status: 'trusted' };
  }

  const knownHostsPath = params.ssh.knownHostsPath || resolveDefaultKnownHostsPath();
  const host = extractSshHost(params.ssh.target);
  const existingText = await readFile(knownHostsPath, 'utf8').catch(() => '');

  const keyscan = await runCommandCapture({
    command: 'ssh-keyscan',
    args: [
      '-T',
      '5',
      ...(params.ssh.port ? ['-p', String(params.ssh.port)] : []),
      '-t',
      'ed25519',
      host,
    ],
  });
  if (keyscan.status !== 0 || !keyscan.stdout.trim()) {
    throw new Error(redactSshText(keyscan.stderr || 'Failed to resolve SSH host key.'));
  }

  const scanned = extractFirstScannedSshKnownHostLine(keyscan.stdout);
  const trust = resolveSshKnownHostTrust({
    knownHostsText: existingText,
    scannedHostKeyLine: scanned.line,
    trustedHostKey: params.ssh.trustedHostKey,
  });

  if (trust.status === 'rejected') {
    throw new Error(trust.message);
  }

  if (trust.status === 'trusted') {
    if (normalizeKnownHostsText(trust.nextKnownHostsText) !== normalizeKnownHostsText(existingText)) {
      await writeKnownHostsText(knownHostsPath, trust.nextKnownHostsText);
    }
    return { status: 'trusted' };
  }

  return {
    status: 'prompt',
    promptKind: trust.promptKind,
    promptMessage: trust.promptKind === 'ssh.replaceHostKey'
      ? 'Replace the saved SSH host key?'
      : 'Trust this SSH host?',
    promptData: {
      host: trust.scanned.host,
      keyType: trust.scanned.keyType,
      fingerprint: trust.scanned.fingerprint,
      ...(trust.promptKind === 'ssh.replaceHostKey'
        ? { existingFingerprint: trust.existingFingerprint ?? null }
        : {}),
    },
    accept: async () => {
      await writeKnownHostsText(knownHostsPath, trust.nextKnownHostsText);
    },
  };
}

export async function installRemoteCliDefault(params: Readonly<{
  parsed: RemoteBootstrapMachineParams;
  auth: Readonly<{ mode: 'agent' } | { mode: 'keyFile'; privateKeyPath: string }>;
  knownHostsMode: 'app' | 'system';
}>, deps: Readonly<{
  installRemoteFirstPartyComponent?: typeof installRemoteFirstPartyComponent;
}> = {}): Promise<void> {
  await (deps.installRemoteFirstPartyComponent ?? installRemoteFirstPartyComponent)({
    componentId: 'happier-cli',
    channel: params.parsed.channel,
    ssh: {
      ...params.parsed.ssh,
      auth: params.auth.mode === 'keyFile' ? 'keyfile' : 'agent',
      ...(params.auth.mode === 'keyFile' ? { identityFile: params.auth.privateKeyPath } : {}),
    },
    knownHostsMode: params.knownHostsMode,
  });
}

export async function approveLocalRemoteAuthRequestDefault(params: Readonly<{
  publicKey: string;
  parsed: RemoteBootstrapMachineParams;
}>, deps: Readonly<{
  runLocalHappierJsonCommand?: typeof runLocalHappierJsonCommand;
}> = {}): Promise<void> {
  const relayArgs = [
    `--server-url=${params.parsed.relay.relayUrl}`,
    `--webapp-url=${params.parsed.relay.webappUrl ?? params.parsed.relay.relayUrl}`,
    ...(params.parsed.relay.publicRelayUrl ? [`--public-server-url=${params.parsed.relay.publicRelayUrl}`] : []),
  ];
  // R13 (a): the approval releases this computer's credentials for exactly the relay the task
  // names, so it runs in that relay's explicit target scope — an inherited launch pin
  // (`HAPPIER_ACTIVE_SERVER_ID`, …) would otherwise outrank the flags in the CLI's configuration.
  const { relayUrl, publicRelayUrl } = params.parsed.relay;
  await (deps.runLocalHappierJsonCommand ?? runLocalHappierJsonCommand)({
    args: ['auth', 'approve', '--public-key', params.publicKey, '--json', '--persist', ...relayArgs],
    releaseRing: normalizeBootstrapChannel(params.parsed.channel).releaseChannel,
    processEnv: scopeProcessEnvToTargetRelay({
      serverUrl: publicRelayUrl ?? relayUrl,
      webappUrl: params.parsed.relay.webappUrl ?? relayUrl,
      localServerUrl: publicRelayUrl ? relayUrl : null,
    }, process.env),
  });
}

export async function runRemoteBootstrapCommandDefault(params: Readonly<{
  label:
    | 'auth.status'
    | 'server.configure'
    | 'auth.request'
    | 'auth.wait'
    | 'daemon.service.install'
    | 'daemon.service.start'
    | 'relay.runtime.install';
  parsed: RemoteBootstrapMachineParams;
  auth: Readonly<{ mode: 'agent' } | { mode: 'keyFile'; privateKeyPath: string }>;
  knownHostsMode: 'app' | 'system';
  data?: Record<string, unknown>;
}>): Promise<Readonly<{ ok: boolean; data: Record<string, unknown> }>> {
  const ssh: SshConnectionConfig = {
    ...params.parsed.ssh,
    auth: params.auth.mode === 'keyFile' ? 'keyfile' : 'agent',
    ...(params.auth.mode === 'keyFile' ? { identityFile: params.auth.privateKeyPath } : {}),
  };
  if (params.label === 'relay.runtime.install') {
    const installed = await installOrUpdateRelayRuntimeDefault({
      target: {
        kind: 'ssh',
        ssh,
      },
      channel: params.parsed.channel,
      mode: params.parsed.relayRuntime?.mode ?? 'user',
      env: params.parsed.relayRuntime?.env,
      selfHostRelayBinaryOverride: params.parsed.relayRuntime?.selfHostRelayBinaryOverride,
    }, {
      ensureRemoteCliInstalled: false,
    });
    return {
      ok: true,
      data: {
        relayUrl: installed.relayUrl,
        mode: installed.mode,
      },
    };
  }

  const command = buildRemoteBootstrapCommand({
    label: params.label,
    channel: params.parsed.channel,
    serverUrl: params.parsed.relay.relayUrl,
    webappUrl: params.parsed.relay.webappUrl ?? params.parsed.relay.relayUrl,
    publicServerUrl: params.parsed.relay.publicRelayUrl,
    daemonServiceMode: params.parsed.serviceMode,
    data: params.data,
  });
  const authStatus = params.label === 'auth.status';
  const result = await runRemoteJson(ssh, command, params.knownHostsMode, authStatus);
  return normalizeRemoteBootstrapCliJsonResult(result, authStatus);
}

async function runRemoteJson(
  ssh: SshConnectionConfig,
  remoteCommand: string,
  knownHostsMode: 'app' | 'system',
  authStatus: boolean,
): Promise<unknown> {
  const result = await runRemoteText(ssh, remoteCommand, knownHostsMode);
  const parsed = parseFirstJsonObject(result.stdout);
  if (result.signal || (result.status !== 0 && !(authStatus && isRemoteBootstrapUnauthenticatedCliResult(parsed, result.status)))) {
    throw new Error(redactSshText(result.stderr || `SSH command failed for ${ssh.target}.`));
  }
  return parsed;
}

async function runRemoteText(
  ssh: SshConnectionConfig,
  remoteCommand: string,
  knownHostsMode: 'app' | 'system',
): Promise<CommandExecutionResult> {
  const invocation = buildSshCommand({
    target: ssh.target,
    port: ssh.port,
    auth: {
      kind: ssh.auth,
      identityFile: ssh.identityFile,
    },
    knownHosts: knownHostsMode === 'app'
      ? { mode: 'app', path: ssh.knownHostsPath || resolveDefaultKnownHostsPath() }
      : { mode: 'system' },
    remoteCommand,
  });
  const result = await runCommandCapture({
    command: invocation.command,
    args: invocation.args,
  });
  return result;
}
