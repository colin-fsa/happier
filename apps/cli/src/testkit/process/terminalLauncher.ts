import { EventEmitter } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect } from 'vitest';
import type { TerminalLaunchSpec } from '@/terminal/runtime/terminalLaunchSpec';

/** OS child/IPC boundary fixture; the owning runtime and launch-spec producer remain real. */
export function terminalLauncherBoundary<T extends object>(child: T): T {
  // Real ChildProcess.once delegates to .on; preserve its EventEmitter so exit/error
  // listeners and the IPC receipt share the same boundary rather than separate buses.
  const messages = child instanceof EventEmitter ? child : new EventEmitter();
  Object.assign(child, {
    ...(!(child instanceof EventEmitter) ? { on: (event: string, handler: (message: unknown) => void) => {
      messages.on(event, handler);
      return child;
    } } : {}),
    send: (message: { signal?: NodeJS.Signals }, callback: (error: Error | null) => void) => {
      if ('kill' in child && typeof child.kill === 'function') child.kill(message.signal);
      callback(null);
      return true;
    },
  });
  setImmediate(() => messages.emit('message', { type: 'terminal-native-spawned' }));
  return child;
}

/** Assert the actual serialized native invocation, not the intermediate launcher argv. */
export async function expectTerminalNativeInvocation(
  calls: readonly (readonly unknown[])[],
  command: unknown,
  args: unknown,
  options: unknown,
): Promise<void> {
  expect(calls).toHaveLength(1);
  // The raw OS spawn recording is a genuinely untyped fixture boundary.
  const [, launcherArgs, launcherOptions] = calls[0] as [string, string[], { env: NodeJS.ProcessEnv; stdio: unknown }];
  expect(launcherOptions.stdio).toEqual(['inherit', 'inherit', 'inherit', 'ipc']);
  const specPath = launcherArgs.at(-1)!;
  const spec = JSON.parse(await readFile(specPath, 'utf8')) as TerminalLaunchSpec;
  try {
    expect([spec.command, spec.args, {
      env: launcherOptions.env,
      stdio: 'inherit',
      shell: false,
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    }]).toEqual([command, args, options]);
  } finally {
    await rm(dirname(specPath), { recursive: true, force: true });
  }
}
