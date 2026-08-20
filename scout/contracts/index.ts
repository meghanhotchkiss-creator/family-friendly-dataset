/**
 * The frozen contract surface. Every track imports from here and nowhere else.
 *
 * Rule: one schema, one source-of-truth model, one confidence model, one
 * provider interface family. If a track needs a new shared type it is added
 * here first, not invented locally.
 */

export * from './result.ts';
export * from './ids.ts';
export * from './confidence.ts';
export * from './freshness.ts';
export * from './entities.ts';
export * from './user.ts';
export * from './topic.ts';
export * from './truth.ts';
export * from './radar.ts';
export * from './provider.ts';
export * from './sentinel.ts';
export * from './rewards.ts';
export * from './recommendation.ts';
