/**
 * Google Cloud Vision — document OCR for label photos.
 * Uses API key auth (GOOGLE_CLOUD_VISION_API_KEY).
 */

const imagePreprocess = require('./imagePreprocessService');

class VisionService {
  isConfigured() {
    return Boolean(String(process.env.GOOGLE_CLOUD_VISION_API_KEY || '').trim());
  }

  /**
   * @param {Buffer} imageBuffer
   * @returns {Promise<string>} Full document text in reading order
   */
  async detectDocumentText(imageBuffer) {
    const apiKey = String(process.env.GOOGLE_CLOUD_VISION_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error('GOOGLE_CLOUD_VISION_API_KEY not set');
    }

    const ocrBuffer = await imagePreprocess.enhanceForOcr(imageBuffer);

    const url = `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            image: { content: ocrBuffer.toString('base64') },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
          },
        ],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Vision API HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const data = await res.json();
    const response = data.responses?.[0];
    if (!response) {
      throw new Error('Vision API: empty response');
    }
    if (response.error?.message) {
      throw new Error(`Vision API: ${response.error.message}`);
    }

    const docText = response.fullTextAnnotation?.text?.trim();
    if (docText) return docText;

    const fallback = response.textAnnotations?.[0]?.description?.trim();
    if (fallback) return fallback;

    throw new Error('Vision API: no text detected');
  }
}

module.exports = new VisionService();
