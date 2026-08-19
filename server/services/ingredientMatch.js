/**
 * INGREDIENT MATCH
 *
 * Helpers for finding "similar" pet food alternatives based on the source
 * product's primary ingredients.
 *
 * Concept:
 *   - Pet owners typically swap to alternatives within the same protein/base
 *     family (e.g. chicken-based dry food → another chicken-based dry food,
 *     or salmon → fish, beef → red meat).
 *   - We derive up to two "keyword sets" (K1, K2) from the source product's
 *     first few ingredients and use them to filter candidate products.
 *
 * API (consumed by productService.getCandidateAlternatives):
 *
 *   deriveSourceKeywords(ingredientsList) → { k1, k2 }
 *     - k1 = primary keyword set, k2 = secondary keyword set (or null)
 *     - Each set: { category: string|null, keywords: string[] }
 *
 *   candidateMatchesKeywords(candidateIngredients, keywordSet) → boolean
 *     - true if any candidate ingredient (in its top positions) matches any
 *       keyword in the set.
 */

// Categorized keyword groups. Each "category" expands a single ingredient
// hit (e.g. "salmon") into a wider matching family (any fish), so we don't
// over-narrow alternatives.
const CATEGORY_GROUPS = [
  {
    category: 'chicken',
    keywords: ['chicken', 'hen', 'poultry'],
  },
  {
    category: 'turkey',
    keywords: ['turkey'],
  },
  {
    category: 'duck',
    keywords: ['duck'],
  },
  {
    category: 'beef',
    keywords: ['beef', 'cattle', 'bovine'],
  },
  {
    category: 'lamb',
    keywords: ['lamb', 'mutton'],
  },
  {
    category: 'pork',
    keywords: ['pork', 'pig', 'porcine', 'bacon'],
  },
  {
    category: 'venison',
    keywords: ['venison', 'deer'],
  },
  {
    category: 'rabbit',
    keywords: ['rabbit'],
  },
  {
    category: 'fish',
    keywords: [
      'fish', 'salmon', 'tuna', 'whitefish', 'white fish', 'trout',
      'herring', 'mackerel', 'sardine', 'anchovy', 'cod', 'pollock',
      'menhaden', 'haddock', 'tilapia',
    ],
  },
  {
    category: 'lentil_legume',
    keywords: ['lentil', 'chickpea', 'garbanzo', 'pea protein', 'pea flour'],
  },
  {
    category: 'rice',
    keywords: ['rice', 'brown rice', 'white rice'],
  },
  {
    category: 'potato',
    keywords: ['potato', 'sweet potato'],
  },
];

// Soft fillers / generic terms that should not by themselves drive the
// similarity decision (they appear in nearly everything).
const IGNORE_TERMS = new Set([
  'water', 'broth', 'natural flavor', 'salt', 'oil', 'fat',
  'vitamin', 'mineral', 'supplement',
]);

const MAX_SOURCE_INGREDIENTS_TO_INSPECT = 5;
const MAX_CANDIDATE_INGREDIENTS_TO_INSPECT = 6;

function normalize(text) {
  return String(text || '').toLowerCase().trim();
}

function shouldIgnore(ingredient) {
  const lower = normalize(ingredient);
  if (!lower) return true;
  for (const term of IGNORE_TERMS) {
    if (lower === term) return true;
  }
  return false;
}

/**
 * Try to classify a single ingredient string into one of CATEGORY_GROUPS.
 * Returns { category, keywords } or null when no group matches.
 */
function classifyIngredient(ingredient) {
  const lower = normalize(ingredient);
  if (!lower) return null;

  for (const group of CATEGORY_GROUPS) {
    for (const keyword of group.keywords) {
      // Word-boundary-ish check: substring containment is enough here because
      // ingredient names are short noun phrases and keywords are distinct.
      if (lower.includes(keyword)) {
        return { category: group.category, keywords: group.keywords.slice() };
      }
    }
  }
  return null;
}

/**
 * Derive up to two keyword sets from the source product's main ingredients.
 *
 * Strategy:
 *   - Walk the first MAX_SOURCE_INGREDIENTS_TO_INSPECT ingredients.
 *   - Skip generic terms (water, salt, vitamin, ...).
 *   - First categorized hit becomes K1.
 *   - Next categorized hit with a different category becomes K2.
 *   - If we never hit a known category, fall back to a raw keyword set built
 *     from the first non-ignored ingredient (so the filter still narrows
 *     instead of returning nothing).
 */
function deriveSourceKeywords(ingredientsList) {
  if (!Array.isArray(ingredientsList) || ingredientsList.length === 0) {
    return { k1: null, k2: null };
  }

  const top = ingredientsList.slice(0, MAX_SOURCE_INGREDIENTS_TO_INSPECT);

  let k1 = null;
  let k2 = null;

  for (const ing of top) {
    if (shouldIgnore(ing)) continue;
    const classified = classifyIngredient(ing);
    if (!classified) continue;
    if (!k1) {
      k1 = classified;
    } else if (!k2 && classified.category !== k1.category) {
      k2 = classified;
      break;
    }
  }

  // Fallback: no known categories detected — derive a raw keyword from the
  // first meaningful ingredient so we still have *some* similarity signal.
  if (!k1) {
    const firstReal = top.find(ing => !shouldIgnore(ing));
    if (firstReal) {
      const word = normalize(firstReal).split(/\s+/)[0];
      if (word && word.length >= 3) {
        k1 = { category: null, keywords: [word] };
      }
    }
  }

  return { k1, k2 };
}

/**
 * Does this candidate look like it shares the given keyword set?
 *
 * A candidate matches when any of its top ingredients contains any of the
 * set's keywords (case-insensitive substring).
 */
function candidateMatchesKeywords(candidateIngredients, keywordSet) {
  if (!keywordSet || !Array.isArray(keywordSet.keywords) || keywordSet.keywords.length === 0) {
    return false;
  }
  if (!Array.isArray(candidateIngredients) || candidateIngredients.length === 0) {
    return false;
  }

  const top = candidateIngredients.slice(0, MAX_CANDIDATE_INGREDIENTS_TO_INSPECT);
  const lowerKeywords = keywordSet.keywords.map(k => normalize(k));

  for (const ing of top) {
    const lower = normalize(ing);
    if (!lower) continue;
    for (const kw of lowerKeywords) {
      if (kw && lower.includes(kw)) return true;
    }
  }
  return false;
}

module.exports = {
  deriveSourceKeywords,
  candidateMatchesKeywords,
};
