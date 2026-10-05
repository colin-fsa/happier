import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

describe('hydrateVoiceReplayDialogFromTranscript (integration)', () => {
  let server: Server | null = null;
  let happyHomeDir = '';
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR']);

  beforeEach(async () => {
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR']);
    happyHomeDir = await createTempDir('happier-cli-voice-replay-hydrate-');
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = null;
    if (happyHomeDir) {
      await removeTempDir(happyHomeDir);
    }
    envScope.restore();

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('prefers memory synopsis system records over stale transcript synopsis artifacts', async () => {
    const sessionId = 'sess_voice_system_record_synopsis';
    const sessionRow = {
      id: sessionId,
      seq: 3,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ flavor: 'claude', path: '/tmp' }),
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 0,
      pendingVersion: 0,
      dataEncryptionKey: null,
      share: null,
    };

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: sessionRow }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}/system-records/latest`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          record: {
            id: 'rec_synopsis',
            sessionId,
            namespace: 'memory',
            kind: 'synopsis.v1',
            localId: 'memory:synopsis:v1:3',
            content: {
              t: 'plain',
              v: { v: 1, seqTo: 3, updatedAtMs: 30, synopsis: 'SYSTEM_RECORD_SYNOPSIS' },
            },
            createdAt: '2026-05-20T00:00:00.000Z',
            updatedAt: '2026-05-20T00:00:01.000Z',
          },
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          hasMore: false,
          messages: [
            {
              seq: 1,
              createdAt: 1000,
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: { type: 'text', text: '[memory]' },
                  meta: {
                    happier: {
                      kind: 'session_synopsis.v1',
                      payload: { v: 1, seqTo: 1, updatedAtMs: 10, synopsis: 'STALE_TRANSCRIPT_SYNOPSIS' },
                    },
                  },
                },
              },
            },
            {
              seq: 2,
              createdAt: 2000,
              content: {
                t: 'plain',
                v: {
                  role: 'user',
                  content: { type: 'text', text: 'voice user text' },
                  meta: {
                    happier: {
                      kind: 'voice_agent_turn.v1',
                      payload: { v: 1, epoch: 7, role: 'user', voiceAgentId: 'voice-1', ts: 20 },
                    },
                  },
                },
              },
            },
          ],
        }));
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve replay hydrate server address');

    envScope.patch({
      HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}`,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
      HAPPIER_HOME_DIR: happyHomeDir,
    });
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { hydrateVoiceReplayDialogFromTranscript } = await import('./hydrateVoiceReplayDialogFromTranscript');
    const result = await hydrateVoiceReplayDialogFromTranscript({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      previousSessionId: sessionId,
      transcriptEpoch: 7,
      limit: 20,
    });

    expect(result?.synopsisText).toBe('SYSTEM_RECORD_SYNOPSIS');
    expect(result?.dialog.map((item) => item.text)).toEqual(['voice user text']);
  });

  it('falls back to transcript hydration when the optional memory synopsis lookup is unauthorized', async () => {
    const sessionId = 'sess_voice_optional_synopsis_unauthorized';
    const sessionRow = {
      id: sessionId,
      seq: 3,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ flavor: 'claude', path: '/tmp' }),
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 0,
      pendingVersion: 0,
      dataEncryptionKey: null,
      share: null,
    };

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: sessionRow }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}/system-records/latest`) {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          hasMore: false,
          messages: [
            {
              seq: 1,
              createdAt: 1000,
              content: {
                t: 'plain',
                v: {
                  role: 'user',
                  content: { type: 'text', text: 'voice user text' },
                  meta: {
                    happier: {
                      kind: 'voice_agent_turn.v1',
                      payload: { v: 1, epoch: 8, role: 'user', voiceAgentId: 'voice-1', ts: 10 },
                    },
                  },
                },
              },
            },
            {
              seq: 2,
              createdAt: 2000,
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: {
                    type: 'acp',
                    provider: 'claude',
                    data: { type: 'message', message: 'voice assistant text' },
                  },
                  meta: {
                    happier: {
                      kind: 'voice_agent_turn.v1',
                      payload: { v: 1, epoch: 8, role: 'assistant', voiceAgentId: 'voice-1', ts: 20 },
                    },
                  },
                },
              },
            },
            {
              seq: 3,
              createdAt: 3000,
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: { type: 'text', text: '[memory]' },
                  meta: {
                    happier: {
                      kind: 'session_synopsis.v1',
                      payload: { v: 1, seqTo: 2, updatedAtMs: 30, synopsis: 'TRANSCRIPT_SYNOPSIS' },
                    },
                  },
                },
              },
            },
          ],
        }));
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve replay hydrate server address');

    envScope.patch({
      HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}`,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
      HAPPIER_HOME_DIR: happyHomeDir,
    });
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { hydrateVoiceReplayDialogFromTranscript } = await import('./hydrateVoiceReplayDialogFromTranscript');
    const result = await hydrateVoiceReplayDialogFromTranscript({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      previousSessionId: sessionId,
      transcriptEpoch: 8,
      limit: 20,
    });

    expect(result?.synopsisText).toBe('TRANSCRIPT_SYNOPSIS');
    expect(result?.dialog.map((item) => item.text)).toEqual(['voice user text', 'voice assistant text']);
  });
});
