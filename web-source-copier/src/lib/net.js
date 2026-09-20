/**
 * Shared fetch guards.
 *
 * One unreachable host should cost a few seconds, not the whole capture, so
 * every network call the extension makes carries a timeout.
 */

/**
 * A signal that fires on the timeout or when `external` aborts, whichever
 * comes first. `external` is how the Stop button reaches an in-flight request.
 */
export function timeoutSignal(timeoutMs, external) {
  if (typeof AbortSignal === 'undefined') return {};
  const signals = [];
  if (timeoutMs && AbortSignal.timeout) signals.push(AbortSignal.timeout(timeoutMs));
  if (external) signals.push(external);
  if (!signals.length) return {};
  if (signals.length === 1) return { signal: signals[0] };
  return { signal: AbortSignal.any ? AbortSignal.any(signals) : signals[0] };
}

/** fetch() with a timeout, reporting a clear reason when it runs out. */
export async function fetchWithTimeout(url, init, timeoutMs, external) {
  try {
    return await fetch(url, Object.assign({}, init, timeoutSignal(timeoutMs, external)));
  } catch (err) {
    if (external && external.aborted) throw new Error('stopped');
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('timed out after ' + Math.round(timeoutMs / 1000) + 's');
    }
    throw err;
  }
}

/**
 * Runs `handler` over `items` with at most `concurrency` in flight.
 *
 * Downloads dominate a capture and they are almost all waiting on the network,
 * so a handful at a time turns minutes into seconds. Order of completion is not
 * guaranteed; callers that need stable output sort afterwards.
 */
export async function forEachPooled(items, concurrency, handler, signal) {
  const list = Array.from(items);
  let next = 0;
  const size = Math.max(1, Math.min(concurrency || 1, list.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (true) {
        if (signal && signal.aborted) return; // the Stop button
        const index = next++;
        if (index >= list.length) return;
        await handler(list[index], index);
      }
    })
  );
}
