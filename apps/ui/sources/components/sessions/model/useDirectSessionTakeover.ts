import * as React from 'react';
import type { DirectSessionImportOperation } from '@happier-dev/protocol';

import { showDirectSessionTakeoverDialog } from '@/components/sessions/directSessions/takeover/showDirectSessionTakeoverDialog';
import { Modal } from '@/modal';
import type { UseDirectSessionRuntimeResult } from '@/components/sessions/model/useDirectSessionRuntime';
import { machineDirectSessionTakeover, machineDirectSessionTakeoverPersistStart, machineDirectSessionImportStatus, machineDirectSessionImportCancel } from '@/sync/ops/machineDirectSessions';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@/sync/runtime/rpcErrors';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { isHostVisible, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';

type DirectTakeoverMode = 'direct' | 'persisted';

type UseDirectSessionTakeoverParams = Readonly<{
    sessionId: string;
    hasWriteAccess: boolean;
    directSessionRuntime: Pick<UseDirectSessionRuntimeResult, 'directSessionLink' | 'status' | 'refreshNow'>;
}>;

type UseDirectSessionTakeoverResult = Readonly<{
    takeoverInFlight: DirectTakeoverMode | null;
    importOperation: DirectSessionImportOperation | null;
    importStatusError: string | null;
    cancelImport: () => Promise<void>;
    refreshImport: () => Promise<void>;
    requestTakeover: (mode: DirectTakeoverMode, options?: Readonly<{ forceStop?: boolean; promptForForceStop?: boolean }>) => Promise<boolean>;
    ensureReadyForSend: () => Promise<boolean>;
}>;

function isImportActive(operation: DirectSessionImportOperation | null): boolean {
    return operation?.state === 'running' || operation?.state === 'cancelling';
}

function areOperationsEqual(left: DirectSessionImportOperation | null, right: DirectSessionImportOperation | null): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return left.sessionId === right.sessionId && left.state === right.state && left.phase === right.phase
        && left.importedCount === right.importedCount && left.totalCount === right.totalCount
        && left.canCancel === right.canCancel && left.error === right.error;
}

export function useDirectSessionTakeover(params: UseDirectSessionTakeoverParams): UseDirectSessionTakeoverResult {
    const [requestInFlight, setRequestInFlight] = React.useState<DirectTakeoverMode | null>(null);
    const [importOperation, setImportOperation] = React.useState<DirectSessionImportOperation | null>(null);
    const [importStatusError, setImportStatusError] = React.useState<string | null>(null);
    const operationRef = React.useRef<DirectSessionImportOperation | null>(null);
    const importAddressRef = React.useRef<{ sessionId: string; machineId: string } | null>(null);
    const requestInFlightRef = React.useRef(false);
    const statusInFlightRef = React.useRef<Promise<void> | null>(null);
    const terminalHandledRef = React.useRef(false);
    const terminalRefreshingRef = React.useRef(false);
    const pendingImportRef = React.useRef<((ready: boolean) => void) | null>(null);
    const currentParamsRef = React.useRef(params);
    currentParamsRef.current = params;
    // Conversion removes the direct link before the daemon publishes its terminal snapshot.
    const machineId = importAddressRef.current?.sessionId === params.sessionId
        ? importAddressRef.current.machineId
        : params.directSessionRuntime.directSessionLink?.machineId;
    const owner = params.sessionId;
    const mountedOwnerRef = React.useRef<string | null>(owner);

    React.useEffect(() => {
        mountedOwnerRef.current = owner;
        operationRef.current = null;
        importAddressRef.current = null;
        terminalHandledRef.current = false;
        terminalRefreshingRef.current = false;
        requestInFlightRef.current = false;
        statusInFlightRef.current = null;
        setRequestInFlight(null);
        setImportOperation(null);
        setImportStatusError(null);
        return () => {
            mountedOwnerRef.current = null;
            pendingImportRef.current?.(false);
            pendingImportRef.current = null;
        };
    }, [owner]);

    const acceptOperation = React.useCallback(async (operation: DirectSessionImportOperation | null) => {
        if (mountedOwnerRef.current !== owner) return;
        const previous = operationRef.current;
        if (operation && machineId && importAddressRef.current?.sessionId !== params.sessionId) {
            importAddressRef.current = { sessionId: params.sessionId, machineId };
        }
        if (!areOperationsEqual(previous, operation)) {
            operationRef.current = operation;
            setImportOperation(operation);
        }
        if (!operation && isImportActive(previous)) {
            importAddressRef.current = null;
            setImportStatusError(t('chatFooter.directImportStatusUnavailable'));
            pendingImportRef.current?.(false);
            pendingImportRef.current = null;
        } else if (operation) {
            setImportStatusError(null);
        }
        if (!operation || isImportActive(operation)) {
            terminalHandledRef.current = false;
            return;
        }
        if (terminalHandledRef.current) return;
        terminalHandledRef.current = true;
        terminalRefreshingRef.current = true;
        const pendingImport = pendingImportRef.current;
        setRequestInFlight('persisted');
        let refreshed = false;
        try {
            await Promise.all([
                currentParamsRef.current.directSessionRuntime.refreshNow(),
                sync.refreshSessionMessages(params.sessionId),
                sync.refreshSessions(),
            ]);
            refreshed = true;
        } catch (error) {
            if (mountedOwnerRef.current === owner) {
                terminalHandledRef.current = false;
                setImportStatusError(error instanceof Error ? error.message : t('errors.failedToSwitchControl'));
            }
        } finally {
            if (mountedOwnerRef.current === owner) {
                if (pendingImportRef.current === pendingImport) {
                    pendingImport?.(refreshed && operation.state === 'completed');
                    pendingImportRef.current = null;
                }
                terminalRefreshingRef.current = false;
                if (refreshed) importAddressRef.current = null;
                setRequestInFlight(null);
            }
        }
    }, [machineId, owner, params.sessionId]);

    const refreshImport = React.useCallback(async () => {
        if (!machineId || mountedOwnerRef.current !== owner) return;
        if (statusInFlightRef.current) return statusInFlightRef.current;
        const previous = operationRef.current;
        const refresh = (async () => {
            try {
                const result = await machineDirectSessionImportStatus({ machineId, sessionId: params.sessionId }, {
                    serverId: resolvePreferredServerIdForSessionId(params.sessionId),
                });
                if (mountedOwnerRef.current !== owner || operationRef.current !== previous) return;
                if (!result.ok) {
                    setImportStatusError(result.error);
                    return;
                }
                await acceptOperation(result.operation);
            } catch (error) {
                if (mountedOwnerRef.current !== owner) return;
                // Older daemons have no operation to observe. Starting an import reports the upgrade requirement.
                if (!operationRef.current && (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error))) return;
                setImportStatusError(error instanceof Error ? error.message : t('errors.failedToSwitchControl'));
            }
        })();
        statusInFlightRef.current = refresh;
        try { await refresh; } finally {
            if (statusInFlightRef.current === refresh) statusInFlightRef.current = null;
        }
    }, [acceptOperation, machineId, owner, params.sessionId]);

    const activeImport = isImportActive(importOperation);
    React.useEffect(() => {
        if (!machineId) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let polling = false;
        const poll = async () => {
            if (stopped || polling || !isHostVisible()) return;
            if (operationRef.current && !isImportActive(operationRef.current)) return;
            polling = true;
            await refreshImport();
            polling = false;
            if (stopped || !isHostVisible() || !isImportActive(operationRef.current)) return;
            // Presentation cadence; requests retain the transport's own deadline, with no deadline on the import.
            timer = setTimeout(() => { timer = null; void poll(); }, 2_000);
        };
        const onVisibilityChange = () => {
            if (timer !== null) { clearTimeout(timer); timer = null; }
            if (isHostVisible()) void poll();
        };
        const unsubscribe = subscribeToRuntimeActiveChange(onVisibilityChange);
        void poll();
        return () => {
            stopped = true;
            if (timer !== null) clearTimeout(timer);
            unsubscribe();
        };
    }, [activeImport, machineId, refreshImport]);

    const cancelImport = React.useCallback(async () => {
        if (!params.hasWriteAccess || !machineId || operationRef.current?.canCancel !== true) return;
        try {
            const result = await machineDirectSessionImportCancel({ machineId, sessionId: params.sessionId }, {
                serverId: resolvePreferredServerIdForSessionId(params.sessionId),
            });
            if (mountedOwnerRef.current !== owner) return;
            if (!result.ok) { setImportStatusError(result.error); return; }
            await acceptOperation(result.operation);
        } catch (error) {
            if (mountedOwnerRef.current === owner) {
                setImportStatusError(error instanceof Error ? error.message : t('errors.failedToSwitchControl'));
            }
        }
    }, [acceptOperation, machineId, owner, params.hasWriteAccess, params.sessionId]);

    const readLatestStatus = React.useCallback(async () => {
        return await currentParamsRef.current.directSessionRuntime.refreshNow();
    }, []);

    const requestTakeover = React.useCallback(async (
        mode: DirectTakeoverMode,
        options?: Readonly<{ forceStop?: boolean; promptForForceStop?: boolean }>,
    ): Promise<boolean> => {
        if (!params.hasWriteAccess) {
            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
            return false;
        }
        if (!machineId || requestInFlightRef.current || terminalRefreshingRef.current || isImportActive(operationRef.current)) return false;
        requestInFlightRef.current = true;
        setRequestInFlight(mode);
        try {
            const latestStatus = await readLatestStatus();
            if (!latestStatus || mountedOwnerRef.current !== owner || terminalRefreshingRef.current) return false;
            if (!latestStatus.machineOnline) {
                Modal.alert(t('common.error'), t('chatFooter.directSessionMachineOffline'));
                return false;
            }
            let forceStop = options?.forceStop === true;
            if (!forceStop && latestStatus.canForceStop && options?.promptForForceStop !== false) {
                const confirmed = await Modal.confirm(
                    t('chatFooter.directTakeoverForceStopConfirmTitle'),
                    t('chatFooter.directTakeoverForceStopConfirmBody'),
                    { confirmText: t('chatFooter.directTakeoverForceStopConfirmAction'), cancelText: t('common.cancel') },
                );
                if (!confirmed) return false;
                forceStop = true;
            }
            if (mountedOwnerRef.current !== owner || terminalRefreshingRef.current) return false;
            setImportStatusError(null);
            const request = { machineId, sessionId: params.sessionId, ...(forceStop ? { forceStop: true } : {}) };
            const serverId = resolvePreferredServerIdForSessionId(params.sessionId);
            if (mode === 'persisted') {
                terminalHandledRef.current = false;
                let result;
                try {
                    result = await machineDirectSessionTakeoverPersistStart(request, { serverId });
                } catch (error) {
                    // A lost start acknowledgement does not prove that the daemon failed to start.
                    result = await machineDirectSessionImportStatus({ machineId, sessionId: params.sessionId }, { serverId });
                    if (result.ok && !result.operation) throw error;
                }
                if (mountedOwnerRef.current !== owner) return false;
                if (!result.ok) {
                    Modal.alert(t('common.error'), result.error === 'direct_session_import_requires_daemon_upgrade'
                        ? t('chatFooter.directImportRequiresDaemonUpgrade') : result.error);
                    return false;
                }
                if (!result.operation) throw new Error(t('chatFooter.directImportStatusUnavailable'));
                const ready = new Promise<boolean>((resolve) => { pendingImportRef.current = resolve; });
                await acceptOperation(result.operation);
                return await ready;
            }
            const result = await machineDirectSessionTakeover(request, { serverId });
            if (!result.ok) { Modal.alert(t('common.error'), result.error); return false; }
            await Promise.all([readLatestStatus(), sync.refreshSessionMessages(params.sessionId)]);
            return true;
        } catch (error) {
            if (mountedOwnerRef.current !== owner) return false;
            if (mode === 'persisted') setImportStatusError(error instanceof Error ? error.message : t('errors.failedToSwitchControl'));
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.failedToSwitchControl'));
            return false;
        } finally {
            if (mountedOwnerRef.current === owner) {
                requestInFlightRef.current = false;
                if (!terminalRefreshingRef.current) setRequestInFlight(null);
            }
        }
    }, [acceptOperation, machineId, owner, params.hasWriteAccess, params.sessionId, readLatestStatus]);

    const ensureReadyForSend = React.useCallback(async (): Promise<boolean> => {
        if (requestInFlightRef.current || terminalRefreshingRef.current || isImportActive(operationRef.current)) return false;
        if (!currentParamsRef.current.directSessionRuntime.directSessionLink) return true;
        const latestStatus = await readLatestStatus();
        if (!latestStatus || latestStatus.runnerActive) return true;
        if (!latestStatus.machineOnline) {
            Modal.alert(t('common.error'), t('chatFooter.directSessionMachineOffline'));
            return false;
        }
        const resolution = await showDirectSessionTakeoverDialog({
            canTakeOverDirect: latestStatus.canTakeOverDirect,
            canTakeOverPersist: latestStatus.canTakeOverPersist,
            canForceStop: latestStatus.canForceStop,
        });
        if (!resolution.action) return false;
        return requestTakeover(resolution.action, { forceStop: resolution.forceStop, promptForForceStop: false });
    }, [readLatestStatus, requestTakeover]);

    return React.useMemo(() => ({
        takeoverInFlight: activeImport ? 'persisted' : requestInFlight,
        importOperation, importStatusError, cancelImport, refreshImport, requestTakeover, ensureReadyForSend,
    }), [activeImport, requestInFlight, importOperation, importStatusError, cancelImport, refreshImport, requestTakeover, ensureReadyForSend]);
}
