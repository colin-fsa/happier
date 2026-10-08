import { describe, expect, it, vi } from 'vitest';
import { createSetupCliChoicePromptData, SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskEvent } from '@happier-dev/protocol';

import type { SystemTaskRunState } from '@/components/systemTasks/types';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import {
    SETUP_STAGES,
    deriveSetupStageModel,
    type SetupLocalFacts,
} from './setupStageModel';

const RELAY = 'relay.example.test';

function facts(overrides: Partial<SetupLocalFacts> = {}): SetupLocalFacts {
    return {
        relayDisplayName: RELAY,
        entry: 'setup',
        startFailure: null,
        ...overrides,
    };
}

function progress(stepId: string, tsMs: number): SystemTaskEvent {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        taskId: 'task_1',
        tsMs,
        type: 'progress',
        stepId,
        message: `m:${stepId}`,
    };
}

function runState(overrides: Partial<SystemTaskRunState> = {}): SystemTaskRunState {
    const events = overrides.events ?? [];
    const latest = events[events.length - 1] ?? null;
    return {
        taskId: 'task_1',
        status: 'running',
        currentStepId: latest?.stepId ?? null,
        latestMessage: latest?.message ?? null,
        awaitingInput: false,
        cancelRequested: false,
        events,
        result: null,
        ...overrides,
    };
}

const FRACTION_STEPS = SETUP_STAGES.map((_, index) => index / SETUP_STAGES.length);

describe('deriveSetupStageModel (INV3 — milestone-quantised)', () => {
    it('shows only reported transfer bytes and clears them when the download phase ends', () => {
        const event = { ...progress('setup.thisComputer.ensureCli', 1), type: 'cli.acquisition.progress' };
        const model = (data: SystemTaskEvent['data']) => deriveSetupStageModel(runState({ events: [{ ...event, data }] }), facts());
        expect(model({ phase: 'downloading', receivedBytes: 1024 }).downloadProgress).toEqual({
            key: 'setupSurface.acquisitionDownloadBytes', params: { received: '1.0 KB' },
        });
        expect(model({ phase: 'downloading', receivedBytes: 1024, totalBytes: 2048 }).downloadProgress).toEqual({
            key: 'setupSurface.acquisitionDownloadBytesTotal', params: { received: '1.0 KB', total: '2.0 KB' },
        });
        const invalidOrLater: SystemTaskEvent['data'][] = [{ phase: 'unpacking' }, { phase: 'future', receivedBytes: 1024 }, { phase: 'downloading', receivedBytes: -1 }];
        for (const data of invalidOrLater) {
            expect(model(data).downloadProgress).toBeUndefined();
            expect(model(data).completedFraction).toBe(0);
        }
    });

    it('shows acquisition work during inspection without treating inspection success as setup success', () => {
        const events: SystemTaskEvent[] = [{ ...progress('setup.thisComputer.ensureCli', 1), type: 'cli.acquisition.progress', data: { phase: 'unpacking' } }];
        const active = deriveSetupStageModel(runState({ events }), facts({ entry: 'checking' }));
        expect(active.statusSentence).toBe('setupSurface.acquisitionUnpackingStatus');
        expect(active.completedFraction).toBe(0);
        const settled = deriveSetupStageModel(runState({ events, status: 'succeeded', result: { protocolVersion: 1, taskId: 'task_1', ok: true } }), facts({ entry: 'checking' }));
        expect(settled.currentIndex).toBe(0);
        expect(settled.phase).toBe('checking');
    });

    it('advances the fraction only when a later stage is first observed, never within a stage', () => {
        const withinPrepare = deriveSetupStageModel(runState({
            events: [progress('setup.thisComputer.ensureCli', 30)],
        }), facts());
        const stillWithinPrepare = deriveSetupStageModel(runState({
            events: [
                progress('setup.thisComputer.ensureCli', 30),
                progress('setup.thisComputer.inspectService', 60),
                progress('setup.thisComputer.serviceConsent', 90),
            ],
        }), facts());
        const intoConnect = deriveSetupStageModel(runState({
            events: [
                progress('setup.thisComputer.ensureCli', 30),
                progress('setup.thisComputer.inspectService', 60),
                progress('setup.thisComputer.configureRelay', 120),
            ],
        }), facts());

        expect(withinPrepare.completedFraction).toBe(0);
        expect(stillWithinPrepare.completedFraction).toBe(0);
        expect(intoConnect.completedFraction).toBe(1 / SETUP_STAGES.length);
        expect(intoConnect.currentIndex).toBe(1);
    });

    it('only ever yields one of the milestone fractions', () => {
        const sequences: string[][] = [
            [],
            ['setup.thisComputer.ensureCli'],
            ['setup.thisComputer.ensureCli', 'setup.thisComputer.checkAuth'],
            ['setup.thisComputer.checkAuth', 'setup.thisComputer.auth.request', 'setup.thisComputer.auth.wait'],
            ['setup.thisComputer.installService', 'setup.thisComputer.startService'],
            ['setup.thisComputer.restartService'],
            ['setup.thisComputer.somethingNew'],
        ];
        for (const stepIds of sequences) {
            const model = deriveSetupStageModel(runState({
                events: stepIds.map((stepId, index) => progress(stepId, (index + 1) * 10)),
            }), facts());
            expect(FRACTION_STEPS).toContain(model.completedFraction);
            expect(model.completedFraction).toBeLessThan(1);
        }
    });

    it('never moves backwards when an earlier-stage step arrives after a later one', () => {
        const model = deriveSetupStageModel(runState({
            events: [
                progress('setup.thisComputer.installService', 240),
                progress('setup.thisComputer.checkAuth', 250),
            ],
        }), facts());
        expect(model.currentIndex).toBe(SETUP_STAGES.indexOf('service'));
    });

    it('places the PATH step in the service stage and never lets it move the ring back', () => {
        // PATH is ancillary (R6): its failure report arrives late in the run, after the service
        // work, and it must neither look like a new stage nor undo one the executor reached.
        expect(deriveSetupStageModel(runState({
            events: [progress('setup.thisComputer.pathExposure', 300)],
        }), facts()).currentIndex).toBe(SETUP_STAGES.indexOf('service'));

        expect(deriveSetupStageModel(runState({
            events: [
                progress('setup.thisComputer.installService', 240),
                progress('setup.thisComputer.pathExposure', 300),
            ],
        }), facts()).currentIndex).toBe(SETUP_STAGES.indexOf('service'));
    });

    it('shows no progress before a real task event, whatever the ambient inspection found', () => {
        // The ambient inspection resolving is not a setup milestone: `prepare` also covers service
        // inspection and consent, and the inspection may have resolved an override CLI the
        // executor will refuse. Only the executor's own events may move the ring.
        const noRun = deriveSetupStageModel(null, facts());
        const startedRun = deriveSetupStageModel(runState({ events: [] }), facts());

        expect(noRun.currentIndex).toBe(0);
        expect(noRun.completedFraction).toBe(0);
        expect(startedRun.currentIndex).toBe(0);
        expect(startedRun.completedFraction).toBe(0);
    });

    it('opens the verify stage on the executor result and never claims completion', () => {
        const succeededRun = runState({
            status: 'succeeded',
            events: [progress('setup.thisComputer.startService', 240)],
            result: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', ok: true, data: { machineId: 'm' } },
        });
        const starting = deriveSetupStageModel(runState({
            events: [progress('setup.thisComputer.startService', 240)],
        }), facts());
        const succeeded = deriveSetupStageModel(succeededRun, facts());

        expect(starting.currentIndex).toBe(SETUP_STAGES.indexOf('service'));
        expect(starting.completedFraction).toBe(SETUP_STAGES.indexOf('service') / SETUP_STAGES.length);
        // Task success is never "ready": it is the verify stage in progress. The host reveals the
        // shell the moment readiness is proven, so the surface has no success state to reach.
        expect(succeeded.phase).toBe('working');
        expect(succeeded.currentIndex).toBe(SETUP_STAGES.indexOf('verify'));
        expect(succeeded.completedFraction).toBe((SETUP_STAGES.length - 1) / SETUP_STAGES.length);
        expect(succeeded.statusSentence).toEqual({ key: 'setupSurface.stageVerifyStatus', params: { relay: RELAY } });
    });

    it('fails closed with an honest sentence when the executor finished but the machine does not answer (INV10)', () => {
        const model = deriveSetupStageModel(runState({
            status: 'succeeded',
            events: [progress('setup.thisComputer.startService', 240)],
            result: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', ok: true, data: { machineId: 'm' } },
        }), facts({ verification: 'machine_unreachable' }));

        expect(model.phase).toBe('blocked');
        expect(model.completedFraction).toBeLessThan(1);
        expect(model.blocked).toMatchObject({ code: 'machine_unreachable', canceled: false });
        expect(model.statusSentence).toEqual({ key: 'setupSurface.unreachableStatus', params: { relay: RELAY } });
    });

    it('fails closed with its own sentence when the executor finished but the runtime did not converge (INV8)', () => {
        // The service command succeeded and the machine was never asked anything, because the
        // re-read runtime is not this relay's daemon. Leaving the surface "working" here was a
        // permanent stall with no Retry; the named failure is what makes it recoverable.
        const model = deriveSetupStageModel(runState({
            status: 'succeeded',
            events: [progress('setup.thisComputer.startService', 240)],
            result: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', ok: true, data: { machineId: 'm' } },
        }), facts({ verification: 'runtime_not_converged' }));

        expect(model.phase).toBe('blocked');
        expect(model.blocked).toMatchObject({ code: 'runtime_not_converged', canceled: false });
        expect(model.statusSentence).toEqual({ key: 'setupSurface.notConvergedStatus', params: { relay: RELAY } });
    });

    it('never reports completion from task success while the re-read has not proven readiness', () => {
        const model = deriveSetupStageModel(runState({
            status: 'succeeded',
            events: [],
            result: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', ok: true, data: { machineId: 'm' } },
        }), facts({ verification: 'pending' }));
        expect(model.phase).toBe('working');
        expect(model.completedFraction).toBeLessThan(1);
    });

    it('holds the fraction and speaks calm mapped copy when the task fails, keeping the raw text for details', () => {
        const model = deriveSetupStageModel(runState({
            status: 'failed',
            events: [progress('setup.thisComputer.installService', 240)],
            result: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1',
                ok: false,
                error: { code: 'service_install_blocked', message: 'systemd user bus unavailable' },
            },
        }), facts());

        expect(model.phase).toBe('blocked');
        // The raw executor text stays reachable as a diagnostic, never as the headline.
        expect(model.blocked).toEqual({ code: 'service_install_blocked', message: 'systemd user bus unavailable', canceled: false });
        expect(model.completedFraction).toBe(SETUP_STAGES.indexOf('service') / SETUP_STAGES.length);
        expect(model.statusSentence).toBe('setupSurface.blockedServiceConflictStatus');
    });

    it('falls back to the calm generic sentence for a code it does not know', () => {
        const model = deriveSetupStageModel(runState({
            status: 'failed',
            events: [],
            result: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1',
                ok: false,
                error: { code: 'something_new_from_the_executor', message: 'ENOENT: /usr/lib/systemd not found' },
            },
        }), facts());

        expect(model.statusSentence).toBe('setupSurface.blockedStatusFallback');
        expect(model.blocked?.message).toBe('ENOENT: /usr/lib/systemd not found');
    });

    it('names the failed service-install step from Details instead of calling it a setup read', () => {
        const model = deriveSetupStageModel(runState({
            status: 'failed',
            events: [progress('setup.thisComputer.installService', 240)],
            result: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1',
                ok: false,
                error: { code: 'cli_command_failed', message: 'Access is denied.' },
            },
        }), facts());

        expect(model.statusSentence).toEqual({
            key: 'setupSurface.blockedStepStatus',
            params: { step: 'setupSurface.stageServiceStatus' },
        });
        expect(model.blocked?.message).toBe('Access is denied.');
    });

    it.each([
        ['setup.thisComputer.ensureCli', 'cli_command_failed', 'settings.machineSetupStageInstall'],
        ['setup.thisComputer.configureRelay', 'cli_command_failed', 'settings.machineSetupStageConnect'],
        ['setup.thisComputer.auth.request', 'invalid_cli_response', 'settings.machineSetupStageConnect'],
        ['setup.thisComputer.auth.wait', 'cli_command_failed', 'settings.machineSetupStageConnect'],
        ['setup.thisComputer.startService', 'invalid_status_result', 'setupSurface.stageServiceStartStatus'],
        ['setup.thisComputer.restartService', 'cli_command_failed', 'setupSurface.stageServiceRestartStatus'],
    ])('names the current failed step %s even when the last milestone is different', (stepId, code, step) => {
        const model = deriveSetupStageModel(runState({
            status: 'failed',
            currentStepId: stepId,
            events: [progress('setup.thisComputer.installService', 240)],
            result: { protocolVersion: 1, taskId: 'task_1', ok: false, error: { code, message: 'diagnostic' } },
        }), facts());
        expect(model.statusSentence).toEqual({ key: 'setupSurface.blockedStepStatus', params: { step } });
    });

    it('keeps reading setup for an inspection failure, but never guesses a missing or unknown setup step', () => {
        const failed = runState({
            status: 'failed',
            result: { protocolVersion: 1, taskId: 'task_1', ok: false, error: { code: 'cli_command_failed', message: 'diagnostic' } },
        });
        expect(deriveSetupStageModel(failed, facts({ entry: 'checking' })).statusSentence).toBe('setupSurface.blockedCliFailedStatus');
        for (const currentStepId of [null, 'setup.thisComputer.futureStep']) {
            expect(deriveSetupStageModel({ ...failed, currentStepId }, facts()).statusSentence).toBe('setupSurface.blockedStatusFallback');
        }
    });

    it('keeps acquisition failure phases more specific than the enclosing setup step', () => {
        const model = deriveSetupStageModel(runState({
            status: 'failed',
            events: [progress('setup.thisComputer.ensureCli', 1)],
            result: { protocolVersion: 1, taskId: 'task_1', ok: false, error: { code: 'cli_acquisition_verifying_failed', message: 'bad signature' } },
        }), facts());
        expect(model.statusSentence).toBe('setupSurface.acquisitionVerificationFailed');
    });

    it('maps every executor failure code the setup corridor can raise', () => {
        const mapped: Readonly<Record<string, string>> = {
            service_install_blocked: 'setupSurface.blockedServiceConflictStatus',
            service_consent_declined: 'setupSurface.blockedConsentDeclinedStatus',
            account_consent_declined: 'setupSurface.blockedAccountKeptStatus',
            account_changed_during_setup: 'setupSurface.blockedAccountChangedStatus',
            pairing_declined: 'setupSurface.blockedPairingDeclinedStatus',
            machine_id_unavailable: 'setupSurface.blockedPairingIncompleteStatus',
            cli_below_setup_floor: 'setupSurface.blockedCliOutdatedStatus',
            cli_override_below_setup_floor: 'setupSurface.blockedCliOutdatedStatus',
            cli_own_missing: 'setupSurface.blockedCliOwnMissingStatus',
            cli_command_timeout: 'setupSurface.blockedCliUnresponsiveStatus',
            cli_spawn_failed: 'setupSurface.blockedCliUnavailableStatus',
            first_party_component_install_failed: 'setupSurface.acquisitionInstallFailed',
            cli_acquisition_resolvingRelease_failed: 'setupSurface.acquisitionReleaseFailed',
            cli_acquisition_downloading_failed: 'setupSurface.acquisitionDownloadFailed',
            cli_acquisition_verifying_failed: 'setupSurface.acquisitionVerificationFailed',
            cli_acquisition_unpacking_failed: 'setupSurface.acquisitionInstallFailed',
            cli_acquisition_installing_failed: 'setupSurface.acquisitionInstallFailed',
            cli_acquisition_finalizing_failed: 'setupSurface.acquisitionInstallFailed',
            cli_acquisition_checkingCli_failed: 'setupSurface.blockedCliUnavailableStatus',
            cli_acquisition_checkingDaemon_failed: 'setupSurface.blockedCliFailedStatus',
            system_task_start_failed: 'setupSurface.blockedCliUnavailableStatus',
            cli_command_failed: 'setupSurface.blockedCliFailedStatus',
            invalid_cli_response: 'setupSurface.blockedCliFailedStatus',
            invalid_status_result: 'setupSurface.blockedCliFailedStatus',
        };
        for (const [code, key] of Object.entries(mapped)) {
            const model = deriveSetupStageModel(null, facts({ startFailure: { code, message: 'raw diagnostic text' } }));
            expect(model.statusSentence).toBe(key);
            expect(JSON.stringify(model.statusSentence)).not.toContain('raw diagnostic');
        }
    });

    it('keeps the person\'s own too-old command line theirs: one sentence with the exact update command, never Update (R12)', () => {
        const code = 'cli_own_below_setup_floor';
        const named = deriveSetupStageModel(null, facts({
            startFailure: { code, message: 'Your Happier CLI at /usr/local/bin/happier is version 0.2.5' },
            ownCliUpdateCommand: 'npm install -g @happier-dev/cli@latest',
        }));
        expect(named.statusSentence).toEqual({
            key: 'setupSurface.blockedCliOwnOutdatedStatus',
            params: { command: 'npm install -g @happier-dev/cli@latest' },
        });

        // Where it came from is unknown: it says so without inventing a command.
        const unknown = deriveSetupStageModel(null, facts({ startFailure: { code, message: 'old' } }));
        expect(unknown.statusSentence).toBe('setupSurface.blockedCliOwnOutdatedUnknownStatus');
    });

    it('names the update command the run\'s own question named, when the kept CLI never answered a read (R12)', () => {
        // The app-open read failed on that CLI, so there are no ambient facts; the executor's
        // one-CLI question in this run named where it came from.
        const run = runState({
            status: 'failed',
            events: [{
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1',
                tsMs: 1,
                type: 'prompt',
                stepId: 'setup.thisComputer.cliChoice',
                message: 'Should Happier manage the command line on this computer?',
                data: createSetupCliChoicePromptData({
                    command: '/usr/local/bin/happier',
                    version: null,
                    origin: 'npm',
                    removalCommand: 'npm uninstall -g @happier-dev/cli',
                    updateCommand: 'npm install -g @happier-dev/cli@latest',
                    belowSetupFloor: true,
                    missing: false,
                    keepBlockedBy: null,
                }),
            }],
            result: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', ok: false, error: { code: 'cli_own_below_setup_floor', message: 'did not report a version' } },
        });

        expect(deriveSetupStageModel(run, facts()).statusSentence).toEqual({
            key: 'setupSurface.blockedCliOwnOutdatedStatus',
            params: { command: 'npm install -g @happier-dev/cli@latest' },
        });
    });

    it('says a dismissed one-CLI question stopped setup before anything changed (R12)', () => {
        const model = deriveSetupStageModel(null, facts({ startFailure: { code: 'cli_choice_unanswered', message: 'stopped' } }));
        expect(model.statusSentence).toBe('setupSurface.blockedCliChoiceStatus');
    });

    it('names the channel when this computer follows a default channel with no CLI new enough yet (RV-9)', () => {
        // The app adopted the default channel's CLI (D2); that channel's newest release is below
        // setup's floor, so the one sentence says which channel it is waiting on.
        const code = 'cli_default_channel_below_setup_floor';
        const named = deriveSetupStageModel(null, facts({
            startFailure: { code, message: 'default channel stable, newest 0.2.12' },
            cliChannel: 'stable',
        }));
        expect(named.statusSentence).toEqual({
            key: 'setupSurface.blockedCliChannelOutdatedStatus',
            params: { channel: 'machine.thisComputer.cliChannelStable' },
        });
        expect(named.blocked?.message).toBe('default channel stable, newest 0.2.12');

        // With the channel's newest version from the CLI's own update check, it names that too.
        const versioned = deriveSetupStageModel(null, facts({
            startFailure: { code, message: 'default channel stable, newest 0.2.10' },
            cliChannel: 'stable',
            cliLatestVersion: '0.2.10',
        }));
        expect(versioned.statusSentence).toEqual({
            key: 'setupSurface.blockedCliChannelOutdatedVersionStatus',
            params: { channel: 'machine.thisComputer.cliChannelStable', version: '0.2.10' },
        });

        // Without the channel fact it still says why, without naming one.
        const unnamed = deriveSetupStageModel(null, facts({ startFailure: { code, message: null } }));
        expect(unnamed.statusSentence).toBe('setupSurface.blockedCliOutdatedStatus');
    });

    it('treats a start failure as blocked before any task exists', () => {
        const model = deriveSetupStageModel(null, facts({
            startFailure: { code: 'system_task_start_failed', message: 'hsetup is missing' },
        }));
        expect(model.phase).toBe('blocked');
        expect(model.blocked).toEqual({ code: 'system_task_start_failed', message: 'hsetup is missing', canceled: false });
    });

    it('is the checking phase when no task exists and the entry context is checking', () => {
        const model = deriveSetupStageModel(null, facts({ entry: 'checking' }));
        expect(model.phase).toBe('checking');
        expect(model.completedFraction).toBe(0);
        expect(model.title).toBe('setupSurface.checkingTitle');
    });
});

describe('deriveSetupStageModel copy and announcements', () => {
    it('names the real relay in the connect and verify sentences', () => {
        const connect = deriveSetupStageModel(runState({
            events: [progress('setup.thisComputer.configureRelay', 120)],
        }), facts());
        const verify = deriveSetupStageModel(runState({
            status: 'succeeded',
            events: [progress('setup.thisComputer.startService', 240)],
            result: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', ok: true, data: { machineId: 'm' } },
        }), facts());

        expect(connect.statusSentence).toEqual({ key: 'setupSurface.stageConnectStatus', params: { relay: RELAY } });
        expect(verify.statusSentence).toEqual({ key: 'setupSurface.stageVerifyStatus', params: { relay: RELAY } });
    });

    it('names the account as well as the relay while connecting, when the app knows it (R17)', () => {
        const connect = deriveSetupStageModel(runState({
            events: [progress('setup.thisComputer.configureRelay', 120)],
        }), facts({ accountLabel: 'alice' }));

        expect(connect.statusSentence).toEqual({ key: 'setupSurface.stageConnectStatusAs', params: { relay: RELAY, account: 'alice' } });
    });

    it('names the service step the executor is actually on: install, start and restart differ', () => {
        const sentence = (...stepIds: string[]) => deriveSetupStageModel(
            runState({ events: stepIds.map((stepId, index) => progress(stepId, 100 + index)) }),
            facts(),
        ).statusSentence;

        expect(sentence('setup.thisComputer.installService')).toBe('setupSurface.stageServiceStatus');
        expect(sentence('setup.thisComputer.installService', 'setup.thisComputer.startService')).toBe('setupSurface.stageServiceStartStatus');
        // A relay move only reconfigures and restarts an existing service; it installs nothing.
        expect(sentence('setup.thisComputer.configureRelay', 'setup.thisComputer.restartService')).toBe('setupSurface.stageServiceRestartStatus');
        // The ancillary PATH report keeps the sentence of the service step it ran beside.
        expect(sentence('setup.thisComputer.restartService', 'setup.thisComputer.pathExposure')).toBe('setupSurface.stageServiceRestartStatus');
    });

    it('titles a run that moves this computer to another relay as a move, not a first setup', () => {
        const run = runState({ events: [progress('setup.thisComputer.restartService', 100)] });

        expect(deriveSetupStageModel(run, facts()).title).toBe('setupSurface.workingTitle');
        expect(deriveSetupStageModel(run, facts({ relayMove: true })).title).toEqual({
            key: 'setupSurface.movingTitle', params: { relay: RELAY },
        });
        // A failure keeps its own honest title whatever the run was for.
        const failed = runState({
            status: 'failed',
            events: [progress('setup.thisComputer.restartService', 100)],
            result: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', ok: false, error: { code: 'cli_command_failed', message: 'x' } },
        });
        expect(deriveSetupStageModel(failed, facts({ relayMove: true })).title).toBe('setupSurface.blockedTitle');
    });

    it('announces the step position, never a percentage', () => {
        for (const stepId of ['setup.thisComputer.ensureCli', 'setup.thisComputer.configureRelay', 'setup.thisComputer.installService', 'setup.thisComputer.restartService']) {
            const model = deriveSetupStageModel(runState({ events: [progress(stepId, 10)] }), facts());
            expect(model.stepAnnouncement).toEqual({
                key: 'setupSurface.stepOfTotal',
                params: { step: model.currentIndex + 1, total: SETUP_STAGES.length },
            });
            expect(JSON.stringify(model.stepAnnouncement)).not.toMatch(/%|percent/i);
        }
    });
});
