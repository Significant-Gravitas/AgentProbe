/** Clamp a 0-1 score to an integer percentage (0-100). */
export function scorePct(val: number | null): number {
  if (val == null) return 0;
  return Math.max(0, Math.min(100, Math.round(val * 100)));
}
