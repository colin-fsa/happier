export function isPidAliveBySignal(pid: number, onProbeFailure?: () => void): boolean;

export function killProcessTree(
  proc: Readonly<{ pid?: number }>,
  opts?: Readonly<{ graceMs?: number }>,
  enumerate?: () => Promise<ReadonlyArray<Readonly<{ pid: number; ppid: number }>>>,
): Promise<void>;
