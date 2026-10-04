import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const cliProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function importSetupModule() {
    return await import('./test-setup');
}

describe('CLI test global setup', () => {
    const envScope = createEnvKeyScope(['HAPPIER_CLI_TEST_SKIP_BUILD']);

    beforeEach(() => {
        // Build-policy cases own this input even when CI reuses its prebuilt runtime.
        envScope.patch({ HAPPIER_CLI_TEST_SKIP_BUILD: undefined });
    });

    afterEach(() => {
        envScope.restore();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('skips the dist build for shared-only mode', async () => {
        const { setup } = await importSetupModule();
        const ensureSharedDepsBuiltOnce = vi.fn(async () => undefined);
        const ensureDistBuiltOnce = vi.fn(async () => undefined);

        await setup({
            buildMode: 'shared-only',
            dependencies: {
                resolveProjectRoot: () => '/tmp/happier-cli-project',
                ensureSharedDepsBuiltOnce,
                ensureDistBuiltOnce,
            },
        });

        expect(ensureSharedDepsBuiltOnce).toHaveBeenCalledWith('/tmp/happier-cli-project');
        expect(ensureDistBuiltOnce).not.toHaveBeenCalled();
    });

    it('runs both shared deps and dist builds for full mode', async () => {
        const { setup } = await importSetupModule();
        const ensureSharedDepsBuiltOnce = vi.fn(async () => undefined);
        const ensureDistBuiltOnce = vi.fn(async () => undefined);

        await setup({
            buildMode: 'full',
            dependencies: {
                resolveProjectRoot: () => '/tmp/happier-cli-project',
                ensureSharedDepsBuiltOnce,
                ensureDistBuiltOnce,
            },
        });

        expect(ensureSharedDepsBuiltOnce).toHaveBeenCalledWith('/tmp/happier-cli-project');
        expect(ensureDistBuiltOnce).toHaveBeenCalledWith('/tmp/happier-cli-project');
    });

    it('respects the global skip-build override', async () => {
        const { setup } = await importSetupModule();
        process.env.HAPPIER_CLI_TEST_SKIP_BUILD = 'true';

        const ensureSharedDepsBuiltOnce = vi.fn(async () => undefined);
        const ensureDistBuiltOnce = vi.fn(async () => undefined);

        await setup({
            buildMode: 'full',
            dependencies: {
                resolveProjectRoot: () => '/tmp/happier-cli-project',
                ensureSharedDepsBuiltOnce,
                ensureDistBuiltOnce,
            },
        });

        expect(ensureSharedDepsBuiltOnce).not.toHaveBeenCalled();
        expect(ensureDistBuiltOnce).not.toHaveBeenCalled();
    });

    it('requires bundled protocol runtime dependency markers before skipping shared deps build', async () => {
        const ensureBuildArtifactsReadyOnce = vi.fn(async () => undefined);
        vi.doMock('./testSetupBuildCoordinator', () => ({
            ensureBuildArtifactsReadyOnce,
        }));

        const { setup } = await importSetupModule();

        await setup({
            buildMode: 'shared-only',
            dependencies: {
                resolveProjectRoot: () => cliProjectRoot,
            },
        });

        expect(ensureBuildArtifactsReadyOnce).toHaveBeenCalledTimes(1);
        expect(ensureBuildArtifactsReadyOnce).toHaveBeenCalledWith(
            expect.objectContaining({
                markerPaths: expect.arrayContaining([
                    join(cliProjectRoot, 'node_modules', '@happier-dev', 'protocol', 'dist', 'sessionFork.js'),
                    join(cliProjectRoot, 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'zod', 'package.json'),
                    join(
                        cliProjectRoot,
                        'node_modules',
                        '@happier-dev',
                        'protocol',
                        'node_modules',
                        'base64-js',
                        'package.json',
                    ),
                ]),
            }),
        );
    });
});
