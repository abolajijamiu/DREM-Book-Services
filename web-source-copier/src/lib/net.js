/**
 * Shared fetch guards.
 *
 * One unreachable host should cost a few seconds, not the whole capture, so
 * every network call the extension makes carries a timeout.
 */

/** `AbortSignal.timeout` where the platform has it, and nothing where it does not. */
export function timeoutSignal(timeoutMs) {
  if (!timeoutMs || typeof AbortSignal === 'undefined' || !AbortSignal.timeout) return {};
  return { signal: AbortSignal.timeout(timeoutMs) };
}

/** fetch() with a timeout, reporting a clear reason when it runs out. */
export async function fetchWithTimeout(url, init, timeoutMs) {
  try {
    return await fetch(url, Object.assign({}, init, timeoutSignal(timeoutMs)));
  } catch (err) {
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
export async function forEachPooled(items, concurrency, handler) {
  const list = Array.from(items);
  let next = 0;
  const size = Math.max(1, Math.min(concurrency || 1, list.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (true) {
        const index = next++;
        if (index >= list.length) return;
        await handler(list[index], index);
      }
    })
  );
}
