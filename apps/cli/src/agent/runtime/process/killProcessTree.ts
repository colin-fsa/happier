import psList from 'ps-list';

import { killProcessTree as terminateProcessTree } from '../../../../scripts/process_tree.cjs';
import { logger } from '@/ui/logger';

type ProcessTreeRoot = Readonly<{ pid?: number }>;
type ProcessTreeOptions = Readonly<{ graceMs?: number }>;

// The launcher requires this same CJS owner as a sidecar. Static imports bundle it
// into the compiled CLI, including detached installer promotion runners.

export async function killProcessTree(proc: ProcessTreeRoot, opts?: ProcessTreeOptions): Promise<void> {
  try {
    await terminateProcessTree(proc, opts, psList);
  } catch (error) {
    // Existing best-effort callers may catch cleanup rejection. Keep this outcome
    // observable at its canonical owner without exposing OS errors or terminal noise.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'process_tree_termination_incomplete') {
      logger.infoFile('[process-tree] Owned process cleanup could not be verified', {
        code: 'process_tree_termination_incomplete',
      });
    }
    throw error;
  }
}
