import { describe, expect, it } from 'vitest';

import { normalizeOpenCodeAppSkills } from './appSkills.js';

describe('OpenCode app skills wire schema', () => {
    it('preserves released V2 native skill identity and path without exposing its content', () => {
        expect(normalizeOpenCodeAppSkills([{
            id: 'review-directory',
            name: 'security-review',
            path: '/repo/.opencode/skills/review-directory/SKILL.md',
            content: 'private skill instructions',
        }])).toEqual([{
            id: 'review-directory',
            name: 'security-review',
            displayName: 'security-review',
            path: '/repo/.opencode/skills/review-directory/SKILL.md',
            origin: 'opencode_native',
            enabled: true,
        }]);
    });
    it('normalizes skill catalog items without exposing raw skill content', () => {
        const skills = normalizeOpenCodeAppSkills([
            {
                name: 'reviewer',
                description: 'Review code',
                location: '/repo/.agents/skills/reviewer/SKILL.md',
                content: 'secret instructions',
            },
        ]);

        expect(skills).toEqual([
            {
                name: 'reviewer',
                displayName: 'reviewer',
                description: 'Review code',
                path: '/repo/.agents/skills/reviewer/SKILL.md',
                origin: 'opencode_native',
                enabled: true,
            },
        ]);
        expect(JSON.stringify(skills)).not.toContain('secret instructions');
    });
});
