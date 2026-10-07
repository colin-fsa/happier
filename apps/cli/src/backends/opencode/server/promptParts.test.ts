import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

import { buildOpenCodePromptParts } from './promptParts';

describe('buildOpenCodePromptParts', () => {
  it('projects resolved native skills and agents using the canonical metadata reader', async () => {
    expect(await buildOpenCodePromptParts({
      cwd: '/repo',
      text: 'Use $review with @planner',
      metadata: {
        happierStructuredInputV1: {
          v: 1,
          skillMentions: [
            { id: 'review-directory', name: 'review', path: '/skills/review/SKILL.md' },
            { id: 'vendor:opencode:legacy', idSource: 'generated', name: 'legacy', path: '/skills/legacy/SKILL.md' },
          ],
          vendorPluginMentions: [{ vendorPluginRef: 'planner' }],
        },
        // Older clients dual-write these aliases. They must not invoke the skill twice.
        happierSkillMentions: [{ id: 'review-directory', name: 'review', path: '/skills/review/SKILL.md' }],
      },
    })).toEqual([
      { type: 'text', text: 'Use $review with @planner' },
      { type: 'agent', name: 'planner' },
      { type: 'skill', id: 'review-directory', name: 'review', path: '/skills/review/SKILL.md', text: 'Use the review skill for this request.' },
      { type: 'skill', name: 'legacy', path: '/skills/legacy/SKILL.md', text: 'Use the legacy skill for this request.' },
    ]);
  });

  it('does not project stale legacy skill selections beside unresolved canonical references', async () => {
    expect(await buildOpenCodePromptParts({
      cwd: '/repo',
      text: 'Use $review',
      metadata: {
        happierStructuredInputV1: {
          v: 1,
          mentions: [{ kind: 'happier.skill', ref: 'skill:review', token: '$review', start: 4, end: 11 }],
          skillMentions: [{ name: 'stale', path: '/skills/stale/SKILL.md' }],
        },
      },
    })).toEqual([{ type: 'text', text: 'Use $review' }]);
  });

  it('maps a hash-verified uploaded image to the exact OpenCode file-part contract', async () => {
    await withTempDir('opencode-prompt-image-', async (cwd) => {
      const bytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x00,
      ]);
      const uploadPath = '.happier/uploads/messages/message-1/screen.png';
      await mkdir(dirname(join(cwd, uploadPath)), { recursive: true });
      await writeFile(join(cwd, uploadPath), bytes);

      await expect(buildOpenCodePromptParts({
        cwd,
        text: 'Inspect this image',
        metadata: {
          happier: {
            kind: 'attachments.v1',
            payload: {
              attachments: [{
                path: uploadPath,
                mimeType: 'image/png',
                sizeBytes: bytes.byteLength,
                sha256: createHash('sha256').update(bytes).digest('hex'),
              }],
            },
          },
          happierStructuredInputV1: {
            v: 1,
            imageInputs: [{
              id: 'image-1',
              kind: 'localImage',
              path: uploadPath,
              mimeType: 'image/png',
              provenance: { kind: 'sessionAttachmentUpload' },
            }],
          },
        },
      })).resolves.toEqual([
        { type: 'text', text: 'Inspect this image' },
        {
          type: 'file',
          mime: 'image/png',
          filename: 'screen.png',
          url: `data:image/png;base64,${bytes.toString('base64')}`,
        },
      ]);
    });
  });

  it('fails closed when uploaded image bytes no longer match the admitted digest', async () => {
    await withTempDir('opencode-prompt-image-mismatch-', async (cwd) => {
      const uploadPath = '.happier/uploads/messages/message-1/screen.png';
      const bytes = Buffer.from('changed bytes');
      await mkdir(dirname(join(cwd, uploadPath)), { recursive: true });
      await writeFile(join(cwd, uploadPath), bytes);

      await expect(buildOpenCodePromptParts({
        cwd,
        text: 'Inspect this image',
        metadata: {
          happier: {
            kind: 'attachments.v1',
            payload: {
              attachments: [{
                path: uploadPath,
                mimeType: 'image/png',
                sizeBytes: bytes.byteLength,
                sha256: createHash('sha256').update('original bytes').digest('hex'),
              }],
            },
          },
          happierStructuredInputV1: {
            v: 1,
            imageInputs: [{
              id: 'image-1',
              kind: 'localImage',
              path: uploadPath,
              mimeType: 'image/png',
              provenance: { kind: 'sessionAttachmentUpload' },
            }],
          },
        },
      })).rejects.toMatchObject({ code: 'opencode_image_input_untrusted' });
    });
  });
});
