/**
 * LOGOS :: Memory :: Public surface
 * ---------------------------------------------------------------------------
 * The four memory systems plus the consolidation step that links them.
 *
 * Layering, strictly observed:
 *
 *   vector ──▶ working ──┐
 *                    ├──▶ consolidation ──▶ remember
 *   vector ──▶ episodic ─┤
 *   vector ──▶ semantic ─┘
 *
 * `remember` is the only module allowed to depend on all three stores; it is
 * the facade the rest of the architecture talks to, so nothing above this
 * layer has to know that memory is four systems rather than one.
 */

export * from './types.ts';
export * from './vector.ts';
export * from './working.ts';
export * from './episodic.ts';
export * from './semantic.ts';
export * from './consolidation.ts';
export * from './remember.ts';
