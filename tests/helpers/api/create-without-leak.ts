import { retryOnDroppedConnection } from "./retry-on-dropped-connection";

/**
 * A request that CREATES something, re-dialled once when the connection drops —
 * without leaking a second copy (#2354).
 *
 * `retryOnDroppedConnection` must never wrap such a request on its own: the drop can
 * happen after the server took the request, and a blind retry then creates the
 * resource twice. This asks first. On the re-dial, `landed` looks for what the dropped
 * attempt would have created and answers it when found, and nothing is created again.
 * When what landed cannot be used — an API key whose secret only the lost response
 * carried — `landed` removes it and answers `undefined`, and the request is made again.
 *
 * It decides nothing about which errors are drops: it runs inside
 * `retryOnDroppedConnection`, which re-dials only a request that THREW at the transport
 * layer, and only once, and passes every other error and every response straight
 * through. Measured on the @instance-migration lane: a setup `POST /api/v1/flows/` threw
 * `socket hang up` in 1 of 5 runs — the server's 2 s keep-alive edge.
 */
export async function createWithoutLeak<T>(
  create: () => Promise<T>,
  landed: () => Promise<T | undefined>,
): Promise<T> {
  let attempts = 0;
  return retryOnDroppedConnection(async () => {
    attempts += 1;
    if (attempts === 1) return create();
    // The first attempt dropped. Whatever it created is looked for before anything
    // is created again; the look-up is a read, so its own drop is simply re-dialled.
    const found = await retryOnDroppedConnection(landed);
    return found !== undefined ? found : create();
  });
}
