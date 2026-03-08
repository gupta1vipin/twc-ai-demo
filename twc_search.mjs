import axios from 'axios';

const DEFAULT_BASE_URL = 'https://www.thewhitecompany.com';
const TWC_BASE_URL = (process.env.TWC_BASE_URL || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
const DEFAULT_SEARCH_URL = `${TWC_BASE_URL}/uk/search/async/search`;
const TWC_SEARCH_URL = (process.env.TWC_SEARCH_URL || DEFAULT_SEARCH_URL).trim() || DEFAULT_SEARCH_URL;

const TWC_DEBUG_LOG = /^(1|true|yes)$/i.test(String(process.env.TWC_DEBUG_LOG || ''));
const TWC_LOG_RAW_RESPONSE = /^(1|true|yes)$/i.test(String(process.env.TWC_LOG_RAW_RESPONSE || ''));
const TWC_LOG_RAW_MAX_CHARS = Math.max(1000, Math.min(200_000, Number(process.env.TWC_LOG_RAW_MAX_CHARS || 12000)));

const TWC_SEARCH_MODULE_VERSION = 'twc_search_mjs_2026-03-05_2';
if (TWC_DEBUG_LOG) {
  console.log('[DEBUG] Loaded', TWC_SEARCH_MODULE_VERSION);
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function resolveUrl(pathOrUrl) {
  const v = cleanText(pathOrUrl);
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  // Protocol-relative URL (e.g. //whitecompany.scene7.com/...)
  if (v.startsWith('//')) return `https:${v}`;
  if (v.startsWith('/')) return `${TWC_BASE_URL}${v}`;
  return v;
}

function pickImage(product) {
  const imagesNp = Array.isArray(product?.imagesNp) ? product.imagesNp : [];
  const primaryThumb = imagesNp.find(i => i?.imageType === 'PRIMARY' && (i?.format === 'thumbnail' || i?.format === 'groupThumb'));
  if (primaryThumb?.url) return resolveUrl(primaryThumb.url);

  const swatch0 = Array.isArray(product?.swatch) ? product.swatch[0] : null;
  if (swatch0?.imageUrl) return resolveUrl(swatch0.imageUrl);

  const pdp0 = Array.isArray(product?.pdpImageSet) ? product.pdpImageSet[0] : null;
  if (pdp0?.url) return resolveUrl(pdp0.url);

  return '';
}

function extractSkuFromText(value) {
  const v = cleanText(value);
  if (!v) return '';
  // Common formats:
  // - "A15239"
  // - "A15239 - The Perfect Organic Cotton Rib Side Shirt - Navy"
  // - sometimes includes hidden characters; don't anchor at start.
  const m = v.match(/([A-Za-z]\d{4,6})\b/);
  return m ? m[1] : '';
}

function extractSkuFromUrl(pathOrUrl) {
  const u = cleanText(pathOrUrl);
  if (!u) return '';
  // Works for URLs like: /Some-Product/p/A15239?swatch=Navy
  const m = u.match(/\/p\/([A-Za-z0-9_-]{2,})/);
  if (m && m[1]) return cleanText(m[1]);
  return '';
}

function normalizeResult(item) {
  const rawCode = cleanText(item?.code);
  const url = resolveUrl(item?.url || item?.searchResultProductUrl);
  const skuFromUrl = extractSkuFromUrl(url);
  const skuFromText = extractSkuFromText(rawCode);
  const skuFromBaseField = cleanText(item?.baseProductCode) || cleanText(item?.baseCode);

  // If code is a strict SKU token (no spaces/dashes), keep it (could be a variant SKU).
  const codeLooksStrict = /^[A-Za-z0-9]{2,24}$/.test(rawCode);
  const strictCode = codeLooksStrict ? rawCode : '';

  const baseCode = skuFromBaseField || skuFromUrl || skuFromText || strictCode;
  // Prefer strict code (variant SKU) when available; otherwise use base SKU.
  const code = strictCode || baseCode;
  const name = cleanText(item?.name || code);

  const stock = cleanText(item?.stock?.stockLevelStatus?.code);
  const price = cleanText(item?.price?.formattedValue);
  const currency = cleanText(item?.price?.currencyIso || item?.currentCurrency?.isocode);
  const averageRating = Number.isFinite(Number(item?.averageRating))
    ? Number(item.averageRating)
    : (Number.isFinite(Number(item?.commonAverageRating)) ? Number(item.commonAverageRating) : null);

  const image = pickImage(item);

  return {
    code,
    baseCode,
    name,
    url,
    stock,
    price,
    currency,
    averageRating,
    image
  };
}

function normalizeFacets(data) {
  const facets = Array.isArray(data?.facets) ? data.facets : [];
  return facets
    .filter(f => f && typeof f === 'object')
    .map(f => ({
      code: cleanText(f.code),
      name: cleanText(f.name),
      multiSelect: Boolean(f.multiSelect),
      values: (Array.isArray(f.values) ? f.values : []).map(v => ({
        code: cleanText(v?.code),
        name: cleanText(v?.name),
        count: Number.isFinite(Number(v?.count)) ? Number(v.count) : null
      })).filter(v => v.code && v.name)
    }))
    .filter(f => f.code);
}

function dedupeProducts(products) {
  const list = Array.isArray(products) ? products : [];
  const keyOf = (p) => {
    const key = cleanText(p?.baseCode || p?.code || p?.url);
    return key ? key.toLowerCase() : '';
  };

  const out = [];
  const indexByKey = new Map();
  for (const p of list) {
    const key = keyOf(p);
    if (!key) continue;

    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, out.length);
      out.push(p);
      continue;
    }

    // Merge: keep the first occurrence order, but fill in any missing fields.
    const existing = out[existingIndex];
    if (!existing) continue;
    out[existingIndex] = {
      ...p,
      ...existing,
      // Prefer non-empty strings from either side, leaning toward existing.
      code: cleanText(existing.code) || cleanText(p.code),
      baseCode: cleanText(existing.baseCode) || cleanText(p.baseCode),
      name: cleanText(existing.name) || cleanText(p.name),
      url: cleanText(existing.url) || cleanText(p.url),
      image: cleanText(existing.image) || cleanText(p.image),
      price: cleanText(existing.price) || cleanText(p.price),
      currency: cleanText(existing.currency) || cleanText(p.currency),
      stock: cleanText(existing.stock) || cleanText(p.stock),
      averageRating: (typeof existing.averageRating === 'number' && Number.isFinite(existing.averageRating))
        ? existing.averageRating
        : ((typeof p.averageRating === 'number' && Number.isFinite(p.averageRating)) ? p.averageRating : null)
    };
  }
  return out;
}

function buildFacetQ(text, filters = {}) {
  const base = cleanText(text);
  if (!base) return '';

  const sizeCodes = Array.isArray(filters.sizeCodes) ? filters.sizeCodes.map(cleanText).filter(Boolean) : [];
  const colourCodes = Array.isArray(filters.colourCodes) ? filters.colourCodes.map(cleanText).filter(Boolean) : [];

  const facetParts = [];
  if (sizeCodes.length) facetParts.push(`v_facet_size-sm:${sizeCodes.join(',')}`);
  if (colourCodes.length) facetParts.push(`v_facet_colour-sm:${colourCodes.join(',')}`);
  return facetParts.length ? `${base}::${facetParts.join(':')}` : '';
}

export async function searchProducts(query, { currentPage = 0, pageSize = 3, filters } = {}) {
  const text = cleanText(query);
  if (!text) return { products: [], facets: [], pagination: null, currency: null };

  const q = buildFacetQ(text, filters);
  const minPrice = (filters && Number.isFinite(Number(filters.minPrice))) ? Number(filters.minPrice) : undefined;
  const maxPrice = (filters && Number.isFinite(Number(filters.maxPrice))) ? Number(filters.maxPrice) : undefined;

  const params = {
    text,
    currentPage,
    pageSize,
    ...(q ? { q } : {}),
    ...(minPrice !== undefined ? { minPrice } : {}),
    ...(maxPrice !== undefined ? { maxPrice } : {}),
  };

  if (TWC_DEBUG_LOG) {
    console.log('[DEBUG] TWC search request', { url: TWC_SEARCH_URL, params });
  }

  let res;
  try {
    res = await axios.get(TWC_SEARCH_URL, {
      params,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': String(process.env.TWC_USER_AGENT || 'twc-ai-demo/1.0 (+node)').trim() || 'twc-ai-demo/1.0 (+node)'
      },
      timeout: 15000
    });
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    if (TWC_DEBUG_LOG) {
      console.log('[DEBUG] TWC search error', {
        url: TWC_SEARCH_URL,
        status,
        message: err?.message || String(err)
      });
      if (TWC_LOG_RAW_RESPONSE && data) {
        const raw = JSON.stringify(data);
        console.log('[DEBUG] TWC raw error response (truncated)', raw.slice(0, TWC_LOG_RAW_MAX_CHARS));
      }
    }
    throw err;
  }

  if (TWC_LOG_RAW_RESPONSE) {
    const raw = JSON.stringify(res.data);
    console.log('[DEBUG] TWC raw response (truncated)', raw.slice(0, TWC_LOG_RAW_MAX_CHARS));
  }

  const results = Array.isArray(res.data?.results) ? res.data.results : [];
  const products = dedupeProducts(results.map(normalizeResult).filter(p => p.code));
  const facets = normalizeFacets(res.data);
  const pagination = res.data?.pagination || null;
  const currency = res.data?.currentCurrency || null;

  return { products, facets, pagination, currency };
}
