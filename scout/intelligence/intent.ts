/**
 * Natural-language intent parsing.
 *
 * The driving example is "Family-friendly, local, not too touristy". Getting
 * that right means getting negation right: a bag-of-words parser sees the word
 * "touristy" and biases TOWARDS tourist traps, which is the exact opposite of
 * what was asked. So every recognised term is checked against a small window of
 * preceding tokens for a negator, and a negated term flips the sign of its bias
 * instead of being dropped.
 */

import type { ParsedIntent } from '../contracts/index.ts';
import { CORE_TOPICS } from './topic-graph.ts';

/** Words that invert the term that follows them. */
const NEGATORS: ReadonlySet<string> = new Set([
  'not', 'no', 'avoid', 'without', 'less', 'skip', 'never', 'anti', 'except',
  'dont', 'doesnt', 'isnt', 'arent', 'nothing', 'nope', 'minus', 'exclude',
]);

/** How far back a negator can reach: "not too touristy" needs 2. */
const NEGATION_WINDOW = 3;

interface Bias {
  dimension: string;
  value: string;
  weight: number;
}

/**
 * One recognised concept: the tokens that trigger it, and what it means when
 * asserted. Negating it flips every bias sign and every flag.
 */
interface Rule {
  id: string;
  terms: string[];
  biases: Bias[];
  topics?: string[];
  vibes?: string[];
  familyFriendly?: boolean;
  wantsLocal?: boolean;
  avoidsTouristy?: boolean;
  /** Negating this rule sets avoidsTouristy rather than clearing it. */
  negatedAvoidsTouristy?: boolean;
}

const RULES: Rule[] = [
  {
    id: 'family',
    terms: ['family', 'family friendly', 'familyfriendly', 'kid friendly', 'kidfriendly', 'child friendly', 'kids', 'kid', 'children', 'child'],
    biases: [],
    familyFriendly: true,
  },
  {
    id: 'toddler',
    terms: ['toddler', 'toddlers', 'baby', 'babies', 'infant', 'preschooler', 'stroller', 'pushchair', 'buggy', 'pram'],
    biases: [{ dimension: 'duration', value: 'short', weight: 0.4 }],
    topics: ['stroller-friendly', 'outdoor-play'],
    familyFriendly: true,
  },
  {
    id: 'teens',
    terms: ['teen', 'teens', 'teenager', 'teenagers'],
    biases: [{ dimension: 'duration', value: 'long', weight: 0.3 }],
    topics: ['art-and-making', 'hands-on-science'],
    familyFriendly: true,
  },
  {
    id: 'local',
    terms: ['local', 'locals', 'locally', 'like a local', 'neighbourhood', 'neighborhood', 'authentic', 'residential', 'everyday'],
    biases: [{ dimension: 'neighborhood_character', value: 'local', weight: 0.7 }],
    topics: ['local-neighbourhood'],
    vibes: ['authentic'],
    wantsLocal: true,
  },
  {
    id: 'touristy',
    // Strong negative bias when negated: this is the headline case.
    terms: ['touristy', 'tourist', 'tourists', 'tourist trap', 'crowded', 'crowds', 'packed', 'queues', 'lines'],
    biases: [{ dimension: 'touristiness', value: 'high', weight: 0.8 }],
    avoidsTouristy: false,
    negatedAvoidsTouristy: true,
  },
  {
    id: 'off-beat',
    terms: ['hidden gem', 'off the beaten path', 'off the beaten track', 'undiscovered', 'under the radar', 'lesser known'],
    biases: [
      { dimension: 'touristiness', value: 'high', weight: -0.7 },
      { dimension: 'neighborhood_character', value: 'local', weight: 0.6 },
    ],
    topics: ['local-neighbourhood'],
    vibes: ['hidden-gem'],
    wantsLocal: true,
    avoidsTouristy: true,
  },
  {
    id: 'quiet',
    terms: ['quiet', 'calm', 'peaceful', 'relaxed', 'chill', 'mellow'],
    biases: [{ dimension: 'touristiness', value: 'high', weight: -0.5 }],
    vibes: ['quiet'],
  },
  {
    id: 'busy',
    terms: ['busy', 'lively', 'buzzing', 'bustling', 'vibrant'],
    biases: [{ dimension: 'touristiness', value: 'high', weight: 0.3 }],
    vibes: ['lively'],
  },
  {
    id: 'free',
    terms: ['free', 'no cost', 'no entry fee'],
    biases: [{ dimension: 'price_tier', value: 'free', weight: 0.8 }],
    topics: ['free-to-enter'],
  },
  {
    id: 'cheap',
    terms: ['cheap', 'budget', 'affordable', 'inexpensive', 'low cost'],
    biases: [
      { dimension: 'price_tier', value: 'free', weight: 0.5 },
      { dimension: 'price_tier', value: '$', weight: 0.6 },
      { dimension: 'price_tier', value: '$$$', weight: -0.5 },
    ],
  },
  {
    id: 'splurge',
    terms: ['splurge', 'luxury', 'upscale', 'fancy', 'treat'],
    biases: [{ dimension: 'price_tier', value: '$$$', weight: 0.6 }],
  },
  {
    id: 'indoor',
    terms: ['indoor', 'indoors', 'inside', 'undercover', 'rainy day', 'rainy', 'raining', 'sheltered'],
    biases: [{ dimension: 'indoor_outdoor', value: 'indoor', weight: 0.7 }],
    topics: ['rainy-day-indoor'],
  },
  {
    id: 'outdoor',
    terms: ['outdoor', 'outdoors', 'outside', 'fresh air', 'open air', 'sunny'],
    biases: [{ dimension: 'indoor_outdoor', value: 'outdoor', weight: 0.7 }],
    topics: ['outdoor-play', 'green-space'],
  },
  {
    id: 'quick',
    terms: ['quick', 'short', 'brief', 'an hour', 'one hour', 'flying visit'],
    biases: [{ dimension: 'duration', value: 'short', weight: 0.7 }],
  },
  {
    id: 'half-day',
    terms: ['half day', 'half-day', 'morning out', 'afternoon out'],
    biases: [{ dimension: 'duration', value: 'medium', weight: 0.6 }],
  },
  {
    id: 'full-day',
    terms: ['full day', 'full-day', 'all day', 'whole day', 'day out'],
    biases: [{ dimension: 'duration', value: 'long', weight: 0.6 }],
  },
  {
    id: 'transit',
    terms: ['transit', 'metro', 'subway', 'public transport', 'no car', 'without a car', 'walkable'],
    biases: [],
    topics: ['transit-accessible'],
  },
];

/** Keyword -> core topic slug, so intent words line up with the taxonomy. */
const TOPIC_KEYWORDS: { keyword: string; slug: string }[] = CORE_TOPICS.flatMap((topic) =>
  topic.match.map((keyword) => ({ keyword: keyword.toLowerCase(), slug: topic.slug })),
);

function normalise(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9$\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens, keeping hyphenated forms split so "family-friendly" also reads as two words. */
function tokenize(text: string): string[] {
  return text.split(/[\s-]+/).filter(Boolean);
}

/** Is the phrase starting at token index `at` negated by something just before it? */
function isNegated(tokens: string[], at: number): boolean {
  for (let i = Math.max(0, at - NEGATION_WINDOW); i < at; i += 1) {
    const token = tokens[i];
    if (token && NEGATORS.has(token)) return true;
  }
  return false;
}

/** Every occurrence of `phrase` in the token stream, with its start index. */
function findPhrase(tokens: string[], phrase: string): number[] {
  const needle = tokenize(phrase);
  if (needle.length === 0) return [];
  const hits: number[] = [];
  for (let i = 0; i + needle.length <= tokens.length; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (tokens[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) hits.push(i);
  }
  return hits;
}

export function parseIntent(raw: string): ParsedIntent {
  const text = normalise(raw ?? '');
  const tokens = tokenize(text);

  const biases = new Map<string, Bias>();
  const topics = new Set<string>();
  const vibes = new Set<string>();
  let familyFriendly = false;
  let wantsLocal = false;
  let avoidsTouristy = false;

  const addBias = (bias: Bias): void => {
    const key = `${bias.dimension}|${bias.value}`;
    const existing = biases.get(key);
    // Strongest signal wins, so "not touristy ... touristy" does not cancel out
    // into a meaningless zero.
    if (!existing || Math.abs(bias.weight) > Math.abs(existing.weight)) biases.set(key, bias);
  };

  for (const rule of RULES) {
    let asserted = false;
    let negated = false;
    for (const term of rule.terms) {
      for (const at of findPhrase(tokens, term)) {
        if (isNegated(tokens, at)) negated = true;
        else asserted = true;
      }
    }
    if (!asserted && !negated) continue;

    // A term appearing both plainly and negated is treated as negated: the user
    // bothered to say "not", and that is the more specific instruction.
    const sign = negated ? -1 : 1;
    for (const bias of rule.biases) {
      addBias({ dimension: bias.dimension, value: bias.value, weight: bias.weight * sign });
    }
    if (!negated) {
      for (const slug of rule.topics ?? []) topics.add(slug);
      for (const vibe of rule.vibes ?? []) vibes.add(vibe);
      if (rule.familyFriendly) familyFriendly = true;
      if (rule.wantsLocal) wantsLocal = true;
      if (rule.avoidsTouristy) avoidsTouristy = true;
    } else {
      if (rule.negatedAvoidsTouristy) avoidsTouristy = true;
    }
  }

  // "not too touristy" also means "yes to local character", which is what the
  // ranker actually needs a positive handle on.
  if (avoidsTouristy) {
    addBias({ dimension: 'touristiness', value: 'low', weight: 0.5 });
  }

  // Free-text topic keywords, negation-aware.
  for (const entry of TOPIC_KEYWORDS) {
    for (const at of findPhrase(tokens, entry.keyword)) {
      if (!isNegated(tokens, at)) topics.add(entry.slug);
    }
  }

  return {
    raw,
    topics: [...topics].sort(),
    vibes: [...vibes].sort(),
    dimensionBias: [...biases.values()].sort((a, b) =>
      a.dimension === b.dimension
        ? a.value < b.value
          ? -1
          : a.value > b.value
            ? 1
            : 0
        : a.dimension < b.dimension
          ? -1
          : 1,
    ),
    familyFriendly,
    wantsLocal,
    avoidsTouristy,
  };
}

/** Look up one bias, e.g. biasFor(intent, 'touristiness', 'high'). */
export function biasFor(intent: ParsedIntent, dimension: string, value: string): number {
  for (const bias of intent.dimensionBias) {
    if (bias.dimension === dimension && bias.value === value) return bias.weight;
  }
  return 0;
}
