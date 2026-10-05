import { expect, it } from 'vitest';
import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createClaudeSessionModelsReconciler, reconcileClaudeSessionModelsState } from './reconcileClaudeSessionModelsState';

type State = NonNullable<Metadata['sessionModelsV1']>;
const state = (availableModels: State['availableModels']): State => ({
  v: 1, provider: 'claude', updatedAt: 10, currentModelId: 'default', availableModels,
});

it('replaces historical catalog membership and removes optional controls absent from the new catalog', () => {
  const previous = state([{ id: 'removed', name: 'Removed' }, {
    id: 'kept', name: 'Kept', contextWindowTokens: 1_000,
    modelOptions: [{ id: 'effort', name: 'Effort', type: 'select', currentValue: 'high' }],
  }]);
  const actual = reconcileClaudeSessionModelsState({
    metadata: { sessionModelsV1: previous } as Metadata,
    incomingState: state([{ id: 'kept', name: 'Kept' }]), source: 'catalog',
  });
  expect(actual.availableModels).toEqual([{ id: 'kept', name: 'Kept' }]);
});

it('keeps only the latest SDK contribution alongside the latest catalog in either publication order', () => {
  for (const firstSource of ['catalog', 'agent_sdk'] as const) {
    const reconcile = createClaudeSessionModelsReconciler();
    let metadata: Metadata | null = null;
    const publish = (source: 'catalog' | 'agent_sdk', models: State['availableModels']) => {
      const result = reconcile({ metadata, source, incomingState: state(models) });
      metadata = { sessionModelsV1: result } as Metadata;
      return result.availableModels;
    };
    const catalog = [{ id: 'kept', name: 'Catalog' }, { id: 'removed', name: 'Removed' }];
    const sdk = [{ id: 'kept', name: 'SDK' }, { id: 'sdk-only', name: 'SDK only' }];
    publish(firstSource, firstSource === 'catalog' ? catalog : sdk);
    publish(firstSource === 'catalog' ? 'agent_sdk' : 'catalog', firstSource === 'catalog' ? sdk : catalog);
    expect(publish('catalog', [{ id: 'kept', name: 'Current catalog' }])).toEqual([
      { id: 'kept', name: 'Current catalog' }, { id: 'sdk-only', name: 'SDK only' },
    ]);
    expect(publish('agent_sdk', [])).toEqual([{ id: 'kept', name: 'Current catalog' }]);
    expect(publish('catalog', [])).toEqual([]);
  }
});

it('preserves live current-model context through later catalog and SDK publications without reviving retired controls', async () => {
  const { buildClaudeSessionModelsMetadataWithCurrentModelId } = await import('../remote/buildClaudeSessionModelsMetadataFromSupportedModels');
  const reconcileModels = createClaudeSessionModelsReconciler();
  const initial = reconcileModels({ metadata: null, source: 'catalog', incomingState: state([
    { id: 'kept', name: 'Kept', contextWindowTokens: 200_000 },
  ]) });
  let metadata = { sessionModelsV1: initial } as Metadata;
  const params = { metadata, currentModelId: 'kept', currentModel: { contextWindowTokens: 1_000_000 }, reconcileModels };
  metadata = { ...metadata, ...buildClaudeSessionModelsMetadataWithCurrentModelId(params) };
  for (const source of ['agent_sdk', 'catalog'] as const) {
    const incomingState = state([{ id: 'kept', name: 'Kept' }]);
    incomingState.currentModelId = 'kept';
    const next = reconcileModels({ metadata, source, incomingState });
    expect(next.availableModels).toEqual([{ id: 'kept', name: 'Kept', contextWindowTokens: 1_000_000 }]);
    metadata = { ...metadata, sessionModelsV1: next };
  }
});

it('does not advance catalog observation time for current-model telemetry, including before first catalog', () => {
  const reconcile = createClaudeSessionModelsReconciler();
  const current = { ...state([{ id: 'active', name: 'Active', contextWindowTokens: 1_000_000 }]), currentModelId: 'active', updatedAt: 200 };
  const beforeCatalog = reconcile({ metadata: null, incomingState: current, source: 'current_model' });
  expect(beforeCatalog.updatedAt).toBe(0);
  const catalog = reconcile({ metadata: { sessionModelsV1: beforeCatalog } as Metadata, incomingState: state([{ id: 'active', name: 'Active' }]), source: 'catalog' });
  expect(catalog.updatedAt).toBe(10);
  const afterCatalog = reconcile({ metadata: { sessionModelsV1: catalog } as Metadata, incomingState: { ...current, updatedAt: 300 }, source: 'current_model' });
  expect(afterCatalog.updatedAt).toBe(10);
  expect(afterCatalog.currentModelId).toBe('active');
  expect(afterCatalog.availableModels[0]?.contextWindowTokens).toBe(1_000_000);
});

it('publishes observed effort through later catalog refreshes while preserving a different pending request', async () => {
  const { buildClaudeSessionModelsMetadataWithCurrentModelId } = await import('../remote/buildClaudeSessionModelsMetadataFromSupportedModels');
  const reconcileModels = createClaudeSessionModelsReconciler();
  const catalog = state([{ id: 'claude-sonnet-4-6', name: 'Sonnet', modelOptions: [
    { id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'high', options: [
      { value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' },
    ] },
  ] }]);
  let metadata = createTestMetadata({ sessionModelsV1: reconcileModels({ metadata: null, incomingState: catalog, source: 'catalog' }),
    sessionConfigOptionOverridesV1: { v: 1, updatedAt: 20, overrides: { reasoning_effort: { value: 'medium', updatedAt: 20 } } },
  });
  metadata = { ...metadata, ...buildClaudeSessionModelsMetadataWithCurrentModelId({
    metadata, reconcileModels, currentModelId: 'claude-sonnet-4-6', currentModel: { reasoningEffort: 'low' },
  }) };
  for (const source of ['catalog', 'agent_sdk'] as const) {
    const actual = reconcileModels({ metadata, incomingState: catalog, source });
    expect(actual.availableModels[0]?.modelOptions?.[0]?.currentValue).toBe('low');
    expect(actual.updatedAt).toBe(10);
    metadata = { ...metadata, sessionModelsV1: actual };
  }
  expect(metadata.sessionConfigOptionOverridesV1?.overrides.reasoning_effort?.value).toBe('medium');
  const retired = reconcileModels({ metadata, incomingState: state([{ id: 'claude-sonnet-4-6', name: 'Sonnet' }]), source: 'catalog' });
  expect(retired.availableModels[0]?.modelOptions).toBeUndefined();
});

it('projects observed effort for the advertised extended-context variant without changing the base context facts', async () => {
  const { buildClaudeSessionModelsMetadataWithCurrentModelId } = await import('../remote/buildClaudeSessionModelsMetadataFromSupportedModels');
  const reconcileModels = createClaudeSessionModelsReconciler();
  const initial = reconcileModels({ metadata: null, source: 'catalog', incomingState: state([{
    id: 'claude-sonnet-4-6', name: 'Sonnet', contextWindowTokens: 200_000,
    extendedContextModelId: 'claude-sonnet-4-6[1m]',
    modelOptions: [{ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'high' }],
  }]) });
  const actual = buildClaudeSessionModelsMetadataWithCurrentModelId({
    metadata: { sessionModelsV1: initial } as Metadata,
    reconcileModels, currentModelId: 'claude-sonnet-4-6[1m]',
    currentModel: { contextWindowTokens: 1_000_000, reasoningEffort: 'low' },
  })?.sessionModelsV1;
  expect(actual?.availableModels.find(model => model.id === 'claude-sonnet-4-6')?.contextWindowTokens).toBe(200_000);
  expect(actual?.availableModels.find(model => model.id === 'claude-sonnet-4-6[1m]')).toMatchObject({
    contextWindowTokens: 1_000_000,
    modelOptions: [expect.objectContaining({ id: 'reasoning_effort', currentValue: 'low' })],
  });
});
