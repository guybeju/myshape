// The property tests' seeded generator (mulberry32), shared by the schedule
// tests so a failing case can be replayed from its seed. Not built into dist.

/** A seeded generator (mulberry32), so a failing case can be replayed from its seed. */
export function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
