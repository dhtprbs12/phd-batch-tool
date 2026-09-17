#!/usr/bin/env node
/**
 * Generate thumbnails for existing R2 images.
 *
 * For every products.image_url and pets.photo_url in the DB:
 *   1. Download from R2 (GetObjectCommand)
 *   2. Resize to 200px (long edge) with sharp
 *   3. Upload as _thumb variant (PutObjectCommand)
 *
 * Original images are NOT modified.
 *
 * Usage:
 *   node server/scripts/generate-thumbnails.js            # dry-run (count only)
 *   node server/scripts/generate-thumbnails.js --run       # actually process
 *   node server/scripts/generate-thumbnails.js --run --concurrency=10
 */

require('dotenv').config();
const sharp = require('sharp');
const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { connectDB, query } = require('../services/connection');

const THUMB_SIZE = 200;
const DEFAULT_CONCURRENCY = 5;

function cleanEnv(v) {
  return v == null ? '' : String(v).trim().replace(/^\uFEFF/, '');
}

const accountId = cleanEnv(process.env.R2_ACCOUNT_ID);
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: cleanEnv(process.env.R2_ACCESS_KEY_ID),
    secretAccessKey: cleanEnv(process.env.R2_SECRET_ACCESS_KEY),
  },
});
const BUCKET = cleanEnv(process.env.R2_BUCKET_NAME);
const PUBLIC_URL = cleanEnv(process.env.R2_PUBLIC_URL).replace(/\/$/, '');

function urlToKey(url) {
  if (!url || !PUBLIC_URL) return null;
  if (url.startsWith(PUBLIC_URL)) {
    return url.slice(PUBLIC_URL.length + 1); // remove leading /
  }
  return null;
}

function keyToThumbKey(key) {
  const dotIdx = key.lastIndexOf('.');
  if (dotIdx === -1) return key + '_thumb';
  return key.slice(0, dotIdx) + '_thumb' + key.slice(dotIdx);
}

async function thumbExists(thumbKey) {
  try {
    await r2Client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: thumbKey }));
    return true;
  } catch {
    return false;
  }
}

async function processImage(url, label) {
  const key = urlToKey(url);
  if (!key) {
    console.log(`  ⏭  [${label}] Not an R2 URL, skipping: ${url}`);
    return { status: 'skipped', reason: 'not_r2' };
  }

  const thumbKey = keyToThumbKey(key);

  // Check if thumb already exists
  if (await thumbExists(thumbKey)) {
    console.log(`  ✅ [${label}] Thumb already exists: ${thumbKey}`);
    return { status: 'skipped', reason: 'exists' };
  }

  // Download original
  let buffer;
  try {
    const resp = await r2Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    buffer = Buffer.from(await resp.Body.transformToByteArray());
  } catch (err) {
    console.log(`  ❌ [${label}] Download failed (${key}): ${err.message}`);
    return { status: 'error', reason: err.message };
  }

  // Resize
  let thumbBuffer;
  try {
    thumbBuffer = await sharp(buffer)
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch (err) {
    console.log(`  ❌ [${label}] Resize failed (${key}): ${err.message}`);
    return { status: 'error', reason: err.message };
  }

  // Upload thumb
  try {
    await r2Client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: thumbKey,
      Body: thumbBuffer,
      ContentType: 'image/jpeg',
    }));
    const saved = ((buffer.length - thumbBuffer.length) / 1024).toFixed(1);
    console.log(`  🖼  [${label}] ${key} → ${thumbKey} (${(buffer.length / 1024).toFixed(0)}KB → ${(thumbBuffer.length / 1024).toFixed(0)}KB, saved ${saved}KB)`);
    return { status: 'created', originalKB: buffer.length / 1024, thumbKB: thumbBuffer.length / 1024 };
  } catch (err) {
    console.log(`  ❌ [${label}] Upload failed (${thumbKey}): ${err.message}`);
    return { status: 'error', reason: err.message };
  }
}

async function processBatch(items, concurrency) {
  const results = { created: 0, skipped: 0, error: 0 };
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(({ url, label }) => processImage(url, label))
    );
    for (const r of batchResults) {
      if (r.status === 'created') results.created++;
      else if (r.status === 'skipped') results.skipped++;
      else results.error++;
    }
    console.log(`\n  📊 Progress: ${Math.min(i + concurrency, items.length)}/${items.length}\n`);
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--run');
  const concurrencyArg = args.find(a => a.startsWith('--concurrency='));
  const concurrency = concurrencyArg ? parseInt(concurrencyArg.split('=')[1]) : DEFAULT_CONCURRENCY;

  console.log('\n🖼  R2 Thumbnail Generator');
  console.log(`   Mode: ${dryRun ? '🔍 DRY RUN (add --run to process)' : '🚀 PROCESSING'}`);
  console.log(`   Thumb size: ${THUMB_SIZE}px`);
  console.log(`   Concurrency: ${concurrency}`);
  console.log(`   Bucket: ${BUCKET}\n`);

  await connectDB();

  // Collect all image URLs
  const items = [];

  // 1. Product images (image_url)
  const products = await query(
    `SELECT id, image_url FROM products WHERE image_url IS NOT NULL AND image_url != ''`
  );
  for (const p of products) {
    items.push({ url: p.image_url, label: `product:${p.id.slice(0, 8)}` });
  }

  // 2. Product front/ingredient/barcode images
  const registered = await query(
    `SELECT id, front_image_url, ingredient_image_url, barcode_image_url 
     FROM products 
     WHERE front_image_url IS NOT NULL OR ingredient_image_url IS NOT NULL OR barcode_image_url IS NOT NULL`
  );
  for (const p of registered) {
    if (p.front_image_url) items.push({ url: p.front_image_url, label: `front:${p.id.slice(0, 8)}` });
    // ingredient/barcode are OCR-only, skip thumbnails
  }

  // 3. Pet profile photos
  const pets = await query(
    `SELECT id, photo_url FROM pets WHERE photo_url IS NOT NULL AND photo_url != ''`
  );
  for (const p of pets) {
    items.push({ url: p.photo_url, label: `pet:${p.id.slice(0, 8)}` });
  }

  console.log(`📋 Found ${items.length} images total:`);
  console.log(`   - ${products.length} product images`);
  console.log(`   - ${registered.filter(r => r.front_image_url).length} product front labels`);
  console.log(`   - ${pets.length} pet photos\n`);

  if (dryRun) {
    console.log('🔍 Dry run complete. Run with --run to generate thumbnails.\n');
    process.exit(0);
  }

  const results = await processBatch(items, concurrency);

  console.log('\n════════════════════════════════');
  console.log(`✅ Created: ${results.created}`);
  console.log(`⏭  Skipped: ${results.skipped}`);
  console.log(`❌ Errors:  ${results.error}`);
  console.log('════════════════════════════════\n');

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
