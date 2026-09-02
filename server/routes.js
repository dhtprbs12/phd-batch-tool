const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// HEIC to JPEG conversion
async function ensureJpeg(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
    const convert = require('heic-convert');
    const inputBuffer = fs.readFileSync(filePath);
    const jpegBuffer = await convert({ buffer: inputBuffer, format: 'JPEG', quality: 0.9 });
    const jpegPath = filePath.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg');
    fs.writeFileSync(jpegPath, jpegBuffer);
    return { path: jpegPath, buffer: jpegBuffer, mime: 'image/jpeg' };
  }
  // For non-HEIC, just read the buffer
  const buffer = fs.readFileSync(filePath);
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return { path: filePath, buffer, mime };
}

// Local services (copied from backend)
const geminiService = require('./services/geminiService');
const ingredientAnalyzer = require('./services/ingredientAnalyzer');
const productMatchKey = require('./services/productMatchKey');
const productService = require('./services/productService');
const imageService = require('./services/imageService');
const { query } = require('./services/connection');
const { decodeBarcode } = require('./barcodeDecoder');

const router = express.Router();

// Multer config
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// In-memory queue of processed but not-yet-reviewed products
const pendingQueue = [];

/**
 * POST /api/batch/process
 * Upload 3 images (front, ingredients, barcode) → AI extract → return JSON
 */
router.post(
  '/process',
  upload.fields([
    { name: 'front', maxCount: 1 },
    { name: 'ingredients', maxCount: 1 },
    { name: 'barcode', maxCount: 1 },
    { name: 'extraBarcodes', maxCount: 20 },
  ]),
  async (req, res) => {
    try {
      const frontFile = req.files?.front?.[0];
      const ingredientsFile = req.files?.ingredients?.[0];
      const barcodeFile = req.files?.barcode?.[0];
      const extraBarcodeFiles = req.files?.extraBarcodes || [];

      if (!frontFile || !ingredientsFile) {
        return res.status(400).json({ error: 'front and ingredients images are required' });
      }

      // 1. Process front label (convert HEIC if needed)
      const front = await ensureJpeg(frontFile.path);
      const frontResult = await geminiService.extractFromImage(front.buffer, front.mime);

      // 2. Process ingredients (convert HEIC if needed)
      const ing = await ensureJpeg(ingredientsFile.path);
      const ingredientsResult = await geminiService.extractFromImage(ing.buffer, ing.mime);

      // 3. Decode barcode (if provided)
      let barcodeValue = null;
      if (barcodeFile) {
        try {
          const bc = await ensureJpeg(barcodeFile.path);
          barcodeValue = await decodeBarcode(bc.path);
        } catch (e) {
          console.warn('⚠️ Barcode decode failed:', e.message);
        }
      }

      // 4. Decode extra barcodes (variant sizes)
      const extraBarcodeValues = [];
      for (const ebFile of extraBarcodeFiles) {
        try {
          const eb = await ensureJpeg(ebFile.path);
          const val = await decodeBarcode(eb.path);
          if (val) extraBarcodeValues.push(val);
        } catch (e) {
          console.warn('⚠️ Extra barcode decode failed:', e.message);
        }
      }

      // Skip if primary barcode already in DB
      if (barcodeValue) {
        const existing = await productService.findByBarcode(barcodeValue);
        if (existing) {
          return res.json({ skipped: true, reason: 'barcode_exists', barcode: barcodeValue, existingProduct: existing.name });
        }
      }

      // Build combined result
      const id = uuidv4();
      const result = {
        id,
        status: 'pending_review',
        images: {
          front: `/uploads/${path.basename(frontFile.path)}`,
          ingredients: `/uploads/${path.basename(ingredientsFile.path)}`,
          barcode: barcodeFile ? `/uploads/${path.basename(barcodeFile.path)}` : null,
        },
        extracted: {
          manufacturer: frontResult.manufacturer || null,
          brand: frontResult.brand || null,
          lineName: frontResult.lineName || null,
          productName: frontResult.productName || null,
          lifeStage: frontResult.lifeStage || 'all',
          primaryProteins: frontResult.primaryProteins || [],
          petType: frontResult.targetPet || 'dog',
          productType: frontResult.productType || 'dry_food',
          texture: frontResult.texture || null,
          breedSize: frontResult.breedSize || 'all',
          dietTags: frontResult.dietTags || [],
        },
        ingredients: ingredientsResult.ingredientsList || [],
        rawIngredientsText: ingredientsResult.rawIngredientsText || '',
        barcode: barcodeValue,
        extraBarcodes: extraBarcodeValues,
        createdAt: new Date().toISOString(),
      };

      pendingQueue.push(result);
      res.json(result);
    } catch (e) {
      console.error('❌ Process error:', e);
      res.status(500).json({ error: e.message });
    }
  }
);

/**
 * POST /api/batch/process-bulk
 * Upload multiple sets at once. Files named: 0-front, 0-ingredients, 0-barcode, 1-front, ...
 */
router.post('/process-bulk', upload.array('photos', 300), async (req, res) => {
  try {
    const files = req.files || [];
    const sets = {};

    // Group files by index prefix
    for (const file of files) {
      const match = file.originalname.match(/^(\d+)-(front|ingredients|barcode)\./i);
      if (match) {
        const idx = match[1];
        const role = match[2].toLowerCase();
        if (!sets[idx]) sets[idx] = {};
        sets[idx][role] = file;
      }
    }

    const results = [];
    for (const idx of Object.keys(sets).sort((a, b) => Number(a) - Number(b))) {
      const set = sets[idx];
      if (!set.front || !set.ingredients) continue;

      const front = await ensureJpeg(set.front.path);
      const frontResult = await geminiService.extractFromImage(front.buffer, front.mime);

      const ing = await ensureJpeg(set.ingredients.path);
      const ingredientsResult = await geminiService.extractFromImage(ing.buffer, ing.mime);

      let barcodeValue = null;
      if (set.barcode) {
        try {
          const bc = await ensureJpeg(set.barcode.path);
          barcodeValue = await decodeBarcode(bc.path);
        } catch (e) {
          console.warn(`⚠️ Barcode decode failed for set ${idx}:`, e.message);
        }
      }

      // Skip if barcode already in DB
      if (barcodeValue) {
        const existing = await productService.findByBarcode(barcodeValue);
        if (existing) {
          console.log(`⚡ [Bulk] Skipping set ${idx}: barcode ${barcodeValue} already exists as "${existing.name}"`);
          results.push({ skipped: true, barcode: barcodeValue, existingProduct: existing.name });
          continue;
        }
      }

      const id = uuidv4();
      const result = {
        id,
        status: 'pending_review',
        images: {
          front: `/uploads/${path.basename(set.front.path)}`,
          ingredients: `/uploads/${path.basename(set.ingredients.path)}`,
          barcode: set.barcode ? `/uploads/${path.basename(set.barcode.path)}` : null,
        },
        extracted: {
          manufacturer: frontResult.manufacturer || null,
          brand: frontResult.brand || null,
          lineName: frontResult.lineName || null,
          productName: frontResult.productName || null,
          lifeStage: frontResult.lifeStage || 'all',
          primaryProteins: frontResult.primaryProteins || [],
          petType: frontResult.targetPet || 'dog',
          productType: frontResult.productType || 'dry_food',
          texture: frontResult.texture || null,
          breedSize: frontResult.breedSize || 'all',
          dietTags: frontResult.dietTags || [],
        },
        ingredients: ingredientsResult.ingredientsList || [],
        rawIngredientsText: ingredientsResult.rawIngredientsText || '',
        barcode: barcodeValue,
        createdAt: new Date().toISOString(),
      };

      pendingQueue.push(result);
      results.push(result);
    }

    res.json({ processed: results.length, results });
  } catch (e) {
    console.error('❌ Bulk process error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/batch/queue
 * List all pending review items
 */
router.get('/queue', (req, res) => {
  res.json(pendingQueue.filter(p => p.status === 'pending_review'));
});

/**
 * GET /api/batch/ingredients/suggest?q=
 * Same logic as app's /api/scan/ingredient-suggest
 * Searches ai_assessment_cache.ingredient_normalized (prefix + contains)
 */
router.get('/ingredients/suggest', async (req, res) => {
  try {
    const raw = String(req.query.q || '').trim();
    const limit = 20;
    if (raw.length < 1) return res.json([]);

    const qLower = raw.toLowerCase();
    const esc = qLower.replace(/[%_\\]/g, '\\$&');
    const prefixPat = `${esc}%`;
    const containPat = `%${esc}%`;

    // Prefix matches first
    const prefixRows = await query(
      `SELECT DISTINCT ingredient_normalized AS n
       FROM ai_assessment_cache
       WHERE ingredient_normalized LIKE ? ESCAPE '\\\\'
       ORDER BY n ASC LIMIT ?`,
      [prefixPat, limit]
    );
    const out = prefixRows.map(r => r.n);
    const seen = new Set(out.map(x => x.toLowerCase()));

    // Then contains matches
    if (out.length < limit) {
      const need = limit - out.length;
      const containRows = await query(
        `SELECT DISTINCT ingredient_normalized AS n
         FROM ai_assessment_cache
         WHERE ingredient_normalized LIKE ? ESCAPE '\\\\'
           AND NOT (ingredient_normalized LIKE ? ESCAPE '\\\\')
         ORDER BY n ASC LIMIT ?`,
        [containPat, prefixPat, need]
      );
      for (const r of containRows) {
        if (!seen.has(r.n.toLowerCase())) {
          out.push(r.n);
          if (out.length >= limit) break;
        }
      }
    }

    res.json(out);
  } catch (e) {
    console.error('❌ Suggest error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/batch/save
 * Save a reviewed product to the production DB
 */
router.post('/save', async (req, res) => {
  try {
    const { id, extracted, ingredients, barcode, extraBarcodes } = req.body;

    if (!extracted || !ingredients || ingredients.length === 0) {
      return res.status(400).json({ error: 'extracted data and ingredients are required' });
    }

    const ingredientsList = ingredients.map(s => String(s).trim()).filter(Boolean);
    const rawText = ingredientsList.join(', ');

    // Build slots and match fields
    const slots = productMatchKey.buildSlotsFromExtracted({
      manufacturer: extracted.manufacturer,
      brand: extracted.brand,
      lineName: extracted.lineName,
      lifeStage: extracted.lifeStage,
      primaryProteins: extracted.primaryProteins,
      breedSize: extracted.breedSize,
      dietTags: extracted.dietTags,
      targetPet: extracted.petType,
      productName: extracted.productName,
    });

    const displayName = extracted.lineName || extracted.productName || 'Unknown Product';

    // Check if this exact barcode already exists — only skip if same barcode
    let product = null;
    if (barcode) {
      product = await productService.findByBarcode(barcode);
    }

    if (!product) {
      // Different barcode (or no barcode) = always create new row
      product = await productService.createFromScan({
        name: displayName,
        displayName,
        manufacturer: extracted.manufacturer,
        brand: extracted.brand,
        lineName: slots.lineName,
        primaryProteins: slots.primaryProteins,
        breedSize: slots.breedSize,
        dietTags: slots.dietTags,
        productType: extracted.productType || 'dry_food',
        texture: extracted.texture,
        targetPetType: extracted.petType || 'dog',
        lifeStage: extracted.lifeStage || 'all',
        rawIngredientsText: rawText,
        ingredientsList,
        imageUrl: null,
        barcode: barcode || null,
        source: 'batch_import',
      });
    }

    // Fetch and save product image (search Google → download → R2)
    try {
      const imgUrl = await imageService.fetchAndSaveProductImage(
        product.id,
        product.name,
        extracted.brand || extracted.manufacturer
      );
      if (imgUrl) console.log(`🖼️ [Batch] Image saved: ${imgUrl}`);
    } catch (imgErr) {
      console.error(`⚠️ [Batch] Image fetch failed:`, imgErr.message);
    }

    // Update ingredient dictionary
    await updateIngredientDictionary(ingredientsList);

    // Run analysis and cache it (same as app's processAnalysisInBackground)
    try {
      console.log(`🧪 [Batch] Running analysis for "${product.name}" (${ingredientsList.length} ingredients)...`);
      const productType = (extracted.productType === 'treats' || extracted.productType === 'treat') ? 'treats' : 'food';
      const ingredientHash = productService.generateIngredientHash(ingredientsList);
      const { getSingleConditionHash } = require('./utils/cacheHelpers');
      const conditionHash = getSingleConditionHash('healthy', productType);

      // Fill per-ingredient AI assessment cache (same as app)
      try {
        const result = await ingredientAnalyzer.ensureIngredientAssessmentsInCache({
          ingredientsList,
          condition: 'healthy',
          productTypeForHash: productType,
          petType: 'dog',
          petName: 'default',
          productTypeForAI: extracted.productType || 'dry_food',
        });
        console.log(`💾 [Batch] Ingredient cache: ${result.filledFromAi} AI-assessed, ${result.neutralFallbacks} neutral`);
      } catch (cacheErr) {
        console.warn(`⚠️ [Batch] Ingredient cache fill failed:`, cacheErr.message);
      }

      // Check if already cached
      const existing = await query(
        `SELECT id FROM product_review_cache WHERE ingredient_hash = ? AND conditions_hash = ? AND pet_type = ?`,
        [ingredientHash, conditionHash, 'dog']
      );

      if (existing.length === 0) {
        // Generate AI holistic review (same as app)
        const review = await geminiService.reviewProductHolistically({
          ingredients: ingredientsList,
          petType: 'dog',
          healthConditions: [],
          productType,
          petName: 'default',
        });

        await query(
          `INSERT INTO product_review_cache 
           (id, ingredient_hash, conditions_hash, pet_type, product_type, final_score, grade, recommendation,
            key_issues, positives, ai_summary, protein_quality, has_artificial_additives, primary_ingredient_type)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE hit_count = hit_count + 1`,
          [
            ingredientHash, conditionHash, 'dog', `healthy_${productType}`,
            review.finalScore, review.grade, review.recommendation,
            JSON.stringify(review.keyIssues || []), JSON.stringify(review.positives || []),
            review.aiSummary || null, review.proteinQuality || null,
            review.hasArtificialAdditives ? 1 : 0, review.primaryIngredientType || null
          ]
        );
        console.log(`✅ [Batch] Analysis cached: score=${review.finalScore} grade=${review.grade}`);
      } else {
        console.log(`⚡ [Batch] Analysis already cached for this product`);
      }
    } catch (analysisErr) {
      console.error(`⚠️ [Batch] Analysis failed (product still saved):`, analysisErr.message);
    }

    // Create variant rows for extra barcodes (same product, different size)
    const variantIds = [];
    if (Array.isArray(extraBarcodes) && extraBarcodes.length > 0) {
      for (const variantBarcode of extraBarcodes) {
        if (!variantBarcode) continue;
        const existingVariant = await productService.findByBarcode(variantBarcode);
        if (existingVariant) {
          console.log(`⚡ [Batch] Variant barcode ${variantBarcode} already exists, skipping`);
          continue;
        }
        const variant = await productService.createFromScan({
          name: displayName,
          displayName,
          manufacturer: extracted.manufacturer,
          brand: extracted.brand,
          lineName: slots.lineName,
          primaryProteins: slots.primaryProteins,
          breedSize: slots.breedSize,
          dietTags: slots.dietTags,
          productType: extracted.productType || 'dry_food',
          texture: extracted.texture,
          targetPetType: extracted.petType || 'dog',
          lifeStage: extracted.lifeStage || 'all',
          rawIngredientsText: rawText,
          ingredientsList,
          imageUrl: null,
          barcode: variantBarcode,
          source: 'batch_import',
        });
        variantIds.push({ id: variant.id, barcode: variantBarcode });
        console.log(`✅ [Batch] Variant saved: ${variantBarcode} → ${variant.id}`);
      }
    }

    // Remove from pending queue
    const queueIdx = pendingQueue.findIndex(p => p.id === id);
    if (queueIdx >= 0) pendingQueue[queueIdx].status = 'saved';

    res.json({
      success: true,
      product: { id: product.id, name: product.name, brand: product.brand, barcode: product.barcode },
      variants: variantIds,
    });
  } catch (e) {
    console.error('❌ Save error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/batch/skip
 * Mark a queue item as skipped
 */
router.post('/skip', (req, res) => {
  const { id } = req.body;
  const item = pendingQueue.find(p => p.id === id);
  if (item) item.status = 'skipped';
  res.json({ success: true });
});

// Helper: update ingredient dictionary table
async function updateIngredientDictionary(ingredientsList) {
  try {
    for (const name of ingredientsList) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      await query(
        `INSERT INTO ingredient_dictionary (name, frequency) VALUES (?, 1)
         ON DUPLICATE KEY UPDATE frequency = frequency + 1`,
        [trimmed]
      );
    }
  } catch (e) {
    // Table might not exist — that's okay
    if (e.code !== 'ER_NO_SUCH_TABLE') {
      console.warn('⚠️ ingredient_dictionary update failed:', e.message);
    }
  }
}

module.exports = router;
