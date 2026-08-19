/**
 * Topic Graph: a small curated taxonomy plus automatic candidate discovery.
 *
 * The curated half is deliberately opinionated and family-shaped ("water play",
 * "rainy day indoor", "stroller friendly"), because those are the words parents
 * actually use. The discovered half exists so the taxonomy is not frozen at
 * whatever twenty topics one author thought of: terms that recur across places
 * but are NOT true of every place become candidates, and only the ones with
 * enough support and enough discriminative power are promoted.
 */

import type { Db } from '../db/index.ts';
import type { Place, Result, Topic, TopicCandidate, TopicStatus } from '../contracts/index.ts';
import {
  ok,
  err,
  computeConfidence,
  makeId,
  slugify,
  SOURCE_AUTHORITY,
  TOPIC_PROMOTION_MIN_SUPPORT,
  TOPIC_PROMOTION_MIN_DISTINCTIVENESS,
} from '../contracts/index.ts';
import { listAllPlaces } from '../db/repo-places.ts';
import { nowIso } from '../runtime/clock.ts';

/**
 * The curated taxonomy. `match` keywords are matched case-insensitively against
 * a place's name, category, subcategory and description.
 */
export const CORE_TOPICS: { slug: string; label: string; parent?: string; match: string[] }[] = [
  // --- roots -------------------------------------------------------------
  { slug: 'learning', label: 'Learning', match: ['museum', 'exhibit', 'educational'] },
  { slug: 'outdoors', label: 'Outdoors', match: ['outdoor', 'fresh air', 'open air'] },
  { slug: 'culture', label: 'Culture', match: ['culture', 'cultural', 'heritage'] },
  { slug: 'practicalities', label: 'Practicalities', match: ['facilities', 'amenities'] },
  { slug: 'food', label: 'Food and Drink', match: ['food', 'eat', 'dining'] },

  // --- learning ----------------------------------------------------------
  {
    slug: 'hands-on-science',
    label: 'Hands-on Science',
    parent: 'learning',
    match: ['science', 'experiment', 'hands-on', 'interactive', 'discovery', 'planetarium', 'laboratory'],
  },
  {
    slug: 'animals-and-wildlife',
    label: 'Animals and Wildlife',
    parent: 'learning',
    match: ['zoo', 'aquarium', 'animals', 'wildlife', 'birds', 'farm', 'petting', 'safari', 'penguin'],
  },
  {
    slug: 'space-and-sky',
    label: 'Space and Sky',
    parent: 'learning',
    match: ['space', 'astronomy', 'observatory', 'stars', 'rocket', 'telescope'],
  },
  {
    slug: 'books-and-stories',
    label: 'Books and Stories',
    parent: 'learning',
    match: ['library', 'books', 'storytime', 'reading', 'bookshop'],
  },

  // --- outdoors ----------------------------------------------------------
  {
    slug: 'outdoor-play',
    label: 'Outdoor Play',
    parent: 'outdoors',
    match: ['playground', 'play area', 'swings', 'climbing frame', 'sandpit', 'adventure play'],
  },
  {
    slug: 'water-play',
    label: 'Water Play',
    parent: 'outdoors',
    match: ['splash', 'paddling', 'fountain', 'water play', 'lido', 'beach', 'swimming', 'boating'],
  },
  {
    slug: 'green-space',
    label: 'Parks and Green Space',
    parent: 'outdoors',
    match: ['park', 'garden', 'meadow', 'lawn', 'botanic', 'arboretum'],
  },
  {
    slug: 'easy-walks',
    label: 'Easy Walks',
    parent: 'outdoors',
    match: ['trail', 'walk', 'path', 'boardwalk', 'promenade', 'stroll'],
  },
  {
    slug: 'viewpoints',
    label: 'Views and Lookouts',
    parent: 'outdoors',
    match: ['viewpoint', 'lookout', 'panorama', 'skyline', 'observation deck'],
  },

  // --- culture -----------------------------------------------------------
  {
    slug: 'historic',
    label: 'Historic Places',
    parent: 'culture',
    match: ['historic', 'history', 'castle', 'ruins', 'heritage', 'ancient', 'monument', 'cathedral'],
  },
  {
    slug: 'art-and-making',
    label: 'Art and Making',
    parent: 'culture',
    match: ['art', 'gallery', 'craft', 'workshop', 'pottery', 'making', 'studio', 'sculpture'],
  },
  {
    slug: 'local-neighbourhood',
    label: 'Local Neighbourhood',
    parent: 'culture',
    match: ['neighbourhood', 'neighborhood', 'local favourite', 'local favorite', 'residential', 'community'],
  },
  {
    slug: 'markets-and-street-life',
    label: 'Markets and Street Life',
    parent: 'culture',
    match: ['market', 'stalls', 'bazaar', 'street food', 'flea market'],
  },
  {
    slug: 'performance',
    label: 'Shows and Performance',
    parent: 'culture',
    match: ['theatre', 'theater', 'puppet', 'concert', 'performance', 'cinema'],
  },

  // --- practicalities ----------------------------------------------------
  {
    slug: 'rainy-day-indoor',
    label: 'Rainy Day Indoor',
    parent: 'practicalities',
    match: ['indoor', 'undercover', 'rainy day', 'sheltered', 'all weather'],
  },
  {
    slug: 'stroller-friendly',
    label: 'Stroller Friendly',
    parent: 'practicalities',
    match: ['stroller', 'pushchair', 'pram', 'buggy', 'step-free', 'level access', 'accessible'],
  },
  {
    slug: 'transit-accessible',
    label: 'Transit Accessible',
    parent: 'practicalities',
    match: ['metro', 'subway', 'tram', 'bus stop', 'station', 'transit', 'underground'],
  },
  {
    slug: 'free-to-enter',
    label: 'Free to Enter',
    parent: 'practicalities',
    match: ['free entry', 'free admission', 'no charge', 'donation'],
  },

  // --- food --------------------------------------------------------------
  {
    slug: 'kid-friendly-eating',
    label: 'Kid-friendly Eating',
    parent: 'food',
    match: ['kids menu', 'high chair', 'family restaurant', 'picnic', 'cafe'],
  },
];

const TAXONOMY_AUTHORITY = SOURCE_AUTHORITY.official;
const DISCOVERY_AUTHORITY = SOURCE_AUTHORITY.inferred;

/** Match strengths. A word in the name says far more than a word in the blurb. */
const WEIGHT_NAME = 0.9;
const WEIGHT_CATEGORY = 0.7;
const WEIGHT_DESCRIPTION = 0.45;

export function topicIdFor(slug: string): string {
  return makeId('topic', slug);
}

export function seedCoreTopics(db: Db): Result<{ created: number }> {
  try {
    const now = nowIso();
    // Curated by hand and reviewed, so the taxonomy sits at official authority.
    const confidence = computeConfidence({
      authorities: [TAXONOMY_AUTHORITY],
      verification: 'human_verified',
    });
    let created = 0;
    db.transaction(() => {
      // Parents first so the self-referencing FK is always satisfiable.
      const ordered = [
        ...CORE_TOPICS.filter((t) => !t.parent),
        ...CORE_TOPICS.filter((t) => t.parent),
      ];
      for (const topic of ordered) {
        const existed = db.get<{ id: string }>('SELECT id FROM topics WHERE slug = ?', topic.slug);
        db.run(
          `INSERT INTO topics (id, slug, label, parent_topic_id, status, support_count, confidence, created_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(slug) DO UPDATE SET
             label = excluded.label,
             parent_topic_id = excluded.parent_topic_id,
             status = 'core',
             confidence = excluded.confidence`,
          topicIdFor(topic.slug),
          topic.slug,
          topic.label,
          topic.parent ? topicIdFor(topic.parent) : null,
          'core',
          0,
          confidence.value,
          now,
        );
        if (!existed) created += 1;
      }
    });
    return ok({ created });
  } catch (error) {
    return err('internal', 'could not seed core topics', undefined, error);
  }
}

function haystacks(place: Place): { name: string; category: string; description: string } {
  return {
    name: place.name.toLowerCase(),
    category: `${place.category} ${place.subcategory ?? ''}`.toLowerCase().replace(/_/g, ' '),
    description: (place.description ?? '').toLowerCase(),
  };
}

/** Strength of the best keyword hit for one topic on one place, or 0. */
export function matchStrength(place: Place, keywords: string[]): number {
  const text = haystacks(place);
  let best = 0;
  for (const raw of keywords) {
    const keyword = raw.toLowerCase();
    if (text.name.includes(keyword)) best = Math.max(best, WEIGHT_NAME);
    else if (text.category.includes(keyword)) best = Math.max(best, WEIGHT_CATEGORY);
    else if (text.description.includes(keyword)) best = Math.max(best, WEIGHT_DESCRIPTION);
  }
  return best;
}

function linkPlaceTopic(db: Db, placeId: string, topicId: string, weight: number, source: 'taxonomy' | 'discovered'): void {
  db.run(
    `INSERT INTO place_topics (place_id, topic_id, weight, source)
     VALUES (?,?,?,?)
     ON CONFLICT(place_id, topic_id) DO UPDATE SET
       weight = excluded.weight, source = excluded.source
     WHERE place_topics.source <> 'manual'`,
    placeId,
    topicId,
    weight,
    source,
  );
}

function refreshSupportCounts(db: Db): void {
  db.run(
    `UPDATE topics SET support_count =
       (SELECT COUNT(*) FROM place_topics WHERE place_topics.topic_id = topics.id)`,
  );
}

export function linkPlacesToTopics(db: Db): Result<{ links: number }> {
  try {
    const places = listAllPlaces(db);
    let links = 0;
    db.transaction(() => {
      for (const place of places) {
        for (const topic of CORE_TOPICS) {
          const weight = matchStrength(place, topic.match);
          if (weight <= 0) continue;
          linkPlaceTopic(db, place.id, topicIdFor(topic.slug), weight, 'taxonomy');
          links += 1;
        }
      }
      refreshSupportCounts(db);
    });
    return ok({ links });
  } catch (error) {
    return err('internal', 'could not link places to topics', undefined, error);
  }
}

/**
 * Words that carry no discriminative power in place blurbs. Deliberately
 * includes travel filler ("visit", "experience") as well as English stopwords.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'they', 'them', 'there', 'their',
  'have', 'has', 'had', 'was', 'were', 'are', 'you', 'your', 'our', 'its', 'it',
  'a', 'an', 'of', 'in', 'on', 'at', 'to', 'by', 'as', 'is', 'be', 'or', 'but', 'not',
  'all', 'any', 'can', 'will', 'more', 'most', 'other', 'over', 'into', 'out', 'about',
  'visit', 'visitors', 'experience', 'place', 'places', 'great', 'good', 'best', 'nice',
  'here', 'where', 'when', 'while', 'also', 'very', 'just', 'like', 'one', 'two',
  'city', 'town', 'area', 'well', 'many', 'some', 'each', 'every', 'both', 'than',
  'then', 'been', 'being', 'get', 'go', 'goes', 'make', 'made', 'take', 'takes',
  'day', 'days', 'time', 'times', 'people', 'family', 'families', 'kids', 'children',
]);

const TOKEN_RE = /[a-z][a-z'-]{3,}/g;

export function tokenise(text: string): string[] {
  const out: string[] = [];
  for (const match of text.toLowerCase().matchAll(TOKEN_RE)) {
    const token = match[0].replace(/^['-]+|['-]+$/g, '');
    if (token.length < 4) continue;
    if (STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

/** Terms already spoken for by the curated taxonomy. */
function coveredTerms(): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const topic of CORE_TOPICS) {
    for (const part of topic.slug.split('-')) covered.add(part);
    for (const keyword of topic.match) {
      for (const part of keyword.toLowerCase().split(/[^a-z]+/)) {
        if (part) covered.add(part);
      }
    }
  }
  return covered;
}

/**
 * Find terms that might deserve to be topics.
 *
 * Distinctiveness = 1 - docFrequency/totalPlaces. A word appearing in every
 * description ("museum" in a museums-only dataset) describes the corpus, not a
 * subset of it, and is worth nothing as a topic no matter how common it is.
 */
export function discoverCandidates(db: Db, minSupport = 2): Result<TopicCandidate[]> {
  try {
    const places = listAllPlaces(db);
    const total = places.length;
    if (total === 0) return ok([]);

    const covered = coveredTerms();
    const support = new Map<string, Set<string>>();

    for (const place of places) {
      const text = `${place.name} ${place.description ?? ''}`;
      for (const token of new Set(tokenise(text))) {
        if (covered.has(token)) continue;
        let ids = support.get(token);
        if (!ids) {
          ids = new Set<string>();
          support.set(token, ids);
        }
        ids.add(place.id);
      }
    }

    const candidates: TopicCandidate[] = [];
    for (const [term, ids] of support) {
      const docFrequency = ids.size;
      if (docFrequency < minSupport) continue;
      const distinctiveness = 1 - docFrequency / total;
      candidates.push({
        term,
        support: [...ids].sort(),
        distinctiveness,
        score: Math.log(1 + docFrequency) * distinctiveness,
      });
    }

    candidates.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.term < b.term ? -1 : 1));
    return ok(candidates);
  } catch (error) {
    return err('internal', 'topic discovery failed', undefined, error);
  }
}

/**
 * Turn candidates into topic rows. Everything discovered is recorded; only what
 * clears BOTH thresholds becomes a `promoted` topic linked to its places. The
 * rest are parked as `candidate` so a later, larger corpus can promote them.
 */
export function promoteCandidates(
  db: Db,
  candidates: TopicCandidate[],
): Result<{ promoted: number; rejected: number }> {
  try {
    const now = nowIso();
    let promoted = 0;
    let rejected = 0;

    db.transaction(() => {
      for (const candidate of candidates) {
        const slug = slugify(candidate.term);
        if (!slug) continue;
        const existing = db.get<{ status: string }>('SELECT status FROM topics WHERE slug = ?', slug);
        if (existing && existing.status === 'core') continue;

        const qualifies =
          candidate.support.length >= TOPIC_PROMOTION_MIN_SUPPORT &&
          candidate.distinctiveness >= TOPIC_PROMOTION_MIN_DISTINCTIVENESS;
        const status: TopicStatus = qualifies ? 'promoted' : 'candidate';
        // Discovery is inference over existing records, never observation.
        const confidence = computeConfidence({
          authorities: new Array<number>(candidate.support.length).fill(DISCOVERY_AUTHORITY),
        });
        const id = topicIdFor(slug);

        db.run(
          `INSERT INTO topics (id, slug, label, parent_topic_id, status, support_count, confidence, created_at)
           VALUES (?,?,?,NULL,?,?,?,?)
           ON CONFLICT(slug) DO UPDATE SET
             status = excluded.status,
             support_count = excluded.support_count,
             confidence = excluded.confidence`,
          id,
          slug,
          labelFor(candidate.term),
          status,
          candidate.support.length,
          confidence.value,
          now,
        );

        if (qualifies) {
          promoted += 1;
          const weight = 0.4 + 0.4 * candidate.distinctiveness;
          for (const placeId of candidate.support) {
            linkPlaceTopic(db, placeId, id, weight, 'discovered');
          }
        } else {
          rejected += 1;
        }
      }
      refreshSupportCounts(db);
    });

    return ok({ promoted, rejected });
  } catch (error) {
    return err('internal', 'could not promote topic candidates', undefined, error);
  }
}

function labelFor(term: string): string {
  return term
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => (w[0] ?? '').toUpperCase() + w.slice(1))
    .join(' ');
}

export function buildTopicGraph(
  db: Db,
  opts?: { discover?: boolean },
): Result<{ core: number; links: number; candidates: number; promoted: number }> {
  const seeded = seedCoreTopics(db);
  if (!seeded.ok) return err(seeded.error.kind, seeded.error.message, seeded.error.detail, seeded.error.cause);

  const linked = linkPlacesToTopics(db);
  if (!linked.ok) return err(linked.error.kind, linked.error.message, linked.error.detail, linked.error.cause);

  let candidates = 0;
  let promoted = 0;
  if (opts?.discover) {
    const found = discoverCandidates(db);
    if (!found.ok) return err(found.error.kind, found.error.message, found.error.detail, found.error.cause);
    candidates = found.value.length;
    const result = promoteCandidates(db, found.value);
    if (!result.ok) return err(result.error.kind, result.error.message, result.error.detail, result.error.cause);
    promoted = result.value.promoted;
  }

  return ok({ core: seeded.value.created, links: linked.value.links, candidates, promoted });
}

export function getTopicBySlug(db: Db, slug: string): Topic | null {
  const row = db.get<Record<string, unknown>>('SELECT * FROM topics WHERE slug = ?', slug);
  if (!row) return null;
  return {
    id: String(row.id),
    slug: String(row.slug),
    label: String(row.label),
    parentTopicId: (row.parent_topic_id as string) ?? null,
    status: row.status as TopicStatus,
    supportCount: Number(row.support_count),
    // `topics` has no confidence_json column, so only the scalar survives: the
    // object is rebuilt with that scalar as its authority component.
    confidence: computeConfidence({ authorities: [Number(row.confidence)] }),
    createdAt: String(row.created_at),
  };
}
