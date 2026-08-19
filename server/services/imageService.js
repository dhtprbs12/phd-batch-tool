const fs = require('fs');
const path = require('path');
const { query } = require('./connection');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

/** Strip whitespace + UTF-8 BOM (invisible; breaks AWS Sig V4 if pasted from some editors) */
function cleanR2Env(value) {
  if (value == null) return '';
  return String(value).trim().replace(/^\uFEFF/, '');
}

/**
 * IMAGE SERVICE
 * 
 * Handles product image fetching and storage.
 * 
 * Flow:
 * 1. Search for product image via SerpAPI (Google Images wrapper)
 * 2. Download the image
 * 3. Upload to Cloudflare R2 (remote storage with CDN)
 * 4. Save the public R2 URL to products.image_url
 * 
 * Env vars:
 *   SERPAPI_KEY - SerpAPI key (primary, wraps Google Images)
 *   R2_ACCOUNT_ID - Cloudflare account ID
 *   R2_ACCESS_KEY_ID - R2 API token access key
 *   R2_SECRET_ACCESS_KEY - R2 API token secret key
 *   R2_BUCKET_NAME - R2 bucket name (e.g., petfood-images)
 *   R2_PUBLIC_URL - R2 public bucket URL (e.g., https://pub-xxxxx.r2.dev)
 */

class ImageService {
  constructor() {
    this.serpApiKey = process.env.SERPAPI_KEY;
    // Google as fallback
    this.googleApiKey = process.env.GOOGLE_SEARCH_API_KEY;
    this.searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

    // Cloudflare R2 — use cleanR2Env (BOM/whitespace breaks signature even when “it looks right” in UI)
    this.r2BucketName = cleanR2Env(process.env.R2_BUCKET_NAME);
    this.r2PublicUrl = cleanR2Env(process.env.R2_PUBLIC_URL).replace(/\/$/, '');
    this.r2Client = null;

    const accountId = cleanR2Env(process.env.R2_ACCOUNT_ID);
    const accessKeyId = cleanR2Env(process.env.R2_ACCESS_KEY_ID);
    const secretAccessKey = cleanR2Env(process.env.R2_SECRET_ACCESS_KEY);

    if (accountId && accessKeyId && secretAccessKey) {
      // Cloudflare R2 + AWS SDK: official examples omit forcePathStyle (default signing path).
      // If you need legacy path-style, set R2_FORCE_PATH_STYLE=true
      const pathStyle = process.env.R2_FORCE_PATH_STYLE === 'true';
      const s3Config = {
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      };
      if (pathStyle) s3Config.forcePathStyle = true;
      this.r2Client = new S3Client(s3Config);
      console.log(
        '☁️  [R2] configured | pathStyle=%s | lens account=%d access=%d secret=%d bucket=%s',
        String(pathStyle),
        accountId.length,
        accessKeyId.length,
        secretAccessKey.length,
        this.r2BucketName || '(empty)',
      );
    } else {
      console.log('⚠️  [R2] Cloudflare R2 not configured — images will be saved locally');
    }
  }

  // ─── IMAGE SEARCH ───────────────────────────────────────────

  /**
   * Search for a product image
   * Priority: SerpAPI → Google Custom Search
   */
  async searchProductImage(productName, brand) {
    if (this.serpApiKey) {
      return this.searchViaSerpApi(productName, brand);
    }
    if (this.googleApiKey && this.searchEngineId) {
      return this.searchViaGoogle(productName, brand);
    }
    console.log('⚠️ No image search API configured (set SERPAPI_KEY or GOOGLE_SEARCH_API_KEY)');
    return null;
  }

  /**
   * SerpAPI - Google Images wrapper (primary)
   */
  async searchViaSerpApi(productName, brand) {
    const queries = [
      `${brand || ''} ${productName} pet food product package`.trim(),
      `"${brand || ''}" "${productName}" pet food`.trim(),
      `${brand || ''} ${productName} dog cat food`.trim(),
    ];

    for (const searchQuery of queries) {
      const url = `https://serpapi.com/search.json?` +
        `api_key=${this.serpApiKey}&` +
        `engine=google_images&` +
        `q=${encodeURIComponent(searchQuery)}&` +
        `num=3`;

      try {
        console.log(`🔍 [SerpAPI] Searching: "${searchQuery}"`);
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          console.error(`❌ [SerpAPI] HTTP ${response.status}: ${errText.slice(0, 200)}`);
          continue;
        }

        const data = await response.json();

        if (data.images_results && data.images_results.length > 0) {
          const best = data.images_results.find(r =>
            r.original && !r.original.includes('placeholder') && !r.original.includes('no-image')
          ) || data.images_results[0];
          if (best?.original) {
            console.log(`✅ [SerpAPI] Found: ${best.original}`);
            return best.original;
          }
        }

        console.log(`⚠️ [SerpAPI] No results for: "${searchQuery}"`);
      } catch (error) {
        console.error(`❌ [SerpAPI] Error:`, error.message);
      }
    }

    return null;
  }

  /**
   * Google Custom Search API (fallback)
   */
  async searchViaGoogle(productName, brand) {
    const searchQuery = `${brand || ''} ${productName} pet food`.trim();
    const url = `https://www.googleapis.com/customsearch/v1?` +
      `key=${this.googleApiKey}&` +
      `cx=${this.searchEngineId}&` +
      `q=${encodeURIComponent(searchQuery)}&` +
      `searchType=image&` +
      `num=1&` +
      `imgSize=medium&` +
      `safe=active`;

    try {
      console.log(`🔍 [Google Image Search] Searching: "${searchQuery}"`);
      const response = await fetch(url);
      const data = await response.json();

      if (data.items && data.items.length > 0) {
        const imageUrl = data.items[0].link;
        console.log(`✅ [Google Image Search] Found: ${imageUrl}`);
        return imageUrl;
      }

      console.log(`⚠️ [Google Image Search] No results for: "${searchQuery}"`);
      return null;
    } catch (error) {
      console.error(`❌ [Google Image Search] Error:`, error.message);
      return null;
    }
  }

  // ─── IMAGE STORAGE (R2 with local fallback) ─────────────────

  /**
   * Download an image from URL, upload to R2, return public URL
   * Falls back to local storage if R2 is not configured
   */
  async downloadAndSave(imageUrl, productId) {
    try {
      console.log(`📥 [Image] Downloading: ${imageUrl}`);
      const response = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PetFoodAnalyzer/1.0)',
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        console.log(`⚠️ [Image] HTTP ${response.status} for: ${imageUrl}`);
        return null;
      }

      const contentType = response.headers.get('content-type') || 'image/jpeg';
      let ext = '.jpg';
      if (contentType.includes('png')) ext = '.png';
      else if (contentType.includes('webp')) ext = '.webp';
      else if (contentType.includes('gif')) ext = '.gif';

      const buffer = Buffer.from(await response.arrayBuffer());

      // Validate it's actually an image
      if (buffer.length < 100) {
        console.log(`⚠️ [Image] File too small (${buffer.length} bytes), skipping`);
        return null;
      }

      const filename = `products/${productId}${ext}`;

      // Upload to R2 if configured, otherwise save locally
      if (this.r2Client) {
        return await this.uploadToR2(buffer, filename, contentType);
      } else {
        return await this.saveLocally(buffer, `${productId}${ext}`);
      }
    } catch (error) {
      console.error(`❌ [Image] Download error:`, error.message);
      return null;
    }
  }

  /**
   * Upload image buffer to Cloudflare R2
   * @returns {string} Public URL
   */
  async uploadToR2(buffer, key, contentType) {
    try {
      await this.r2Client.send(new PutObjectCommand({
        Bucket: this.r2BucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }));

      const publicUrl = `${this.r2PublicUrl}/${key}`;
      console.log(`☁️  [R2] Uploaded: ${publicUrl} (${(buffer.length / 1024).toFixed(1)}KB)`);
      return publicUrl;
    } catch (error) {
      console.error(`❌ [R2] Upload error:`, error.message);
      // Fall back to local storage
      const filename = key.split('/').pop();
      return await this.saveLocally(buffer, filename);
    }
  }

  /**
   * Save image locally (fallback when R2 is not configured)
   */
  async saveLocally(buffer, filename) {
    const dir = path.join(__dirname, '../../uploads/products');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buffer);
    console.log(`💾 [Local] Saved: ${filename} (${(buffer.length / 1024).toFixed(1)}KB)`);
    return `/images/products/${filename}`;
  }

  /**
   * Save a user-uploaded image (from label scan)
   */
  async saveUserImage(imageBuffer, productId, mimeType = 'image/jpeg') {
    try {
      let ext = '.jpg';
      if (mimeType.includes('png')) ext = '.png';
      else if (mimeType.includes('webp')) ext = '.webp';

      const filename = `products/${productId}${ext}`;

      if (this.r2Client) {
        return await this.uploadToR2(imageBuffer, filename, mimeType);
      } else {
        return await this.saveLocally(imageBuffer, `${productId}${ext}`);
      }
    } catch (error) {
      console.error(`❌ [User Image] Error:`, error.message);
      return null;
    }
  }

  /**
   * Strip-panorama JPEG: always write under backend/tmp/panoramas and
   * upload to R2 at debug/panoramas/… when R2 is configured (no env flags).
   * @param {Buffer} buffer
   * @param {{ cacheHashShort?: string, width?: number, height?: number }} meta
   * @returns {Promise<{ localPath: string|null, publicUrl: string|null }>}
   */
  async savePanoramaDebug(buffer, meta = {}) {
    if (!buffer?.length) return { localPath: null, publicUrl: null };

    const ts = Date.now();
    const hashShort =
      String(meta.cacheHashShort || 'na')
        .replace(/[^a-f0-9]/gi, '')
        .slice(0, 16) || 'na';
    const wh = meta.width && meta.height ? `-${meta.width}x${meta.height}` : '';
    const filename = `pan-${ts}-${hashShort}${wh}.jpg`;
    const r2Key = `debug/panoramas/${filename}`;

    let localAbs = null;
    try {
      const dir = path.join(__dirname, '../../uploads/panoramas');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      localAbs = path.join(dir, filename);
      fs.writeFileSync(localAbs, buffer);
      console.log(
        `🗂️  [Panorama] local ${localAbs} (${(buffer.length / 1024).toFixed(1)}KB)`
      );
    } catch (e) {
      console.warn(`[Panorama] local write skipped: ${e.message}`);
    }

    let publicUrl = null;
    if (this.r2Client && this.r2BucketName) {
      publicUrl = await this.uploadToR2(buffer, r2Key, 'image/jpeg');
    } else {
      console.warn('[Panorama] R2 not configured — skipped upload');
    }
    return { localPath: localAbs, publicUrl };
  }

  // ─── FULL FLOW ──────────────────────────────────────────────

  /**
   * Full flow: Find, download, upload to R2, save URL to DB
   */
  async fetchAndSaveProductImage(productId, productName, brand) {
    // Check if image already exists
    const existingUrl = await this.getExistingImageUrl(productId);
    if (existingUrl) {
      console.log(`⚡ [Image] Already have image for product ${productId}`);
      return existingUrl;
    }

    // Search for image
    const sourceUrl = await this.searchProductImage(productName, brand);
    if (!sourceUrl) return null;

    // Download and upload to R2
    const publicUrl = await this.downloadAndSave(sourceUrl, productId);
    if (!publicUrl) return null;

    // Update product in DB
    await this.updateProductImageUrl(productId, publicUrl);
    return publicUrl;
  }

  /**
   * Check if we already have an image for this product
   */
  async getExistingImageUrl(productId) {
    try {
      const [product] = await query(
        'SELECT image_url FROM products WHERE id = ? AND image_url IS NOT NULL AND image_url != ""',
        [productId]
      );
      return product?.image_url || null;
    } catch {
      return null;
    }
  }

  /**
   * Update the image_url column in the products table
   */
  async updateProductImageUrl(productId, imageUrl) {
    try {
      await query(
        'UPDATE products SET image_url = ? WHERE id = ?',
        [imageUrl, productId]
      );
      console.log(`✅ [Image DB] Updated image_url for product ${productId}`);
    } catch (error) {
      console.error(`❌ [Image DB] Error updating:`, error.message);
    }
  }
}

module.exports = new ImageService();
