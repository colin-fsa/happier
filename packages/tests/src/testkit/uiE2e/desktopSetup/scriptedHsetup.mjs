#!/usr/bin/env node
/**
 * A scripted stand-in for the bundled `hsetup system-tasks run`, for visual QA of the desktop setup
 * surface. It speaks the same one-line-in / JSON-lines-out contract `desktopSystemTaskHost.ts`
 * relays, and answers from the scenario file named by `HAPPIER_E2E_SETUP_SCENARIO_FILE`, which the
 * spec rewrites between states:
 *
 *   { "relayUrl": string, "status": "hold" | "unconfigured" | "otherAccount", "setup": "hold" | "fail" }
 *
 * It never touches the computer: no CLI, no service, no files outside the scenario it reads.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = 1;
const scenario = JSON.parse(readFileSync(process.env.HAPPIER_E2E_SETUP_SCENARIO_FILE, 'utf8'));
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const event = (type, stepId, message, data) => write({
    protocolVersion: PROTOCOL_VERSION, taskId: 'scripted', tsMs: Date.now(), type, stepId, message, ...(data ? { data } : {}),
});
const hold = () => setInterval(() => {}, 1 << 30);

function statusFacts(kind) {
    const relay = scenario.relayUrl;
    const signedInElsewhere = kind === 'otherAccount';
    return {
        serviceInstalled: signedInElsewhere,
        daemonRunning: signedInElsewhere,
        needsAuth: !signedInElsewhere,
        machineId: signedInElsewhere ? 'machine-scripted' : null,
        acquisition: { command: '/home/user/.happier/cli/current/happier', provenance: 'managed', version: '0.2.13', channel: 'stable' },
        server: { activeServerId: 'custom', serverUrl: relay, publicServerUrl: relay, localServerUrl: null, comparableKey: relay },
        auth: {
            authenticated: signedInElsewhere,
            machineRegistered: signedInElsewhere,
            machineId: signedInElsewhere ? 'machine-scripted' : null,
            needsAuth: !signedInElsewhere,
            accountId: signedInElsewhere ? 'acct_someone_else_0123' : null,
            credentialState: signedInElsewhere ? 'valid' : 'missing',
            validatedAccountId: signedInElsewhere ? 'acct_someone_else_0123' : null,
            accountLabel: signedInElsewhere ? 'sam' : null,
        },
        service: { installed: signedInElsewhere, running: signedInElsewhere, targetMode: signedInElsewhere ? 'default-following' : null, autostart: 'at-login' },
        daemon: { running: signedInElsewhere, startedWithCliVersion: '0.2.13', serviceManaged: signedInElsewhere, serviceLabel: null },
        runtimeConvergence: {
            controlReachable: signedInElsewhere,
            serviceOwnsRunningDaemon: signedInElsewhere,
            machineIdMatches: signedInElsewhere,
            cliVersionMatches: signedInElsewhere,
        },
        cli: { update: null },
    };
}

const lines = createInterface({ input: process.stdin });
lines.once('line', (line) => {
    const spec = JSON.parse(line);
    if (spec.kind === 'daemon.service.status.v1') {
        if (scenario.status === 'hold') {
            event('cli.acquisition.progress', 'setup.thisComputer.ensureCli', 'Downloading', {
                phase: 'downloading', receivedBytes: 18_874_368, totalBytes: 41_943_040,
            });
            hold();
            return;
        }
        write({ protocolVersion: PROTOCOL_VERSION, taskId: 'scripted', ok: true, data: statusFacts(scenario.status) });
        process.exit(0);
    }
    if (spec.kind === 'setup.thisComputer.v1') {
        event('progress', 'setup.thisComputer.ensureCli', 'Command line ready');
        event('progress', 'setup.thisComputer.configureRelay', 'Configuring relay');
        if (scenario.setup === 'hold') {
            hold();
            return;
        }
        event('progress', 'setup.thisComputer.installService', 'Installing service');
        write({
            protocolVersion: PROTOCOL_VERSION, taskId: 'scripted', ok: false,
            error: { code: 'cli_command_failed', message: 'Access is denied.' },
        });
        process.exit(0);
    }
    write({ protocolVersion: PROTOCOL_VERSION, taskId: 'scripted', ok: false, error: { code: 'unsupported_in_visual_qa', message: `No scripted answer for ${spec.kind}.` } });
    process.exit(0);
});
