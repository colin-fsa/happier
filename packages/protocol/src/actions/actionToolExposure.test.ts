import { describe, expect, it } from 'vitest';

import { searchSerializedActionSpecsForSurface } from './actionCatalog.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { getActionSpec } from './actionSpecs.js';
import {
  isActionDirectToolExposedOn,
  isActionDiscoverableOnToolSurface,
  resolveActionToolExposureMode,
} from './actionToolExposure.js';
import { resolveActionSurfaceAvailability } from './actionSurfaceAvailability.js';

describe('actionToolExposure', () => {
  it('directly exposes native goal controls while respecting session-agent settings', () => {
    for (const id of ['session.goal.get', 'session.goal.set', 'session.goal.clear'] as const) {
      const spec = getActionSpec(id);
      expect(isActionDirectToolExposedOn(spec, 'session_agent')).toBe(true);
      const settings = ActionsSettingsV1Schema.parse({
        v: 1, actions: { [id]: { toolExposureModes: { session_agent: 'discoverable_only' } } },
      });
      expect(isActionDirectToolExposedOn(spec, 'session_agent', { settings })).toBe(false);
      expect(isActionDiscoverableOnToolSurface(spec, 'session_agent', { settings })).toBe(true);
    }
  });

  it('defaults ordinary session-agent action-backed tools to discoverable-only', () => {
    for (const id of ['subagents.delegate.start', 'execution.run.start', 'session.status.get'] as const) {
      const spec = getActionSpec(id);

      expect(resolveActionToolExposureMode(spec, 'session_agent')).toBe('discoverable_only');
      expect(isActionDirectToolExposedOn(spec, 'session_agent')).toBe(false);
      expect(isActionDiscoverableOnToolSurface(spec, 'session_agent')).toBe(true);
    }
  });

  it('keeps the session-agent action discovery bootstrap tools directly exposed', () => {
    for (const id of [
      'action.spec.search',
      'action.spec.get',
      'action.options.resolve',
      'execution.run.list',
      'execution.run.get',
      'execution.run.wait',
    ] as const) {
      const spec = getActionSpec(id);

      expect(resolveActionToolExposureMode(spec, 'session_agent')).toBe('direct');
      expect(isActionDirectToolExposedOn(spec, 'session_agent')).toBe(true);
      expect(isActionDiscoverableOnToolSurface(spec, 'session_agent')).toBe(true);
    }
  });

  it('keeps external mcp and cli direct by default', () => {
    const spec = getActionSpec('subagents.delegate.start');

    expect(resolveActionToolExposureMode(spec, 'mcp')).toBe('direct');
    expect(resolveActionToolExposureMode(spec, 'cli')).toBe('direct');
    expect(isActionDirectToolExposedOn(spec, 'mcp')).toBe(true);
    expect(isActionDirectToolExposedOn(spec, 'cli')).toBe(true);
  });

  it('applies sparse per-surface settings overrides', () => {
    const settings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'subagents.delegate.start': {
          toolExposureModes: {
            session_agent: 'direct',
            mcp: 'discoverable_only',
          },
        },
      },
    });
    const spec = getActionSpec('subagents.delegate.start');

    expect(resolveActionToolExposureMode(spec, 'session_agent', { settings })).toBe('direct');
    expect(isActionDirectToolExposedOn(spec, 'session_agent', { settings })).toBe(true);
    expect(resolveActionToolExposureMode(spec, 'mcp', { settings })).toBe('discoverable_only');
    expect(isActionDirectToolExposedOn(spec, 'mcp', { settings })).toBe(false);
    expect(isActionDiscoverableOnToolSurface(spec, 'mcp', { settings })).toBe(true);
    expect(resolveActionToolExposureMode(spec, 'cli', { settings })).toBe('direct');
  });

  it('keeps disabled actions neither direct nor discoverable', () => {
    const settings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'subagents.delegate.start': {
          disabledSurfaces: ['session_agent'],
          toolExposureModes: {
            session_agent: 'direct',
          },
        },
      },
    });
    const spec = getActionSpec('subagents.delegate.start');

    expect(isActionDirectToolExposedOn(spec, 'session_agent', { settings })).toBe(false);
    expect(isActionDiscoverableOnToolSurface(spec, 'session_agent', { settings })).toBe(false);
  });

  it('reports unsupported surfaces with stable availability details', () => {
    const availability = resolveActionSurfaceAvailability({
      actionId: 'session.spawn_picker',
      surface: 'session_agent',
    });

    expect(availability).toMatchObject({
      available: false,
      actionId: 'session.spawn_picker',
      surface: 'session_agent',
      reason: 'unsupported_surface',
      availableSurfaces: ['mcp', 'cli'],
    });
  });

  it('reports settings-disabled surfaces with stable availability details', () => {
    const settings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.message.send': {
          disabledSurfaces: ['session_agent'],
        },
      },
    });

    const availability = resolveActionSurfaceAvailability({
      actionId: 'session.message.send',
      surface: 'session_agent',
      settings,
    });

    expect(availability).toMatchObject({
      available: false,
      actionId: 'session.message.send',
      surface: 'session_agent',
      reason: 'disabled_by_settings',
      settingsState: 'disabled',
    });
  });

  it('reports injected policy-disabled surfaces with stable availability details', () => {
    const availability = resolveActionSurfaceAvailability({
      actionId: 'session.message.send',
      surface: 'session_agent',
      isActionEnabled: () => false,
    });

    expect(availability).toMatchObject({
      available: false,
      actionId: 'session.message.send',
      surface: 'session_agent',
      reason: 'disabled_by_policy',
    });
  });

  it('keeps action-executable surfaced actions discoverable even without a direct MCP tool binding', () => {
    const spec = getActionSpec('session.spawn_picker');

    expect(spec.bindings?.mcpToolName).toBeUndefined();
    expect(isActionDiscoverableOnToolSurface(spec, 'mcp')).toBe(true);
    expect(isActionDirectToolExposedOn(spec, 'mcp')).toBe(false);
  });

  it('keeps session-agent create-session discoverable but not directly exposed by default', () => {
    const spec = getActionSpec('session.spawn_new');

    expect(isActionDiscoverableOnToolSurface(spec, 'session_agent')).toBe(true);
    expect(resolveActionToolExposureMode(spec, 'session_agent')).toBe('discoverable_only');
    expect(isActionDirectToolExposedOn(spec, 'session_agent')).toBe(false);
  });

  it('keeps discoverable-only session-agent actions in action search results', () => {
    const results = searchSerializedActionSpecsForSurface({
      surface: 'session_agent',
      query: 'delegate',
      limit: 10,
    });

    expect(results.map((spec) => spec.id)).toContain('subagents.delegate.start');
  });
});
