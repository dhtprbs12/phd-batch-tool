/**
 * Label photo preprocessing before OCR.
 * Upload path: EXIF rotate + resize (color preserved for Gemini metadata).
 * OCR path: grayscale + contrast + sharpen for Vision document text.
 */

const sharp = require('sharp');

/**
 * @param {Buffer} inputBuffer
 * @param {{ maxDimension?: number, quality?: number }} [options]
 * @returns {Promise<Buffer>}
 */
async function optimizeForUpload(inputBuffer, { maxDimension = 1500, quality = 85 } = {}) {
  try {
    return await sharp(inputBuffer)
      .rotate()
      .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    console.warn('[imagePreprocess] upload optimize failed, using original:', err.message);
    return inputBuffer;
  }
}

/**
 * Enhance text contrast for document OCR (Cloud Vision).
 * @param {Buffer} inputBuffer
 * @returns {Promise<Buffer>}
 */
async function enhanceForOcr(inputBuffer) {
  try {
    return await sharp(inputBuffer)
      .rotate()
      .greyscale()
      .normalize()
      .sharpen({ sigma: 1.0, m1: 0.5, m2: 0.5 })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    console.warn('[imagePreprocess] OCR enhance failed, using original:', err.message);
    return inputBuffer;
  }
}

module.exports = {
  optimizeForUpload,
  enhanceForOcr,
};
