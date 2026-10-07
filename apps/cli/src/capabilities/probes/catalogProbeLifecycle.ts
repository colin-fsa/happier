export type CatalogProbeLifecycle = Readonly<{
  timeoutMs: number;
  deadlineAt?: number;
  signal?: AbortSignal;
}>;

export type NativeCatalogCleanup = () => Promise<void> | void;
export type RegisterNativeCatalogCleanup = (cleanup: NativeCatalogCleanup) => void;

export function remainingCatalogProbeMs(params: CatalogProbeLifecycle): number {
  params.signal?.throwIfAborted();
  const remainingMs = params.deadlineAt === undefined ? params.timeoutMs : params.deadlineAt - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new Error('Native catalog probe timed out');
  return remainingMs;
}

/** Each phase consumes the same containing deadline; preparation never grants a new budget. */
export async function withCatalogProbeLifecycle<T>(
  params: CatalogProbeLifecycle,
  run: (lifecycle: Required<CatalogProbeLifecycle>) => Promise<T>,
  cleanup?: () => Promise<void> | void,
): Promise<T> {
  const controller = new AbortController();
  const deadlineAt = params.deadlineAt ?? Date.now() + params.timeoutMs;
  const onAbort = () => controller.abort(params.signal?.reason);
  params.signal?.addEventListener('abort', onAbort, { once: true });
  if (params.signal?.aborted) onAbort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  try {
    const timeoutMs = remainingCatalogProbeMs({ ...params, deadlineAt, signal: controller.signal });
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', stop, { once: true });
      timer = setTimeout(() => controller.abort(new Error('Native catalog probe timed out')), timeoutMs);
    });
    return await Promise.race([run({ timeoutMs, deadlineAt, signal: controller.signal }), stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (stop) controller.signal.removeEventListener('abort', stop);
    params.signal?.removeEventListener('abort', onAbort);
    controller.abort();
    await cleanup?.();
  }
}
