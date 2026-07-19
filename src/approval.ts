export function preferredPersistentApprovalIndex(baselineCount: number, currentCount: number): number | null {
  return currentCount > baselineCount ? currentCount - 1 : null;
}
