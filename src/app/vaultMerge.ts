/**
 * A listing read from disk can predate in-app writes or partial refreshes that were applied
 * while it was in flight. For each path changed since the listing started, the current
 * in-memory state wins: its content is kept, or the file stays removed.
 */
export function mergeListing<F extends { path: string }>(
  listed: readonly F[],
  current: ReadonlyMap<string, F>,
  changedSinceStart: Iterable<string>,
): F[] {
  const merged = new Map<string, F>(listed.map((f) => [f.path, f]));
  for (const path of changedSinceStart) {
    const file = current.get(path);
    if (file) merged.set(path, file);
    else merged.delete(path);
  }
  return [...merged.values()];
}
