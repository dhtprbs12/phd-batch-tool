const { query } = require('./connection');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const ingredientAnalyzer = require('./ingredientAnalyzer');
const ingredientMatch = require('./ingredientMatch');
const productMatchKey = require('./productMatchKey');

class ProductService {
  /**
   * Generate ingredient hash for deduplication
   * Same ingredients (regardless of name) = Same hash
   */
  generateIngredientHash(ingredientsList) {
    if (!ingredientsList || ingredientsList.length === 0) {
      return null;
    }
    
    // Normalize: lowercase, trim, sort alphabetically, comma-separated
    // Must match seed-products.js hash format for consistency
    const normalized = ingredientsList
      .map(ing => ing.toLowerCase().trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .sort()
      .join(',');
    
    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  /**
   * Normalize a name/brand string for fuzzy comparison
   * (lowercase, strip punctuation, collapse whitespace)
   */
  normalizeForMatch(text) {
    if (!text) return '';
    return String(text)
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Tokens for Jaccard / overlap; each token trim()d, empties dropped. */
  _tokensFromNormalized(norm) {
    if (!norm || !String(norm).trim()) return [];
    return String(norm)
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  /** Jaccard similarity on token sets in [0, 1]. Both empty => 1; one empty => 0. */
  _jaccardTokenSimilarity(normA, normB) {
    const ta = this._tokensFromNormalized(normA);
    const tb = this._tokensFromNormalized(normB);
    if (ta.length === 0 && tb.length === 0) return 1;
    if (ta.length === 0 || tb.length === 0) return 0;
    const setA = new Set(ta);
    const setB = new Set(tb);
    let inter = 0;
    for (const x of setA) {
      if (setB.has(x)) inter += 1;
    }
    const union = setA.size + setB.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  static MATCH_TOKEN_JACCARD_MIN = 0.7;

  /**
   * Find product by ingredient hash, optionally narrowing by brand + name.
   *
   * Why brand/name on top of hash:
   * - Two different SKUs (e.g. same OEM private-label, or two trims in the
   *   same product line) can share an identical ingredient list → same hash.
   *   Without a brand/name guard we'd merge them into one DB row.
   *
   * Matching rules when brand/name are provided:
   *   1. Exact-ish match: hash + brand fuzzy-equal + name fuzzy-equal → that row
   *   2. Otherwise: hash + brand fuzzy-equal → first row (handles OCR noise on name)
   *   3. Otherwise: hash + token Jaccard ≥ MATCH_TOKEN_JACCARD_MIN on each
   *      non-empty scan field (brand and/or name; empty scan side skipped as 1) → best row
   *   4. Otherwise: null (treat as a new product even though ingredients match)
   *
   * If brand/name are not provided, falls back to hash-only (legacy behavior).
   */
  async findByIngredientHash(hash, brand = null, name = null) {
    if (!hash) return null;

    const results = await query(
      'SELECT * FROM products WHERE ingredient_hash = ?',
      [hash]
    );
    if (results.length === 0) return null;

    if (!brand && !name) {
      return results[0];
    }

    const normBrand = this.normalizeForMatch(brand);
    const normName = this.normalizeForMatch(name);

    if (normBrand && normName) {
      const exact = results.find(r =>
        (this.normalizeForMatch(r.brand) === normBrand || this.normalizeForMatch(r.manufacturer) === normBrand) &&
        this.normalizeForMatch(r.name) === normName
      );
      if (exact) return exact;
    }

    if (normBrand) {
      const brandMatch = results.find(r =>
        this.normalizeForMatch(r.brand) === normBrand || this.normalizeForMatch(r.manufacturer) === normBrand
      );
      if (brandMatch) return brandMatch;
    }

    // Token Jaccard on brand AND name (each side with signal must pass ≥ min).
    if (!normBrand && !normName) {
      return null;
    }
    const minJ = ProductService.MATCH_TOKEN_JACCARD_MIN;
    let best = null;
    let bestKey = -1;
    for (const r of results) {
      const dbBrand = this.normalizeForMatch(r.brand) || this.normalizeForMatch(r.manufacturer);
      const dbName = this.normalizeForMatch(r.name);
      const jb = normBrand ? this._jaccardTokenSimilarity(normBrand, dbBrand) : 1;
      const jn = normName ? this._jaccardTokenSimilarity(normName, dbName) : 1;
      if (jb >= minJ && jn >= minJ) {
        const mn = Math.min(jb, jn);
        const av = (jb + jn) / 2;
        const key = mn * 1000 + av;
        if (key > bestKey) {
          bestKey = key;
          best = r;
        }
      }
    }
    if (best) return best;

    return null;
  }

  /**
   * Find product by ID
   */
  async findById(productId) {
    const results = await query(
      'SELECT * FROM products WHERE id = ?',
      [productId]
    );
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Search products by text
   */
  async search(searchTerm, options = {}) {
    const { targetPetType, productType, lifeStage, limit = 20, offset = 0 } = options;
    
    // Handle empty search term
    if (!searchTerm || searchTerm.trim() === '') {
      return [];
    }
    
    const term = searchTerm.trim();
    const words = term.split(/\s+/).filter(Boolean);
    
    let sql = `SELECT * FROM products WHERE `;
    const params = [];

    if (words.length > 1) {
      const wordClauses = words.map(() => `(name LIKE ? OR brand LIKE ? OR manufacturer LIKE ?)`);
      sql += `(${wordClauses.join(' AND ')})`;
      for (const w of words) {
        params.push(`%${w}%`, `%${w}%`, `%${w}%`);
      }
    } else {
      sql += `(name LIKE ? OR brand LIKE ? OR manufacturer LIKE ?)`;
      params.push(`%${term}%`, `%${term}%`, `%${term}%`);
    }

    if (targetPetType) {
      sql += ` AND (target_pet_type = ? OR target_pet_type = 'both')`;
      params.push(targetPetType);
    }

    if (productType) {
      sql += ` AND product_type = ?`;
      params.push(productType);
    }

    if (lifeStage) {
      sql += ` AND (target_life_stage = ? OR target_life_stage = 'all')`;
      params.push(lifeStage);
    }

    sql += ` ORDER BY name ASC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    return await query(sql, params);
  }


  /**
   * Filter products by multiple criteria
   * Used for product discovery feature
   */
  async filterProducts(filters = {}) {
    const {
      petType,
      productType,
      lifeStage,
      allergenExclusions = {},
      ingredientInclusions = {},
      healthConditions = [],
      minScore,
      searchTerm,
      limit = 20,
      offset = 0
    } = filters;

    // Ingredient keywords for allergen filtering
    const ingredientKeywords = {
      chicken: ['chicken', 'poultry'],
      beef: ['beef', 'cattle'],
      fish: ['fish', 'salmon', 'tuna', 'sardine', 'anchovy', 'herring', 'cod', 'tilapia', 'whitefish'],
      lamb: ['lamb'],
      turkey: ['turkey'],
      duck: ['duck'],
      dairy: ['milk', 'cheese', 'whey', 'dairy'],
      grains: ['wheat', 'corn', 'maize', 'rice', 'barley', 'oat', 'grain', 'sorghum', 'millet', 'rye', 'spelt'],
      eggs: ['egg'],
      soy: ['soy', 'soybean']
    };

    // Map allergy condition types to ingredient keyword keys
    const allergyToKeyword = {
      allergy_chicken: 'chicken',
      allergy_beef: 'beef',
      allergy_fish: 'fish',
      allergy_dairy: 'dairy',
      allergy_grains: 'grains',
      allergy_eggs: 'eggs',
      allergy_soy: 'soy',
      allergy_lamb: 'lamb'
    };

    // =============================================
    // Classify health conditions upfront
    // =============================================
    const allergyConditions = [];
    const diseaseConditions = [];

    for (const condition of healthConditions) {
      const conditionType = condition.condition_type || condition.conditionType || condition;
      if (allergyToKeyword[conditionType]) {
        allergyConditions.push(conditionType);
      } else if (conditionType !== 'healthy') {
        diseaseConditions.push(conditionType);
      }
    }

    // =============================================
    // Build SQL in order: SELECT → JOIN → WHERE → ORDER
    // Single params array, pushed in SQL clause order
    // =============================================
    const params = [];

    // ── 1. JOINs (disease condition exclusion via product_review_cache) ──
    const isTreats = productType === 'treats';
    const productTypeForHash = isTreats ? 'treats' : 'food';
    let joinSql = '';

    diseaseConditions.forEach((condition, idx) => {
      const alias = `prc${idx}`;
      const conditionHash = `${condition}_${productTypeForHash}`;
      joinSql += ` LEFT JOIN product_review_cache ${alias}` +
        ` ON ${alias}.ingredient_hash = p.ingredient_hash` +
        ` AND ${alias}.conditions_hash = ? AND ${alias}.pet_type = ?`;
      params.push(conditionHash, petType || 'dog');
    });

    // ── 2. WHERE clauses ──
    const where = [];

    // Pet type
    if (petType) {
      where.push(`(p.target_pet_type = ? OR p.target_pet_type = 'both')`);
      params.push(petType);
    }

    // Product type
    if (productType) {
      where.push('p.product_type = ?');
      params.push(productType);
    }

    // Life stage
    if (lifeStage) {
      where.push(`(p.target_life_stage = ? OR p.target_life_stage = 'all')`);
      params.push(lifeStage);
    }

    // Min score
    if (minScore) {
      if (petType === 'dog') {
        where.push('p.base_dog_score >= ?');
      } else if (petType === 'cat') {
        where.push('p.base_cat_score >= ?');
      } else {
        where.push('(p.base_dog_score >= ? OR p.base_cat_score >= ?)');
        params.push(minScore);
      }
      params.push(minScore);
    }

    // Allergy exclusions — only when browsing via filters, not when user typed a search
    if (!searchTerm) {
      for (const conditionType of allergyConditions) {
        const keywords = ingredientKeywords[allergyToKeyword[conditionType]];
        for (const keyword of keywords) {
          where.push(`LOWER(p.raw_ingredients_text) NOT LIKE ?`);
          params.push(`%${keyword}%`);
        }
      }

      // Disease condition WHERE filters (exclude D/F grades, keep unscored)
      diseaseConditions.forEach((_, idx) => {
        const alias = `prc${idx}`;
        where.push(`(${alias}.id IS NULL OR ${alias}.grade NOT IN ('D', 'F'))`);
      });
    }

    // Filter chip exclusions (grain-free toggle etc.)
    for (const [allergen, exclude] of Object.entries(allergenExclusions)) {
      if (exclude && ingredientKeywords[allergen]) {
        for (const keyword of ingredientKeywords[allergen]) {
          where.push(`LOWER(p.raw_ingredients_text) NOT LIKE ?`);
          params.push(`%${keyword}%`);
        }
      }
    }

    // Ingredient inclusions — match if keyword appears in first 3 ingredients
    const activeInclusions = Object.entries(ingredientInclusions)
      .filter(([_, include]) => include)
      .map(([ingredient]) => ingredient);
    
    if (activeInclusions.length > 0) {
      const inclusionClauses = [];
      for (const ingredient of activeInclusions) {
        if (!ingredientKeywords[ingredient]) continue;
        for (const keyword of ingredientKeywords[ingredient]) {
          inclusionClauses.push(
            `LOWER(SUBSTRING_INDEX(p.raw_ingredients_text, ',', 1)) LIKE ?`,
            `LOWER(TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(p.raw_ingredients_text, ',', 2), ',', -1))) LIKE ?`,
            `LOWER(TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(p.raw_ingredients_text, ',', 3), ',', -1))) LIKE ?`
          );
          params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
        }
      }
      if (inclusionClauses.length > 0) {
        where.push(`(${inclusionClauses.join(' OR ')})`);
      }
    }

    // Text search
    if (searchTerm && searchTerm.length >= 2) {
      where.push('(p.name LIKE ? OR p.brand LIKE ? OR p.manufacturer LIKE ?)');
      params.push(`%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`);
    }

    // ── Assemble WHERE ──
    const whereStr = where.length > 0 ? where.join(' AND ') : '1=1';

    // Count total matching rows (before LIMIT/OFFSET)
    const countSql = `SELECT COUNT(*) as total FROM products p${joinSql} WHERE ${whereStr}`;
    const countResult = await query(countSql, [...params]);
    const total = countResult[0]?.total ?? 0;

    // ── 3. ORDER + LIMIT ──
    params.push(limit, offset);
    const sql = `SELECT p.* FROM products p${joinSql} WHERE ${whereStr} ORDER BY p.name ASC LIMIT ? OFFSET ?`;

    console.log('🔍 Filter SQL:', sql);

    const results = await query(sql, params);
    console.log(`🔍 Filter results: ${results.length} products (total: ${total})`);
    
    return { products: results, total };
  }

  /**
   * Create new product from scan data
   */
  async createFromScan(productData) {
    const id = uuidv4();
    
    // Generate ingredient hash for deduplication
    const ingredientHash = productData.ingredientsList 
      ? this.generateIngredientHash(productData.ingredientsList)
      : null;

    const matchFields = productMatchKey.buildProductMatchFields({
      manufacturer: productData.manufacturer,
      brand: productData.brand,
      lineName: productData.lineName,
      lifeStage: productData.lifeStage,
      targetPetType: productData.targetPetType,
      primaryProteins: productData.primaryProteins,
      breedSize: productData.breedSize,
      dietTags: productData.dietTags,
    });
    
    try {
      await query(
        `INSERT INTO products 
         (id, name, brand, manufacturer, barcode, brand_norm, line_name, primary_proteins, breed_size, diet_tags, match_key,
          product_type, texture, target_pet_type, target_life_stage, 
          raw_ingredients_text, ingredient_hash, image_url, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          productData.name || productData.displayName || 'Unknown Product',
          productData.brand || null,
          productData.manufacturer || null,
          productData.barcode || null,
          matchFields.brand_norm,
          matchFields.line_name,
          matchFields.primary_proteins,
          matchFields.breed_size,
          matchFields.diet_tags,
          matchFields.match_key,
          productData.productType || 'dry_food',
          productData.texture || null,
          productData.targetPetType || 'both',
          productData.lifeStage || matchFields.target_life_stage || 'all',
          productData.rawIngredientsText || null,
          ingredientHash,
          productData.imageUrl || null,
          productData.source || 'user_scan'
        ]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY' && ingredientHash) {
        const existing = await this.findByIngredientHash(ingredientHash);
        if (existing) return existing;
      }
      throw err;
    }

    return await this.findById(id);
  }

  /**
   * Get product with full analysis for a specific pet
   */
  async getProductAnalysis(productId, pet) {
    console.log('🔍 [getProductAnalysis] Looking for product ID:', productId);
    const product = await this.findById(productId);
    if (!product) {
      console.log('❌ [getProductAnalysis] Product not found!');
      throw new Error('Product not found');
    }
    console.log('✅ [getProductAnalysis] Found product:', product.name);

    // Parse ingredients
    const ingredientsList = ingredientAnalyzer.parseIngredientText(product.raw_ingredients_text);

    // Run analysis
    const analysis = await ingredientAnalyzer.analyzeIngredients(ingredientsList, pet);

    return {
      product,
      analysis
    };
  }

  /**
   * Get candidate alternative products (no scoring - that's done in the route).
   *
   * Two-stage filter:
   *  1) SQL: same product_type, compatible pet type, has ingredient text,
   *     allergen keywords excluded. No popularity ordering — final ranking is
   *     decided by score in the route. A high SAFETY_CAP guards against
   *     pathological catalogs.
   *  2) JS (K1/K2 similarity): the source product's first two "meaningful"
   *     ingredients (skip dictionary applied — water/broth/flavor/etc.) must
   *     show up in the candidate's first two meaningful ingredients. K1 is
   *     preferred; K2 is the fallback. If neither is mappable, the
   *     similarity stage is skipped (legacy behavior).
   *
   * Returns every K1/K2-matched candidate (no slice). The route scores them
   * and sorts by score with the ≥80 → ≥60 → ≥50 thresholds.
   *
   * @param {string} productId - Source product to find alternatives for
   * @param {string} petType - 'dog' or 'cat'
   * @param {number} limit - Used only when the similarity filter cannot be
   *   built (legacy path). Otherwise ignored.
   * @param {string[]} allergens - Allergen keywords to exclude (e.g., ['chicken', 'beef'])
   */
  async getCandidateAlternatives(productId, petType, limit = 10, allergens = []) {
    const product = await this.findById(productId);
    if (!product) return { product: null, candidates: [] };

    const sourceIngredients = ingredientAnalyzer.parseIngredientText(product.raw_ingredients_text || '');
    const { k1, k2 } = ingredientMatch.deriveSourceKeywords(sourceIngredients);
    const hasSimilarityFilter = !!(k1 || k2);

    if (hasSimilarityFilter) {
      console.log(
        `🎯 [ALT-K] Source K1=${k1 ? `${k1.category || 'raw'}:${k1.keywords.join('|')}` : '∅'} ` +
        `K2=${k2 ? `${k2.category || 'raw'}:${k2.keywords.join('|')}` : '∅'}`
      );
    }

    let allergenFilter = '';
    const params = [productId, product.product_type, petType, productId, productId];

    for (const allergen of allergens) {
      allergenFilter += ` AND LOWER(p.raw_ingredients_text) NOT LIKE ?`;
      params.push(`%${allergen.toLowerCase()}%`);
    }

    // Safety cap to avoid hauling a pathological number of rows when the
    // similarity filter is active. With a normal catalog, K1/K2 matches sit
    // well under this. When the filter cannot be built, fall back to the
    // caller-supplied `limit` for legacy behavior.
    const SAFETY_CAP = 1500;
    const sqlLimit = hasSimilarityFilter ? SAFETY_CAP : limit;
    params.push(sqlLimit);

    const sql = `
      SELECT p.*,
        p.scan_count as relevance_score
      FROM products p
      WHERE p.id != ?
        AND p.product_type = ?
        AND (p.target_pet_type = ? OR p.target_pet_type = 'both')
        AND p.raw_ingredients_text IS NOT NULL
        AND p.raw_ingredients_text != ''
        AND NOT (p.name = (SELECT name FROM products WHERE id = ?) AND p.brand <=> (SELECT brand FROM products WHERE id = ?))
        ${allergenFilter}
      LIMIT ?
    `;

    const rows = await query(sql, params);

    if (!hasSimilarityFilter) {
      return { product, candidates: rows };
    }

    const filtered = [];
    for (const row of rows) {
      const candIngs = ingredientAnalyzer.parseIngredientText(row.raw_ingredients_text || '');
      if (k1 && ingredientMatch.candidateMatchesKeywords(candIngs, k1)) {
        filtered.push(row);
        continue;
      }
      if (k2 && ingredientMatch.candidateMatchesKeywords(candIngs, k2)) {
        filtered.push(row);
      }
    }

    console.log(`🎯 [ALT-K] Pool ${rows.length} → matched ${filtered.length} (no slice — route ranks by score)`);

    return { product, candidates: filtered };
  }

  /**
   * Get product reviews with filtering
   */
  async getReviews(productId, filters = {}) {
    const { petType, petSize, petAgeGroup, hasAllergies, limit = 20, offset = 0 } = filters;

    let sql = 'SELECT * FROM product_reviews WHERE product_id = ?';
    const params = [productId];

    if (petType) {
      sql += ' AND pet_type = ?';
      params.push(petType);
    }
    if (petSize) {
      sql += ' AND pet_size = ?';
      params.push(petSize);
    }
    if (petAgeGroup) {
      sql += ' AND pet_age_group = ?';
      params.push(petAgeGroup);
    }
    if (hasAllergies !== undefined) {
      sql += ' AND has_allergies = ?';
      params.push(hasAllergies);
    }

    sql += ' ORDER BY helpful_count DESC, created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const reviews = await query(sql, params);

    // Get aggregate stats
    const [stats] = await query(
      `SELECT 
        COUNT(*) as total_reviews,
        AVG(rating) as average_rating,
        SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) as positive_count,
        SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) as negative_count
       FROM product_reviews 
       WHERE product_id = ?`,
      [productId]
    );

    return {
      reviews,
      stats: stats || { total_reviews: 0, average_rating: 0 }
    };
  }

  /**
   * Add a review
   */
  async addReview(productId, userId, petId, reviewData) {
    // Get pet info for denormalization
    const [pet] = await query('SELECT * FROM pets WHERE id = ? AND user_id = ?', [petId, userId]);
    if (!pet) {
      throw new Error('Pet not found');
    }

    // Determine pet size based on weight
    let petSize = 'medium';
    if (pet.pet_type === 'dog') {
      if (pet.weight_kg < 5) petSize = 'tiny';
      else if (pet.weight_kg < 10) petSize = 'small';
      else if (pet.weight_kg < 25) petSize = 'medium';
      else if (pet.weight_kg < 45) petSize = 'large';
      else petSize = 'giant';
    } else {
      if (pet.weight_kg < 3) petSize = 'small';
      else if (pet.weight_kg < 5) petSize = 'medium';
      else petSize = 'large';
    }

    let petAgeGroup = 'adult';
    if (pet.age_months != null && pet.age_months < 12) {
      petAgeGroup = pet.pet_type === 'cat' ? 'kitten' : 'puppy';
    } else if (pet.age_months != null && pet.age_months < 24) petAgeGroup = 'young';
    else if (pet.age_months != null && pet.age_months > 84) petAgeGroup = 'senior';

    const conditions = await query(
      'SELECT condition_type FROM pet_health_conditions WHERE pet_id = ?',
      [petId]
    );
    const hasAllergies = conditions.some(c => c.condition_type?.startsWith('allergy_'));
    const hasHealthConditions = conditions.length > 0;

    const id = uuidv4();

    await query(
      `INSERT INTO product_reviews 
       (id, product_id, user_id, pet_id, rating, title, content,
        pet_type, pet_breed, pet_size, pet_age_group, has_allergies, has_health_conditions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), title = VALUES(title), content = VALUES(content), updated_at = NOW()`,
      [
        id, productId, userId, petId,
        reviewData.rating,
        reviewData.title || null,
        reviewData.content || null,
        pet.pet_type,
        pet.breed,
        petSize,
        petAgeGroup,
        hasAllergies,
        hasHealthConditions
      ]
    );

    return await query('SELECT * FROM product_reviews WHERE id = ?', [id]);
  }

  async findByBarcode(barcode) {
    if (!barcode) return null;
    const rows = await query('SELECT * FROM products WHERE barcode = ? LIMIT 1', [barcode]);
    return rows[0] || null;
  }

  /**
   * Exact lookup by canonical match_key (brand|line|stage|proteins|breed|diet|).
   */
  async findByMatchKey(matchKey) {
    if (!matchKey) return null;
    const rows = await query('SELECT * FROM products WHERE match_key = ? LIMIT 1', [matchKey]);
    return rows[0] || null;
  }

  _petTypesCompatible(scanPet, dbPet) {
    if (!scanPet || scanPet === 'both') return true;
    if (!dbPet || dbPet === 'both') return true;
    return scanPet === dbPet;
  }

  _lifeStagesCompatibleSlot(scannedStage, dbStage, petType = null) {
    const scan = scannedStage && scannedStage !== 'all' ? scannedStage : null;
    const db = productMatchKey.normalizeLifeStage(dbStage, petType);
    if (db === 'all') return true;
    if (!scan) return true;
    return scan === db;
  }

  /**
   * Column fallback when full match_key misses (e.g. protein omitted on re-scan).
   * Requires a single unambiguous row on brand_norm + line_name + pet + stage.
   */
  async findBySlotColumns(slots) {
    const brandNorm = productMatchKey.normalizeBrand(slots.brand);
    const lineName = productMatchKey.normalizeLineName(slots.lineName);
    if (!brandNorm || !lineName) return null;

    const lifeStage = productMatchKey.normalizeLifeStage(slots.lifeStage, slots.targetPetType);
    const scanPet = slots.targetPetType || null;

    const rows = await query(
      `SELECT * FROM products
       WHERE brand_norm = ? AND line_name = ?
         AND raw_ingredients_text IS NOT NULL AND raw_ingredients_text != ''`,
      [brandNorm, lineName]
    );

    const filtered = rows.filter((r) => {
      if (!this._petTypesCompatible(scanPet, r.target_pet_type)) return false;
      if (!this._lifeStagesCompatibleSlot(lifeStage, r.target_life_stage, scanPet)) return false;
      return true;
    });

    if (filtered.length === 1) return filtered[0];

    if (filtered.length > 1 && lifeStage !== 'all') {
      const stageExact = filtered.filter(
        (r) => productMatchKey.normalizeLifeStage(r.target_life_stage, r.target_pet_type) === lifeStage
      );
      if (stageExact.length === 1) return stageExact[0];
    }

    return null;
  }

  /**
   * Build match_key from slots and look up product (protein-less fallback only).
   */
  async findByMatchSlots(slots) {
    const withPet = { ...slots, targetPetType: slots.targetPetType };
    const fullKey = productMatchKey.buildMatchKey(withPet);
    let row = await this.findByMatchKey(fullKey);
    if (row) return row;

    if (productMatchKey.normalizeProteinList(slots.primaryProteins)) {
      const keyNoProtein = productMatchKey.buildMatchKey({
        ...withPet,
        primaryProteins: null,
      });
      row = await this.findByMatchKey(keyNoProtein);
      if (row) return row;
    }

    return null;
  }

  /**
   * Backfill match_key / slot columns on products created before slot matching existed.
   */
  async ensureProductMatchFields(productId, slots) {
    const product = await this.findById(productId);
    if (!product || product.match_key) return product;

    const fields = productMatchKey.buildProductMatchFields({
      ...slots,
      targetPetType: slots.targetPetType || product.target_pet_type,
    });

    try {
      await query(
        `UPDATE products SET
           manufacturer = COALESCE(manufacturer, ?),
           brand_norm = COALESCE(brand_norm, ?),
           line_name = COALESCE(line_name, ?),
           primary_proteins = COALESCE(primary_proteins, ?),
           breed_size = ?,
           diet_tags = COALESCE(diet_tags, ?),
           match_key = ?,
           target_life_stage = CASE
             WHEN target_life_stage IS NULL OR target_life_stage = 'all' THEN ?
             ELSE target_life_stage
           END
         WHERE id = ? AND (match_key IS NULL OR match_key = '')`,
        [
          fields.manufacturer,
          fields.brand_norm,
          fields.line_name,
          fields.primary_proteins,
          fields.breed_size,
          fields.diet_tags,
          fields.match_key,
          fields.target_life_stage,
          productId,
        ]
      );
    } catch (err) {
      console.warn(`⚠️ [MATCH] ensureProductMatchFields failed for ${productId}:`, err.message);
      return product;
    }

    return this.findById(productId);
  }

  /** DB-ready match column values from scan/import slots. */
  buildProductMatchFields(slots) {
    return productMatchKey.buildProductMatchFields(slots);
  }

  buildMatchKey(slots) {
    return productMatchKey.buildMatchKey(slots);
  }

  /**
   * Tiered lookup: exact match_key first, then fuzzy brand+name.
   * @returns {{ slots: object, displayName: string|null, candidates: Array<{product, score, matchType?}> }}
   */
  async lookupBySlotsOrFuzzy(extracted, normalizedName = null) {
    const slots = productMatchKey.buildSlotsFromExtracted(extracted);
    const displayName =
      productMatchKey.buildDisplayName(slots) ||
      normalizedName ||
      extracted.productName ||
      null;

    if (productMatchKey.hasMinimumMatchSlots(slots)) {
      const lookupKey = productMatchKey.buildMatchKey({
        ...slots,
        targetPetType: slots.targetPetType,
      });
      let exact = await this.findByMatchSlots(slots);
      if (exact && !exact.match_key) {
        exact = await this.ensureProductMatchFields(exact.id, slots);
      }
      if (exact) {
        console.log(
          `✅ [MATCH] Exact hit: "${exact.brand} ${exact.name}" (key: ${exact.match_key || lookupKey})`
        );
        return {
          slots,
          displayName,
          candidates: [{ product: exact, score: 1.0, matchType: 'exact' }],
        };
      }
      console.log(`⚠️ [MATCH] No exact hit for key: ${lookupKey}`);
    }

    const lifeStageFilter =
      slots.lifeStage && slots.lifeStage !== 'all' ? slots.lifeStage : null;

    const { candidates } = await this.findByBrandAndName(
      slots.brand || extracted.brand,
      displayName,
      lifeStageFilter,
      slots.targetPetType || extracted.targetPet || null
    );

    return { slots, displayName, candidates };
  }

  /**
   * Find existing product: match_key → ingredient hash.
   */
  async findProductForConfirm({ slots, ingredientsList, brand, displayName }) {
    if (productMatchKey.hasMinimumMatchSlots(slots)) {
      const byKey = await this.findByMatchSlots(slots);
      if (byKey) {
        return this.ensureProductMatchFields(byKey.id, slots);
      }
    }

    if (ingredientsList?.length) {
      const ingredientHash = this.generateIngredientHash(ingredientsList);
      const byHash = await this.findByIngredientHash(ingredientHash, brand, displayName);
      if (byHash) return byHash;
    }

    return null;
  }

  buildDisplayNameFromExtracted(extracted) {
    const slots = productMatchKey.buildSlotsFromExtracted(extracted);
    return productMatchKey.buildDisplayName(slots);
  }

  buildSlotsFromExtracted(extracted) {
    return productMatchKey.buildSlotsFromExtracted(extracted);
  }

  // ─── Product Name Normalization ─────────────────────────────────────

  static PRODUCT_NAME_FILLER_PATTERNS = [
    /\b(premium|natural|delicious|nutritious|healthy|nourishing|high protein|real)\b/gi,
    /\b(recipe|formula|food|meal|dinner|entrée|entree|feast|medley|platter|stew)\b/gi,
    /\b(for dogs?|for cats?|for puppies|for kittens|for seniors?|canine|feline)\b/gi,
    /\b(dog food|cat food|puppy food|kitten food)\b/gi,
    /\b(adult|puppy|kitten|senior|all life stages?|all breeds?)\b/gi,
    /\b(grain[- ]?free|grain inclusive|gluten[- ]?free)\b/gi,
    /\b(with|made with)\b/gi,
    /\b(new|improved)\b/gi,
  ];

  normalizeProductName(rawName) {
    if (!rawName) return null;

    let name = String(rawName).trim();

    for (const pattern of ProductService.PRODUCT_NAME_FILLER_PATTERNS) {
      name = name.replace(pattern, ' ');
    }

    // Replace "&" variants
    name = name.replace(/\bAND\b/gi, '&');

    // Collapse whitespace and trim
    name = name.replace(/\s+/g, ' ').trim();

    // Remove leading/trailing punctuation or connectors
    name = name.replace(/^[&,\-–—\s]+/, '').replace(/[&,\-–—\s]+$/, '');

    // Title Case
    name = name
      .split(' ')
      .map(w => {
        if (w === '&') return '&';
        if (w.length <= 2 && w === w.toUpperCase()) return w; // e.g. "DL"
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      })
      .join(' ');

    return name || null;
  }

  // ─── Find by Brand + Name (exact / fuzzy) ──────────────────────────

  static FUZZY_MATCH_THRESHOLD = 0.65;

  static LIFE_STAGE_TOKENS = new Set(['puppy', 'kitten', 'adult', 'senior', 'junior', 'mature']);

  _normalizeLifeStage(val, petType = null) {
    if (!val) return null;
    const resolved = productMatchKey.resolveLifeStage(val, petType);
    if (resolved === 'all' || resolved === '') return null;
    return resolved;
  }

  _lifeStagesCompatible(scannedLifeStage, dbLifeStage, petType = null) {
    const a = this._normalizeLifeStage(scannedLifeStage, petType);
    const b = this._normalizeLifeStage(dbLifeStage, petType);
    if (!a || !b) return false;
    return a === b;
  }

  /**
   * Search for a product by brand and product name with life stage awareness.
   * Always returns candidates (never auto-matches). The caller decides how to present them.
   * @returns {{ candidates: Array<{product, score}> }}
   */
  async findByBrandAndName(brand, productName, lifeStage = null, targetPet = null) {
    if (!brand && !productName) return { candidates: [] };

    const normBrand = this.normalizeForMatch(brand);
    const normName = this.normalizeForMatch(productName);

    const allRows = await query(
      `SELECT * FROM products WHERE brand IS NOT NULL OR name IS NOT NULL OR manufacturer IS NOT NULL LIMIT 500`
    );

    const scored = [];

    for (const r of allRows) {
      const dbBrand = this.normalizeForMatch(r.brand);
      const dbMfr = this.normalizeForMatch(r.manufacturer);
      const dbName = this.normalizeForMatch(r.name);

      let nameScore = 0;

      // Brand or manufacturer must match for any candidate to qualify
      if (normBrand && dbBrand !== normBrand && dbMfr !== normBrand) continue;
      if (!normBrand && !dbBrand) continue;

      // Name similarity
      if (normName && dbName) {
        if (dbName === normName) {
          nameScore = 1.0;
        } else {
          nameScore = this._jaccardTokenSimilarity(normName, dbName);
        }
      }

      if (nameScore < this.constructor.FUZZY_MATCH_THRESHOLD) continue;

      // Life stage filter: both must have a value and they must match
      if (lifeStage) {
        const petType = targetPet || r.target_pet_type || null;
        if (!this._lifeStagesCompatible(lifeStage, r.target_life_stage, petType)) continue;
      } else {
        const petType = targetPet || r.target_pet_type || null;
        const dbLs = this._normalizeLifeStage(r.target_life_stage, petType);
        if (dbLs) continue;
      }

      scored.push({ product: r, score: nameScore });
    }

    scored.sort((a, b) => b.score - a.score);
    return { candidates: scored.slice(0, 5) };
  }
}

module.exports = new ProductService();

