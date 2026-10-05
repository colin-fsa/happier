import { spawn } from 'node:child_process';

export async function runHerdrForeground(params: Readonly<{
  binary: string;
  args: readonly string[];
  socketPath?: string;
  sessionName?: string;
}>): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(params.binary, [...params.args], {
      env: {
        ...process.env,
        ...(params.socketPath ? { HERDR_SOCKET_PATH: params.socketPath } : {}),
        ...(params.sessionName ? { HERDR_SESSION: params.sessionName } : {}),
      },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
