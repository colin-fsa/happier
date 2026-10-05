import type { Metadata } from '@/api/types';
import { readNewestSessionModelsMetadataStateV1 } from '@happier-dev/agents';

type SessionModelsState = NonNullable<Metadata['sessionModelsV1']>;
type SessionModelEntry = SessionModelsState['availableModels'][number];

export type ClaudeSessionModelsPublicationSource = 'catalog' | 'agent_sdk' | 'current_model';

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNewestClaudeState(metadata: Metadata | null | undefined): SessionModelsState | null {
  const state = readNewestSessionModelsMetadataStateV1(
    metadata as unknown as Record<string, unknown> | null | undefined,
  ) as SessionModelsState | null;
  return state?.provider === 'claude' ? state : null;
}

type ClaudeSessionModelContributions = Partial<Record<ClaudeSessionModelsPublicationSource, SessionModelsState>>;

function mergeAvailableModels(contributions: ClaudeSessionModelContributions): SessionModelEntry[] {
  const catalog = contributions.catalog?.availableModels ?? [];
  const sdk = contributions.agent_sdk?.availableModels ?? [];
  const catalogIds = new Set(catalog.map(model => model.id));
  const sdkById = new Map(sdk.map(model => [model.id, model]));
  const models = [
    ...catalog.map(model => {
      const sdkModel = sdkById.get(model.id);
      if (!sdkModel) return model;
      // SDK presentation/context may enrich missing catalog facts, but capability controls belong
      // to the filtered catalog: their absence must remove a previously supported option.
      const { modelOptions: _options, ...sdkFacts } = sdkModel;
      return { ...sdkFacts, ...model };
    }),
    ...sdk.filter(model => !catalogIds.has(model.id)),
  ];
  const current = contributions.current_model?.availableModels[0];
  if (!current) return models;
  const observedOptions = new Map((current.modelOptions ?? []).map(option => [option.id, option]));
  const projected = models.map(model => model.id === current.id || model.extendedContextModelId === current.id
    ? {
      ...model,
      ...(model.id === current.id && current.contextWindowTokens !== undefined ? { contextWindowTokens: current.contextWindowTokens } : {}),
      ...(model.modelOptions ? { modelOptions: model.modelOptions.map(option => {
        const observed = observedOptions.get(option.id);
        return observed ? { ...option, currentValue: observed.currentValue } : option;
      }) } : {}),
    }
    : model);
  if (models.some(model => model.id === current.id)) return projected;
  // Current facts may add a live model, but cannot create controls the catalog does not admit.
  const { modelOptions: _observedOptions, ...currentFacts } = current;
  const variant = projected.find(model => model.extendedContextModelId === current.id);
  return [...projected, { ...currentFacts, ...(variant?.modelOptions ? { modelOptions: variant.modelOptions } : {}) }];

}

/** Latest contributions live only for the owning session process; persisted unions are not evidence. */
export function createClaudeSessionModelsReconciler(): typeof reconcileClaudeSessionModelsState {
  const contributions: ClaudeSessionModelContributions = {};
  return params => reconcileClaudeSessionModelsState({ ...params, contributions });
}

/**
 * Reconcile Claude model-list and effective-current facts without making either publication order observable.
 *
 * The catalog owns the canonical baseline, ordering, and fields for matching ids. Agent SDK facts
 * supplement that baseline and may add SDK-only ids, but a sparse SDK response cannot erase catalog
 * options. Callers publish the returned object to both metadata aliases in one update.
 */
export function reconcileClaudeSessionModelsState(params: Readonly<{
  metadata: Metadata | null | undefined;
  incomingState: SessionModelsState;
  source: ClaudeSessionModelsPublicationSource;
  contributions?: ClaudeSessionModelContributions;
}>): SessionModelsState {
  const existing = readNewestClaudeState(params.metadata);
  const contributions = params.contributions ?? {};
  const previousCurrent = contributions.current_model?.availableModels[0];
  const incomingCurrent = params.incomingState.availableModels[0];
  contributions[params.source] = params.source === 'current_model'
    && incomingCurrent && previousCurrent?.id === incomingCurrent.id
    ? { ...params.incomingState, availableModels: [{ ...previousCurrent, ...incomingCurrent }] }
    : params.incomingState;

  const existingCurrentModelId = normalizeNonEmptyString(existing?.currentModelId);
  const incomingCurrentModelId = normalizeNonEmptyString(params.incomingState.currentModelId);
  const selectedModelId = params.source !== 'agent_sdk'
    ? incomingCurrentModelId || existingCurrentModelId || 'default'
    : existingCurrentModelId && existingCurrentModelId !== 'default'
      ? existingCurrentModelId
      : incomingCurrentModelId || existingCurrentModelId || 'default';

  return {
    ...params.incomingState,
    // Current-model telemetry changes effective facts, not catalog freshness. Zero denotes that
    // no membership source has been observed yet (including a current-only startup snapshot).
    updatedAt: Math.max(
      contributions.catalog?.updatedAt ?? 0,
      contributions.agent_sdk?.updatedAt ?? 0,
      params.source === 'current_model' ? existing?.updatedAt ?? 0 : 0,
    ),
    currentModelId: contributions.current_model?.currentModelId || selectedModelId,
    availableModels: mergeAvailableModels(contributions),
  };
}
