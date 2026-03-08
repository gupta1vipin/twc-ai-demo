import { createLoggedAxios } from './http_log.mjs';

const axios = createLoggedAxios('TWC_PDP');

const DEFAULT_BASE_URL = 'https://www.thewhitecompany.com';

function getTwcBaseUrl() {
  const base = String(process.env.TWC_BASE_URL || DEFAULT_BASE_URL).trim();
  return base || DEFAULT_BASE_URL;
}

function getProductUrlTemplate() {
  const base = getTwcBaseUrl();
  // Default matches the user's provided curl.
  const defaultTemplate = `${base}/TWCcommercewebservices/v2/twc-uk/products/{code}`;
  const tpl = String(process.env.TWC_PRODUCT_URL_TEMPLATE || defaultTemplate).trim();
  return tpl || defaultTemplate;
}

function buildUrl(code) {
  const c = String(code || '').trim();
  if (!c) throw new Error('Missing product code');
  return getProductUrlTemplate().replace('{code}', encodeURIComponent(c));
}

export async function getTwcProductDetails(code, { fields = 'FULL', referer, userAgent } = {}) {
  const url = buildUrl(code);
  const envUa = String(process.env.TWC_USER_AGENT || '').trim();
  const ua = String(userAgent || envUa || 'twc-ai-demo/1.0 (+node)').trim();
  const uaSafe = ua.length < 20
    ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    : ua;

  const envReferer = String(process.env.TWC_PRODUCT_REFERER || '').trim();
  const ref = String(referer || envReferer || '').trim();
  const res = await axios.get(url, {
    params: { fields },
    headers: {
      Accept: 'application/json',
      'User-Agent': uaSafe,
      'Accept-Language': 'en-GB,en;q=0.9',
      DNT: '1',
      ...(ref ? { Referer: ref } : {})
    },
    timeout: 15000
  });
  return res.data;
}

export function guessTwcBaseCode(value) {
  const t = String(value || '').trim();
  if (!t) return null;
  // Typical TWC base product codes look like: A17471 (sometimes users type spaces inside digits: "A14 888").
  const spaced = t.match(/\b([A-Z])\s*((?:\d\s*){4,6})\b/i);
  if (spaced && spaced[1] && spaced[2]) {
    const digits = String(spaced[2]).replace(/\s+/g, '');
    if (/^\d{4,6}$/.test(digits)) return `${spaced[1].toUpperCase()}${digits}`;
  }

  const m = t.match(/\b([A-Z])\s*(\d{4,6})\b/i);
  if (m && m[1] && m[2]) return `${m[1].toUpperCase()}${m[2]}`;

  // Common phrasing: "sku 17290" / "skua 17290". If no letter prefix is provided, assume "A".
  const sku = t.match(/\bsku[a]?\s*[:#-]?\s*([A-Z]?)(\d{4,6})\b/i);
  if (sku && sku[2]) {
    const prefix = sku[1] ? sku[1].toUpperCase() : 'A';
    return `${prefix}${sku[2]}`;
  }

  // Bare 4-6 digits can also be used informally; assume A-prefix.
  const digits = t.match(/\b(\d{4,6})\b/);
  if (digits && digits[1]) return `A${digits[1]}`;
  return null;
}
