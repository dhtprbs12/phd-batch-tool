const fs = require('fs');
const path = require('path');

/**
 * Decode barcode from an image file.
 * Strategy: zxing-wasm (native decode) → Gemini Vision (fallback OCR)
 */
async function decodeBarcode(filePath) {
  // Try zxing-wasm first (accurate pattern decoding)
  try {
    const result = await decodeWithZxing(filePath);
    if (result) {
      console.log(`📊 [Barcode] zxing decoded: ${result}`);
      return result;
    }
  } catch (e) {
    console.warn('⚠️ zxing decode failed, trying Gemini:', e.message);
  }

  // Fallback: Gemini Vision (reads printed numbers)
  return await decodeWithGemini(filePath);
}

async function decodeWithZxing(filePath) {
  const { readBarcodes } = await import('zxing-wasm/reader');
  const buffer = fs.readFileSync(filePath);
  const uint8 = new Uint8Array(buffer);

  const results = await readBarcodes(uint8, {
    formats: ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'Code128', 'Code39', 'ITF', 'QRCode'],
  });

  if (results && results.length > 0 && results[0].text) {
    return results[0].text.trim();
  }
  return null;
}

async function decodeWithGemini(filePath) {
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString('base64');
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const result = await model.generateContent([
    { inlineData: { mimeType, data: base64 } },
    {
      text: `This image contains a barcode (UPC, EAN, or other format). 
Read and return ONLY the numeric/alphanumeric code printed below or encoded in the barcode.
Return just the raw code string with no other text, no explanation, no formatting.
If you cannot read a barcode, return "UNREADABLE".`,
    },
  ]);

  const text = result.response.text().trim();
  if (!text || text === 'UNREADABLE' || text.length < 4) {
    throw new Error('Could not decode barcode');
  }

  console.log(`📊 [Barcode] Gemini read: ${text}`);
  return text.replace(/[\s\-]/g, '');
}

module.exports = { decodeBarcode };
