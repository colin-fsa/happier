import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SOURCES_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** The module specifiers a source file imports. Empty means the guard below saw nothing. */
function readImportLines(relativePath: string): string[] {
    const source = readFileSync(join(SOURCES_ROOT, relativePath), 'utf8');
    return source.match(/^\s*import[\s\S]*?from\s+'[^']+';/gm) ?? [];
}

function listSourceFiles(root: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...listSourceFiles(path));
            continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
        files.push(path);
    }
    return files;
}

describe('setup ownership guards', () => {
    it('keeps every daemon decision out of the active-server switch (INV7)', () => {
        // 13 non-test callers switch the active server with scope `device` — notification routing,
        // session navigation, voice, machine detail — so the switch itself can never tell an
        // intentional Relay/Home preference change from incidental navigation. Reconciliation is
        // decided by the desktop setup gate from the durable direct preference, never here.
        const imports = readImportLines('sync/domains/server/activeServerSwitch.ts');
        expect(imports.length).toBeGreaterThan(0);
        expect(imports.filter((line) => /daemon|setup|reconcil|systemTask/i.test(line))).toEqual([]);
    });

    it('leaves the relay picker recording intent, never starting a daemon task (R8/INV7)', () => {
        // The direct Relay/Home site contributes the durable preference write plus the one fact no
        // persisted state can supply — that a person chose this relay just now. Turning that into a
        // daemon mutation stays with the desktop setup gate and its one coordinator, so neither
        // this site nor the group site beside it can grow a second executor caller.
        const imports = readImportLines('components/navigation/ConnectionStatusControl.tsx');
        expect(imports.length).toBeGreaterThan(0);
        expect(imports.filter((line) => /daemon|reconcil|systemTask|setupCoordinator/i.test(line))).toEqual([]);
        expect(imports.filter((line) => /@\/setup\//.test(line))).toEqual([
            "import { selectRelayDirectly } from '@/setup/directRelaySelectionIntent';",
        ]);
    });

    /**
     * The intent is what authorises repointing this computer's background service. It is armed by
     * one operation, `selectRelayDirectly`, which also performs the switch, so no call site can
     * repeat the "record, then switch" pattern and forget half of it (the Settings Add path did).
     */
    it('arms the intent only inside the one direct-selection operation (R8/INV7)', () => {
        const recorders = listSourceFiles(SOURCES_ROOT)
            .filter((path) => readFileSync(path, 'utf8').includes('recordDirectRelaySelectionIntent('))
            .map((path) => path.slice(SOURCES_ROOT.length + 1));

        expect(recorders).toEqual(['setup/directRelaySelectionIntent.ts']);
    });

    /**
     * Exactly the surfaces where a person chooses one relay for this device call it: the connection
     * status control, the onboarding `/setup` relay pick and custom-relay add, and Settings › Server
     * (profile pick, Add — including a notification-prefilled form the person still submits — and a
     * confirmed Reset), and a background-service relay chosen from the desktop tray.
     * Deep-link auto-add, group selection,
     * notification routing, voice and session navigation keep the raw switch and arm nothing.
     */
    it('keeps the direct-selection operation to the explicit relay-choice surfaces (R8/INV7)', () => {
        const callers = listSourceFiles(SOURCES_ROOT)
            .filter((path) => readFileSync(path, 'utf8').includes('selectRelayDirectly('))
            .map((path) => path.slice(SOURCES_ROOT.length + 1))
            .sort();

        expect(callers).toEqual([
            'app/(app)/setup/index.tsx',
            'components/navigation/ConnectionStatusControl.tsx',
            'components/settings/server/hooks/useServerSettingsScreenController.ts',
            'desktop/tray/DesktopTrayRuntime.tsx',
            'setup/directRelaySelectionIntent.ts',
        ]);
    });

    it('has no producer left for the deleted relay.connectBackgroundService.v1 kind (SB1/D2)', () => {
        const sources = listSourceFiles(SOURCES_ROOT).map((path) => ({
            path: path.slice(SOURCES_ROOT.length + 1),
            text: readFileSync(path, 'utf8'),
        }));
        // The scan is only meaningful if it can see the kind that replaced it.
        expect(sources.filter((file) => file.text.includes('setup.thisComputer.v1')).length).toBeGreaterThan(0);
        expect(sources.filter((file) => file.text.includes('relay.connectBackgroundService.v1')).map((file) => file.path)).toEqual([]);
    });
});
