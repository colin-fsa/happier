import { describe, expect, it } from 'vitest';

import { reconcileModelOutput, resetModelOutputSegment } from './reconcileModelOutput';

describe('reconcileModelOutput', () => {
  it('replaces a divergent segment without losing earlier segments', () => {
    const state = { turnText: '', segmentText: '' };
    reconcileModelOutput(state, { type: 'model-output', fullText: 'retained prefix', fullTextScope: 'segment' });
    resetModelOutputSegment(state);
    reconcileModelOutput(state, { type: 'model-output', textDelta: 'draft' });
    reconcileModelOutput(state, { type: 'model-output', fullText: 'corrected', fullTextScope: 'segment' });

    expect(state).toEqual({ turnText: 'retained prefixcorrected', segmentText: 'corrected' });
    reconcileModelOutput(state, { type: 'model-output', fullText: 'corrected final', fullTextScope: 'segment' });
    expect(state.turnText).toBe('retained prefixcorrected final');
  });

  it('exposes replacements to persistence consumers instead of an appendable corrected snapshot', () => {
    const state = { turnText: 'draft', segmentText: 'draft' };
    expect(reconcileModelOutput(state, {
      type: 'model-output', fullText: 'corrected', fullTextScope: 'segment',
    })).toEqual({ kind: 'replace', scope: 'segment', text: 'corrected' });
    expect(reconcileModelOutput(state, {
      type: 'model-output', fullText: 'corrected', fullTextScope: 'segment',
    })).toEqual({ kind: 'none' });
  });

  it('keeps a turn snapshot correction scoped to the current suffix when its earlier segments are unchanged', () => {
    const state = { turnText: 'prefixdraft', segmentText: 'draft' };
    reconcileModelOutput(state, { type: 'model-output', fullText: 'prefixcorrected', fullTextScope: 'turn' });
    expect(state).toEqual({ turnText: 'prefixcorrected', segmentText: 'corrected' });
    reconcileModelOutput(state, { type: 'model-output', fullText: 'corrected final', fullTextScope: 'segment' });
    expect(state.turnText).toBe('prefixcorrected final');
  });
});
