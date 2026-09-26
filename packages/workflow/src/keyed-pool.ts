/**
 * Run `task` over `items` with at most `concurrency` in flight, never two items
 * with the same key at once. Results come back in input order.
 *
 * The patrol uses it with the drive as the key: separate drives are separate
 * accounts and run side by side, while two runs on one drive would double the call
 * rate its risk control sees (each run paces only its own calls).
 *
 * If a task throws, nothing new starts; the ones already running finish and the
 * first error is rethrown.
 */
export async function runKeyedPool<T, R>(
  items: readonly T[],
  options: { concurrency: number; keyOf: (item: T) => string },
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(options.concurrency));
  const results = new Array<R>(items.length);
  const pending = items.map((_, index) => index);
  const busyKeys = new Set<string>();
  const running = new Set<Promise<void>>();
  let failure: { error: unknown } | null = null;

  const nextRunnable = (): number | undefined => {
    const at = pending.findIndex((index) => !busyKeys.has(options.keyOf(items[index]!)));
    return at === -1 ? undefined : pending.splice(at, 1)[0];
  };

  while (pending.length > 0 || running.size > 0) {
    while (failure === null && running.size < limit) {
      const index = nextRunnable();
      if (index === undefined) break;
      const key = options.keyOf(items[index]!);
      busyKeys.add(key);
      // Started inside a promise so a task that throws synchronously fails like one
      // that rejects: its key is released and the running work still drains.
      const job: Promise<void> = Promise.resolve()
        .then(() => task(items[index]!))
        .then(
          (result) => {
            results[index] = result;
          },
          (error: unknown) => {
            failure ??= { error };
          },
        )
        .finally(() => {
          busyKeys.delete(key);
          running.delete(job);
        });
      running.add(job);
    }
    if (running.size === 0) break; // only reachable after a failure
    await Promise.race(running);
  }
  if (failure !== null) throw (failure as { error: unknown }).error;
  return results;
}
