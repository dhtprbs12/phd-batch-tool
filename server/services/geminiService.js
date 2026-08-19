const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');
const { query } = require('./connection');
const { v4: uuidv4 } = require('uuid');
const visionService = require('./visionService');
const ingredientAnalyzer = require('./ingredientAnalyzer');
const { resolveLifeStage, ALLOWED_BREED_SIZES } = require('./productMatchKey');

function coerceStringList(value) {
  if (value == null || value === '') return null;
  if (Array.isArray(value)) {
    const list = value.map((v) => String(v).trim()).filter(Boolean);
    return list.length ? list : null;
  }
  if (typeof value === 'string') {
    const list = value.split(/[,+]/).map((s) => s.trim()).filter(Boolean);
    return list.length ? list : null;
  }
  return null;
}

function normalizeExtractedSlots(parsed = {}) {
  const targetPet = parsed.targetPet || null;
  let breedSize = String(parsed.breedSize || 'all').toLowerCase().trim();
  if (!ALLOWED_BREED_SIZES.has(breedSize)) breedSize = 'all';

  return {
    lineName: parsed.lineName || null,
    primaryProteins: coerceStringList(parsed.primaryProteins),
    breedSize,
    dietTags: coerceStringList(parsed.dietTags),
    lifeStage: parsed.lifeStage ? resolveLifeStage(parsed.lifeStage, targetPet) : null,
  };
}

/**
 * GEMINI AI SERVICE
 *
 * Handles:
 * 1. Label metadata extraction (product type, brand, GA, image type)
 * 2. Ingredient risk assessment and holistic review
 * 3. Legacy Gemini-only OCR fallback when Cloud Vision is unavailable
 */

class GeminiService {
  constructor() {
    this.genAI = null;
    this.model = null;
    this.initialized = false;
  }

  /**
   * Initialize Gemini AI client
   */
  initialize() {
    if (this.initialized) return;

    if (!process.env.GEMINI_API_KEY) {
      console.warn('⚠️ GEMINI_API_KEY not set. OCR features will be unavailable.');
      return;
    }

    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    this.initialized = true;
    console.log('✅ Gemini AI initialized');
  }

  /**
   * Extract label data from image.
   * Hybrid: Cloud Vision OCR for ingredient text + Gemini for metadata.
   * Falls back to Gemini-only when Vision is unavailable.
   * @param {Buffer} imageBuffer - Image data
   * @param {string} mimeType - Image MIME type
   * @returns {Object} Extracted data
   */
  async extractFromImage(imageBuffer, mimeType = 'image/jpeg') {
    this.initialize();

    if (!this.model) {
      throw new Error('Gemini AI not initialized. Check API key.');
    }

    const imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');

    const cached = await this.checkCache(imageHash);
    if (cached) {
      console.log('📦 Using cached OCR result');
      return cached;
    }

    let extracted;
    if (visionService.isConfigured()) {
      try {
        extracted = await this._extractFromImageHybrid(imageBuffer, mimeType);
      } catch (err) {
        console.warn('⚠️ Cloud Vision hybrid failed, falling back to Gemini OCR:', err.message);
        extracted = await this._extractFromImageGeminiLegacy(imageBuffer, mimeType);
      }
    } else {
      console.log('ℹ️ GOOGLE_CLOUD_VISION_API_KEY not set — Gemini-only OCR');
      extracted = await this._extractFromImageGeminiLegacy(imageBuffer, mimeType);
    }

    await this.cacheResult(imageHash, extracted);
    const { ocrFullText: _omit, ...result } = extracted;
    result.rawOcrText = _omit || null;

    // Infer missing slots from available text (safety net for Gemini omissions)
    const slotInferText = [result.productName, result.lineName, result.rawOcrText]
      .filter(Boolean).join(' ').toLowerCase();

    if (!result.lifeStage || result.lifeStage === 'all') {
      if (/\bpuppy\b/.test(slotInferText)) result.lifeStage = 'puppy';
      else if (/\bkitten\b/.test(slotInferText)) result.lifeStage = 'kitten';
      else if (/\bsenior\b|\b7\+/.test(slotInferText)) result.lifeStage = 'senior';
      else if (/\badult\b/.test(slotInferText)) result.lifeStage = 'adult';
    }

    if (!result.dietTags || result.dietTags.length === 0) {
      const tags = [];
      if (/\bgrain[\s-]?free\b/.test(slotInferText)) tags.push('grain_free');
      if (/\blimited[\s-]?ingredient\b/.test(slotInferText)) tags.push('limited_ingredient');
      if (tags.length) result.dietTags = tags;
    }

    if (!result.breedSize || result.breedSize === 'all') {
      if (/\blarge[\s-]?breed\b/.test(slotInferText)) result.breedSize = 'large_breed';
      else if (/\bsmall[\s-]?breed\b/.test(slotInferText)) result.breedSize = 'small_breed';
    }

    return result;
  }

  /**
   * Cloud Vision document OCR + Gemini metadata (no Gemini ingredient rewriting).
   */
  async _extractFromImageHybrid(imageBuffer, mimeType) {
    const ocrFullText = await visionService.detectDocumentText(imageBuffer);
    console.log(`👁️ [Vision OCR] ${ocrFullText.length} chars`);

    const metadata = await this._extractLabelMetadataFromImage(
      imageBuffer,
      mimeType,
      ocrFullText
    );

    const rawIngredientsText = this._buildRawIngredientsFromOcr(
      ocrFullText,
      metadata.imageType
    );
    const ingredientsList =
      rawIngredientsText.length > 0
        ? ingredientAnalyzer.parseIngredientText(rawIngredientsText)
        : [];

    return {
      ...metadata,
      rawIngredientsText,
      ingredientsList,
      ocrSource: 'cloud_vision',
      ocrFullText,
    };
  }

  /**
   * Slice Vision OCR to the ingredient declaration; never use Gemini for this text.
   */
  _buildRawIngredientsFromOcr(ocrFullText, imageType) {
    const full = String(ocrFullText || '').trim();
    if (!full || imageType === 'front_label') return '';

    const hasHeader = ingredientAnalyzer.rawTextHasIngredientSectionHeader(full);
    const sliced = ingredientAnalyzer.sliceIngredientNarrativeFromRaw(full);

    if (hasHeader && sliced.length >= 20) return sliced;

    // Close-up ingredient panel: no header visible but OCR is mostly the list
    if (
      (imageType === 'ingredients_label' || imageType === 'mixed') &&
      sliced.length >= 40 &&
      !/\b(?:scan for more|complete & balanced|wellbeing|veterinarians|discover)\b/i.test(sliced)
    ) {
      return sliced;
    }

    return hasHeader ? sliced : '';
  }

  /**
   * Product / package metadata from image (+ optional Vision OCR for GA context).
   */
  async _extractLabelMetadataFromImage(imageBuffer, mimeType, ocrFullText) {
    const imageBase64 = imageBuffer.toString('base64');
    const ocrBlock = ocrFullText
      ? `\nCLOUD VISION OCR (verbatim — do NOT rewrite as ingredient list output):\n---\n${String(ocrFullText).slice(0, 12000)}\n---\n`
      : '';

    const prompt = `You classify pet food label photos and extract product METADATA only.
Do NOT output ingredient list text — OCR is handled separately.

${ocrBlock}

Return JSON only:
{
  "imageType": "ingredients_label" | "front_label" | "mixed",
  "productName": "string or null",
  "manufacturer": "string or null",
  "brand": "string or null",
  "productType": "dry_food" | "wet_food" | "treats" | "supplement" | "other" | null,
  "texture": "dry" | "wet" | "semi_moist" | "freeze_dried" | null,
  "targetPet": "dog" | "cat" | "both" | null,
  "lifeStage": "puppy" | "kitten" | "adult" | "senior" | "all" | null,
  "lineName": "string or null",
  "primaryProteins": ["chicken"] or null,
  "breedSize": "all" | "large_breed" | "small_breed" | null,
  "dietTags": ["grain_free"] or null,
  "packageShape": "flat" | "round" | "pouch" | null,
  "guaranteedAnalysis": { "protein": number or null, "fat": number or null, "fiber": number or null, "moisture": number or null },
  "confidence": number between 0 and 1,
  "notes": "brief notes on photo quality / what is visible"
}

Rules:
- front_label: no ingredient declaration visible → imageType "front_label"
- ingredients_label: ingredient panel is the main subject
- mixed: both front marketing and ingredients visible
- packageShape: round = can/cylinder, pouch = soft bag, flat = default box/bag panel
- Read guaranteedAnalysis numbers from the label or OCR when visible; null if not shown
- Do not invent product names; use null when unreadable

SLOT EXTRACTION (most important — fill these FIRST):
- manufacturer: the parent company / maker. Usually printed smaller on the package (e.g. "Purina", "Mars", "Hill's", "Champion Petfoods", "Diamond Pet Foods", "General Mills", "Colgate-Palmolive", "J.M. Smucker"). If manufacturer and brand are the same entity (e.g. Bil-Jac, Wellness, ACANA), put the same value in both fields. Use null only if truly unreadable.
- brand: the product line brand displayed most prominently on the front of the package (e.g. "Pro Plan", "Blue Buffalo", "Science Diet", "ACANA", "Wellness", "Bil-Jac"). This is NOT the parent company — it's the name consumers use to identify the product line.
- lineName: product LINE or SERIES name only (e.g. "Select", "Core", "Complete Essentials", "Wholesome Grains", "Life Protection"). NOT flavor/protein words.
- lifeStage: "Puppy" → "puppy", "Kitten" → "kitten", "Adult" → "adult", "Senior"/"7+" → "senior", "All Life Stages" → "all". If label clearly says a life stage, you MUST capture it here.
- primaryProteins: main animal protein sources as lowercase (e.g. ["chicken"], ["lamb","salmon"]). From flavor/name on label.
- breedSize: "large_breed" | "small_breed" | "all". Only when label explicitly says Large Breed / Small Breed.
- dietTags: ["grain_free"], ["limited_ingredient"] — only when clearly stated on label.
- targetPet: "dog" | "cat" | "both" — from "Dog Food", "Cat Food", or imagery.

productName: Just write the full product name as printed on the label (excluding manufacturer and brand). No formatting rules needed — we build the display name from slots in code.

Examples:
  Label: "Purina Pro Plan Adult Complete Essentials Salmon & Rice Formula Dog Food"
  → manufacturer "Purina", brand "Pro Plan", productName "Adult Complete Essentials Salmon & Rice Formula", lineName "Complete Essentials", lifeStage "adult", primaryProteins ["salmon"], targetPet "dog"

  Label: "Purina Pro Plan Puppy Sensitive Skin & Stomach Salmon & Rice Formula"
  → manufacturer "Purina", brand "Pro Plan", productName "Puppy Sensitive Skin & Stomach Salmon & Rice Formula", lineName "Sensitive Skin & Stomach", lifeStage "puppy", primaryProteins ["salmon"], targetPet "dog"

  Label: "Bil-Jac Adult Select Chicken Formula Dog Food"
  → manufacturer "Bil-Jac", brand "Bil-Jac", productName "Adult Select Chicken Formula", lineName "Select", lifeStage "adult", primaryProteins ["chicken"], targetPet "dog"

  Label: "Blue Buffalo Life Protection Large Breed Puppy Chicken & Brown Rice"
  → manufacturer "Blue Buffalo", brand "Blue Buffalo", productName "Life Protection Large Breed Puppy Chicken & Brown Rice", lineName "Life Protection", lifeStage "puppy", breedSize "large_breed", primaryProteins ["chicken"], targetPet "dog"

  Label: "Hill's Science Diet Adult Sensitive Stomach & Skin Chicken Recipe"
  → manufacturer "Hill's", brand "Science Diet", productName "Adult Sensitive Stomach & Skin Chicken Recipe", lineName "Sensitive Stomach & Skin", lifeStage "adult", primaryProteins ["chicken"], targetPet "dog"

  Label: "Wellness CORE Grain Free Ocean Whitefish Salmon & Herring"
  → manufacturer "Wellness", brand "Wellness", productName "CORE Grain Free Ocean Whitefish Salmon & Herring", lineName "Core", dietTags ["grain_free"], primaryProteins ["whitefish","salmon","herring"]

  Label: "ACANA Wholesome Grains Red Meat Recipe"
  → manufacturer "Champion Petfoods", brand "ACANA", productName "Wholesome Grains Red Meat Recipe", lineName "Wholesome Grains", primaryProteins ["beef"]`;

    const result = await this.model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: imageBase64 } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        candidateCount: 1,
        maxOutputTokens: 4096,
      },
    });

    const parsed = this.parseGeminiResponse(result.response.text());
    const allowedShapes = new Set(['flat', 'round', 'pouch']);
    const slots = normalizeExtractedSlots(parsed);
    return {
      imageType: parsed.imageType || null,
      productType: parsed.productType || null,
      productName: parsed.productName || null,
      manufacturer: parsed.manufacturer || null,
      brand: parsed.brand || null,
      targetPet: parsed.targetPet || null,
      ...slots,
      packageShape: allowedShapes.has(parsed.packageShape) ? parsed.packageShape : null,
      guaranteedAnalysis: parsed.guaranteedAnalysis || {},
      confidence: parsed.confidence ?? 0.5,
      notes: parsed.notes || '',
    };
  }

  /**
   * Legacy: Gemini reads image and outputs ingredients + metadata in one shot.
   */
  async _extractFromImageGeminiLegacy(imageBuffer, mimeType) {
    const imageBase64 = imageBuffer.toString('base64');

    const prompt = `You are analyzing a pet food product image. First, determine what type of image this is, then extract information accordingly.

STEP 1: Identify the image type
- "ingredients_label": Shows the ingredients list (usually back of package)
- "front_label": Shows product name/brand/marketing (front of package)  
- "mixed": Shows both product info AND ingredients

STEP 2: Extract information based on what's visible

Return your response in this exact JSON format:
{
  "imageType": "ingredients_label" | "front_label" | "mixed",
  "productName": "string or null",
  "brand": "string or null", 
  "productType": "dry_food" | "wet_food" | "treats" | "supplement" | "other" | null,
  "texture": "dry" | "wet" | "semi_moist" | "freeze_dried" | null,
  "targetPet": "dog" | "cat" | "both" | null,
  "lifeStage": "puppy" | "kitten" | "adult" | "senior" | "all" | null,
  "lineName": "string or null",
  "primaryProteins": ["chicken"] or null,
  "breedSize": "all" | "large_breed" | "small_breed" | null,
  "dietTags": ["grain_free"] or null,
  "packageShape": "flat" | "round" | "pouch" | null,
  "ingredientsList": ["ingredient1", "ingredient2", ...],
  "rawIngredientsText": "ingredient paragraph copied as printed on the label (see PRINT-FIDELITY); null if not visible",
  "guaranteedAnalysis": {
    "protein": number or null,
    "fat": number or null,
    "fiber": number or null,
    "moisture": number or null
  },
  "confidence": number between 0 and 1,
  "notes": "any relevant notes about extraction quality"
}

Package shape inference (optional metadata for clients; default "flat" when
genuinely uncertain):
- "round": cylindrical can or bottle. Visible curvature on the body,
  metal lid/seam visible, label clearly wraps around (text on the
  edges runs off into perspective distortion). Typical wet food cans,
  treat tins, supplement bottles.
- "pouch": soft stand-up pouch / curved foil bag. Has a flexible /
  curved face but is not a rigid cylinder. Often used for wet food
  pouches, freeze-dried treats.
- "flat": rigid box, kibble bag laid flat, sachet, or any package
  where the ingredient panel is plausibly readable in a single
  straight-on photo. THIS IS THE DEFAULT.
- null: package not clearly visible (e.g. only a closeup of text).

Product type hints:
- "dry_food": kibble, dry food, crunchy food
- "wet_food": canned, pâté, gravy, pouches, stew
- "treats": treats, snacks, chews, dental sticks, training treats, biscuits
- "supplement": vitamins, oils, probiotics, joint support, supplements
- "other": anything else

Texture inference rules (IMPORTANT):
- "dry": No water in top 3 ingredients, OR product name contains "kibble", "jerky", "biscuit", "crunchy", OR moisture < 14%
- "wet": Water/broth is #1-2 ingredient, OR product is canned/pâté/stew, OR moisture > 70%
- "semi_moist": Water in top 3-5 but not #1-2, OR contains glycerin as humectant, OR soft chews, OR moisture 14-70%
- "freeze_dried": Product name mentions freeze-dried or raw freeze-dried
- If unsure, infer from product name and ingredient position

CRITICAL RULES:
- If imageType is "front_label" and no ingredients visible, set ingredientsList to [] and rawIngredientsText to null
- If imageType is "ingredients_label" or "mixed", extract the COMPLETE ingredients list
- Ingredients are listed in order of weight (most to least)
- If you cannot read something clearly, note it but still extract what you can
- VERBATIM INTEGRITY (parentheticals and qualifiers). Copy each ingredient line from the label when possible. Never invent comma-separated tokens inside "(" … ")" that are not visible (e.g. do not add ", WATER" inside "BUTTER (CREAM)"). Preserve leading adjectives and legal qualifiers exactly ("MODIFIED EGG YOLK", not "EGG YOLK"). Do not normalize spellings or compress official names. For rawIngredientsText, stay faithful to the printed list paragraph (harmless whitespace collapse only).

PRINT-FIDELITY — synonyms & parentheses (highest priority when text is legible):
- If the package prints "OUTER (INNER)" for a nutrient or synonym pair, keep that exact surface order. WRONG: label shows "Niacin (Vitamin B-3)" but you output "Vitamin B-3 (Niacin)" or swap which name is outside vs inside the parentheses. Same rule for every "A (B)" / "Name (alternate name)" on the label.
- Do not "canonicalize" to a textbook or database name when the label uses a different legal/common name order (e.g. do not rewrite for consistency across the list).
- Inside a long premix parenthesis (vitamins/minerals), keep inner items in the same left-to-right comma order as printed; do not alphabetize, regroup by nutrient class, or merge lines for readability.
- Each string in ingredientsList that corresponds to one printed slot must use the same wording and parenthetical layout as that slot on the label (casing as printed when you can read it).

TOP-LEVEL LEGAL PARENTHETICAL SLOTS (any product category — do not truncate):
- Many labels use ONE printed ingredient slot that is "HEADER (" … many sub-parts … ")" — not only Vitamins/Minerals but also e.g. Natural Flavors (…), Probiotics (…), Enzymes (…), Trace Minerals (…), Dried Fermentation Products (…), Cheese (cultured milk, …), etc.
- For EVERY such slot, the entire printed unit from the HEADER word(s) through the matching closing ")" MUST be exactly ONE string in ingredientsList. Keep nested "(…)" inside that string balanced.
- NEVER output only an inner sub-enumerator (e.g. a single vitamin line) while dropping the printed header and the rest of the same parenthesis block — that is incomplete extraction.
- Inner sub-items stay in left-to-right printed order; do not alphabetize or regroup.
- If part of a long slot is unreadable, lower "confidence" and explain in "notes" — do not silently emit a tiny fragment as the whole slot.
- rawIngredientsText must still contain the full same declaration text for those slots (so mechanical reconciliation from raw is possible).

INGREDIENT LIST EXTRACTION RULES (very important):
- Include ONLY actual food/nutrient ingredients (e.g., "Deboned Chicken", "Vitamin E Supplement", "Rosemary Extract").
- DO NOT include any of the following — they are NOT ingredients, even if they appear right next to the ingredient list:
  * Manufacturing/facility statements: "Manufactured in a facility that also processes grains", "Made in the USA", "Packaged in...", "Processed in..."
  * Preservation/marketing claims: "This is a naturally preserved product", "Naturally preserved", "Preserved with mixed tocopherols" (when written as a standalone sentence — but DO keep "Mixed Tocopherols" itself if listed as an ingredient)
  * Allergen warnings: "May contain traces of...", "Contains: ..."
  * Guaranteed analysis, feeding instructions, storage, expiration, net weight, or any sentence-like text
- REGULATORY TABLE vs INGREDIENT PANEL (many backs show both side by side):
  The "Guaranteed Analysis" / "Typical Analysis" / "Analytical Constituents" block
  (Crude Protein/Fat/Fiber, Moisture with min/max and %, Calorie Content) is NOT
  part of the ingredient statement. Never copy those rows into ingredientsList or
  rawIngredientsText — only populate the structured guaranteedAnalysis numbers when
  visible. Ingredient premix lines ("Vitamins (...)", "Minerals (...)", etc.) list
  additives by name; do not relabel them as "Moisture" or other GA headers just because
  GA text appeared nearby in the photo.
- For "ingredientsList", each item is usually a short noun phrase (1–6 words).
  EXCEPTION — PARENTHETICAL ENUMERATION (any group header): The panel may
  show ONE legal ingredient as a header word or short phrase immediately
  followed by "(" then many comma-separated sub-items ending with ")",
  often wrapping across several printed lines (common for vitamin/mineral
  premixes, trace-mineral packs, amino-acid packs, probiotics/enzymes
  listed in a cluster, etc.). Treat that whole header + one balanced
  "(" … ")" span as ONE list item. Do NOT split on inner commas into
  separate top-level items; do NOT drop the block for length; do NOT
  discard it just because inner tokens look "table-like" — it is still
  ingredient-list text unless it clearly sits under a Guaranteed Analysis
  heading with crude protein/fat/fiber/moisture percentages.
- If you find yourself writing a full standalone marketing sentence as
  an item, it is not an ingredient — drop it.
- For "rawIngredientsText", include ONLY the verbatim ingredient list itself, stopping at the first non-ingredient sentence (e.g., stop before "This is a naturally preserved product." or "Manufactured in...").
- HUMAN FOODS & CONDIMENTS (FDA-style labels — same rules as pet food):
  Many jars, dressings, sauces, and beverages show "Nutrition Facts",
  "Serving size", "Amount per serving", "Calories per serving", "% Daily Value",
  "SHAKE WELL", "REFRIGERATE AFTER OPENING", "DIST. & SOLD EXCLUSIVELY BY",
  "Distributed by", "SKU", certifier boilerplate ("Certified Organic by …"),
  or a second duplicated "INGREDIENTS:" block from an outer sleeve. NONE of
  that may appear inside ingredientsList or rawIngredientsText. If OCR places
  Nutrition Facts before the ingredient paragraph, start rawIngredientsText at
  the real "Ingredients:" / "INGREDIENTS:" line and end it where the list ends
  (before CONTAINS / allergen banners, Nutrition Facts, or usage lines).
  Never emit one giant ingredientsList element that concatenates the oil line,
  Nutrition Facts numbers, marketing text, and a second INGREDIENTS header —
  each top-level ingredient must be a plausible single product component with
  balanced parentheses only for its own sub-ingredients.`;

    try {
      const result = await this.model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType, data: imageBase64 } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          candidateCount: 1,
          maxOutputTokens: 8192,
        },
      });

      const response = result.response;
      const text = response.text();

      // Parse JSON from response
      const extracted = this.parseGeminiResponse(text);
      return { ...extracted, ocrSource: 'gemini' };

    } catch (error) {
      console.error('Gemini OCR error:', error);
      throw new Error(`OCR extraction failed: ${error.message}`);
    }
  }


  /**
   * Normalize and parse ingredient text
   * Useful for manual input or cleaning up OCR results
   */
  async normalizeIngredients(rawText) {
    this.initialize();

    if (!this.model) {
      // Fallback to simple parsing without AI
      return this.simpleParseIngredients(rawText);
    }

    const prompt = `Parse this pet food ingredient list and return a clean, normalized array of ingredients.

INPUT TEXT:
${rawText}

Rules:
1. Split by commas, but keep compound names together (e.g., "chicken meal" stays together)
2. Remove parenthetical percentages like "(min 4%)"
3. Keep preservative information like "preserved with mixed tocopherols"
4. Normalize common variations:
   - "deboned chicken" → "chicken"
   - "chicken by-product meal" → "chicken by-product meal" (keep as is, it's different from chicken)
5. Remove marketing language but keep scientific names if present
6. Return in order of weight (as listed)
7. EXCLUDE non-ingredient text that often appears around the ingredient list:
   - Manufacturing/facility statements ("Manufactured in a facility...", "Made in the USA")
   - Standalone marketing/preservation sentences ("This is a naturally preserved product")
   - Allergen warnings ("May contain traces of...")
   - Guaranteed analysis, feeding instructions, storage, expiration, net weight
   - Any item that reads like a sentence (contains a verb like "is", "are", "may", "manufactured", "processed") is NOT an ingredient

Return ONLY a JSON array of strings, no explanation:
["ingredient1", "ingredient2", ...]`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text();
      
      // Extract JSON array from response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      // Fallback to simple parsing
      return this.simpleParseIngredients(rawText);

    } catch (error) {
      console.error('Ingredient normalization error:', error);
      return this.simpleParseIngredients(rawText);
    }
  }

  /**
   * Get AI-powered explanation for an ingredient in pet food (universal healthy-pet baseline).
   * @param {unknown} _healthConditions ignored (call-site compatibility)
   */
  async explainIngredientRisk(ingredientName, petType, _healthConditions = []) {
    this.initialize();

    if (!this.model) {
      return null;
    }

    const prompt = `Explain briefly (2-3 sentences) how "${ingredientName}" is generally viewed in ${petType} food for a typical, healthy ${petType}. Do not personalize for diseases, allergies, or special diets.

Be factual and specific. If it is usually fine for healthy pets, say so. If it is sometimes controversial, describe the general concern.`;

    try {
      const result = await this.model.generateContent(prompt);
      return result.response.text().trim();
    } catch (error) {
      console.error('Explanation generation error:', error);
      return null;
    }
  }

  /**
   * Generate personalized analysis summary for a product + pet combination
   * This is the "AI-enhanced" result that provides natural language insights
   * 
   * @param {Object} product - Product data (name, brand, ingredients)
   * @param {Object} pet - Pet profile (name, type, conditions, allergies)
   * @param {Object} analysis - Rule-based analysis results (score, grade, warnings, positives)
   * @returns {Object} AI-generated personalized insights
   */
  async generatePersonalizedInsights(product, pet, analysis) {
    this.initialize();

    if (!this.model) {
      return this.generateFallbackInsights(product, pet, analysis);
    }

    // Build cache key for this combination
    const cacheKey = this.buildInsightsCacheKey(product.id, pet.id, analysis.finalScore);
    
    // Check memory cache (not DB, just for this session)
    if (this.insightsCache && this.insightsCache.has(cacheKey)) {
      return this.insightsCache.get(cacheKey);
    }

    const healthConditions = pet.healthConditions?.map(c => c.condition_type || c.conditionType) || [];
    const allergies = healthConditions.filter(c => c.startsWith('allergy_')).map(c => c.replace('allergy_', ''));
    const conditions = healthConditions.filter(c => !c.startsWith('allergy_'));

    const prompt = `You are a pet nutrition expert. Analyze this pet food for a specific pet and provide personalized insights.

## PRODUCT
Name: ${product.name}
Brand: ${product.brand || 'Unknown'}
Type: ${product.product_type || 'dry food'}
Target: ${product.target_pet_type || 'unknown'}
Ingredients: ${product.raw_ingredients_text || 'Not available'}

## PET PROFILE
Name: ${pet.name}
Type: ${pet.pet_type} (${pet.pet_type === 'cat' ? 'obligate carnivore - needs high protein, taurine essential' : 'omnivore - more flexible diet'})
Breed: ${pet.breed || 'Unknown'}
Age: ${pet.age_months ? Math.floor(pet.age_months / 12) + ' years' : 'Unknown'}
Weight: ${pet.weight_kg ? pet.weight_kg + ' kg' : 'Unknown'}
Activity Level: ${pet.activity_level || 'moderate'}
${allergies.length > 0 ? `Allergies: ${allergies.join(', ')}` : 'No known allergies'}
${conditions.length > 0 ? `Health Conditions: ${conditions.join(', ')}` : 'No health conditions'}

## RULE-BASED ANALYSIS (already calculated)
Score: ${analysis.finalScore}/100
Grade: ${analysis.grade}
Recommendation: ${analysis.recommendation}
Warnings: ${analysis.warnings?.length || 0}
Positives: ${analysis.positives?.length || 0}

## YOUR TASK
Generate a JSON response with personalized insights for ${pet.name}:

{
  "personalizedSummary": "2-3 sentence summary written directly to the pet owner, mentioning ${pet.name} by name. Be warm but factual.",
  "topConcerns": ["List 1-3 specific concerns for THIS pet, or empty if none"],
  "topBenefits": ["List 1-3 specific benefits for THIS pet"],
  "feedingTip": "One practical feeding tip specific to ${pet.name}'s profile (age, weight, conditions)",
  "alternativeAdvice": "If score is below 70, suggest what type of food to look for instead. If score is good, say why this is a good match.",
  "confidenceNote": "Brief note about how confident you are in this analysis based on available data"
}

Be specific to ${pet.name}. Don't be generic. Reference their actual conditions/allergies if any.`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text();
      
      // Parse JSON response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const insights = JSON.parse(jsonMatch[0]);
        
        // Cache the result
        if (!this.insightsCache) this.insightsCache = new Map();
        this.insightsCache.set(cacheKey, insights);
        
        return {
          ...insights,
          aiGenerated: true
        };
      }
      
      return this.generateFallbackInsights(product, pet, analysis);
      
    } catch (error) {
      console.error('Personalized insights generation error:', error);
      return this.generateFallbackInsights(product, pet, analysis);
    }
  }

  /**
   * Build cache key for insights
   */
  buildInsightsCacheKey(productId, petId, score) {
    return `insights_${productId}_${petId}_${score}`;
  }

  /**
   * Generate fallback insights when Gemini is unavailable
   */
  generateFallbackInsights(product, pet, analysis) {
    const petName = pet.name || 'your pet';
    const petType = pet.pet_type || 'pet';
    
    let summary = '';
    if (analysis.grade === 'A') {
      summary = `Great news! This food is an excellent match for ${petName}. It scores ${analysis.finalScore}/100 with high-quality ingredients suitable for ${petType}s.`;
    } else if (analysis.grade === 'B') {
      summary = `This food is a good choice for ${petName}, scoring ${analysis.finalScore}/100. It meets most nutritional needs for ${petType}s.`;
    } else if (analysis.grade === 'C') {
      summary = `This food is acceptable for ${petName} but has some concerns. Score: ${analysis.finalScore}/100. Consider the warnings below.`;
    } else {
      summary = `This food may not be ideal for ${petName}. Score: ${analysis.finalScore}/100. Review the concerns carefully.`;
    }

    return {
      personalizedSummary: summary,
      topConcerns: analysis.warnings?.slice(0, 3).map(w => w.reason) || [],
      topBenefits: analysis.positives?.slice(0, 3).map(p => p.benefit) || [],
      feedingTip: `Follow the feeding guidelines on the package based on ${petName}'s weight and activity level.`,
      alternativeAdvice: analysis.finalScore < 70 
        ? `Look for ${petType} food with higher-quality protein sources and fewer fillers.`
        : `This appears to be a suitable choice for ${petName}.`,
      confidenceNote: 'Analysis based on ingredient database rules.',
      aiGenerated: false
    };
  }

  /** @returns {number} index of closing bracket/paren that balances openIdx, or -1 */
  _closingGroupIndex(haystack, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < haystack.length; i++) {
      const c = haystack[i];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') {
        depth = Math.max(0, depth - 1);
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** @returns {number} index of closing ')' that balances openParenIdx, or -1 */
  _closingParenIndex(haystack, openParenIdx) {
    if (haystack[openParenIdx] !== '(') return -1;
    return this._closingGroupIndex(haystack, openParenIdx);
  }

  /** First top-level ( … ) or [ … ] in a single line, or null. */
  _firstBalancedGroupSpanInLine(line) {
    const s = String(line || '');
    const open = s.search(/[\(\[]/);
    if (open <= 0) return null;
    const close = this._closingGroupIndex(s, open);
    if (close === -1 || close <= open) return null;
    return { open, close, inner: s.slice(open + 1, close), openChar: s[open], closeChar: s[close] };
  }

  /** First top-level "( … )" in a single line (merge output), or null. */
  _firstBalancedParenSpanInLine(line) {
    const span = this._firstBalancedGroupSpanInLine(line);
    if (!span) return null;
    return { open: span.open, close: span.close, inner: span.inner };
  }

  /** Tokens for overlap (letters/digits; min length 2). */
  _overlapTokens(s) {
    return String(s || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length >= 2);
  }

  /** Index after ")" or "]" that precedes openIdx with no group chars in the gap. */
  _gapStartAfterPrevCloseParen(raw, openIdx) {
    for (let i = openIdx - 1; i >= 0; i--) {
      if (raw[i] !== ')' && raw[i] !== ']') continue;
      const gap = raw.slice(i + 1, openIdx);
      if (!/[\(\)\[\]]/.test(gap)) return i + 1;
    }
    return -1;
  }

  /** Last comma/semicolon before openIdx at group depth 0. */
  _lastTopLevelCommaBefore(raw, openIdx) {
    let depth = 0;
    for (let i = openIdx - 1; i >= 0; i--) {
      const c = raw[i];
      if (c === ')' || c === ']') depth++;
      else if (c === '(' || c === '[') depth--;
      else if ((c === ',' || c === ';') && depth === 0) return i;
    }
    return -1;
  }

  /**
   * Start index in raw for the header immediately preceding `openIdx` '('.
   * Uses depth-0 commas, else tail-word trim when many tokens lack commas,
   * else a short character walkback.
   */
  _headerStartBeforeParen(raw, openIdx) {
    const before = raw.slice(0, openIdx);
    const lastComma = this._lastTopLevelCommaBefore(raw, openIdx);
    if (lastComma >= 0) {
      let s = lastComma + 1;
      while (s < openIdx && /\s/.test(raw[s])) s++;
      return s;
    }
    const trimmed = before.trimEnd();
    if (!trimmed.length) return openIdx;
    const words = trimmed.split(/\s+/);
    const head0 = (words[0] || '').toLowerCase();
    const longPhrase =
      /^(contains|including|less\s+than|added|with\s+added)\b/.test(head0) ||
      /^[\d.]+%?$/.test(head0);
    if (longPhrase || words.length <= 4) {
      const si = openIdx - trimmed.length;
      return si >= 0 ? si : 0;
    }
    const nTail = words.length >= 8 ? 5 : 3;
    const tail = words.slice(-nTail).join(' ');
    let idx = before.lastIndexOf(tail);
    if (idx < 0) {
      const ir = trimmed.indexOf(tail);
      idx = ir >= 0 ? openIdx - trimmed.length + ir : -1;
    }
    if (idx < 0) {
      let start = openIdx;
      let steps = 0;
      const maxHeaderChars = 56;
      while (start > 0 && steps < maxHeaderChars) {
        const c = raw[start - 1];
        if (c === '\n' || c === '\r') break;
        if (c === ',' || c === ';') break;
        if (/[A-Za-z0-9'\-.]/.test(c) || c === ' ') {
          start -= 1;
          steps++;
        } else break;
      }
      return start;
    }
    return Math.max(0, idx);
  }

  /** Enumerate balanced (…)/[…] spans in Vision haystack with safe header bounds. */
  _listHaystackParenSpans(rawS) {
    const raw = String(rawS || '');
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] !== '(' && raw[i] !== '[') continue;
      const close = this._closingGroupIndex(raw, i);
      if (close === -1) continue;
      let start = this._headerStartBeforeParen(raw, i);
      const afterClose = this._gapStartAfterPrevCloseParen(raw, i);
      if (afterClose >= 0) start = Math.max(start, afterClose);
      while (start < raw.length && /\s/.test(raw[start])) start++;
      const inner = raw.slice(i + 1, close).replace(/\s+/g, ' ').trim();
      const full = raw.slice(start, close + 1).replace(/\s+/g, ' ').trim();
      if (full.length >= 10 && full.length <= 2200 && inner.length >= 3) out.push({ full, inner });
    }
    return out;
  }

  /**
   * When merge drops a header ("Modified …"), drops "Roasted …", or omits
   * parentheses entirely, snap to a haystack span whose INNER token set
   * matches the merge line (Jaccard / coverage). No product names — only
   * structure + token overlap against the same Vision dump.
   */
  _reconcileLineByParenInnerOverlap(rawS, line) {
    const L = String(line || '').trim();
    if (!rawS || rawS.length < 40 || !L) return L;
    const spans = this._listHaystackParenSpans(rawS);
    if (!spans.length) return L;

    const spanL = this._firstBalancedGroupSpanInLine(L);
    const innerL = spanL ? spanL.inner : null;
    const toksL = new Set(this._overlapTokens(innerL || L));
    if (toksL.size < 2) return L;

    let best = null;
    let bestAdj = -1;

    for (const { full, inner } of spans) {
      const toksI = new Set(this._overlapTokens(inner));
      const toksF = new Set(this._overlapTokens(full));
      if (toksI.size < 2) continue;

      let score = 0;
      if (innerL) {
        const a = new Set(this._overlapTokens(innerL));
        const b = toksI;
        let inter = 0;
        for (const x of a) if (b.has(x)) inter++;
        const uni = new Set([...a, ...b]).size;
        score = uni ? inter / uni : 0;
        if (score < 0.56) continue;
      } else {
        if (toksL.size < 4) continue;
        let interI = 0;
        for (const x of toksI) if (toksL.has(x)) interI++;
        const coverI = toksI.size ? interI / toksI.size : 0;
        let interF = 0;
        for (const x of toksL) if (toksF.has(x)) interF++;
        const coverF = toksL.size ? interF / toksL.size : 0;
        score = Math.min(coverI, coverF) * 0.55 + Math.max(coverI, coverF) * 0.45;
        if (score < 0.74) continue;
      }

      const lenPen = full.replace(/\s+/g, ' ').length * 0.00012;
      const adj = score - lenPen;
      if (adj > bestAdj) {
        bestAdj = adj;
        best = full;
      }
    }

    if (!best) return L;
    if (!this._reconcileHaystackSwapPassesSanity(L, best)) return L;
    const nL = L.replace(/\s+/g, ' ').toLowerCase();
    const nB = best.replace(/\s+/g, ' ').toLowerCase();
    if (nB === nL) return L;
    if (L.includes('(') || L.includes('[')) {
      if (best.length < L.length * 0.82) return L;
    }
    return best.replace(/\s+/g, ' ').trim();
  }

  /**
   * Reject haystack replacements that are almost certainly multi-ingredient
   * OCR blobs or runaway repeats (would poison AI cache keys).
   */
  _reconcileHaystackSwapPassesSanity(line, candidate) {
    const L = String(line || '').trim();
    const B = String(candidate || '').trim();
    if (!L || !B) return false;
    const l = L.length;
    const b = B.length;
    if (b > 520) return false;
    if (b > Math.max(220, l * 2.0 + 80)) return false;
    if (l > 140 && b > l + 100) return false;
    const wc = B.split(/\s+/).filter(Boolean).length;
    if (wc > 44) return false;
    const compact = B.replace(/\s+/g, ' ');
    if (/(.{14,42})\1\1/i.test(compact)) return false;
    const opens = (B.match(/[\(\[]/g) || []).length;
    if (opens > 3) return false;
    return true;
  }

  /**
   * Snap a parenthetical line to the literal balanced "(…)" span found in
   * raw OCR / rawIngredientsText so dropped prefixes (MODIFIED …) or
   * invented inner tokens (, WATER) can be corrected when the source text
   * still contains the true span.
   */
  _reconcileParenLineFromRaw(rawOrHaystack, line) {
    const trimmed = String(line || '').trim();
    const rawS = String(rawOrHaystack || '');
    if (rawS.length < 40) return this._reconcileLineByParenInnerOverlap(rawS, trimmed);

    let out = trimmed;
    const openParen = trimmed.indexOf('(');
    const openBracket = trimmed.indexOf('[');
    let open = -1;
    if (openParen > 0 && openBracket > 0) open = Math.min(openParen, openBracket);
    else if (openParen > 0) open = openParen;
    else if (openBracket > 0) open = openBracket;

    const closeParen = trimmed.lastIndexOf(')');
    const closeBracket = trimmed.lastIndexOf(']');
    const hasClose =
      (open === openParen && closeParen > open) ||
      (open === openBracket && closeBracket > open);

    if (open > 0 && hasClose) {
      const words = trimmed
        .slice(0, open)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (words.length) {
        outer: for (let take = words.length; take >= 1; take -= 1) {
          const h = words.slice(-take).join(' ');
          if (h.length < 3) continue;
          const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(esc + '\\s*[\\(\\[]', 'gi');
          let m;
          while ((m = re.exec(rawS)) !== null) {
            const openIdx = m.index + m[0].length - 1;
            if (rawS[openIdx] !== '(' && rawS[openIdx] !== '[') continue;
            let start = this._headerStartBeforeParen(rawS, openIdx);
            const afterClose = this._gapStartAfterPrevCloseParen(rawS, openIdx);
            if (afterClose >= 0) start = Math.max(start, afterClose);
            while (start < rawS.length && /\s/.test(rawS[start])) start++;
            const closeIdx = this._closingGroupIndex(rawS, openIdx);
            if (closeIdx === -1) continue;
            const candidate = rawS
              .slice(start, closeIdx + 1)
              .replace(/\s+/g, ' ')
              .trim();
            if (candidate.length < 8 || candidate.length > 2200) continue;
            if (!this._reconcileHaystackSwapPassesSanity(trimmed, candidate)) continue;
            const nC = candidate.replace(/\s+/g, ' ').toLowerCase();
            const nT = trimmed.replace(/\s+/g, ' ').toLowerCase();
            if (nC === nT) continue;
            const ratio = candidate.length / Math.max(trimmed.length, 1);
            if (ratio > 1.45 && take < words.length) continue;
            if (ratio > 1.55) continue;
            out = candidate;
            break outer;
          }
        }
      }
    }

    return this._reconcileLineByParenInnerOverlap(rawS, out);
  }

  _reconcileListParenFromRaw(rawOrHaystack, list) {
    if (!Array.isArray(list) || list.length === 0) return list;
    const hay = String(rawOrHaystack || '');
    if (hay.length < 50) return list;
    return list.map(line => this._reconcileParenLineFromRaw(hay, line));
  }

  /**
   * Parse Gemini response and extract JSON
   */
  parseGeminiResponse(text) {
    try {
      // Try to find JSON in the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        // Clean ingredients list - remove OCR artifacts
        let ingredientsList = parsed.ingredientsList || [];
        if (ingredientsList.length > 0) {
          ingredientsList = ingredientsList.map((ing, index) => {
            let cleaned = ing.trim();
            // Remove "Ingredients:" prefix from first item (common OCR artifact)
            if (index === 0) {
              cleaned = cleaned.replace(/^ingredients?:?\s*/i, '');
            }
            // Remove trailing punctuation
            cleaned = cleaned.replace(/[.,;:]+$/, '').trim();
            return cleaned;
          }).filter(ing => ing.length > 0);
        }
        const rawTrim = String(parsed.rawIngredientsText || '').trim();
        if (rawTrim.length > 50 && ingredientsList.length > 0) {
          ingredientsList = this._reconcileListParenFromRaw(rawTrim, ingredientsList);
        }
        {
          const ingredientAnalyzer = require('./ingredientAnalyzer');
          ingredientsList = ingredientAnalyzer.postProcessExtractedIngredientList(ingredientsList);
        }

        // packageShape: optional UI hint from the front label (flat / round / pouch).
        const allowedShapes = new Set(['flat', 'round', 'pouch']);
        const packageShape = allowedShapes.has(parsed.packageShape)
          ? parsed.packageShape
          : null;
        const slots = normalizeExtractedSlots(parsed);

        return {
          imageType: parsed.imageType || null,
          productType: parsed.productType || null,
          productName: parsed.productName || null,
          manufacturer: parsed.manufacturer || null,
          brand: parsed.brand || null,
          targetPet: parsed.targetPet || null,
          ...slots,
          packageShape,
          ingredientsList: ingredientsList,
          rawIngredientsText: parsed.rawIngredientsText || '',
          guaranteedAnalysis: parsed.guaranteedAnalysis || {},
          confidence: parsed.confidence || 0.5,
          notes: parsed.notes || ''
        };
      }
    } catch (e) {
      console.error('JSON parsing error:', e);
    }

    // Return empty result if parsing fails
    return {
      imageType: null,
      productType: null,
      productName: null,
      brand: null,
      targetPet: null,
      lineName: null,
      primaryProteins: null,
      breedSize: 'all',
      dietTags: null,
      lifeStage: null,
      packageShape: null,
      ingredientsList: [],
      rawIngredientsText: text,
      guaranteedAnalysis: {},
      confidence: 0,
      notes: 'Failed to parse structured response'
    };
  }

  /**
   * Simple ingredient parsing without AI.
   * Delegates to ingredientAnalyzer.parseIngredientText so the same disclaimer
   * stripping and sentence filtering rules apply everywhere.
   */
  simpleParseIngredients(rawText) {
    if (!rawText) return [];
    const ingredientAnalyzer = require('./ingredientAnalyzer');
    return ingredientAnalyzer.parseIngredientText(rawText);
  }

  /**
   * Check OCR cache
   */
  async checkCache(imageHash) {
    try {
      const results = await query(
        'SELECT extracted_text, parsed_ingredients FROM ocr_cache WHERE image_hash = ? AND (expires_at IS NULL OR expires_at > NOW())',
        [imageHash]
      );

      if (results.length > 0) {
        let ingredientsList = [];
        try {
          // Safely parse ingredients JSON
          const rawIngredients = results[0].parsed_ingredients;
          if (rawIngredients && rawIngredients.trim()) {
            ingredientsList = JSON.parse(rawIngredients);
          }
        } catch (parseError) {
          // Invalid JSON in cache - delete this corrupted entry
          await query('DELETE FROM ocr_cache WHERE image_hash = ?', [imageHash]);
          return null; // Cache miss - will re-process
        }
        
        return {
          rawIngredientsText: results[0].extracted_text,
          ingredientsList,
          fromCache: true
        };
      }
    } catch (error) {
      // Silently handle cache errors - not critical
      console.warn('Cache unavailable:', error.message);
    }
    return null;
  }

  /**
   * Cache OCR result
   */
  async cacheResult(imageHash, extracted) {
    try {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // Cache for 30 days

      await query(
        `INSERT INTO ocr_cache (id, image_hash, extracted_text, parsed_ingredients, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE extracted_text = VALUES(extracted_text), parsed_ingredients = VALUES(parsed_ingredients)`,
        [
          uuidv4(),
          imageHash,
          extracted.rawIngredientsText,
          JSON.stringify(extracted.ingredientsList),
          expiresAt
        ]
      );
    } catch (error) {
      console.error('Cache write error:', error);
    }
  }

  /**
   * Quickly assess a list of ingredients for a specific pet type
   * Returns risk adjustments and explanations for each ingredient
   *
   * Always uses a universal "healthy pet" nutritional baseline. Pet-specific conditions
   * (allergies, etc.) are NOT passed into this prompt — they are handled by rule-based
   * layers (e.g. allergen match) and conditionWarnings elsewhere.
   *
   * @param {unknown} _healthConditions ignored (kept for call-site compatibility)
   * @param {object} [options]
   * @param {string[]} [options.fullIngredientLines] Full label-ordered lines for this product (context only).
   *        When set, the model sees the complete formula but must return JSON only for `ingredients` targets.
   */
  async assessIngredientsForPet(ingredients, petType, petName, _healthConditions = [], productType = 'food', options = {}) {
    this.initialize();

    if (!this.model || ingredients.length === 0) {
      return {};
    }

    const fullIngredientLines = Array.isArray(options.fullIngredientLines)
      ? options.fullIngredientLines.map((s) => String(s || '').trim()).filter(Boolean)
      : null;
    const hasFullContext = fullIngredientLines && fullIngredientLines.length > 0;

    const linesForProductClass = hasFullContext
      ? fullIngredientLines
      : ingredients.map((i) => String(i.name || i || '').trim()).filter(Boolean);

    // Build target list (only rows we need assessments for)
    const ingredientDetails = ingredients.map((i, idx) => {
      const name = i.name || i;
      const position = i.position || (idx + 1);
      return `${position}. ${name}`;
    }).join('\n');

    const totalIngredients = ingredients.length;
    const fullListBlock = hasFullContext
      ? fullIngredientLines.map((line, i) => `${i + 1}. ${line}`).join('\n')
      : '';

    // Determine if this is a treat or supplement (more lenient scoring)
    const isSupplement = productType === 'supplement';
    const isTreat = isSupplement || productType === 'treats' || productType === 'treat' ||
                    (linesForProductClass.length <= 6 && linesForProductClass.some((line) =>
                      line.toLowerCase().includes('jerky') ||
                      line.toLowerCase().includes('treat')));

    // Product type context
    const productContext = isSupplement ? `
PRODUCT TYPE: SUPPLEMENT (not a food source)
- This is a dietary supplement, NOT daily food or a treat
- It is NOT expected to be nutritionally complete — it supplements the diet
- Capsule shells, binders, and carrier ingredients (gelatin, glycerin, water, cellulose) are standard delivery mechanisms — score them NEUTRAL (-2 to +2)
- Focus ONLY on: active ingredient quality and general safety
- Do NOT penalize for "nutritional inadequacy" — supplements are not meals
` : isTreat ? `
PRODUCT TYPE: TREAT (occasional consumption)
- Treats are given occasionally, not as daily nutrition
- Be MORE LENIENT with minor concerns (sugars, salts) since exposure is limited
- Focus on SAFETY (toxic ingredients) rather than optimal nutrition
- A small amount of sugar/salt in a treat is acceptable for healthy pets
- Quality matters: "organic cane sugar" is better than "corn syrup"
` : `
PRODUCT TYPE: DAILY FOOD (regular consumption)
- This food is eaten daily, so ingredient quality matters more
- Be appropriately strict with fillers, sugars, artificial additives
- Prioritize nutritional completeness and digestibility
`;

    const listSection = hasFullContext ? `
FULL INGREDIENT LIST (label order — complete product formula; CONTEXT ONLY):
${fullListBlock}

Use this list only to interpret each target line (e.g. "water sufficient for processing" as the first item in a canned/wet formula is normal moisture for processing — it does NOT mean the entire product is only water). Score each target for its typical role in this complete formula, not as if it were the sole component of the diet.

INGREDIENTS TO ASSESS — return JSON "assessments" ONLY for these exact lines (one object per line below; keys must match these strings):
${ingredientDetails}
` : `
INGREDIENTS (by position - earlier = larger amount):
${ingredientDetails}
`;

    const opening = hasFullContext
      ? `You are a veterinary nutritionist. For a ${petType} named ${petName}, assign risk scores ONLY for the ingredient lines listed under "INGREDIENTS TO ASSESS".`
      : `You are a veterinary nutritionist. Assess these pet food ingredients for a ${petType} named ${petName}.`;

    const countLines = hasFullContext
      ? `FULL_PRODUCT_INGREDIENT_LINES: ${fullIngredientLines.length}
TARGET_LINES_TO_SCORE: ${totalIngredients}`
      : `TOTAL INGREDIENTS: ${totalIngredients}`;

    const extraRules = hasFullContext ? `
4. The "assessments" object must contain ONLY the target ingredient names from "INGREDIENTS TO ASSESS" — do not include keys for other lines from the full list.
5. Each explanation describes that ingredient's role in this product type (wet/dry/treat), using the full list only as context — do not claim the product is only water or only one line unless the full list truly contains nothing else.
` : '';

    const prompt = `${opening}
Assume a generally healthy, typical ${petType} (no special medical conditions) — this is a universal product assessment.

${listSection}

${countLines}
PET TYPE: ${petType}
HEALTH CONDITIONS: None (universal / healthy-pet baseline — do not personalize for diseases or allergies)
${productContext}

SCORING GUIDELINES:
- riskScore: -20 to +50 (negative = BENEFICIAL, positive = concerning)

For SUPPLEMENTS - score the ACTIVE ingredients, not delivery mechanisms:
  - Active beneficial ingredients (fish oil, glucosamine, probiotics, vitamins, CoQ10): -15 to -20 (very beneficial!)
  - Carrier oils (coconut oil, flaxseed oil): -5 to -10 (beneficial)
  - Capsule/delivery components (gelatin, glycerin, water, cellulose, starch): -2 to +2 (NEUTRAL — standard delivery)
  - Natural preservatives (tocopherols, rosemary): -3 to +2 (neutral to beneficial)
  - Artificial additives: +10 to +15

For TREATS (healthy pets) - BE LENIENT, treats are occasional:
  - Quality proteins (chicken, beef, fish, eggs): -12 to -18 (very beneficial!)
  - Wholesome grains (oatmeal, brown rice): -5 to -10 (good fiber & energy)
  - TREAT FILLERS/BINDERS (rice flour, vegetable glycerin, water, tapioca, potato starch, pea starch, maltodextrin, cellulose, guar gum, xanthan gum, lecithin, gelatin): -2 to +2 (NEUTRAL - expected in treats for texture/binding!)
  - Vegetables, fruits: -5 to -10 (beneficial)
  - Minerals/supplements (calcium carbonate, vitamins): -3 to +2 (neutral to beneficial)
  - Organic/natural sugars (in moderation): +2 to +5 (minor concern, acceptable in treats)
  - Refined sugars, corn syrup: +8 to +15 (more concerning)
  - Natural preservatives (rosemary, tocopherols): -3 to +2 (neutral to beneficial)
  - Artificial colors (Yellow 5, Blue 1, Red 40): +8 to +15 (unnecessary but not toxic)
  - Artificial preservatives: +10 to +20
  - Toxic ingredients (xylitol, onion, grapes, chocolate): +40 to +50

For DAILY FOOD (healthy pets):
  - Quality proteins (chicken, beef, salmon, eggs): -10 to -18 (VERY beneficial!)
  - Organ meats (liver, heart): -8 to -12 (nutrient-dense)
  - WHOLESOME grains (oatmeal, brown rice, barley, quinoa): -5 to -10 (beneficial fiber & energy!)
  - Vegetables & fruits: -5 to -10 (beneficial vitamins)
  - LOWER QUALITY grains/fillers (corn, wheat gluten, soy): +3 to +8 (common allergens, less nutritious - but not dangerous)
  - Any added sugars: +8 to +15 (more strict for daily consumption)
  - Artificial colors/flavors: +10 to +18
  - Byproducts (unspecified): +5 to +10
  - Water as moisture/processing aid in wet food (e.g. "water sufficient for processing", "water", "filtered water" early in list): typically NEUTRAL (-2 to +2) when the full formula clearly includes proteins, vitamins, and minerals — do NOT score as if water were the entire diet.

GRAIN/FILLER DISTINCTION (important!):
- GOOD whole grains: oatmeal, brown rice, barley, quinoa, millet → score NEGATIVE (beneficial)
- NEUTRAL fillers (OK for treats): rice flour, white rice, tapioca, potato starch, pea starch, pea flour, chickpea flour → score -2 to +2
- NEUTRAL binders/texture: vegetable glycerin, glycerin, gelatin, guar gum, xanthan gum, cellulose, lecithin → score -2 to +2
- LOWER QUALITY fillers (common allergens, less nutritious): corn, wheat, soy, wheat gluten, corn gluten → score +2 to +8 (not ideal but not dangerous for healthy pets)

IMPORTANT RULES:
1. Consider ingredient QUALITY (organic > conventional > artificial)
2. Use position to WEIGHT the risk score (earlier = more impactful), but...
3. DO NOT mention position/order in explanations! Write descriptions that apply to the ingredient itself, regardless of where it appears in the list.
${extraRules}
BAD explanation: "As the 5th ingredient, its quantity is likely small"
GOOD explanation: "Provides empty calories with no nutritional benefit"

Return VALID JSON (no + prefix on numbers, use -5 or 5, not +5):
{
  "assessments": {
    "Ingredient Name": {
      "riskScore": <integer like -15, 0, 10, 45 - NO + prefix>,
      "category": "string",
      "explanation": "string (describe the ingredient itself, NOT its position)",
      "benefit": "string or empty"
    }
  }
}

Use standard nutritional assessment for a healthy ${petType}. Explanations describe the ingredient itself, not a specific sick pet.`;

    try {
      console.log('🤖 [AI PROMPT] Ingredient assessment: universal healthy-pet baseline (no condition personalization)');
      
      const result = await this.model.generateContent(prompt);
      const text = result.response.text();
      
      console.log(`🤖 [AI RAW RESPONSE]:\n${text.substring(0, 500)}...`);
      
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        // Fix invalid JSON: AI sometimes returns +5 instead of 5 for positive numbers
        const cleanedJson = jsonMatch[0].replace(/:\s*\+(\d)/g, ': $1');
        const parsed = JSON.parse(cleanedJson);
        const assessments = parsed.assessments || {};
        
        // Log each assessment
        for (const [ingName, assessment] of Object.entries(assessments)) {
          console.log(`🤖 [AI RESULT] ${ingName}: score=${assessment.riskScore}, level=${assessment.riskScore > 30 ? 'danger' : assessment.riskScore > 15 ? 'high' : assessment.riskScore > 0 ? 'moderate' : 'safe'}`);
        }
        
        return assessments;
      }
    } catch (error) {
      console.error('AI ingredient assessment error:', error.message);
    }
    
    return {};
  }

  /**
   * Pull the text out of a Gemini response, tolerating cases where one
   * of the candidates was blocked (RECITATION / SAFETY) but another
   * succeeded. Throws if NO candidate yielded usable text — in which
   * case the caller will handle the retry.
   */
  _extractFirstText(response) {
    if (!response) throw new Error('Empty Gemini response');

    const candidates = response.candidates || [];
    for (const c of candidates) {
      const finish = c?.finishReason;
      // STOP / MAX_TOKENS are fine; RECITATION / SAFETY mean blocked.
      if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') continue;
      const partsText = (c?.content?.parts || [])
        .map(p => p?.text || '')
        .join('')
        .trim();
      if (partsText) return partsText;
    }

    // Fall back to .text() — it throws on a fully blocked response,
    // surfacing the RECITATION error to the caller's catch block.
    return response.text();
  }

  /**
   * HOLISTIC PRODUCT REVIEW
   * AI evaluates the ENTIRE product and gives a final score (universal healthy-pet product quality only).
   * @param {Object} params
   * @param {string[]} params.healthConditions - ignored; kept for call-site compatibility
   * @param {string} params.petName - may be used in summary tone only, not for medical context
   */
  async reviewProductHolistically({ ingredients, petType, healthConditions: _healthConditions = [], productType = 'food', petName = 'your pet' }) {
    this.initialize();
    
    if (!this.model) {
      throw new Error('Gemini AI not initialized. Check GEMINI_API_KEY.');
    }

    const conditionsText = 'None — universal healthy pet (do not adjust score or text for specific diseases, allergies, or special diets)';
    const isSupplement = productType === 'supplement';
    const isTreat = isSupplement || productType === 'treats' || productType === 'treat';

    // Different evaluation criteria for treats vs. daily food vs. supplements
    const supplementPrompt = `You are a veterinary nutritionist reviewing a PET DIETARY SUPPLEMENT.

PRODUCT TYPE: SUPPLEMENT (not food or treat)
PET: ${petType} named ${petName}
HEALTH CONDITIONS: ${conditionsText}

INGREDIENTS (by weight):
${ingredients.map((ing, i) => `${i + 1}. ${ing}`).join('\n')}

IMPORTANT: This is a SUPPLEMENT, NOT daily food or a treat. Supplements are:
- Taken to complement the regular diet (e.g., fish oil, joint support, probiotics)
- NOT expected to be nutritionally complete
- Capsule shells/binders/carriers (gelatin, glycerin, water, cellulose) are standard delivery mechanisms — NEUTRAL
- Evaluate ONLY: active ingredient quality and general safety (universal, healthy pet)

BASE SCORE: 80 (supplements start here)

SCORING ADJUSTMENTS FOR SUPPLEMENTS:

PENALTIES (subtract from base):
- Artificial preservatives (BHA, BHT): -10 to -15
- Toxic ingredients: -50 (instant fail)
- Low-quality/rancid oil sources: -10 to -15
- Artificial colors or flavors: -5 to -10

BONUSES (add to base):
- High-quality active ingredients (wild-caught fish oil, organic extracts): +10 to +15
- Natural preservatives (tocopherols, rosemary extract): +3 to +5
- Clean, minimal ingredient list: +3 to +5
- Proven beneficial supplements (omega-3, glucosamine, probiotics): +5 to +10

NEUTRAL FOR SUPPLEMENTS (don't penalize):
- Capsule shell ingredients (gelatin, glycerin, water) — standard delivery
- Cellulose, starch — common filler in capsules/tablets
- Small amounts of carrier oils
- No protein content — supplements aren't protein sources

SCORING GUIDE FOR SUPPLEMENTS:
- 90-100: Excellent supplement (high-quality actives + clean + no artificial additives)
- 80-89: Good supplement (quality actives, minimal concerns)
- 70-79: Acceptable (some minor concerns, still potentially beneficial)
- 60-69: Caution (quality concerns)
- Below 60: Not recommended (toxic or very low quality)

IMPORTANT: In keyIssues, positives, and aiSummary, DO NOT mention ingredient position/order.

Return JSON:
{
  "finalScore": <number 0-100>,
  "grade": "<A|B|C|D|F>",
  "recommendation": "<highly_recommended|recommended|acceptable|caution|not_recommended>",
  "proteinQuality": "<none|low|medium|high>",
  "primaryIngredientType": "<protein|carb|filler|fat|other>",
  "hasArtificialAdditives": <true|false>,
  "keyIssues": ["<issue without position reference>"],
  "positives": ["<positive without position reference>"],
  "aiSummary": "<2-3 sentence summary for ${petName} - no position references>"
}`;

    const treatPrompt = `You are a veterinary nutritionist reviewing a PET TREAT (not daily food).

PRODUCT TYPE: TREAT / SNACK
PET: ${petType} named ${petName}
HEALTH CONDITIONS: ${conditionsText}

INGREDIENTS (by weight):
${ingredients.map((ing, i) => `${i + 1}. ${ing}`).join('\n')}

IMPORTANT: This is a TREAT, not daily food. Treats are:
- Given occasionally (not primary nutrition source)
- NOT expected to be nutritionally complete
- Allowed to have fillers for texture/shape
- Evaluated differently than daily food

BASE SCORE: 75 (treats start here)

SCORING ADJUSTMENTS FOR TREATS:

PENALTIES (subtract from base):
- Artificial colors (Yellow 5, Blue 1, Red 40): -8 to -12 (unnecessary, potentially harmful)
- Artificial preservatives (BHA, BHT, ethoxyquin): -10 to -15
- Toxic ingredients (xylitol, chocolate, grapes): -50 (instant fail)
- Sugar/sweeteners as #1 or #2 ingredient: -2 to -4 (minor concern for treats)
- Long ingredient list (15+) with many unrecognizable items: -3 to -5

BONUSES (add to base):
- Real meat/protein as #1 ingredient: +12 to +18 (significant bonus!)
- Real meat/protein in top 3 (not #1): +6 to +10
- Natural preservatives (tocopherols, rosemary extract): +3 to +5
- Short, clean ingredient list (5 or fewer ingredients): +3 to +5
- All recognizable, whole-food ingredients: +3 to +5
- Functional benefits (dental, joint, skin): +2 to +3
- Beneficial herbs (parsley, peppermint): +1 to +2

NEUTRAL FOR TREATS (don't penalize):
- Fillers as primary ingredient (rice flour, corn starch) - expected in treats
- No protein - treats don't need to be protein-rich
- Glycerin/water - common in soft treats
- "Natural Flavor" - acceptable for treats
- Organic sugar in small amounts - treats are meant to be tasty

SCORING GUIDE FOR TREATS:
- 90-100: Excellent treat (real protein #1 + clean ingredients + no artificial additives)
- 80-89: Great treat (real protein + mostly clean OR very clean but no protein)
- 70-79: Good treat (acceptable ingredients, may have minor concerns)
- 60-69: Caution (artificial additives or multiple concerns)
- Below 60: Not recommended (toxic, artificial colors + preservatives, or serious issues)

IMPORTANT: In keyIssues, positives, and aiSummary, DO NOT mention ingredient position/order.
BAD: "Cane sugar as the #1 ingredient is concerning"
GOOD: "Contains added sugar which provides empty calories"

Return JSON:
{
  "finalScore": <number 0-100>,
  "grade": "<A|B|C|D|F>",
  "recommendation": "<highly_recommended|recommended|acceptable|caution|not_recommended>",
  "proteinQuality": "<none|low|medium|high>",
  "primaryIngredientType": "<protein|carb|filler|fat|other>",
  "hasArtificialAdditives": <true|false>,
  "keyIssues": ["<issue without position reference>", "<issue 2>"],
  "positives": ["<positive without position reference>", "<positive 2>"],
  "aiSummary": "<2-3 sentence summary for ${petName} - no position references>"
}

CALIBRATION EXAMPLES (follow these closely):
- Chicken #1, organic sugar, vinegar, rosemary extract (4 ingredients, all recognizable, natural preservative) = 90-93 (Grade A)
- Chicken #1, sugar, glycerin, natural flavors, rosemary (clean but slightly longer) = 86-89 (Grade A)
- Rice flour, glycerin, natural preservatives, herbs, NO artificial colors = 78-82 (Grade B)
- Rice flour, glycerin, natural preservatives, herbs, WITH artificial colors (Yellow 5, Blue 1) = 65-72 (Grade C/D)
- Artificial colors AND artificial preservatives = 55-65 (Grade D/F)

KEY PRINCIPLE: Score for a typical healthy pet. Treats deserve 90+ if clean ingredients and no artificial additives.`;

    const foodPrompt = `You are a veterinary nutritionist reviewing DAILY PET FOOD (not treats).

PRODUCT TYPE: DAILY FOOD
PET: ${petType} named ${petName}
HEALTH CONDITIONS: ${conditionsText}

INGREDIENTS (by weight):
${ingredients.map((ing, i) => `${i + 1}. ${ing}`).join('\n')}

IMPORTANT: This is DAILY FOOD - the primary nutrition source. Must be:
- Nutritionally appropriate
- Protein should be prominent
- Quality matters significantly

BASE SCORE: 75 (daily food starts here - stricter than treats)

SCORING FOR DAILY FOOD:

PENALTIES:
- No real protein in top 3: -10 to -15
- "Flavor" instead of real meat: -8 to -12
- Artificial colors: -8 to -12
- Artificial preservatives: -8 to -12
- Corn/wheat as #1 ingredient: -8 to -12
- By-products as primary protein: -5 to -8
- Toxic ingredients: -50 (instant fail)

BONUSES:
- Real meat as #1 ingredient: +8 to +12
- Named meat (chicken, beef) vs generic: +3 to +5
- Natural preservatives: +3 to +5
- Whole grains vs refined: +2 to +4
- Added vitamins/minerals: +2 to +4
- Omega fatty acids: +2 to +4

${petType === 'cat' ? `
CAT-SPECIFIC:
- Cats are obligate carnivores - NEED high protein
- No taurine listed: -10 to -15
- Carb-heavy formula: -8 to -12
` : `
DOG-SPECIFIC:
- Dogs are omnivores - some carbs OK
- Still need quality protein
- Balanced nutrition important
`}

IMPORTANT: In keyIssues, positives, and aiSummary, DO NOT mention ingredient position/order.
BAD: "Real chicken as the #1 ingredient" or "Sugar is the first ingredient"
GOOD: "Contains quality chicken protein" or "High sugar content is concerning"

Return JSON:
{
  "finalScore": <number 0-100>,
  "grade": "<A|B|C|D|F>",
  "recommendation": "<highly_recommended|recommended|acceptable|caution|not_recommended>",
  "proteinQuality": "<none|low|medium|high>",
  "primaryIngredientType": "<protein|carb|filler|fat|other>",
  "hasArtificialAdditives": <true|false>,
  "keyIssues": ["<issue without position reference>", "<issue 2>"],
  "positives": ["<positive without position reference>", "<positive 2>"],
  "aiSummary": "<2-3 sentence product-quality summary (typical healthy pet) — you may use ${petName} naturally; no position references>"
}`;

    const prompt = isSupplement ? supplementPrompt : (isTreat ? treatPrompt : foodPrompt);

    // Two-pass strategy:
    //   Pass 1 — model returns JSON directly via responseMimeType.
    //   Pass 2 — if that still returns malformed JSON (rare but happens
    //            when the model tries to "explain"), reissue with an even
    //            stricter prompt suffix.
    //
    // We deliberately do NOT silently return a placeholder ("Unable to
    // complete AI analysis"). That fallback used to be cached forever in
    // product_review_cache, polluting every future scan that hashed to
    // the same ingredient list. Instead, throw — the call sites are all
    // wrapped in try/catch and will simply skip caching.
    // NOTE: We intentionally don't set responseMimeType: 'application/json'
    // here — the @google/generative-ai SDK pinned in this project is too
    // old to translate that field, and the v1 REST endpoint rejects it
    // (HTTP 400 "Unknown name 'responseMimeType' at 'generation_config'").
    // Strict-JSON behaviour comes from the prompt + the tolerant parser
    // + the retry below; not from the SDK option.
    const baseGenerationConfig = {
      temperature: 0.0,
      candidateCount: 1,
    };

    const attempts = [
      {
        suffix: '\n\nReturn ONLY a single valid JSON object. No markdown fences, no prose, no comments, no trailing text. Start the response with `{` and end with `}`.',
        config: baseGenerationConfig,
      },
      {
        suffix: '\n\nIMPORTANT: Your previous attempt produced invalid JSON. Output exactly one JSON object that JSON.parse() can read. Do not wrap it in ```. No commentary before or after. Begin with `{` and end with `}`.',
        config: baseGenerationConfig,
      },
    ];

    let lastError = null;

    for (let attempt = 0; attempt < attempts.length; attempt++) {
      const { suffix, config } = attempts[attempt];
      try {
        const result = await this.model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt + suffix }] }],
          generationConfig: config,
        });
        const text = this._extractFirstText(result?.response) || '';
        const parsed = this._parseHolisticReviewJson(text);

        return {
          finalScore: Math.max(0, Math.min(100, parseInt(parsed.finalScore) || 50)),
          grade: ['A', 'B', 'C', 'D', 'F'].includes(parsed.grade) ? parsed.grade : 'C',
          recommendation: parsed.recommendation || 'acceptable',
          proteinQuality: parsed.proteinQuality || 'unknown',
          primaryIngredientType: parsed.primaryIngredientType || 'unknown',
          hasArtificialAdditives: !!parsed.hasArtificialAdditives,
          keyIssues: Array.isArray(parsed.keyIssues) ? parsed.keyIssues : [],
          positives: Array.isArray(parsed.positives) ? parsed.positives : [],
          aiSummary: parsed.aiSummary || ''
        };
      } catch (error) {
        lastError = error;
        console.warn(
          `[reviewProductHolistically] attempt ${attempt + 1}/${attempts.length} failed: ${error.message}`
        );
      }
    }

    // Both passes failed → surface the error so callers skip caching.
    const finalErr = new Error(
      `Holistic AI review failed after ${attempts.length} attempts: ${lastError?.message || 'unknown error'}`
    );
    finalErr.cause = lastError;
    throw finalErr;
  }

  /**
   * Tolerant JSON extractor for holistic-review responses.
   *
   * Tries (in order):
   *   1. Strip ``` / ```json fences, then JSON.parse the whole thing
   *      (responseMimeType: application/json should already give clean JSON,
   *       but Gemini still occasionally wraps it).
   *   2. Pull the first {...} block out and parse that.
   *   3. Apply a couple of targeted fixups (trailing commas) before re-parsing.
   *
   * Throws if nothing parseable is found — caller should retry or give up.
   */
  _parseHolisticReviewJson(text) {
    if (!text || typeof text !== 'string') {
      throw new Error('Empty AI response');
    }

    const stripFences = (s) =>
      s
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();

    const cleaned = stripFences(text);

    try {
      return JSON.parse(cleaned);
    } catch (_) { /* try the next strategy */ }

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON object found in AI response');
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch (_) { /* try one more fixup */ }

    // Last-chance cleanup: drop trailing commas before } or ].
    const fixed = jsonMatch[0]
      .replace(/,(\s*[}\]])/g, '$1')
      .replace(/[\u0000-\u001F]+/g, ' ');

    return JSON.parse(fixed);
  }

  /**
   * MERGED: Per-ingredient assessment + Holistic review in ONE Gemini call.
   * @param {Object} params
   * @param {Array} params.uncachedIngredients - Only the ingredients needing AI assessment
   * @param {Array} params.allIngredients - Full ingredient list for holistic review
   * @param {string} params.petType
   * @param {string} params.petName
   * @param {Array} params.healthConditions ignored (holistic is universal healthy baseline)
   * @param {string} params.productType
   */
  async assessAndReviewProduct({ uncachedIngredients, allIngredients, petType, petName = 'your pet', healthConditions: _healthConditions = [], productType = 'food' }) {
    this.initialize();

    const ingredients = uncachedIngredients || allIngredients;
    const fullIngredients = allIngredients || ingredients;

    if (!this.model || ingredients.length === 0) {
      throw new Error('Gemini AI not initialized or no ingredients');
    }

    const uncachedDetails = ingredients.map((i, idx) => {
      const name = i.name || i;
      const position = i.position || (idx + 1);
      return `${position}. ${name}`;
    }).join('\n');

    const fullIngredientDetails = fullIngredients.map((i, idx) => {
      const name = i.name || i;
      const position = i.position || (idx + 1);
      return `${position}. ${name}`;
    }).join('\n');

    const totalIngredients = fullIngredients.length;
    const conditionsText = 'None (universal healthy pet — same baseline as per-ingredient assessment)';

    const isSupplement = productType === 'supplement';
    const isTreat = isSupplement || productType === 'treats' || productType === 'treat' ||
                    (ingredients.length <= 6 && ingredients.some(i =>
                      (i.name || i).toLowerCase().includes('jerky') ||
                      (i.name || i).toLowerCase().includes('treat')));

    const productTypeLabel = isSupplement ? 'SUPPLEMENT' : (isTreat ? 'TREAT' : 'DAILY FOOD');

    const hasPartialCache = ingredients.length < fullIngredients.length;
    
    const prompt = `You are a veterinary nutritionist. Perform a COMPLETE analysis of this pet food product.

PRODUCT TYPE: ${productTypeLabel}
PET: ${petType} named ${petName}

PART 1: Per-ingredient — UNIVERSAL healthy-pet baseline (no disease or allergy personalization).
PART 2: Holistic product score & summary — UNIVERSAL healthy-pet baseline (same; score overall product quality for a typical healthy ${petType}).
HEALTH CONDITIONS: ${conditionsText}

FULL INGREDIENT LIST (for holistic review - by weight, earlier = larger amount):
${fullIngredientDetails}

TOTAL INGREDIENTS: ${totalIngredients}

You must return TWO things in your response:

═══ PART 1: PER-INGREDIENT ASSESSMENT ═══
Assume a typical healthy ${petType} — do NOT personalize per-ingredient text for specific diseases or named allergies.
${hasPartialCache ? `Assess ONLY these ${ingredients.length} ingredients (the others are already evaluated):
${uncachedDetails}` : `For EACH ingredient, provide a risk score and explanation.`}

riskScore guidelines: -20 (very beneficial) to +50 (dangerous)
${isSupplement ? `- Active beneficial ingredients (fish oil, glucosamine, probiotics): -15 to -20
- Carrier/capsule components (gelatin, glycerin, cellulose): -2 to +2 (NEUTRAL)
- Natural preservatives: -3 to +2` :
isTreat ? `- Quality proteins (chicken, beef, fish): -12 to -18 (very beneficial)
- Wholesome grains (oatmeal, brown rice): -5 to -10
- Treat fillers/binders (rice flour, glycerin, tapioca, guar gum): -2 to +2 (NEUTRAL - expected in treats)
- Vegetables, fruits: -5 to -10
- Organic sugars in moderation: +2 to +5
- Refined sugars, corn syrup: +8 to +15
- Artificial colors: +8 to +15
- Artificial preservatives: +10 to +20
- Toxic ingredients (xylitol, chocolate): +40 to +50` :
`- Quality proteins (chicken, beef, salmon): -10 to -18 (very beneficial)
- Wholesome grains (oatmeal, brown rice, barley): -5 to -10
- Vegetables & fruits: -5 to -10
- Lower quality fillers (corn, wheat gluten, soy): +3 to +8
- Any added sugars: +8 to +15
- Artificial colors/flavors: +10 to +18
- Byproducts (unspecified): +5 to +10`}

IMPORTANT: Do NOT mention ingredient position/order in explanations.

═══ PART 2: HOLISTIC PRODUCT REVIEW ═══
Evaluate the ENTIRE product (all ${totalIngredients} ingredients in the FULL INGREDIENT LIST above) for overall quality for a typical healthy ${petType}. Do not adjust the holistic score for specific medical conditions or allergies.

${isSupplement ? 'BASE SCORE: 80 (supplements start here)' : isTreat ? 'BASE SCORE: 75 (treats start here)' : 'BASE SCORE: 75 (daily food starts here)'}

Scoring guide:
- 90-100: Excellent (Grade A) ${isTreat ? '- real protein + clean ingredients' : '- high-quality protein + nutritionally complete'}
- 80-89: Good (Grade B)
- 70-79: Acceptable (Grade C)
- 55-69: Below average (Grade D)
- Below 55: Avoid - significant issues (Grade F)

Return VALID JSON (no + prefix on numbers):
{
  "assessments": {
    "Ingredient Name": {
      "riskScore": <integer>,
      "category": "string",
      "explanation": "string",
      "benefit": "string or empty"
    }
  },
  "holistic": {
    "finalScore": <number 0-100>,
    "grade": "<A|B|C|D|F>",
    "recommendation": "<highly_recommended|recommended|acceptable|caution|not_recommended>",
    "proteinQuality": "<none|low|medium|high>",
    "primaryIngredientType": "<protein|carb|filler|fat|other>",
    "hasArtificialAdditives": <true|false>,
    "keyIssues": ["issue 1", "issue 2"],
    "positives": ["positive 1", "positive 2"],
    "aiSummary": "<2-3 sentence summary for ${petName}>"
  }
}`;

    try {
      console.log(`🚀 [MERGED AI] Single call for ${totalIngredients} ingredients + holistic (${conditionsText})`);
      const result = await this.model.generateContent(prompt);
      const text = result.response.text();

      console.log(`🤖 [MERGED AI RAW]:\n${text.substring(0, 500)}...`);

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const cleanedJson = jsonMatch[0].replace(/:\s*\+(\d)/g, ': $1');
        const parsed = JSON.parse(cleanedJson);

        const assessments = parsed.assessments || {};
        const holistic = parsed.holistic || {};

        const normalizedHolistic = {
          finalScore: Math.max(0, Math.min(100, parseInt(holistic.finalScore) || 50)),
          grade: ['A', 'B', 'C', 'D', 'F'].includes(holistic.grade) ? holistic.grade : 'C',
          recommendation: holistic.recommendation || 'acceptable',
          proteinQuality: holistic.proteinQuality || 'unknown',
          primaryIngredientType: holistic.primaryIngredientType || 'unknown',
          hasArtificialAdditives: !!holistic.hasArtificialAdditives,
          keyIssues: Array.isArray(holistic.keyIssues) ? holistic.keyIssues : [],
          positives: Array.isArray(holistic.positives) ? holistic.positives : [],
          aiSummary: holistic.aiSummary || ''
        };

        console.log(`✅ [MERGED AI] Got ${Object.keys(assessments).length} ingredient assessments + holistic score=${normalizedHolistic.finalScore} grade=${normalizedHolistic.grade}`);

        return { assessments, holistic: normalizedHolistic };
      }

      throw new Error('Invalid JSON response from merged AI call');
    } catch (error) {
      console.error('Merged AI assessment error:', error.message);
      throw error;
    }
  }

  /**
   * Identify food from photo (Step 1 - always needed for image recognition)
   * @param {Buffer} imageBuffer - Image data
   * @param {string} mimeType - Image MIME type
   * @returns {Object} Food identification { identified, foodName, category, foodType }
   */
  async identifyFoodFromImage(imageBuffer, mimeType = 'image/jpeg') {
    this.initialize();

    if (!this.model) {
      throw new Error('Gemini AI not initialized. Check API key.');
    }

    const imageBase64 = imageBuffer.toString('base64');

    const prompt = `You are a food identification expert. Look at this photo and identify what food is shown.

INSTRUCTIONS:
1. Identify the food in the photo
2. Determine if it's a SIMPLE food or PREPARED dish
3. Be specific with the name

FOOD TYPES:
- "simple": Single ingredient or raw food (apple, egg, raw chicken, carrot, cheese, chocolate bar)
- "prepared": Cooked dish, meal, recipe with multiple ingredients (soup, pizza, stew, sandwich, salad, pasta dish, Korean food, etc.)

Return ONLY a JSON object:
{
  "identified": true,
  "foodName": "<Name of the food>",
  "category": "<Fruit|Vegetable|Meat|Dairy|Grain|Snack|Beverage|Candy|Nut|Seafood|PreparedDish|Other>",
  "foodType": "<simple|prepared>"
}

EXAMPLES:
- Photo of an apple → { "foodName": "Apple", "category": "Fruit", "foodType": "simple" }
- Photo of pizza → { "foodName": "Pizza", "category": "PreparedDish", "foodType": "prepared" }
- Photo of raw egg → { "foodName": "Egg", "category": "Dairy", "foodType": "simple" }
- Photo of Korean soup → { "foodName": "Tteok-Manduguk", "category": "PreparedDish", "foodType": "prepared" }
- Photo of chocolate → { "foodName": "Chocolate", "category": "Candy", "foodType": "simple" }

If the image does NOT show food:
{
  "identified": false,
  "foodName": null,
  "category": null,
  "foodType": null
}`;

    try {
      const result = await this.model.generateContent([
        {
          inlineData: {
            data: imageBase64,
            mimeType
          }
        },
        prompt
      ]);

      const text = result.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          identified: !!parsed.identified,
          foodName: parsed.foodName || null,
          category: parsed.category || null,
          foodType: parsed.foodType || 'simple' // default to simple if not specified
        };
      }

      return { identified: false, foodName: null, category: null, foodType: null };
    } catch (error) {
      console.error('[Food Identification] Error:', error.message);
      return { identified: false, foodName: null, category: null, foodType: null };
    }
  }

  /**
   * Assess food safety for a specific pet (Step 2 - can be cached)
   * @param {string} foodName - Name of the food
   * @param {string} category - Food category
   * @param {Object} petInfo - Pet details (name, type, healthConditions, foodType)
   * @returns {Object} Safety assessment { safetyLevel, explanation, tip, category }
   */
  async assessFoodSafety(foodName, category, petInfo) {
    this.initialize();

    if (!this.model) {
      throw new Error('Gemini AI not initialized. Check API key.');
    }

    const { petName, petType, healthConditions = [], foodType = 'simple' } = petInfo;
    const isPreparedDish = foodType === 'prepared' || category === 'PreparedDish';

    // Build health conditions context with EXPLICIT rules
    let healthContext = '';
    if (healthConditions.length > 0) {
      const conditionRules = healthConditions.map(c => {
        const condition = c.name || c.condition_type || c;
        if (condition.includes('allergy')) {
          const allergen = condition.replace('allergy_', '').replace(/_/g, ' ');
          return `🚨 ${allergen.toUpperCase()} ALLERGY: If food is ${allergen} or contains ${allergen} → safetyLevel="danger"`;
        }
        if (condition.includes('diabetes')) return `🚨 DIABETES: If high sugar food → safetyLevel="danger" or "caution"`;
        if (condition.includes('kidney')) return `🚨 KIDNEY DISEASE: If high protein/phosphorus → safetyLevel="caution"`;
        if (condition.includes('pancreatitis')) return `🚨 PANCREATITIS: If high fat → safetyLevel="danger"`;
        if (condition.includes('liver')) return `🚨 LIVER DISEASE: If high protein/copper → safetyLevel="caution"`;
        if (condition.includes('heart')) return `🚨 HEART DISEASE: If high sodium → safetyLevel="caution"`;
        if (condition.includes('digestive') || condition.includes('sensitive')) return `⚠️ DIGESTIVE SENSITIVITY: If hard to digest/fatty/dairy → safetyLevel="caution"`;
        if (condition.includes('obesity')) return `⚠️ OBESITY: If high calorie/fat → safetyLevel="caution"`;
        return `⚠️ ${condition.replace(/_/g, ' ').toUpperCase()}: Consider impact on this condition`;
      });
      healthContext = `\n⚠️ HEALTH CONDITIONS:\n${conditionRules.join('\n')}`;
    }

    // Different prompts for simple foods vs prepared dishes
    let prompt;
    
    if (isPreparedDish) {
      // PREPARED DISH prompt - cannot know exact ingredients
      prompt = `You are a veterinary nutrition expert. "${foodName}" is a PREPARED DISH (meal/recipe with multiple ingredients).

Assess safety for a ${petType}.${healthContext}

CRITICAL RULES FOR PREPARED DISHES:
1. You CANNOT know exact ingredients from just the dish name
2. NEVER say "contains X" - always say "often contains" or "may contain"
3. Mention common toxic ingredients typically found in this type of dish
4. Default to "caution" unless it's a dish KNOWN to always contain toxic ingredients

Common toxic ingredients in prepared foods:
- Many dishes: onion, garlic (toxic to dogs/cats)
- Asian dishes: often have garlic, soy sauce, MSG
- Western dishes: often have onion, garlic, butter
- Desserts: may have chocolate, xylitol, raisins

Return ONLY JSON:
{
  "safetyLevel": "<caution|danger>",
  "explanation": "<Max 15 words. Start with 'Often contains...' or 'May contain...' - list concerning ingredients>",
  "tip": "Check ingredients before sharing. Avoid if contains onion/garlic.",
  "category": "PreparedDish"
}

NEVER use "safe" for prepared dishes - we can't verify ingredients.`;
    } else {
      // SIMPLE FOOD prompt - single ingredient, can be definitive
      prompt = `You are a veterinary nutrition expert. Assess whether "${foodName}" (a simple, single food item) is safe for a ${petType}.${healthContext}

TOXIC FOR DOGS: Chocolate, grapes, raisins, onions, garlic, xylitol, macadamia nuts, avocado
TOXIC FOR CATS: Onions, garlic, chocolate, grapes, raisins, xylitol, lilies

Return ONLY JSON:
{
  "safetyLevel": "<safe|caution|danger>",
  "explanation": "<ONE sentence, max 15 words. Be direct about why it's safe/dangerous.>",
  "tip": "<Short tip about portion/preparation, or null>",
  "category": "${category || 'Other'}"
}

Examples:
- Apple: "Safe and nutritious, good source of fiber and vitamins."
- Chocolate: "Toxic - contains theobromine which is poisonous to dogs."
- Cheese: "Okay in small amounts, but may cause digestive upset."`;
    }

    try {
      console.log(`🔍 [Food Safety] Assessing "${foodName}" for ${petType}`);

      const result = await this.model.generateContent(prompt);
      const text = result.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        console.log(`✅ [Food Safety] "${foodName}" = ${parsed.safetyLevel}`);

        return {
          safetyLevel: parsed.safetyLevel || 'unknown',
          explanation: parsed.explanation || 'Unable to determine safety. Please consult your veterinarian.',
          tip: parsed.tip || null,
          category: parsed.category || category
        };
      }

      throw new Error('Invalid JSON response');
    } catch (error) {
      console.error('[Food Safety] Error:', error.message);

      return {
        safetyLevel: 'unknown',
        explanation: 'We couldn\'t assess this food\'s safety. Please consult your veterinarian.',
        tip: 'When in doubt, don\'t feed it to your pet.',
        category: category
      };
    }
  }
}

module.exports = new GeminiService();

