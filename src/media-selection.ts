import type { MediaAssetIdentity } from "./types.js";

export interface MediaSnapshot {
  index: number;
  keys: string[];
  ready: boolean;
  sourceUrl?: string;
}

function overlaps(left: string[], right: ReadonlySet<string>): boolean {
  return left.some((key) => right.has(key));
}

export function flattenMediaKeys(snapshots: MediaSnapshot[]): string[] {
  return [...new Set(snapshots.flatMap((snapshot) => snapshot.keys))];
}

export function selectNewMedia(
  snapshots: MediaSnapshot[],
  baselineKeys: string[],
): MediaSnapshot[] {
  const baseline = new Set(baselineKeys);
  return snapshots.filter((snapshot) => snapshot.keys.length > 0 && !overlaps(snapshot.keys, baseline));
}

export function identitiesFor(snapshots: MediaSnapshot[]): MediaAssetIdentity[] {
  return snapshots.map((snapshot) => ({ keys: [...snapshot.keys] }));
}

export function resolveMediaIdentities(
  snapshots: MediaSnapshot[],
  identities: MediaAssetIdentity[],
): MediaSnapshot[] | null {
  const usedIndexes = new Set<number>();
  const resolved: MediaSnapshot[] = [];

  for (const identity of identities) {
    const keys = new Set(identity.keys);
    const matches = snapshots.filter((snapshot) => !usedIndexes.has(snapshot.index) && overlaps(snapshot.keys, keys));
    if (matches.length !== 1) return null;
    const match = matches[0]!;
    usedIndexes.add(match.index);
    resolved.push(match);
  }

  return resolved;
}
