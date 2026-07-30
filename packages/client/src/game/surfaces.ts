/**
 * Surface index table.
 *
 * Must stay byte-identical to `SURFACES` in packages/server/src/game/match.ts:
 * the binary event channel sends a surface as a single byte, and a mismatch
 * would silently play a glass impact on concrete.  Asserted by
 * packages/shared/src/__tests__/protocol.test.ts.
 */

export const CLIENT_SURFACES = [
  'metal',
  'concrete',
  'glass',
  'grate',
  'energy',
  'holo',
  'panel',
  'rubber',
  'sand',
  'flesh',
  'air',
] as const;

export function surfaceFromIndexClient(index: number): string {
  return CLIENT_SURFACES[index] ?? 'metal';
}

export function surfaceIndexClient(surface: string): number {
  const i = (CLIENT_SURFACES as readonly string[]).indexOf(surface);
  return i < 0 ? 0 : i;
}
