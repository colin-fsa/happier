import { t, type TranslationKey, type TranslationKeyNoParams } from '@/text';

/**
 * The setup executor's three service steps, each with its own name. The executor chooses one
 * (`resolveServiceAction` in `apps/bootstrap/src/systemTasks/kinds/setupThisComputer.ts`): it
 * installs only when there is no service or a consented replacement, restarts a running one it
 * reconfigured (a relay move), and otherwise starts it. This is the ONE step → copy table for them,
 * read by this label resolver and by the setup surface's status sentence (`setupStageModel.ts`),
 * so neither can collapse a restart back into "installing".
 */
export const SETUP_SERVICE_STEP_STATUS_KEY = {
    'setup.thisComputer.installService': 'setupSurface.stageServiceStatus',
    'setup.thisComputer.startService': 'setupSurface.stageServiceStartStatus',
    'setup.thisComputer.restartService': 'setupSurface.stageServiceRestartStatus',
} as const satisfies Readonly<Record<string, TranslationKeyNoParams>>;

const SYSTEM_TASK_STEP_TRANSLATION_KEYS: Readonly<Record<string, TranslationKey>> = {
    'task.step.prepare': 'settings.systemTaskStepPrepare',
    'task.step.installRuntime': 'settings.systemTaskStepInstallRuntime',
    'task.step.finish': 'settings.systemTaskStepFinish',
    'install.runtime': 'settings.systemTaskStepInstallRuntime',
    'setup.thisComputer.cliChoice': 'settings.machineSetupStageInstall',
    'setup.thisComputer.ensureCli': 'settings.machineSetupStageInstall',
    'setup.thisComputer.inspectService': 'settings.machineSetupStageConnect',
    'setup.thisComputer.serviceConsent': 'settings.machineSetupStageConnect',
    'setup.thisComputer.checkAuth': 'settings.machineSetupStageConnect',
    'setup.thisComputer.configureRelay': 'settings.machineSetupStageConnect',
    'setup.thisComputer.auth.request': 'settings.machineSetupStageConnect',
    'setup.thisComputer.auth.wait': 'settings.machineSetupStageConnect',
    ...SETUP_SERVICE_STEP_STATUS_KEY,
    // PATH is its own ancillary step (R6), and the settings row that repairs it already owns this
    // sentence — one name for one thing, wherever the person meets it.
    'setup.thisComputer.pathExposure': 'machine.cliPath.addTitle',
    'relay.drift.repair.start': 'server.relayDrift.progressStepPrepare',
    'ssh.trust': 'settings.machineSetupStageConnect',
    'ssh.hostTrust': 'settings.machineSetupStageConnect',
    'ssh.auth.request': 'settings.machineSetupStageConnect',
    'ssh.auth.approval': 'settings.machineSetupStageConnect',
    'ssh.auth.wait': 'settings.machineSetupStageConnect',
    'ssh.installCli': 'settings.machineSetupStageInstall',
    'relay.runtime.install': 'settings.machineSetupStageInstall',
    'ssh.complete': 'settings.machineSetupStageFinish',
};

export function resolveSystemTaskStepLabel(
    stepId: string | null,
    options?: Readonly<{ fallbackToStepId?: boolean }>,
): string | null {
    if (!stepId) {
        return null;
    }

    const translationKey = SYSTEM_TASK_STEP_TRANSLATION_KEYS[stepId];
    return translationKey ? t(translationKey) : options?.fallbackToStepId === false ? null : stepId;
}
