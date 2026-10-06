import { describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedInputArbiter } from './createClaudeUnifiedInputArbiter';
import { createClaudeUnifiedInFlightSteerEvaluator } from './createClaudeUnifiedInFlightSteerEvaluator';

describe('createClaudeUnifiedInputArbiter', () => {
  it.each(['steer', 'send'] as const)('steers a live generating terminal even when recorded turn state says idle (action=%s)', async (pendingProviderAction) => {
    const wiring = createClaudeUnifiedInFlightSteerEvaluator({
      hostAdapter: {
        captureInputState: async () => ({
          stable: true,
          currentInput: '● Reading files\n✶ Forging… (42s · esc to interrupt)',
          observedAt: 10_000,
        }),
      },
      handle: {
        kind: 'tmux', sessionName: 'recorded-idle-live-turn', paneId: '%1',
        attachMetadata: {
          attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required',
        },
      },
      telemetry: { emit: () => {} },
    });
    const injectPrompt = vi.fn(async (batch: Readonly<{ message: string }>) => ({
      status: 'injected' as const, at: 10_000, bytesWritten: batch.message.length,
    }));
    const onProviderAcceptancePending = vi.fn();
    const interruptActiveTurn = vi.fn(async () => {});
    const arbiter = createClaudeUnifiedInputArbiter({
      quietPeriodMs: 0,
      injectPrompt,
      evaluateInFlightSteer: wiring.evaluateInFlightSteer,
      isCanonicalTurnActive: () => false,
      onProviderAcceptancePending,
      interruptActiveTurn,
    });
    try {
      arbiter.observeLifecycle({ type: 'turn_state', state: 'idle' });
      arbiter.observeLifecycle({ type: 'output' });
      await arbiter.enqueueUiMessage({
        message: 'continue without interruption', origin: { kind: 'ui_pending' },
        pendingProviderAction,
        pendingRequestedAction: { v: 1, kind: 'steer_now' },
        userMessageLocalIds: ['recorded-idle-steer'],
      });
      await arbiter.drainWhenSafe();
      expect(injectPrompt).toHaveBeenCalledWith(expect.objectContaining({
        userMessageLocalIds: ['recorded-idle-steer'],
      }), { inFlightSteer: true });
      expect(onProviderAcceptancePending).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        acceptedAs: 'in_flight_steer',
      }), expect.any(Number));
      expect(interruptActiveTurn).not.toHaveBeenCalled();
    } finally {
      await arbiter.dispose();
      wiring.dispose();
    }
  });
  it('fills Claude native steer queue without waiting for prior steer consumption', async () => {
    const injectedTexts: string[] = [];
    const acceptedTexts: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      quietPeriodMs: 0,
      evaluateInFlightSteer: vi.fn(async () => ({ steer: true as const })),
      onPromptAccepted: vi.fn(async (batch) => {
        acceptedTexts.push(batch.message);
      }),
      injectPrompt: vi.fn(async (batch) => {
        injectedTexts.push(batch.message);
        return {
          status: 'injected' as const,
          at: 10_000,
          bytesWritten: batch.message.length,
          inFlightSteer: true,
        };
      }),
    });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: 10_000 });

    const first = {
      message: 'first steer',
      origin: { kind: 'ui_pending' as const },
      pendingProviderAction: 'steer' as const,
      userMessageLocalIds: ['first-steer'],
    };
    const second = { ...first, message: 'second steer', userMessageLocalIds: ['second-steer'] };
    const third = { ...first, message: 'third steer', userMessageLocalIds: ['third-steer'] };

    await arbiter.enqueueUiMessage(first);
    await arbiter.drainWhenSafe();
    await arbiter.observePromptCustodyByTerminal(first);
    await arbiter.enqueueUiMessage(second);
    await arbiter.enqueueUiMessage(third);
    await arbiter.drainWhenSafe();

    expect(injectedTexts).toEqual(['first steer', 'second steer', 'third steer']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 2,
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 0,
    });
    await expect(arbiter.confirmPromptAcceptedByProviderIf((batch) => batch === first)).resolves.toBe(true);
    await expect(arbiter.confirmPromptAcceptedByProviderIf((batch) => batch === second)).resolves.toBe(true);
    await expect(arbiter.confirmPromptAcceptedByProviderIf((batch) => batch === third)).resolves.toBe(true);
    expect(acceptedTexts).toEqual(['first steer', 'second steer', 'third steer']);

    await arbiter.dispose();
  });

  it('retains every submitted steer when the active terminal fails before consumption', async () => {
    const first = { message: 'failure first', origin: { kind: 'ui_pending' as const }, pendingProviderAction: 'steer' as const };
    const second = { ...first, message: 'failure second' };
    const third = { ...first, message: 'failure third' };
    const failures: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      quietPeriodMs: 0,
      evaluateInFlightSteer: vi.fn(async () => ({ steer: true as const })),
      injectPrompt: vi.fn(async (batch) => ({
        status: 'injected' as const,
        at: 10_000,
        bytesWritten: batch.message.length,
        inFlightSteer: true,
      })),
      onInjectionFailure: vi.fn(async ({ batch }) => {
        failures.push(batch.message);
        return { action: 'surfaced_runtime_issue' as const };
      }),
    });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage(first);
    await arbiter.drainWhenSafe();
    await arbiter.observePromptCustodyByTerminal(first);
    await arbiter.enqueueUiMessage(second);
    await arbiter.enqueueUiMessage(third);
    await arbiter.drainWhenSafe();

    await expect(arbiter.observePendingProviderAcceptanceTerminalFailure()).resolves.toBe(true);
    expect(failures).toEqual(['failure second', 'failure third']);
    expect(arbiter.snapshot()).toMatchObject({ terminalCustodyCount: 3, queuedCount: 0 });
    await arbiter.dispose();
  });

  it('settles an injected goal control without opening or awaiting a provider turn', async () => {
    const injectPrompt = vi.fn(async (batch: Readonly<{ message: string }>) => ({
      status: 'injected' as const,
      at: 10_000,
      bytesWritten: batch.message.length,
    }));
    const onProviderAcceptancePending = vi.fn();
    const onPromptInjected = vi.fn();
    const onPromptAccepted = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      quietPeriodMs: 0,
      injectPrompt,
      onProviderAcceptancePending,
      onPromptInjected,
      onPromptAccepted,
    });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });

    await arbiter.enqueueUiMessage({
      message: '/goal clear',
      origin: { kind: 'goal_control' },
    });
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledOnce();
    expect(onProviderAcceptancePending).not.toHaveBeenCalled();
    expect(onPromptInjected).not.toHaveBeenCalled();
    expect(onPromptAccepted).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      providerAcceptancePendingCount: 0,
      terminalCustodyCount: 0,
      headInputState: 'submitted',
    });

    await arbiter.enqueueUiMessage({
      message: 'the next real prompt',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['next-real-prompt'],
    });
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(onProviderAcceptancePending).toHaveBeenCalledOnce();
    expect(onProviderAcceptancePending).toHaveBeenCalledWith(
      expect.objectContaining({ userMessageLocalIds: ['next-real-prompt'] }),
      expect.objectContaining({ acceptedAs: 'new_turn' }),
      10_000,
    );
    expect(onPromptInjected).toHaveBeenCalledOnce();
    expect(onPromptAccepted).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      providerAcceptancePendingCount: 1,
      terminalCustodyCount: 0,
      headInputState: 'awaiting_provider_acceptance',
    });

    await arbiter.dispose();
  });

  it('fails closed when prompt-only acceptance matches multiple terminal-custody rows', async () => {
    const acceptedLocalIds: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      quietPeriodMs: 0,
      evaluateInFlightSteer: vi.fn(async () => ({ steer: true as const })),
      injectPrompt: vi.fn(async (batch) => ({
        status: 'injected' as const,
        at: 10_000,
        bytesWritten: batch.message.length,
        inFlightSteer: true,
      })),
      onPromptAccepted: (batch) => {
        acceptedLocalIds.push(...(batch.userMessageLocalIds ?? []));
      },
    });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: 10_000 });

    const first = {
      message: 'identical accepted steer',
      origin: { kind: 'ui_pending' as const },
      pendingProviderAction: 'steer' as const,
      userMessageLocalIds: ['first-local'],
    };
    const second = {
      ...first,
      userMessageLocalIds: ['second-local'],
    };
    await arbiter.enqueueUiMessage(first);
    await arbiter.drainWhenSafe();
    await arbiter.observePromptCustodyByTerminal(first);
    await arbiter.enqueueUiMessage(second);
    await arbiter.drainWhenSafe();
    await arbiter.observePromptCustodyByTerminal(second);

    await expect(arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.message === 'identical accepted steer',
    )).resolves.toBe(false);
    expect(acceptedLocalIds).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({ terminalCustodyCount: 2 });

    await arbiter.dispose();
  });

  it('closes the pump snapshot-to-wait race with the arbiter state version', async () => {
    const arbiter = createClaudeUnifiedInputArbiter({
      quietPeriodMs: 0,
      injectPrompt: vi.fn(async (batch: Readonly<{ message: string }>) => ({
        status: 'injected' as const,
        at: 10_000,
        bytesWritten: batch.message.length,
      })),
    });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage({
      message: 'exact pending prompt',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['pending-local'],
    });
    await arbiter.drainWhenSafe();
    const pausedSnapshot = arbiter.snapshot();

    await arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.userMessageLocalIds?.includes('pending-local') === true,
    );

    await expect(arbiter.waitForPendingQueuePumpStateChange({
      afterVersion: pausedSnapshot.pendingQueuePumpStateVersion,
      abortSignal: new AbortController().signal,
    })).resolves.toBe(true);
  });

  it('keeps newer running lifecycle truth when provider acceptance settles the submitted batch', async () => {
    let nowMs = 10_000;
    const injectPrompt = vi.fn(async (batch: Readonly<{ message: string }>, options?: Readonly<{ inFlightSteer?: boolean }>) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
      ...(options?.inFlightSteer ? { inFlightSteer: true } : {}),
    }));
    const evaluateInFlightSteer = vi.fn(async () => ({ steer: true as const }));
    const onInjectionFailure = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      injectPrompt,
      evaluateInFlightSteer,
      onInjectionFailure,
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    await arbiter.enqueueUiMessage({
      message: 'start the provider turn',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['start-local'],
    });
    await arbiter.drainWhenSafe();

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: ++nowMs });
    await expect(arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.userMessageLocalIds?.includes('start-local') === true,
    )).resolves.toBe(true);

    expect(arbiter.snapshot().turnState).toBe('running');

    await arbiter.enqueueUiMessage({
      message: 'steer the active provider turn',
      origin: { kind: 'ui_pending' },
      pendingProviderAction: 'steer',
      userMessageLocalIds: ['steer-local'],
    });
    await arbiter.drainWhenSafe();

    expect(evaluateInFlightSteer).toHaveBeenCalledTimes(1);
    expect(injectPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ pendingProviderAction: 'steer' }),
      { inFlightSteer: true },
    );
    expect(onInjectionFailure).not.toHaveBeenCalled();
  });

  it('keeps an ambiguous after-enter attempt available for later exact provider acceptance', async () => {
    const acceptedLocalIds: string[] = [];
    const onInjectionFailure = vi.fn(async () => ({ action: 'claimed_pending_delivery' as const }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt: vi.fn(async () => ({
        status: 'failed' as const,
        reason: 'verification_failed' as const,
        phase: 'after_enter_unknown' as const,
        duplicateRisk: 'possible' as const,
        recoverable: true,
      })),
      onInjectionFailure,
      onPromptAccepted: (batch) => {
        acceptedLocalIds.push(...(batch.userMessageLocalIds ?? []));
      },
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage({
      message: 'prompt accepted just after terminal verification became ambiguous',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['late-exact-local'],
    });
    await arbiter.drainWhenSafe();

    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_ambiguous',
    }));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      terminalCustodyCount: 1,
      pendingInjectionCount: 0,
    });

    await expect(arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.userMessageLocalIds?.includes('late-exact-local') === true,
    )).resolves.toBe(true);
    expect(acceptedLocalIds).toEqual(['late-exact-local']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      terminalCustodyCount: 0,
    });

    await arbiter.dispose();
  });

  it('moves a prompt into non-blocking terminal custody when Enter was never attempted', async () => {
    const onProviderAcceptancePending = vi.fn();
    const onInjectionFailure = vi.fn(async () => ({ action: 'claimed_pending_delivery' as const }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt: vi.fn(async () => ({
        status: 'failed' as const,
        reason: 'timeout' as const,
        phase: 'after_write_before_enter' as const,
        duplicateRisk: 'possible' as const,
        recoverable: true,
      })),
      onProviderAcceptancePending,
      onInjectionFailure,
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage({
      message: 'prompt accepted after terminal verification timed out',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['after-write-local'],
    });
    await arbiter.drainWhenSafe();

    expect(onProviderAcceptancePending).toHaveBeenCalledOnce();
    expect(onProviderAcceptancePending).toHaveBeenCalledWith(
      expect.objectContaining({ userMessageLocalIds: ['after-write-local'] }),
      expect.objectContaining({ acceptedAs: 'new_turn' }),
    );
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_ambiguous',
      result: expect.objectContaining({
        phase: 'after_write_before_enter',
      }),
    }));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      pendingInjectionCount: 0,
      providerAcceptancePendingCount: 0,
      terminalCustodyCount: 1,
      headInputState: 'terminal_custody',
    });

    await arbiter.dispose();
  });

  it('retires exact terminal custody after the canonical Pending row is discarded', async () => {
    let deliveryState: 'pending' | 'accepted' | 'retired' = 'pending';
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt: vi.fn()
        .mockResolvedValueOnce({
          status: 'failed' as const,
          reason: 'timeout' as const,
          phase: 'after_write_before_enter' as const,
          duplicateRisk: 'possible' as const,
          recoverable: true,
        })
        .mockResolvedValueOnce({
          status: 'injected' as const,
          at: 10_001,
          bytesWritten: 11,
        }),
      onInjectionFailure: vi.fn(async () => ({ action: 'claimed_pending_delivery' as const })),
      resolvePromptDeliveryState: () => deliveryState,
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage({
      message: 'old prompt',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['discarded-local'],
    });
    await arbiter.drainWhenSafe();
    expect(arbiter.snapshot().terminalCustodyCount).toBe(1);

    deliveryState = 'retired';
    await arbiter.enqueueUiMessage({
      message: 'new prompt',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['new-local'],
    });
    await arbiter.drainWhenSafe();

    expect(arbiter.snapshot()).toMatchObject({
      terminalCustodyCount: 0,
      providerAcceptancePendingCount: 1,
    });

    await arbiter.dispose();
  });

  it('releases a submitted queue head once its canonical Pending row is retired', async () => {
    // Live incident 2026-09-18 (session cmtyf86rp1a1ttm237czmr4ts): provider acceptance is
    // correlated by prompt text, which a provider may re-render across the terminal round-trip.
    // Canonical Pending retirement is the authoritative "this row is done" signal; without
    // consuming it at the queue head the arbiter keeps provider-acceptance backpressure forever
    // and every later Pending row starves.
    let deliveryState: 'pending' | 'accepted' | 'retired' = 'pending';
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt: vi.fn(async () => ({
        status: 'injected' as const,
        at: 10_001,
        bytesWritten: 12,
      })),
      resolvePromptDeliveryState: () => deliveryState,
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage({
      message: 'delivered but never text-correlated',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['stuck-local'],
    });
    await arbiter.drainWhenSafe();
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      providerAcceptancePendingCount: 1,
    });

    const backpressuredVersion = arbiter.snapshot().pendingQueuePumpStateVersion;
    deliveryState = 'retired';
    await arbiter.drainWhenSafe();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      providerAcceptancePendingCount: 0,
      terminalCustodyCount: 0,
    });
    // The pending-queue pump parks on this version until the backpressure state changes.
    expect(arbiter.snapshot().pendingQueuePumpStateVersion).not.toBe(backpressuredVersion);

    await arbiter.dispose();
  });

  it('keeps a submitted prompt available for late acceptance after terminal observation is lost', async () => {
    const acceptedLocalIds: string[] = [];
    const onInjectionFailure = vi.fn(async () => ({ action: 'claimed_pending_delivery' as const }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt: vi.fn(async () => ({
        status: 'injected' as const,
        at: 10_000,
        bytesWritten: 25,
      })),
      onInjectionFailure,
      onPromptAccepted: (batch) => {
        acceptedLocalIds.push(...(batch.userMessageLocalIds ?? []));
      },
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage({
      message: 'submitted before terminal observation was lost',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['late-after-terminal-loss'],
    });
    await arbiter.drainWhenSafe();

    await expect(arbiter.observePendingProviderAcceptanceTerminalFailure()).resolves.toBe(true);
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_ambiguous',
    }));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      terminalCustodyCount: 1,
      pendingInjectionCount: 0,
    });

    await expect(arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.userMessageLocalIds?.includes('late-after-terminal-loss') === true,
    )).resolves.toBe(true);
    expect(acceptedLocalIds).toEqual(['late-after-terminal-loss']);
    expect(arbiter.snapshot().terminalCustodyCount).toBe(0);

    await arbiter.dispose();
  });

  it('keeps an ordinary submitted prompt awaiting exact acceptance across compaction completion', async () => {
    const acceptedLocalIds: string[] = [];
    const injectPrompt = vi.fn(async (batch: Readonly<{ message: string }>) => ({
      status: 'injected' as const,
      at: 10_000,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt,
      onPromptAccepted: (batch) => {
        acceptedLocalIds.push(...(batch.userMessageLocalIds ?? []));
      },
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage({
      message: 'ordinary prompt queued while Claude compacts',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['pending-through-compaction'],
    });
    await arbiter.drainWhenSafe();

    arbiter.observeLifecycle({ type: 'compaction', phase: 'completed', observedAtMs: 10_001 });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_001 });
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    await expect(arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.userMessageLocalIds?.includes('pending-through-compaction') === true,
    )).resolves.toBe(true);
    expect(acceptedLocalIds).toEqual(['pending-through-compaction']);

    await arbiter.dispose();
  });

  it('claims interrupt-and-run only for the exact native queued custody head while its turn is live', async () => {
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt: vi.fn(async (batch: Readonly<{ message: string }>) => ({
        status: 'injected' as const,
        at: 10_000,
        bytesWritten: batch.message.length,
        inFlightSteer: true,
      })),
      evaluateInFlightSteer: vi.fn(async () => ({ steer: true as const })),
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    const head = {
      message: 'queued head',
      origin: { kind: 'ui_pending' as const },
      pendingProviderAction: 'steer' as const,
      userMessageLocalIds: ['head-local'],
    };
    await arbiter.enqueueUiMessage(head);
    await arbiter.drainWhenSafe();
    await expect(arbiter.observePromptCustodyByTerminal(head)).resolves.toBe(true);

    expect(arbiter.readPendingInputInterruptAndRunLocalId()).toBe('head-local');
    expect(arbiter.claimPendingInputInterruptAndRun('wrong-local')).toBe(false);
    expect(arbiter.claimPendingInputInterruptAndRun('head-local')).toBe(true);
    expect(arbiter.claimPendingInputInterruptAndRun('head-local')).toBe(false);

    await expect(arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.userMessageLocalIds?.includes('head-local') === true,
    )).resolves.toBe(true);
    expect(arbiter.snapshot().terminalCustodyCount).toBe(0);
  });

  it('does not expose interrupt-and-run for non-head, non-singleton, accepted, or ended-turn custody', async () => {
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt: vi.fn(async (batch: Readonly<{ message: string }>) => ({
        status: 'injected' as const,
        at: 10_000,
        bytesWritten: batch.message.length,
        inFlightSteer: true,
      })),
      evaluateInFlightSteer: vi.fn(async () => ({ steer: true as const })),
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    const head = {
      message: 'ambiguous ids',
      origin: { kind: 'ui_pending' as const },
      pendingProviderAction: 'steer' as const,
      userMessageLocalIds: ['head-a', 'head-b'],
    };
    await arbiter.enqueueUiMessage(head);
    await arbiter.drainWhenSafe();
    await arbiter.observePromptCustodyByTerminal(head);

    expect(arbiter.readPendingInputInterruptAndRunLocalId()).toBeNull();
    expect(arbiter.claimPendingInputInterruptAndRun('head-a')).toBe(false);

    await arbiter.confirmPromptAcceptedByProviderIf((batch) => batch === head);
    expect(arbiter.readPendingInputInterruptAndRunLocalId()).toBeNull();

    const ended = {
      message: 'turn ends after custody',
      origin: { kind: 'ui_pending' as const },
      pendingProviderAction: 'steer' as const,
      userMessageLocalIds: ['ended-local'],
    };
    await arbiter.enqueueUiMessage(ended);
    await arbiter.drainWhenSafe();
    await arbiter.observePromptCustodyByTerminal(ended);
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_001 });

    expect(arbiter.readPendingInputInterruptAndRunLocalId()).toBeNull();
    expect(arbiter.claimPendingInputInterruptAndRun('ended-local')).toBe(false);
  });

  it('accepts the submitted compact command exactly once when compaction completes', async () => {
    const acceptedLocalIds: string[] = [];
    const injectPrompt = vi.fn(async (batch: Readonly<{ message: string }>) => ({
      status: 'injected' as const,
      at: 10_000,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt,
      onPromptAccepted: (batch) => {
        acceptedLocalIds.push(...(batch.userMessageLocalIds ?? []));
      },
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage({
      message: '/compact',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['compact-local'],
    });
    await arbiter.drainWhenSafe();

    arbiter.observeLifecycle({ type: 'compaction', phase: 'completed', observedAtMs: 10_001 });
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(acceptedLocalIds).toEqual(['compact-local']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      providerAcceptancePendingCount: 0,
      headInputState: 'submitted',
    });

    await arbiter.dispose();
  });

  it.each(['steer_now', 'steer_if_active'] as const)('handles %s after turn-end lifecycle evidence without bypassing conditional admission', async (kind) => {
    const injectPrompt = vi.fn(async (batch: Readonly<{ message: string }>) => ({
      status: 'injected' as const,
      at: 10_000,
      bytesWritten: batch.message.length,
    }));
    const evaluateInFlightSteer = vi.fn(async () => ({ steer: true as const, turnLikelyEnded: true }));
    const onInjectionFailure = vi.fn(async () => ({ action: 'claimed_pending_delivery' as const }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt,
      evaluateInFlightSteer,
      onInjectionFailure,
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle' });
    arbiter.observeLifecycle({ type: 'output' });
    await arbiter.enqueueUiMessage({
      message: 'start the provider turn',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['start-local'],
    });
    await arbiter.drainWhenSafe();
    arbiter.observeLifecycle({ type: 'turn_state', state: 'running' });
    await arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.userMessageLocalIds?.includes('start-local') === true,
    );
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle' });

    await arbiter.enqueueUiMessage({
      message: 'continue the completed turn',
      origin: { kind: 'ui_pending' },
      pendingProviderAction: 'steer',
      pendingRequestedAction: { v: 1, kind },
      userMessageLocalIds: ['steer-after-stop'],
    });
    await arbiter.drainWhenSafe();

    expect(evaluateInFlightSteer).toHaveBeenCalledTimes(1);
    if (kind === 'steer_if_active') {
      expect(injectPrompt).toHaveBeenCalledTimes(1);
      expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
        batch: expect.objectContaining({ userMessageLocalIds: ['steer-after-stop'] }),
        result: expect.objectContaining({ reason: 'no_target', phase: 'before_write', duplicateRisk: 'none' }),
      }));
      await arbiter.dispose();
      return;
    }
    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(injectPrompt).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'continue the completed turn',
      userMessageLocalIds: ['steer-after-stop'],
    }), undefined);
    expect(onInjectionFailure).not.toHaveBeenCalled();
    await arbiter.dispose();
  });
});
