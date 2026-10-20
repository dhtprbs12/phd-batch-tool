const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const { query } = require('./services/connection');
const geminiService = require('./services/geminiService');
const { decodeBarcode } = require('./barcodeDecoder');

const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const BANNED_HOSTS = ['reddit.com', 'facebook.com', 'instagram.com', 'youtube.com', 'youtu.be', 'quora.com', 'tiktok.com', 'pinterest.com', 'x.com', 'twitter.com'];

function hostOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isBanned(raw) {
  const host = hostOf(raw);
  return BANNED_HOSTS.some((banned) => host === banned || host.endsWith(`.${banned}`));
}

function stripUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseModelJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model did not return JSON');
  return JSON.parse(body.slice(start, end + 1));
}

function ingredientLines(extracted) {
  if (!extracted || typeof extracted !== 'object') return [];
  const list = Array.isArray(extracted.ingredients) ? extracted.ingredients : [];
  const cleaned = list.map((item) => String(item || '').trim()).filter((item) => item && item.length < 80);
  const text = cleaned.join(' ').toLowerCase();
  const hits = text.match(/\b(reviews?|customers?|stars?|ratings?)\b/g) || [];
  if (hits.length >= 2) return [];
  return cleaned;
}

function searchPrompt({ brand, name, url }) {
  return `You look up one US pet food from pages that publish the label as text.
Return ONLY JSON, no markdown:
{
  "candidates": [{ "title": string, "brand": string, "url": string }],
  "extracted": null | {
    "brand": string,
    "productName": string,
    "ingredients": string[],
    "sourceUrl": string
  }
}
Rules:
- Read ingredients from ONE page. If they are not written as text on that page, extracted must be null.
- Never invent ingredients. Never mix two recipes. Never use reviews, Q&A, blogs, Reddit, or social posts.
- ingredients are short noun phrases in label order.
${url ? `- Read only this URL: ${url}` : `- Find pages for brand "${brand}" and product "${name}".`}
If several different recipes match, return up to 3 candidates and extracted null.
If one page clearly matches and has an ingredient list as text, fill extracted from that page only.`;
}

async function grounded(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1 },
      }),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Gemini search failed');
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text || '').join('\n');
}

async function findLabel({ brand, name, url }) {
  const first = parseModelJson(await grounded(searchPrompt({ brand, name, url })));
  const ingredients = ingredientLines(first.extracted);
  const candidates = (Array.isArray(first.candidates) ? first.candidates : [])
    .map((item) => {
      const page = stripUrl(item.url);
      if (!page || isBanned(page)) return null;
      return {
        title: String(item.title || item.brand || 'Product').slice(0, 180),
        brand: item.brand ? String(item.brand).slice(0, 120) : null,
        url: page,
        domain: hostOf(page),
      };
    })
    .filter(Boolean)
    .slice(0, 3);
  if (ingredients.length > 0) {
    return {
      extracted: {
        brand: first.extracted.brand ? String(first.extracted.brand).slice(0, 200) : brand || null,
        productName: first.extracted.productName || first.extracted.product_name || name || null,
        ingredients,
        sourceUrl: stripUrl(first.extracted.sourceUrl || first.extracted.source_url || url || '') || candidates[0]?.url || null,
      },
      candidates: [],
    };
  }
  return { extracted: null, candidates };
}

async function listRequests() {
  const rows = await query(
    `SELECT id, pet_name, pet_type, brand, query_name, entry, status, created_at
     FROM lookup_requests
     WHERE status IN ('queued', 'searching')
     ORDER BY created_at ASC`,
  );
  return rows.map((row) => ({
    id: row.id,
    petName: row.pet_name,
    petType: row.pet_type,
    brand: row.brand,
    queryName: row.query_name,
    entry: row.entry,
    status: row.status,
    createdAt: row.created_at,
  }));
}

async function loadRequest(id) {
  const [row] = await query('SELECT * FROM lookup_requests WHERE id = ?', [id]);
  if (!row) {
    const error = new Error('Request not found');
    error.status = 404;
    throw error;
  }
  if (!['queued', 'searching'].includes(row.status)) {
    const error = new Error('This request is no longer waiting');
    error.status = 409;
    throw error;
  }
  await query(`UPDATE lookup_requests SET status = 'searching' WHERE id = ?`, [id]);
  return row;
}

function slotsFromPhotos(frontResult, ingredientsResult) {
  const frontProteins = frontResult.primaryProteins || [];
  const ingredientProteins = ingredientsResult.primaryProteins || [];
  const primaryProteins = ingredientProteins.length ? ingredientProteins : frontProteins;
  const frontTags = frontResult.dietTags || [];
  const ingredientTags = ingredientsResult.dietTags || [];
  const grain = [...ingredientTags, ...frontTags].find((tag) => tag === 'grain_free' || tag === 'with_grains') || null;
  const limited = ingredientTags.includes('limited_ingredient') || frontTags.includes('limited_ingredient');
  const dietTags = [grain, limited ? 'limited_ingredient' : null].filter(Boolean);
  return { primaryProteins, dietTags };
}

function reviewBase(row) {
  return {
    id: uuidv4(),
    lookupId: row.id,
    entry: row.entry,
    status: 'pending_review',
    sourceUrl: row.pasted_url || null,
    images: { front: null, ingredients: null, barcode: null },
    extracted: {
      manufacturer: null,
      brand: row.brand || null,
      lineName: null,
      productName: row.query_name || null,
      lifeStage: 'all',
      primaryProteins: [],
      petType: row.pet_type === 'cat' ? 'cat' : 'dog',
      productType: 'dry_food',
      texture: null,
      breedSize: 'all',
      dietTags: [],
    },
    ingredients: [],
    rawIngredientsText: '',
    barcode: row.barcode || null,
    extraBarcodes: [],
    createdAt: new Date().toISOString(),
  };
}

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download a request photo (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function writeUpload(buffer, name) {
  const filePath = path.join(uploadsDir, `${Date.now()}-${name}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function openPhoto(row) {
  const review = reviewBase(row);
  review.images = {
    front: row.front_image_url || null,
    ingredients: row.ingredient_image_url || null,
    barcode: row.barcode_image_url || null,
  };
  if (!row.front_image_url || !row.ingredient_image_url) return review;

  let frontBuffer;
  let ingredientBuffer;
  try {
    frontBuffer = await downloadImage(row.front_image_url);
    ingredientBuffer = await downloadImage(row.ingredient_image_url);
  } catch (error) {
    review.warning = error.message;
    return review;
  }
  let frontResult;
  let ingredientsResult;
  try {
    frontResult = await geminiService.extractFromImage(frontBuffer, 'image/jpeg');
    ingredientsResult = await geminiService.extractFromImage(ingredientBuffer, 'image/jpeg');
  } catch (error) {
    review.warning = error.message;
    return review;
  }
  let barcodeValue = row.barcode || null;
  if (row.barcode_image_url) {
    try {
      const barcodeBuffer = await downloadImage(row.barcode_image_url);
      const barcodePath = writeUpload(barcodeBuffer, 'barcode.jpg');
      barcodeValue = (await decodeBarcode(barcodePath)) || barcodeValue;
    } catch (error) {
      console.warn('⚠️ Request barcode decode failed:', error.message);
    }
  }
  const ingredients = ingredientsResult.ingredientsList || [];
  review.extracted = {
    manufacturer: frontResult.manufacturer || null,
    brand: frontResult.brand || row.brand || null,
    lineName: frontResult.lineName || null,
    productName: frontResult.productName || row.query_name || null,
    lifeStage: frontResult.lifeStage || 'all',
    ...slotsFromPhotos(frontResult, ingredientsResult),
    petType: row.pet_type === 'cat' ? 'cat' : 'dog',
    productType: frontResult.productType || 'dry_food',
    texture: frontResult.texture || null,
    breedSize: frontResult.breedSize || 'all',
  };
  review.ingredients = ingredients;
  review.rawIngredientsText = ingredientsResult.rawIngredientsText || ingredients.join(', ');
  review.barcode = barcodeValue;
  return review;
}

async function openName(row, pageUrl) {
  const review = reviewBase(row);
  const url = pageUrl || row.pasted_url || null;
  let found;
  try {
    found = await findLabel({ brand: row.brand, name: row.query_name, url });
  } catch (error) {
    console.warn('⚠️ Name search failed:', error.message);
    review.warning = error.message;
    return { review };
  }
  if (!pageUrl && !found.extracted && found.candidates.length >= 2) {
    return { choose: true, candidates: found.candidates };
  }
  if (found.extracted) {
    review.extracted.brand = found.extracted.brand || row.brand || null;
    review.extracted.productName = found.extracted.productName || row.query_name || null;
    review.ingredients = found.extracted.ingredients;
    review.rawIngredientsText = found.extracted.ingredients.join(', ');
    review.sourceUrl = found.extracted.sourceUrl || url;
  }
  return { review };
}

async function openRequest(id, pageUrl) {
  const row = await loadRequest(id);
  if (row.entry === 'photo') return { review: await openPhoto(row) };
  return openName(row, pageUrl || null);
}

async function requeue(id) {
  await query(
    `UPDATE lookup_requests SET status = 'queued' WHERE id = ? AND status = 'searching'`,
    [id],
  );
}

async function sendExpoPush(token, body, data) {
  if (!token) return;
  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: token, title: 'PHD', body, data, sound: 'default' }),
  });
  if (!res.ok) console.warn('[Lookup] push failed:', res.status, (await res.text()).slice(0, 200));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function foodLabel(brand, name, fallback) {
  const brandText = String(brand || '').trim();
  const nameText = String(name || '').trim();
  if (brandText && nameText) {
    if (nameText.toLowerCase().startsWith(brandText.toLowerCase())) return nameText;
    return `${brandText} ${nameText}`;
  }
  return nameText || brandText || fallback;
}

function renderEmail({ headline, paragraphs }) {
  const footer = 'You received this email because you requested a product analysis in PHD.';
  const text = [headline, '', ...paragraphs, '', 'PHD', '', footer].join('\n');
  const body = paragraphs
    .map((paragraph) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#1c1c1c;">${escapeHtml(paragraph)}</p>`)
    .join('');
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f5f3;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f3;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e6e1;">
          <tr><td style="height:4px;background:#2D6A4F;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr>
            <td style="padding:28px 32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;letter-spacing:0.16em;font-weight:600;color:#2D6A4F;">PHD</td>
          </tr>
          <tr>
            <td style="padding:14px 32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:22px;line-height:1.35;font-weight:600;color:#14221b;">${escapeHtml(headline)}</td>
          </tr>
          <tr>
            <td style="padding:16px 32px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">${body}</td>
          </tr>
          <tr>
            <td style="padding:8px 32px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.4;color:#5c675f;">PHD</td>
          </tr>
        </table>
        <p style="max-width:560px;margin:14px auto 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#7a847c;">${escapeHtml(footer)}</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
  return { text, html };
}

async function sendEmail(to, message) {
  if (!to) return;
  const user = String(process.env.GMAIL_USER || '').trim();
  const pass = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !pass) {
    console.log(`[Lookup] email skipped (no Gmail config) to=${to} subject="${message.subject}"`);
    return;
  }
  try {
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass },
    });
    await transport.sendMail({
      from: `PHD <${user}>`,
      to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  } catch (error) {
    console.warn('[Lookup] email failed:', error.message);
  }
}

async function notify(row, notice) {
  const [fresh] = await query(
    'SELECT client_acked_at, notify_push, email_to, user_id FROM lookup_requests WHERE id = ?',
    [row.id],
  );
  if (!fresh || fresh.client_acked_at) return;
  if (fresh.notify_push) {
    const [user] = await query('SELECT expo_push_token FROM users WHERE id = ?', [fresh.user_id]);
    if (user?.expo_push_token) await sendExpoPush(user.expo_push_token, notice.push, { lookupId: row.id });
  }
  if (fresh.email_to) {
    const rendered = renderEmail({ headline: notice.headline, paragraphs: notice.paragraphs });
    await sendEmail(fresh.email_to, { subject: notice.subject, ...rendered });
  }
}

async function awardOnce(row, amount) {
  if (Number(row.tokens_awarded) > 0) return;
  await query(
    'INSERT INTO token_transactions (id, user_id, amount, type, reference_id, description) VALUES (?, ?, ?, ?, ?, ?)',
    [
      uuidv4(),
      row.user_id,
      amount,
      'product_register',
      row.id,
      amount === 20 ? 'Food photos analyzed 🦴×20' : 'Food lookup ready 🦴×10',
    ],
  );
  await query(
    'UPDATE user_tokens SET balance = balance + ?, total_earned = total_earned + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
    [amount, amount, row.user_id],
  );
  await query(
    'UPDATE lookup_requests SET tokens_awarded = ? WHERE id = ? AND tokens_awarded = 0',
    [amount, row.id],
  );
}

async function complete(id, productId, brand, productName) {
  const [row] = await query('SELECT * FROM lookup_requests WHERE id = ?', [id]);
  if (!row) {
    const error = new Error('Request not found');
    error.status = 404;
    throw error;
  }
  const alreadyFinished = row.status === 'ready' && row.product_id && Number(row.tokens_awarded) > 0;
  if (alreadyFinished) return;
  if (!(row.status === 'ready' && row.product_id)) {
    await query(
      `UPDATE lookup_requests
       SET status = 'ready', failure_reason = NULL, product_id = ?,
           brand = COALESCE(brand, ?), query_name = COALESCE(query_name, ?)
       WHERE id = ?`,
      [productId, brand || null, productName || null, id],
    );
  }
  const amount = row.entry === 'photo' ? 20 : 10;
  await awardOnce(row, amount);
  const petName = row.pet_name || 'your pet';
  const food = foodLabel(brand || row.brand, productName || row.query_name, 'this food');
  await notify(row, {
    push: `${petName}'s analysis for ${food} is ready.`,
    subject: `${petName}'s report is ready`,
    headline: `${petName}'s report is ready`,
    paragraphs: [
      `The analysis for ${food} is finished.`,
      'Open PHD and go to History → Analysis requests.',
    ],
  });
}

async function fail(id) {
  const [row] = await query('SELECT * FROM lookup_requests WHERE id = ?', [id]);
  if (!row) {
    const error = new Error('Request not found');
    error.status = 404;
    throw error;
  }
  if (row.status === 'failed' || row.status === 'ready') return;
  const reason = row.entry === 'photo' ? 'unreadable_photo' : 'no_label_text';
  await query(
    `UPDATE lookup_requests SET status = 'failed', failure_reason = ? WHERE id = ?`,
    [reason, id],
  );
  const food = foodLabel(row.brand, row.query_name, 'this food');
  const notice = reason === 'unreadable_photo'
    ? {
      push: "We couldn't read the ingredient panel. Photograph it again.",
      subject: 'Please photograph the ingredient panel again',
      headline: "We couldn't read the ingredient panel",
      paragraphs: [
        `The photos for ${food} didn't show a readable ingredient list.`,
        'Open PHD and send a new request with a clearer photo of the panel.',
      ],
    }
    : {
      push: `We couldn't find a published ingredient panel for ${food}. Check the spelling, or add a product page link.`,
      subject: `We couldn't find ${food}`,
      headline: "We couldn't find this product",
      paragraphs: [
        `We couldn't find a published ingredient panel for ${food}.`,
        'Check the spelling, or include a product page link when you send the request again.',
      ],
    };
  await notify(row, notice);
}

module.exports = { listRequests, openRequest, requeue, complete, fail };
