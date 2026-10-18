/**
 * Run `worker` against every input with at most `limit` concurrent
 * invocations. Preserves input order in the returned array; each output
 * is positional with its input.
 *
 * Implementation: index-cursor + N concurrent producers each picking the
 * next index until the input is drained. Uses `Promise.all` and
 * propagates the first worker rejection — partial-failure isolation is
 * the caller's responsibility.
 */
export async function runWithConcurrencyLimit<T, R>(
  inputs: readonly T[],
  limit: number,
  worker: (input: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error(`runWithConcurrencyLimit: limit must be ≥ 1, got ${limit}`);
  const results = new Array<R>(inputs.length);
  let cursor = 0;
  const workerCount = Math.min(limit, inputs.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < inputs.length) {
        const idx = cursor++;
        results[idx] = await worker(inputs[idx]!, idx);
      }
    }),
  );
  return results;
}
