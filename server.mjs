
import express from 'express';
import { GoogleGenAI } from "@google/genai";
import dotenv from 'dotenv';
import { z } from 'zod';
import crypto from 'crypto';
import axios from 'axios';
import { createCart, addToCart, getCart, checkSapOAuthAndOcc } from './bridge_logic.mjs';
import { searchProducts as searchTwcProducts } from './twc_search.mjs';
import { getTwcProductDetails, guessTwcBaseCode } from './twc_product.mjs';
import { serperSearch, formatSerperTopResults } from './serper_search.mjs';

dotenv.config();
console.log("[DEBUG] GEMINI_API_KEY:", process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET');
console.log("[DEBUG] GENAI_MODEL:", process.env.GENAI_MODEL);
const app = express();
app.disable('etag');
app.use(express.json());
app.use(express.static('public', {
    maxAge: 0,
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

const geminiApiKey = (process.env.GEMINI_API_KEY || '').trim();
const genAI = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;
const modelName = process.env.GENAI_MODEL || "gemini-2.5-flash-lite";
console.log("[DEBUG] Using Gemini model:", modelName);

const serperApiKey = (process.env.SERPER_API_KEY || '').trim();
const serperUrl = (process.env.SERPER_URL || 'https://google.serper.dev/search').trim();
console.log('[DEBUG] SERPER_API_KEY:', serperApiKey ? 'SET' : 'NOT SET');

// Demo-only session store (in-memory; resets on server restart)
const sessions = new Map();
const SID_COOKIE = 'twc_ai_demo_sid';

// Optional: enable a live TWC bag/cart add-to-cart call (server-side proxy).
// This often requires a valid browser session cookie string due to bot protection.
const TWC_REAL_CART_ENABLED = !/^(0|false|no)$/i.test(String(process.env.TWC_REAL_CART_ENABLED ?? 'false'));
const TWC_REAL_CART_STRICT = !/^(0|false|no)$/i.test(String(
    process.env.TWC_REAL_CART_STRICT ?? (TWC_REAL_CART_ENABLED ? 'true' : 'false')
));
const TWC_BASE_URL = String(process.env.TWC_BASE_URL || 'https://www.thewhitecompany.com').trim();
const TWC_BAG_URL = String(process.env.TWC_BAG_URL || 'https://www.thewhitecompany.com/uk/bag').trim();
const TWC_CART_ENTRIES_URL = String(process.env.TWC_CART_ENTRIES_URL || `${TWC_BASE_URL.replace(/\/$/, '')}/uk/cart/entries`).trim();
const TWC_BAG_UNIVERSAL_VARIABLE_URL = String(process.env.TWC_BAG_UNIVERSAL_VARIABLE_URL || `${TWC_BASE_URL.replace(/\/$/, '')}/uk/api/common/universalVariable.json`).trim();
// If set, this cookie header overrides the in-memory cookie jar.
const TWC_CART_COOKIE = String(process.env.TWC_CART_COOKIE || '').trim();

function resolveTwcUrl(urlOrPath) {
    const u = String(urlOrPath || '').trim();
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    // Protocol-relative URL (common for CDN/Scene7 images)
    if (u.startsWith('//')) return `https:${u}`;
    if (u.startsWith('/')) return `${TWC_BASE_URL.replace(/\/$/, '')}${u}`;
    return u;
}

function mergeSetCookieIntoJar(jar, setCookieHeader) {
    const next = (jar && typeof jar === 'object') ? jar : {};
    const arr = Array.isArray(setCookieHeader)
        ? setCookieHeader
        : (setCookieHeader ? [setCookieHeader] : []);
    for (const raw of arr) {
        const first = String(raw || '').split(';')[0];
        const idx = first.indexOf('=');
        if (idx <= 0) continue;
        const name = first.slice(0, idx).trim();
        const value = first.slice(idx + 1).trim();
        if (!name) continue;
        next[name] = value;
    }
    return next;
}

function jarToCookieHeader(jar) {
    const obj = (jar && typeof jar === 'object') ? jar : {};
    return Object.entries(obj)
        .filter(([k, v]) => k && typeof v === 'string')
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

function toMiniCartPayload(data, fallbackProductUrl) {
    const entry = data?.entry || null;
    const product = entry?.product || null;
    const image = Array.isArray(product?.images) ? product.images[0] : null;

    return {
        cartGuid: String(data?.cartGuid || '').trim() || null,
        quantityAdded: (typeof data?.quantityAdded === 'number' ? data.quantityAdded : null),
        entryNumber: (typeof entry?.entryNumber === 'number' ? entry.entryNumber : null),
        quantityInCart: (typeof entry?.quantity === 'number' ? entry.quantity : null),
        basePrice: {
            formattedValue: String(entry?.basePrice?.formattedValue || '').trim() || null,
            currencyIso: String(entry?.basePrice?.currencyIso || '').trim() || null,
            currencySymbol: String(entry?.basePrice?.currencySymbol || '').trim() || null
        },
        totalPrice: {
            formattedValue: String(entry?.totalPrice?.formattedValue || '').trim() || null
        },
        product: {
            code: String(product?.code || '').trim() || null,
            name: String(product?.name || '').trim() || null,
            url: resolveTwcUrl(product?.url || fallbackProductUrl || ''),
            image: resolveTwcUrl(image?.url || ''),
            color: String(product?.color || '').trim() || null,
            size: String(product?.size || '').trim() || null
        },
        bagUrl: TWC_BAG_URL
    };
}

function getDeep(obj, path) {
    const parts = String(path || '').split('.').filter(Boolean);
    let cur = obj;
    for (const p of parts) {
        if (!cur || typeof cur !== 'object') return undefined;
        cur = cur[p];
    }
    return cur;
}

function firstNonEmptyString(...vals) {
    for (const v of vals) {
        const s = String(v ?? '').trim();
        if (s) return s;
    }
    return null;
}

function firstObjectAtPaths(obj, paths) {
    for (const p of paths) {
        const v = getDeep(obj, p);
        if (v && typeof v === 'object') return v;
    }
    return null;
}

function firstArrayAtPaths(obj, paths) {
    for (const p of paths) {
        const v = getDeep(obj, p);
        if (Array.isArray(v)) return v;
    }
    return null;
}

function normalizeMoney(maybe) {
    if (!maybe) return { formattedValue: null, value: null, currencyIso: null };
    if (typeof maybe === 'string') return { formattedValue: maybe.trim() || null, value: null, currencyIso: null };
    const formattedValue = firstNonEmptyString(maybe.formattedValue, maybe.formatted, maybe.display);
    const currencyIso = firstNonEmptyString(maybe.currencyIso, maybe.currency, maybe.currencyCode, maybe.iso);
    const value = Number.isFinite(Number(maybe.value)) ? Number(maybe.value) : (Number.isFinite(Number(maybe.amount)) ? Number(maybe.amount) : null);
    return { formattedValue, value, currencyIso };
}

function formatCurrency(value, currency) {
    const v = Number(value);
    const cur = String(currency || '').trim();
    if (!Number.isFinite(v)) return null;
    if (!cur) return String(v);
    try {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(v);
    } catch {
        return `${v} ${cur}`;
    }
}

function moneyFromNumber(value, currency) {
    const v = Number(value);
    const cur = String(currency || '').trim() || null;
    return {
        value: Number.isFinite(v) ? v : null,
        currencyIso: cur,
        formattedValue: Number.isFinite(v) ? (formatCurrency(v, cur) || String(v)) : null
    };
}

function normalizeTwcBagSummary(raw, { fallbackCartGuid } = {}) {
    const data = raw && typeof raw === 'object' ? raw : {};

    // Primary known schema (example provided by user):
    // { basket: { id, currency, subtotal, tax, total, line_items:[{quantity, subtotal, product:{...}}] }, user:{ cartId, cartGuid } }
    const basket = (data?.basket && typeof data.basket === 'object') ? data.basket : null;
    if (basket) {
        const currency = firstNonEmptyString(basket.currency, data?.user?.currency, data?.currency) || null;
        const cartGuid = firstNonEmptyString(data?.user?.cartGuid, data?.user?.cartGUID, fallbackCartGuid) || null;
        const cartId = firstNonEmptyString(data?.user?.cartId, basket.id, data?.user?.cartID) || null;

        const subtotal = moneyFromNumber(basket.subtotal, currency);
        const tax = moneyFromNumber(basket.tax, currency);
        const total = moneyFromNumber(basket.total, currency);

        const rawItems = Array.isArray(basket.line_items) ? basket.line_items : [];
        const items = rawItems.map(li => {
            const qty = Number.isFinite(Number(li?.quantity)) ? Number(li.quantity) : null;
            const lineTotal = moneyFromNumber(li?.subtotal, currency);
            const p = (li?.product && typeof li.product === 'object') ? li.product : {};
            const unitPrice = moneyFromNumber(p?.unit_sale_price ?? p?.unit_price, currency);
            const image = resolveTwcUrl(p?.imageUrl || p?.image_url || '');
            const url = resolveTwcUrl(p?.url || '');

            return {
                code: firstNonEmptyString(p?.id, p?.sku, p?.sku_code, p?.code) || null,
                baseCode: firstNonEmptyString(p?.sku_code, p?.baseCode) || null,
                name: firstNonEmptyString(p?.name, p?.title) || null,
                quantity: qty,
                unitPrice,
                lineTotal,
                color: firstNonEmptyString(p?.color) || null,
                size: firstNonEmptyString(p?.size) || null,
                image,
                url
            };
        }).filter(it => it.code || it.name);

        return {
            cartGuid,
            cartId,
            currency,
            subtotal,
            tax,
            totalPrice: total,
            items
        };
    }

    // Try a few likely shapes.
    const basketObj = firstObjectAtPaths(data, [
        'basket',
        'cart',
        'data.basket',
        'data.cart',
        'page.basket',
        'universalVariable.basket',
        'universalVariable.cart'
    ]) || data;

    const cartGuid = firstNonEmptyString(
        basketObj?.cartGuid,
        basketObj?.guid,
        basketObj?.code,
        basketObj?.id,
        data?.user?.cartGuid,
        data?.user?.cartGUID,
        data?.cartGuid,
        data?.guid,
        fallbackCartGuid
    );

    const cartId = firstNonEmptyString(
        basketObj?.id,
        basketObj?.code,
        data?.user?.cartId,
        data?.user?.cartID
    );

    const currency = firstNonEmptyString(
        basketObj?.currency,
        basketObj?.currency?.isocode,
        basketObj?.currencyIso,
        data?.currentCurrency?.isocode,
        data?.currency?.isocode,
        data?.user?.currency
    );

    const totalPrice = normalizeMoney(firstObjectAtPaths(basketObj, ['totalPrice', 'totals.total', 'totals.grandTotal', 'total', 'grandTotal']) || null);
    const tax = normalizeMoney(firstObjectAtPaths(basketObj, ['totalTax', 'tax', 'totals.tax', 'taxTotal']) || null);
    const subtotal = normalizeMoney(firstObjectAtPaths(basketObj, ['subtotal', 'subTotal', 'totals.subtotal', 'totals.subTotal']) || null);

    const items = firstArrayAtPaths(basketObj, ['line_items', 'items', 'entries', 'lineItems', 'products']) || [];
    const lineItems = items.map((it) => {
        const productObj = it?.product || it?.item || it;
        const code = firstNonEmptyString(productObj?.code, it?.code, it?.sku);
        const name = firstNonEmptyString(productObj?.name, it?.name, productObj?.title);
        const qty = Number.isFinite(Number(it?.quantity)) ? Number(it.quantity) : (Number.isFinite(Number(it?.qty)) ? Number(it.qty) : null);
        const lineTotal = normalizeMoney(firstObjectAtPaths(it, ['totalPrice', 'lineTotal', 'total', 'totalValue']) || null);
        const unitPrice = normalizeMoney(firstObjectAtPaths(it, ['basePrice', 'unitPrice', 'price', 'unit']) || null);
        return {
            code: code || null,
            name: name || null,
            quantity: qty,
            unitPrice,
            lineTotal
        };
    }).filter(li => li.code || li.name);

    return {
        cartGuid: cartGuid || null,
        cartId: cartId || null,
        currency: currency || totalPrice.currencyIso || tax.currencyIso || null,
        subtotal: subtotal.formattedValue ? subtotal : { ...subtotal, currencyIso: currency || subtotal.currencyIso || null },
        totalPrice: totalPrice.formattedValue ? totalPrice : { ...totalPrice, currencyIso: currency || totalPrice.currencyIso || null },
        tax: tax.formattedValue ? tax : { ...tax, currencyIso: currency || tax.currencyIso || null },
        items: lineItems
    };
}

async function fetchTwcBagSummaryForSession({ session, refererUrl } = {}) {
    if (!session) throw new Error('Missing session');
    session.twcCart = (session.twcCart && typeof session.twcCart === 'object') ? session.twcCart : { cookies: {}, cartGuid: null };
    session.twcCart.cookies = (session.twcCart.cookies && typeof session.twcCart.cookies === 'object') ? session.twcCart.cookies : {};

    const ua = String(process.env.TWC_USER_AGENT || 'Mozilla/5.0').trim();
    const referer = resolveTwcUrl(refererUrl || TWC_BAG_URL);

    const makeUrl = () => {
        try {
            const u = new URL(TWC_BAG_UNIVERSAL_VARIABLE_URL);
            u.searchParams.set('url', '/uk/bag');
            return u.toString();
        } catch {
            return TWC_BAG_UNIVERSAL_VARIABLE_URL.includes('?')
                ? `${TWC_BAG_UNIVERSAL_VARIABLE_URL}&url=%2Fuk%2Fbag`
                : `${TWC_BAG_UNIVERSAL_VARIABLE_URL}?url=%2Fuk%2Fbag`;
        }
    };

    const doGet = async (cookie) => {
        return await axios.get(makeUrl(), {
            headers: {
                accept: 'application/json, text/plain, */*',
                'user-agent': ua,
                ...(referer ? { referer } : {}),
                ...(cookie ? { Cookie: cookie } : {})
            },
            validateStatus: () => true,
            timeout: 20000
        });
    };

    const updateJarFromResponse = (response) => {
        if (TWC_CART_COOKIE) return;
        session.twcCart.cookies = mergeSetCookieIntoJar(session.twcCart.cookies, response?.headers?.['set-cookie']);
    };

    const cookieHeaderInitial = TWC_CART_COOKIE || jarToCookieHeader(session.twcCart.cookies);

    let res = await doGet(cookieHeaderInitial);
    updateJarFromResponse(res);

    const looksBlocked = [401, 403, 412].includes(res.status);
    if (!TWC_CART_COOKIE && !cookieHeaderInitial && looksBlocked) {
        const seedUrl = referer || `${TWC_BASE_URL.replace(/\/$/, '')}/uk`;
        const seedRes = await axios.get(seedUrl, {
            headers: {
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'user-agent': ua,
                ...(referer ? { referer } : {})
            },
            validateStatus: () => true,
            timeout: 20000
        });
        session.twcCart.cookies = mergeSetCookieIntoJar(session.twcCart.cookies, seedRes.headers?.['set-cookie']);
        const cookieHeaderRetry = jarToCookieHeader(session.twcCart.cookies);
        res = await doGet(cookieHeaderRetry);
        updateJarFromResponse(res);
    }

    const ok = res.status >= 200 && res.status < 300;
    if (!ok) {
        const msg = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {}).slice(0, 800);
        const err = new Error(`TWC bag summary failed (${res.status})`);
        err.status = res.status;
        err.details = msg;
        throw err;
    }

    const summary = normalizeTwcBagSummary(res.data, { fallbackCartGuid: session.twcCart.cartGuid || null });
    if (summary?.cartGuid) session.twcCart.cartGuid = summary.cartGuid;
    session.lastTwcBagSummary = { at: new Date().toISOString(), summary };
    return { summary, raw: res.data };
}

function isLikelyTwcBaseCode(code) {
    const c = String(code || '').trim();
    return /^[A-Za-z]\d{4,6}$/.test(c) || /^\d{4,6}$/.test(c);
}

function normalizeTwcVariantOptionsFromDetails(details) {
    const swatches = Array.isArray(details?.swatches) ? details.swatches : [];
    const out = [];
    for (const sw of swatches) {
        const swatchName = String(sw?.name || '').trim();
        const swatchUrl = resolveTwcUrl(sw?.url || details?.url || '');
        const swatchImage = resolveTwcUrl(sw?.squareImage?.url || sw?.image?.url || '');
        const opts = Array.isArray(sw?.variantOptions) ? sw.variantOptions : [];
        const variants = opts
            .map(v => ({
                code: String(v?.code || '').trim(),
                size: String(v?.size || '').trim(),
                inStock: String(v?.stock?.stockLevelStatus || '').toLowerCase().includes('instock') || String(v?.stock?.stockLevelStatus || '').toLowerCase() === 'instock',
                stockStatus: String(v?.stock?.stockLevelStatus || '').trim() || null,
                price: String(v?.priceData?.formattedValue || '').trim() || null,
                currency: String(v?.priceData?.currencyIso || '').trim() || null
            }))
            .filter(v => v.code && v.size);

        if (!swatchName || !variants.length) continue;
        out.push({
            name: swatchName,
            url: swatchUrl,
            image: swatchImage,
            variants
        });
    }
    return out;
}

async function getTwcDetailsForVariantPicker(baseCode, { refererUrl } = {}) {
    const base = String(baseCode || '').trim();
    if (!base) return null;

    // Try without referer first (often works), then retry with provided referer, then retry with a generic search referer.
    try {
        return await getTwcProductDetails(base, { fields: 'FULL' });
    } catch {
        // ignore
    }

    const ref = String(refererUrl || '').trim();
    if (ref) {
        try {
            return await getTwcProductDetails(base, { fields: 'FULL', referer: ref });
        } catch {
            // ignore
        }
    }

    const twcBaseUrl = String(process.env.TWC_BASE_URL || 'https://www.thewhitecompany.com').trim() || 'https://www.thewhitecompany.com';
    try {
        return await getTwcProductDetails(base, { fields: 'FULL', referer: `${twcBaseUrl}/uk/search?q=${encodeURIComponent(base)}` });
    } catch (err) {
        const status = err?.response?.status || err?.status || null;
        const details = err?.response?.data || err?.details || err?.message || null;
        const e = new Error('TWC product details request failed');
        e.status = status;
        e.details = details;
        throw e;
    }
}

async function twcAddToCartForSession({ session, sku, qty, refererUrl }) {
    if (!session) throw new Error('Missing session');
    const productCodePost = String(sku || '').trim();
    if (!productCodePost) throw new Error('Missing sku');
    const quantity = Number.isFinite(Number(qty)) ? Math.max(1, Math.min(99, Number(qty))) : 1;
    const referer = resolveTwcUrl(refererUrl || '');

    session.twcCart = (session.twcCart && typeof session.twcCart === 'object') ? session.twcCart : { cookies: {}, cartGuid: null };
    session.twcCart.cookies = (session.twcCart.cookies && typeof session.twcCart.cookies === 'object') ? session.twcCart.cookies : {};

    const ua = String(process.env.TWC_USER_AGENT || 'Mozilla/5.0').trim();
    const doPost = async (cookie) => {
        const headers = {
            accept: 'application/json',
            'content-type': 'application/json',
            origin: TWC_BASE_URL,
            'user-agent': ua,
            ...(referer ? { referer } : {}),
            ...(cookie ? { Cookie: cookie } : {})
        };
        return await axios.post(
            TWC_CART_ENTRIES_URL,
            { productCodePost, quantity: String(quantity) },
            {
                headers,
                validateStatus: () => true,
                timeout: 20000
            }
        );
    };

    const updateJarFromResponse = (response) => {
        if (TWC_CART_COOKIE) return;
        session.twcCart.cookies = mergeSetCookieIntoJar(session.twcCart.cookies, response?.headers?.['set-cookie']);
    };

    const cookieHeaderInitial = TWC_CART_COOKIE || jarToCookieHeader(session.twcCart.cookies);

    // First attempt: match the Postman/curl-style request (cookie-less if none are present).
    let res = await doPost(cookieHeaderInitial);
    updateJarFromResponse(res);

    // If blocked and we weren't given cookies, try a one-time seed GET then retry.
    const looksBlocked = [401, 403, 412].includes(res.status);
    if (!TWC_CART_COOKIE && !cookieHeaderInitial && looksBlocked) {
        const seedUrl = referer || `${TWC_BASE_URL.replace(/\/$/, '')}/uk`;
        const seedRes = await axios.get(seedUrl, {
            headers: {
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'user-agent': ua,
                ...(referer ? { referer } : {})
            },
            validateStatus: () => true,
            timeout: 20000
        });
        session.twcCart.cookies = mergeSetCookieIntoJar(session.twcCart.cookies, seedRes.headers?.['set-cookie']);
        const cookieHeaderRetry = jarToCookieHeader(session.twcCart.cookies);
        res = await doPost(cookieHeaderRetry);
        updateJarFromResponse(res);
    }

    const ok = res.status >= 200 && res.status < 300;
    if (!ok) {
        const msg = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {}).slice(0, 800);
        const err = new Error(`TWC cart add failed (${res.status})`);
        err.status = res.status;
        err.details = msg;
        throw err;
    }

    const miniCart = toMiniCartPayload(res.data, referer);
    if (miniCart?.cartGuid) session.twcCart.cartGuid = miniCart.cartGuid;
    session.lastTwcCartAdd = { sku: productCodePost, qty: quantity, at: new Date().toISOString(), cartGuid: miniCart?.cartGuid || null };
    return { miniCart, raw: res.data };
}

function parseCookies(header) {
    const out = {};
    const h = header || '';
    h.split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx === -1) return;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (!k) return;
        out[k] = decodeURIComponent(v);
    });
    return out;
}

function getSession(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    let sid = cookies[SID_COOKIE];
    if (!sid || typeof sid !== 'string' || sid.length < 8) {
        sid = crypto.randomUUID();
        // Minimal cookie settings for demo (same-origin)
        res.setHeader('Set-Cookie', `${SID_COOKIE}=${encodeURIComponent(sid)}; Path=/; SameSite=Lax`);
    }
    if (!sessions.has(sid)) {
        sessions.set(sid, {
            cart: null, // { guid, code }
            lastQuery: null,
            lastPage: 0,
            lastProducts: null, // [{code,name,price,stock,image}]
            lastFacets: null, // [{code,name,multiSelect,values:[{code,name,count}]}]
            lastFilters: null, // { sizeCodes, colourCodes, minPrice, maxPrice }
            lastPagination: null,
            lastRevealCount: 0,
            lastCartAdd: null,
            localCart: [],
            lastProductSummary: null,
            // TWC bag/cart (optional live add-to-cart)
            twcCart: { cookies: {}, cartGuid: null },
            lastTwcCartAdd: null
        });
    }
    return sessions.get(sid);
}

function parsePriceFromText(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return null;
    const between = t.match(/\bbetween\s+(\d+(?:\.\d+)?)\s+(?:and|to)\s+(\d+(?:\.\d+)?)\b/);
    if (between) return { minPrice: Number(between[1]), maxPrice: Number(between[2]) };
    const under = t.match(/\b(?:under|below|max)\s*[£$]?\s*(\d+(?:\.\d+)?)\b/);
    if (under) return { maxPrice: Number(under[1]) };
    const over = t.match(/\b(?:over|above|min)\s*[£$]?\s*(\d+(?:\.\d+)?)\b/);
    if (over) return { minPrice: Number(over[1]) };
    return null;
}

function extractFacetSelectionsFromText(text, facets) {
    const t = String(text || '').toLowerCase();
    if (!t) return null;
    if (!Array.isArray(facets) || !facets.length) return null;

    const selected = { sizeCodes: [], colourCodes: [] };
    const add = (key, code) => {
        if (!code) return;
        if (!selected[key].includes(code)) selected[key].push(code);
    };

    for (const facet of facets) {
        const code = facet?.code;
        const values = Array.isArray(facet?.values) ? facet.values : [];
        for (const v of values) {
            const name = String(v?.name || '').toLowerCase().trim();
            if (!name) continue;
            // Match full words when possible; fallback to substring.
            const wordRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i');
            const matched = wordRe.test(t) || t.includes(name);
            if (!matched) continue;
            if (code === 'v_facet_size-sm') add('sizeCodes', v.code);
            if (code === 'v_facet_colour-sm') add('colourCodes', v.code);
        }
    }

    const hasAny = selected.sizeCodes.length || selected.colourCodes.length;
    return hasAny ? selected : null;
}

// Background SAP connectivity check (OAuth + OCC ping). No Gemini usage.
let sapHealth = { ok: null, checkedAt: null };
async function refreshSapHealth() {
    sapHealth = await checkSapOAuthAndOcc();
    const status = sapHealth.ok ? 'OK' : 'FAIL';
    console.log(`[DEBUG] SAP health: ${status} @ ${sapHealth.checkedAt}`);
    if (!sapHealth.ok) {
        console.log('[DEBUG] SAP health error:', sapHealth.error);
    }
}
refreshSapHealth();
setInterval(refreshSapHealth, 15 * 60 * 1000);

app.get('/health/sap', (req, res) => {
    res.json(sapHealth);
});

app.post('/cart/add', async (req, res) => {
    const session = getSession(req, res);
    const { sku, qty } = req.body || {};
    if (!sku || typeof sku !== 'string') {
        return res.status(400).json({ ok: false, error: 'Missing sku' });
    }
    const quantity = Number.isFinite(Number(qty)) ? Number(qty) : 1;
    try {
        if (!session.cart?.guid && !session.cart?.code) {
            session.cart = await createCart();
        }
        await addToCart(sku, quantity, session.cart);
        session.lastCartAdd = { sku, qty: quantity, at: new Date().toISOString() };
        res.json({ ok: true, sku, qty: quantity, cart: session.cart });
    } catch (err) {
        const status = err?.response?.status;
        const details = err?.response?.data;
        res.status(500).json({
            ok: false,
            error: err?.message || String(err),
            status,
            details
        });
    }
});

// Debug/diagnostic: fetch raw SAP OCC cart JSON for the current session.
// This is real-time (calls OCC on each request). Useful for validating URL/fields.
app.get('/cart/sap', async (req, res) => {
    const session = getSession(req, res);
    if (!session.cart?.guid && !session.cart?.code) {
        return res.status(400).json({ ok: false, error: 'No SAP cart in this session yet. Add an SAP item first.' });
    }
    try {
        const cart = await getCart(session.cart);
        res.json({ ok: true, cart });
    } catch (err) {
        const status = err?.response?.status;
        const details = err?.response?.data;
        res.status(500).json({
            ok: false,
            error: err?.message || String(err),
            status,
            details
        });
    }
});

// Local demo cart for non-SAP products (e.g., The White Company search results)
app.post('/cart/local/add', (req, res) => {
    const session = getSession(req, res);
    const p = req.body?.product || req.body || {};
    const code = String(p.code || '').trim();
    if (!code) return res.status(400).json({ ok: false, error: 'Missing product code' });
    const item = {
        code,
        name: String(p.name || '').trim(),
        price: String(p.price || '').trim(),
        currency: String(p.currency || '').trim(),
        url: String(p.url || '').trim(),
        image: String(p.image || '').trim(),
        addedAt: new Date().toISOString()
    };
    session.localCart = Array.isArray(session.localCart) ? session.localCart : [];
    session.localCart.push(item);
    res.json({ ok: true, item, count: session.localCart.length });
});

// Optional: Live TWC bag/cart add-to-cart proxy.
// Enable by setting TWC_REAL_CART_ENABLED=true.
// Strongly recommended to also set TWC_CART_COOKIE to a valid browser session cookie string,
// otherwise bot protection may block server-side calls.
app.post('/cart/twc/add', async (req, res) => {
    const session = getSession(req, res);
    if (!TWC_REAL_CART_ENABLED) {
        return res.status(501).json({ ok: false, error: 'TWC real cart is disabled. Set TWC_REAL_CART_ENABLED=true and restart.' });
    }

    const sku = String(req.body?.sku || req.body?.productCodePost || '').trim();
    const qty = Number.isFinite(Number(req.body?.qty)) ? Number(req.body.qty) : 1;
    const refererUrl = String(req.body?.referer || req.body?.url || '').trim();
    if (!sku) return res.status(400).json({ ok: false, error: 'Missing sku' });

    // Base SKUs (e.g. A15239) are not addable; TWC requires a variant SKU (e.g. A15239008AAB).
    // The chat endpoint can return a variant picker for base codes.
    if (isLikelyTwcBaseCode(sku)) {
        return res.status(400).json({
            ok: false,
            error: `Base SKU "${sku}" cannot be added directly. Choose a size/colour variant first (try typing: add ${sku}).`
        });
    }

    try {
        const { miniCart } = await twcAddToCartForSession({ session, sku, qty, refererUrl });
        let cartSummary = null;
        try {
            const bag = await fetchTwcBagSummaryForSession({ session, refererUrl: refererUrl || TWC_BAG_URL });
            cartSummary = bag?.summary || null;
        } catch (err) {
            if (TWC_REAL_CART_STRICT) {
                // If strict, surface bag summary failures to help debugging.
                cartSummary = null;
            }
        }

        return res.json({ ok: true, miniCart, cartSummary });
    } catch (err) {
        return res.status(502).json({
            ok: false,
            error: err?.message || String(err),
            status: err?.status || null,
            details: err?.details || null
        });
    }
});

// Live TWC bag summary proxy for the current server session.
app.get('/cart/twc/summary', async (req, res) => {
    const session = getSession(req, res);
    if (!TWC_REAL_CART_ENABLED) {
        return res.status(501).json({ ok: false, error: 'TWC real cart is disabled. Set TWC_REAL_CART_ENABLED=true and restart.' });
    }
    try {
        const { summary } = await fetchTwcBagSummaryForSession({ session, refererUrl: TWC_BAG_URL });
        return res.json({ ok: true, cartSummary: summary });
    } catch (err) {
        return res.status(502).json({
            ok: false,
            error: err?.message || String(err),
            status: err?.status || null,
            details: err?.details || null
        });
    }
});

app.post('/chat', async (req, res) => {
    const { message } = req.body;
    try {
        const session = getSession(req, res);
        const rawMessage = typeof message === 'string' ? message : '';
        const userMessage = rawMessage.trim();

        const PREFETCH_PAGE_SIZE = 12;

        const TWC_SEARCH_AI_OVERVIEW = !/^(0|false|no)$/i.test(String(process.env.TWC_SEARCH_AI_OVERVIEW ?? 'true'));
        const TWC_SEARCH_USE_PDP_FOR_SUMMARY = !/^(1|true|yes)$/i.test(String(process.env.TWC_SEARCH_USE_PDP_FOR_SUMMARY ?? 'false'))
            ? false
            : true;
        const TWC_DIRECT_OPEN_DETAILS = !/^(0|false|no)$/i.test(String(process.env.TWC_DIRECT_OPEN_DETAILS ?? 'true'));

        // UI-driven refinement can bypass intent classification.
        const forcedSearch = req.body?.search && typeof req.body.search === 'object'
            ? req.body.search
            : null;

        const stripHtml = (value) => String(value ?? '').replace(/<[^>]*>/g, '').trim();
        const resolveImageUrl = (url) => {
            const u = String(url || '').trim();
            if (!u) return '';
            if (/^https?:\/\//i.test(u)) return u;
            if (u.startsWith('/')) return `${process.env.SAP_BASE_URL}${u}`;
            return u;
        };

        const isProductFollowupQuestion = (text) => {
            const t = String(text || '').trim();
            if (!t) return false;
            // Only handle if there's an active product context.
            if (!session.lastProductSummary || !session.lastProductSummary.code) return false;
            // Avoid hijacking explicit searches, add-to-cart, checkout, etc.
            if (/^\s*(search\s*:|search\s+for\b|find\b|looking\s+for\b|web\s*:|google\s*:|serp\s*:|serper\s*:|intent\s*:)/i.test(t)) return false;
            if (/^\s*(add|buy)\b/i.test(t)) return false;
            if (/\b(checkout|cart|bag|basket|show\s+more|more\s+results)\b/i.test(t)) return false;
            // Don't hijack explicit product info/navigation requests; those are handled by intent routing.
            if (/\b(product\s+summary|summary|overview|more\s+details|more\s+info|tell\s+me\s+more|product\s+details|view\s+details|open\s+details|show\s+details)\b/i.test(t)) return false;

            // A lightweight heuristic for follow-up Qs.
            const looksQuestiony = /\?\s*$/.test(t) || /^\s*(will|would|should|can|could|do|does|is|are|what|why|how|which)\b/i.test(t);
            const refersToIt = /\b(this\s+product|this\s+item|it|that|these|those|the\s+product)\b/i.test(t);
            // If it's clearly a question, or it references the current product context, treat as follow-up.
            return looksQuestiony || refersToIt;
        };

        // Follow-up questions about the last shown product (styling/advice/etc): answer via Gemini using context.
        if (!forcedSearch && genAI && isProductFollowupQuestion(userMessage)) {
            const p = session.lastProductSummary;
            const prompt = [
                'You are a helpful retail assistant.',
                'The user is asking a follow-up question about a product that was just shown.',
                'Answer the question with general, customer-friendly guidance, grounded in the product context provided.',
                'Do NOT invent specific materials, sizes, availability, or review stats beyond what is in context.',
                'Keep it concise: 2–4 sentences.',
                'Return plain text only.',
                'Product context:',
                JSON.stringify({
                    code: p.code,
                    name: p.name,
                    price: p.price || null,
                    currency: p.currency || null,
                    averageRating: (typeof p.averageRating === 'number' ? p.averageRating : null),
                    ratingCount: (typeof p.ratingCount === 'number' ? p.ratingCount : null),
                    summary: p.summary || null
                }),
                `User question: ${userMessage}`
            ].join('\n');

            try {
                const response = await genAI.models.generateContent({
                    model: modelName,
                    contents: [{ role: 'user', parts: [{ text: prompt }] }]
                });
                const raw = (response.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
                if (raw) {
                    return res.json({ reply: raw.replace(/\s+/g, ' ').trim(), products: null });
                }
            } catch {
                // fall through to normal flow
            }
        }

        const extractSearchQuery = (text) => {
            const t = (text || '').trim();
            if (!t) return null;
            const patterns = [
                /^search\s*:\s*(.+)$/i,
                /^search\s+for\s+(.+)$/i,
                /^show\s+me\s+(.+)$/i,
                /^find\s+(.+)$/i,
                /^look\s+for\s+(.+)$/i,
                /^looking\s+for\s+(.+)$/i,
                /^i\s+(?:want|need)\s+(.+)$/i,
                /^can\s+you\s+(?:show|find)\s+me\s+(.+)$/i,
            ];
            for (const re of patterns) {
                const m = t.match(re);
                if (m && m[1]) {
                    let q = m[1].trim().replace(/["'`]/g, '').replace(/\s+/g, ' ');
                    // Drop common filler at the start ("some accessories" -> "accessories").
                    q = q.replace(/^(?:some|any|a|an|the)\s+/i, '').trim();
                    return q.length >= 2 ? q.slice(0, 80) : null;
                }
            }
            return null;
        };

        const extractWebQuery = (text) => {
            const t = String(text || '').trim();
            if (!t) return null;
            const webPrefix = t.match(/^\s*(web|google|serp|serper|intent)\s*:\s*(.+)$/i);
            if (webPrefix && webPrefix[2]) {
                const q = webPrefix[2].trim();
                return q ? q.slice(0, 80) : null;
            }
            const webFor = t.match(/^\s*(?:search\s+the\s+web\s+for|google\s+for)\s+(.+)$/i);
            if (webFor && webFor[1]) {
                const q = webFor[1].trim();
                return q ? q.slice(0, 80) : null;
            }
            return null;
        };

        const extractDetailsTarget = (text) => {
            const t = String(text || '').trim();
            if (!t) return null;
            const patterns = [
                /^show\s+me\s+(?:the\s+)?product\s+details\s+for\s+(.+)$/i,
                /^open\s+(?:the\s+)?product\s+details\s+for\s+(.+)$/i,
                /^product\s+details\s+for\s+(.+)$/i,
                /^show\s+details\s+for\s+(.+)$/i,
                /^open\s+details\s+for\s+(.+)$/i,
                /^show\s+me\s+(?:the\s+)?details\s+(?:for|of)\s+(.+)$/i,
                /^view\s+(?:the\s+)?details\s+(?:for|of)\s+(.+)$/i,
                /^open\s+(?:the\s+)?details\s+(?:for|of)\s+(.+)$/i,
            ];
            for (const re of patterns) {
                const m = t.match(re);
                if (m && m[1]) {
                    const q = m[1].trim().replace(/^["'`]+|["'`]+$/g, '').trim();
                    return q ? q.slice(0, 120) : null;
                }
            }
            return null;
        };

        const extractProductInfoTarget = (text) => {
            const t = String(text || '').trim();
            if (!t) return null;
            const patterns = [
                /^(?:give|provide)\s+me\s+(?:(?:a|an|the|some|any)\s+)?(?:short\s+)?(?:product\s+)?(?:summary|overview|info(?:rmation)?|details|rating|reviews?|ranking|your\s+view)\s*(?:for|of|on)?\s+(.+)$/i,
                /^(?:can\s+you\s+)?(?:share|give|provide)\s+(?:(?:a|an|the|some|any)\s+)?(?:short\s+)?(?:product\s+)?(?:summary|overview|info(?:rmation)?|details|rating|reviews?|ranking|your\s+view)\s*(?:for|of|on)?\s+(.+)$/i,
                /^show\s+me\s+(?:(?:a|an|the|some|any)\s+)?(?:short\s+)?(?:product\s+)?(?:summary|overview|info(?:rmation)?|details|rating|reviews?|ranking|your\s+view)\s*(?:for|of|on)?\s+(.+)$/i,
                /^(?:give|provide|show)\s+me\s+(?:some\s+more\s+)?(?:product|products)\s+(?:summary|summaries|overview|overviews)\s*(?:for|of|on)?\s+(.+)$/i,
                /^(?:give|provide|show)\s+me\s+more\s+(?:product\s+)?(?:details|info(?:rmation)?|summary|overview)\s*(?:for|of|on)?\s+(.+)$/i,
                /^show\s+more\s+(?:product\s+)?(?:details|info(?:rmation)?|summary|overview)\s*(?:for|of|on)?\s+(.+)$/i,
                /^(?:show|open)\s+more\s+(?:product\s+)?(?:details|info(?:rmation)?|summary|overview)\s*(?:for|of|on)?\s+(.+)$/i,
                /^(?:product\s+)?(?:summary|overview|info(?:rmation)?|details|rating|reviews?|ranking|your\s+view)\s*(?:for|of|on)?\s+(.+)$/i,
                /^(?:can\s+you\s+)?tell\s+me\s+more\s+about\s+(.+)$/i,
                /^(?:can\s+you\s+)?tell\s+me\s+about\s+(.+)$/i,
                /^(?:tell\s+me\s+about|what\s+do\s+you\s+think\s+of|your\s+view\s+on)\s+(.+)$/i,
                /^(.+?)\s+(?:details|summary|info(?:rmation)?|rating|reviews?|ranking)\s*$/i,
            ];
            for (const re of patterns) {
                const m = t.match(re);
                if (m && m[1]) {
                    const q = m[1].trim().replace(/^["'`]+|["'`]+$/g, '').trim();
                    return q ? q.slice(0, 120) : null;
                }
            }
            return null;
        };

        const normalizeSkuToken = (value) => {
            const s = String(value || '').trim();
            if (!s) return '';
            return s.replace(/\s+/g, '').replace(/[^A-Za-z0-9_-]/g, '').trim();
        };

        const extractSkuFromText = (text) => {
            const t = String(text || '').trim();
            if (!t) return null;

            // Common: "sku SYDFO", "SKU s y dfo", "sku: sea-salt-collection"
            // Also supports speech-to-text variants like "skua 15239".
            const m = t.match(/\bsku[a]?\b\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9\s_-]{1,40})\b/i);
            if (m && m[1]) {
                const tok = normalizeSkuToken(m[1]);
                if (tok.length >= 2) return tok;
            }

            // Also allow a raw token that matches a last shown product code ignoring spaces.
            const list = Array.isArray(session.lastProducts) ? session.lastProducts : [];
            if (list.length) {
                const compact = normalizeSkuToken(t);
                if (compact.length >= 2) {
                    const hit = list.find(p => normalizeSkuToken(p?.code).toLowerCase() === compact.toLowerCase());
                    if (hit?.code) return String(hit.code).trim();
                }
            }

            return null;
        };

        const resolveCartSku = (intentSku, messageText) => {
            const fromIntent = normalizeSkuToken(intentSku || '');
            const fromText = extractSkuFromText(messageText) || '';

            // Prefer an explicit SKU-like token found in the message.
            const raw = normalizeSkuToken(fromText || fromIntent || '');

            // IMPORTANT: Do not "base-code normalize" variant SKUs like A15239008AAB.
            // Only apply base-code guessing when the token looks like a base code or digits-only.
            const looksBase = /^[A-Za-z]\d{4,6}$/.test(raw) || /^\d{4,6}$/.test(raw);
            const guessed = looksBase ? (guessTwcBaseCode(raw) || guessTwcBaseCode(messageText) || raw) : raw;
            return normalizeSkuToken(guessed);
        };

        const normalizeFragranceQuery = (q, originalMessage) => {
            const query = String(q || '').trim();
            if (!query) return query;
            const msg = String(originalMessage || '').toLowerCase();
            const looksFragrance = /\b(fragrance|scent|diffuser|candle|room\s*spray|oil)\b/i.test(query) || /\b(fragrance|scent|diffuser|candle|room\s*spray|oil)\b/i.test(msg);
            if (!looksFragrance) return query;
            return query
                .replace(/\bsaint\b/gi, 'scent')
                .replace(/\bsent\b/gi, 'scent')
                .replace(/\bsend\b/gi, 'scent');
        };

        const safeParseJson = (raw) => {
            const txt = String(raw || '')
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/```\s*$/i, '')
                .trim();
            if (!txt) return null;
            try {
                return JSON.parse(txt);
            } catch {
                const first = txt.indexOf('{');
                const last = txt.lastIndexOf('}');
                if (first !== -1 && last !== -1 && last > first) {
                    try {
                        return JSON.parse(txt.slice(first, last + 1));
                    } catch {
                        return null;
                    }
                }
                return null;
            }
        };

        const generateSearchSummaries = async (products, queryText, pdpByCode) => {
            if (!genAI) return null;
            const list = Array.isArray(products) ? products : [];
            if (!list.length) return null;

            const pdp = (p) => {
                const key = String(p?.code || '').trim();
                return (pdpByCode && key && typeof pdpByCode === 'object') ? (pdpByCode[key] || null) : null;
            };

            const input = list.slice(0, PREFETCH_PAGE_SIZE).map(p => ({
                code: String(p?.code || '').trim(),
                name: stripHtml(p?.name || ''),
                price: String(p?.price || '').trim() || (String(pdp(p)?.price || '').trim() || null),
                averageRating: (typeof p?.averageRating === 'number' && Number.isFinite(p.averageRating))
                    ? p.averageRating
                    : (typeof pdp(p)?.averageRating === 'number' && Number.isFinite(pdp(p).averageRating) ? pdp(p).averageRating : null),
                descriptionSnippet: String(pdp(p)?.descriptionSnippet || '').trim() || null,
                sustainableSnippet: String(pdp(p)?.sustainableSnippet || '').trim() || null,
                category: String(pdp(p)?.category || '').trim() || null
            })).filter(p => p.code && p.name);

            if (!input.length) return null;

            const prompt = [
                'You are a helpful retail assistant.',
                'For each product, write ONE customer-friendly overview (1–2 sentences, max 26 words).',
                'Only use facts present in the provided product data. Do NOT invent materials, sizes, availability, or review stats.',
                'If price is missing, do not mention price. If rating is missing, do not mention rating.',
                'If descriptionSnippet is present, you may paraphrase it (do not quote verbatim).',
                'Return ONLY valid JSON (no markdown, no explanation).',
                'Return a JSON array of objects: [{"code":"A12345","summary":"..."}, ...].',
                'Include an entry for EVERY product provided.',
                `Search intent: ${String(queryText || '').trim().slice(0, 120)}`,
                'Products:',
                JSON.stringify(input)
            ].join('\n');

            try {
                const response = await genAI.models.generateContent({
                    model: modelName,
                    contents: [{ role: 'user', parts: [{ text: prompt }] }]
                });
                const raw = (response.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
                const parsed = safeParseJson(raw);
                const rows = Array.isArray(parsed) ? parsed : null;
                if (!rows) return null;

                const out = {};
                for (const row of rows) {
                    const code = String(row?.code || '').trim();
                    const summary = typeof row?.summary === 'string' ? row.summary.replace(/\s+/g, ' ').trim() : '';
                    if (code && summary) out[code] = summary;
                }
                return Object.keys(out).length ? out : null;
            } catch {
                return null;
            }
        };

        const findProductByText = (targetText, products) => {
            const list = Array.isArray(products) ? products : [];
            const raw = String(targetText || '').trim();
            if (!raw) return null;
            const lowered = raw.toLowerCase();
            const normalized = lowered.replace(/[\s_-]+/g, '');

            // Prefer SKU match
            const skuMatch = list.find(p => String(p?.code || '').toLowerCase() === lowered);
            if (skuMatch) return skuMatch;

            // Tolerate spaces/dashes in codes and allow prefix match (e.g. user types "a1488" but last product is A14888)
            const skuNormalizedMatch = list.find(p => String(p?.code || '').toLowerCase().replace(/[\s_-]+/g, '') === normalized);
            if (skuNormalizedMatch) return skuNormalizedMatch;
            if (normalized.length >= 4) {
                const prefix = list.find(p => String(p?.code || '').toLowerCase().replace(/[\s_-]+/g, '').startsWith(normalized));
                if (prefix) return prefix;
            }

            // Exact name match
            const exactName = list.find(p => String(p?.name || '').toLowerCase() === lowered);
            if (exactName) return exactName;

            // Substring name match
            const partial = list.find(p => String(p?.name || '').toLowerCase().includes(lowered));
            if (partial) return partial;

            return null;
        };

        const heuristicSearchQuery = (text) => {
            const t = (text || '').toLowerCase();
            if (!t) return null;

            // Strip punctuation but keep spaces
            const cleaned = t.replace(/[^\p{L}\p{N}\s_-]+/gu, ' ').replace(/\s+/g, ' ').trim();
            if (!cleaned) return null;

            const stop = new Set([
                'a','an','the','me','my','for','to','of','on','in','at','with','and','or',
                'get','show','find','search','look','looking','need','want','please','give',
                'some','any','one','something','high','best','good','top','cheap','new'
            ]);

            const tokens = cleaned
                .split(' ')
                .map(s => s.trim())
                .filter(Boolean)
                .filter(tok => tok.length >= 2)
                .filter(tok => !stop.has(tok));

            // A couple of lightweight normalizations
            const normalized = tokens.map(tok => {
                if (tok === 'zoomed') return 'zoom';
                if (tok === 'cameras') return 'camera';
                return tok;
            });

            // Unique while preserving order
            const seen = new Set();
            const unique = [];
            for (const tok of normalized) {
                if (seen.has(tok)) continue;
                seen.add(tok);
                unique.push(tok);
            }

            // Keep it short for OCC search
            const candidate = unique.slice(0, 5).join(' ').trim();
            return candidate && candidate.length >= 2 ? candidate : null;
        };

        const rewriteQueryWithGemini = async (userText) => {
            if (!genAI) return null;
            const prompt = [
                'Extract a short product search query from the user message.',
                'Rules:',
                '- Return ONLY the query text (no punctuation, no quotes, no explanation)',
                '- 2 to 5 words',
                '- Focus on product type + key attribute (example: "zoom camera")',
                `User message: ${userText}`
            ].join('\n');
            const response = await genAI.models.generateContent({
                model: modelName,
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });
            const txt = (response.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
            return txt.replace(/[^\p{L}\p{N}\s_-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
        };

        const IntentSchema = z.object({
            action: z.enum([
                'search',
                'more_results',
                'product_summary',
                'product_details',
                'add_to_cart',
                'buy',
                'show_cart',
                'checkout',
                'open_bag',
                'open_bag_api',
                'web_search',
                'smalltalk',
                'unknown'
            ]),
            query: z.string().min(1).max(80).optional(),
            sku: z.string().min(2).max(40).optional(),
            qty: z.number().int().min(1).max(99).optional(),
            // 1-based index into last shown products
            index: z.number().int().min(1).max(3).optional(),
        });

        const parseIndexFromText = (text) => {
            const t = (text || '').toLowerCase();
            if (/\b(1st|first|one)\b/.test(t)) return 1;
            if (/\b(2nd|second|two)\b/.test(t)) return 2;
            if (/\b(3rd|third|three)\b/.test(t)) return 3;
            return null;
        };

        const classifyIntentWithGemini = async (userText) => {
            if (!genAI) return { action: 'unknown' };
            const contextProducts = Array.isArray(session.lastProducts)
                ? session.lastProducts.slice(0, 3).map((p, i) => ({ index: i + 1, sku: p.code, name: p.name }))
                : [];
            const prompt = [
                'You are a commerce assistant that can execute actions via APIs (search products, add to cart, show cart, checkout).',
                'Classify the user message into an intent for the next action.',
                'Return ONLY valid JSON (no markdown, no extra text).',
                'Schema:',
                '{"action":"search|more_results|product_summary|product_details|add_to_cart|buy|show_cart|checkout|open_bag|open_bag_api|web_search|smalltalk|unknown","query?":string,"sku?":string,"qty?":number,"index?":1|2|3}',
                'Context:',
                `- lastQuery: ${session.lastQuery || ''}`,
                `- hasCart: ${Boolean(session.cart?.guid || session.cart?.code)}`,
                `- lastShownProducts: ${JSON.stringify(contextProducts)}`,
                'Rules:',
                '- If user wants to find products, action=search and include a short query (2-5 words).',
                '- If user says "more", "next", "show more", "search again", use action=more_results (do NOT invent a new query).',
                '- If user wants a PRODUCT SUMMARY / more info about a specific product, action=product_summary and include sku if present, otherwise include index (1-3) based on first/second/third.',
                '- If user wants to OPEN / VIEW PRODUCT DETAILS PAGE (PDP) for a specific product, action=product_details and include sku if present, otherwise include index (1-3).',
                '- If user wants add-to-cart, action=add_to_cart and include sku if present, otherwise include index (1-3) based on first/second/third.',
                '- If user says buy/purchase "that" / "the first one", use action=buy with sku or index.',
                '- If user asks about cart contents, action=show_cart.',
                '- If user says checkout / proceed to checkout, action=checkout.',
                '- If user says open/go to bag/basket, action=open_bag.',
                '- If user explicitly asks for bag/cart API JSON (e.g. "bag api", "bag json"), action=open_bag_api.',
                '- If user explicitly asks to search the web / google (e.g. "web: ..."), action=web_search and include query.',
                '- If the user mentions "details" or "product details" about a product, prefer action=product_details (not search).',
                '- If the user mentions "summary", "tell me more about", "more info", or "more details" about a product, prefer action=product_summary (not more_results).',
                `User message: ${userText}`
            ].join('\n');

            let raw = '';
            try {
                const response = await genAI.models.generateContent({
                    model: modelName,
                    contents: [{ role: 'user', parts: [{ text: prompt }] }]
                });
                raw = (response.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
            } catch {
                return { action: 'unknown' };
            }
            const txt = raw
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/```\s*$/i, '')
                .trim();
            try {
                const first = txt.indexOf('{');
                const last = txt.lastIndexOf('}');
                const jsonText = (first !== -1 && last !== -1 && last > first) ? txt.slice(first, last + 1) : txt;
                const parsed = JSON.parse(jsonText);
                return IntentSchema.parse(parsed);
            } catch {
                return { action: 'unknown' };
            }
        };

        const looksLikeFreeTextSearch = (text) => {
            const t = (text || '').trim();
            if (!t) return false;
            if (t.length < 2 || t.length > 80) return false;
            if (/[?]/.test(t)) return false;
            if (!/^[\p{L}\p{N}\s._-]+$/u.test(t)) return false;
            const lowered = t.toLowerCase();
            const nonSearch = new Set(['hi', 'hello', 'hey', 'thanks', 'thank you', 'ok', 'okay']);
            if (nonSearch.has(lowered)) return false;
            // Avoid treating cart-related phrases as searches.
            if (/(\bcart\b|add\s+to\s+cart|checkout|my\s+cart)/i.test(lowered)) return false;
            return true;
        };

        const extractAddSku = (text) => {
            const t = (text || '').trim();
            if (!t) return null;
            const m = t.match(/^add\s+(?:to\s+cart\s+)?([A-Za-z0-9_-]{2,})$/i);
            return m ? m[1] : null;
        };

        const heuristicIntent = (text) => {
            const t = String(text || '').trim();
            const lowered = t.toLowerCase();
            if (!t) return null;

            const isMoreAboutProduct = /\b(?:tell|say|share|explain)\s+me\s+more\s+about\b/i.test(t) || /\bmore\s+about\b/i.test(t);

            // Explicit web search triggers (so this can work even if Gemini is down).
            const webQ = extractWebQuery(t);
            if (webQ) return { action: 'web_search', query: webQ };

            // Bag API / JSON (opens a tab to the JSON endpoint on TWC domain so browser cookies apply).
            if (/\b(bag|basket|cart)\s*(api|json)\b/i.test(lowered) || /universalvariable\.json/i.test(lowered)) {
                return { action: 'open_bag_api' };
            }

            // NOTE: cart/bag/checkout intent detection is handled by Gemini when available.
            // We intentionally avoid hardcoded phrase matching for these intents here.
            // Pagination should only trigger on short, explicit messages; avoid hijacking "more details".
            if (!isMoreAboutProduct && /^\s*(more|next|show\s+more|more\s+results)\s*$/i.test(lowered)) return { action: 'more_results' };

            const idx = parseIndexFromText(t);
            const sku = extractAddSku(t);
            if (/^\s*(add|buy)\b/i.test(lowered) && (idx || sku)) {
                return { action: /^\s*buy\b/i.test(lowered) ? 'buy' : 'add_to_cart', ...(idx ? { index: idx } : {}), ...(sku ? { sku } : {}) };
            }

            // If the user types a SKU-like token (e.g. "A14888" or "A14 888"), route to search without Gemini.
            const maybeSku = guessTwcBaseCode(t);
            if (maybeSku && t.length <= 20) return { action: 'search', query: maybeSku };

            return null;
        };

        // Use Gemini to recognize intent for both typed and speech input.
        // Fall back to lightweight heuristics if intent parsing fails.
        let intent;
        if (forcedSearch) {
            intent = { action: 'search' };
        } else {
            // Hard routing: explicit web search should never depend on Gemini.
            const explicitWebQuery = extractWebQuery(userMessage);
            if (explicitWebQuery) {
                intent = { action: 'web_search', query: explicitWebQuery };
            } else if (genAI) {
                // AI-first: let Gemini decide cart/show-cart/checkout/add-to-cart/etc.
                try {
                    intent = await classifyIntentWithGemini(userMessage);
                } catch {
                    intent = { action: 'unknown' };
                }
                // If Gemini couldn't classify, fall back to heuristics.
                if (!intent || intent.action === 'unknown') {
                    intent = heuristicIntent(userMessage) || { action: 'unknown' };
                }
            } else {
                // No Gemini available: rely on heuristics.
                intent = heuristicIntent(userMessage) || { action: 'unknown' };
            }
        }

        // Heuristic override for "more/next" if we have a previous query.
        if (intent.action === 'unknown' || intent.action === 'smalltalk') {
            const isMoreAboutProduct = /\b(?:tell|say|share|explain)\s+me\s+more\s+about\b/i.test(userMessage) || /\bmore\s+about\b/i.test(userMessage);
            if (!isMoreAboutProduct && /^\s*(more|next|again|another|show\s+more)\s*$/i.test(userMessage) && session.lastQuery) {
                intent = { action: 'more_results' };
            }
        }

        // If Gemini isn't configured, but the user asked a question, optionally route to web search.
        if (!genAI && intent.action === 'unknown' && /\?\s*$/.test(userMessage) && userMessage.length >= 4) {
            intent = { action: 'web_search', query: userMessage.slice(0, 80) };
        }

        // NOTE: We no longer override intent based on hardcoded "add <sku>" patterns when Gemini is available.
        // SKU extraction is handled inside the add_to_cart/buy handler.

        const toPayload = (products) => (products || []).map(p => ({
            code: p?.code || '',
            baseCode: p?.baseCode || '',
            name: stripHtml(p?.name || p?.code || 'Product'),
            stock: p?.stock || '',
            price: p?.price || '',
            currency: p?.currency || '',
            averageRating: (p?.averageRating ?? null),
            image: resolveImageUrl(p?.image),
            url: p?.url || ''
        })).filter(p => p.code);

        const findLastProduct = (sku) => {
            const code = String(sku || '').trim();
            if (!code) return null;
            const list = Array.isArray(session.lastProducts) ? session.lastProducts : [];
            const lowered = code.toLowerCase();
            return list.find(p => {
                const c = String(p?.code || '').trim().toLowerCase();
                const b = String(p?.baseCode || '').trim().toLowerCase();
                return c === lowered || (b && b === lowered);
            }) || null;
        };

        const addToLocalCartFromLast = (sku, qty = 1) => {
            const p = findLastProduct(sku);
            if (!p) return null;
            session.localCart = Array.isArray(session.localCart) ? session.localCart : [];
            const quantity = Number.isFinite(Number(qty)) ? Number(qty) : 1;
            for (let i = 0; i < quantity; i++) {
                session.localCart.push({
                    code: p.code,
                    name: p.name,
                    price: p.price,
                    currency: p.currency,
                    url: p.url,
                    image: p.image,
                    addedAt: new Date().toISOString()
                });
            }
            return { item: p, count: session.localCart.length, qty: quantity };
        };

        const formatLocalCart = () => {
            const items = Array.isArray(session.localCart) ? session.localCart : [];
            if (!items.length) return null;
            const lines = items.slice(0, 10).map((it, i) => {
                const name = stripHtml(it?.name || 'Item');
                const code = String(it?.code || '').trim();
                const price = String(it?.price || '').trim();
                return `${i + 1}. ${name} (${code}) ${price}`.trim();
            }).join('\n');
            const extra = items.length > 10 ? `\n(+${items.length - 10} more)` : '';
            return { lines, count: items.length, extra };
        };

        // If the user asks to "view/open details" (often mirroring the UI button), open the PDP.
        // Works even if it's embedded in a longer sentence like: "View details instead of giving summary".
        if (!forcedSearch && /\b(view|open)\s+details\b/i.test(userMessage)) {
            const twcBaseUrl = String(process.env.TWC_BASE_URL || 'https://www.thewhitecompany.com').trim() || 'https://www.thewhitecompany.com';
            const resolveTwcUrl = (u) => {
                const s = String(u || '').trim();
                if (!s) return '';
                if (/^https?:\/\//i.test(s)) return s;
                if (s.startsWith('//')) return `https:${s}`;
                if (s.startsWith('/')) return `${twcBaseUrl}${s}`;
                return s;
            };

            const list = Array.isArray(session.lastProducts) ? session.lastProducts : [];
            const idx = parseIndexFromText(userMessage);
            const fromList = list.length ? ((idx && list[idx - 1]) ? list[idx - 1] : list[0]) : null;

            // Prefer an explicit SKU/code in the message if present.
            const codeFromText = guessTwcBaseCode(userMessage);
            const fromListByCode = (codeFromText && list.length) ? findProductByText(codeFromText, list) : null;
            const chosen = fromListByCode || fromList;

            // If we still don't have a product context, ask for a SKU rather than mis-routing to a search.
            if (!chosen && !codeFromText) {
                return res.json({
                    reply: 'Which product do you want to view details for? Please provide a SKU (e.g. “show product details for A15239”) or search first.',
                    products: null
                });
            }

            const code = String(chosen?.code || codeFromText || '').trim();
            let url = resolveTwcUrl(chosen?.url || '');
            if (!url && code) {
                try {
                    const r = await searchTwcProducts(code, { currentPage: 0, pageSize: 1 });
                    const payload = toPayload(r.products);
                    const first = payload?.[0];
                    if (first?.url) url = resolveTwcUrl(first.url);
                } catch {
                    // ignore
                }
            }
            if (!url && code) url = `${twcBaseUrl}/uk/search?q=${encodeURIComponent(code)}`;

            if (url) {
                return res.json({
                    reply: `Opening the product page for “${stripHtml(chosen?.name || code || 'Product')}”.`,
                    products: null,
                    action: { type: 'open_url', url }
                });
            }
        }

        // If the user asks for "more details" but doesn't specify a product, ask rather than searching.
        if (!forcedSearch) {
            const t = String(userMessage || '').trim();
            const looksLikeDetailsButMissingTarget = /^(?:give|show|open)\s+(?:me\s+)?(?:more\s+)?(?:product\s+)?details\s*(?:for|of)?\s*$/i.test(t);
            if (looksLikeDetailsButMissingTarget) {
                const hasContext = Array.isArray(session.lastProducts) && session.lastProducts.length;
                return res.json({
                    reply: hasContext
                        ? 'Which product do you mean? You can say “more details for the first product” (or second/third), or provide a SKU.'
                        : 'Which product do you want more details for? Please provide a SKU (e.g. “more details for A15239”) or search first.',
                    products: null
                });
            }
        }

        // Product details/summary/info/ranking: fetch product JSON, summarize, and render as a single horizontal tile.
        const aiWantsProductDetailsRaw = !forcedSearch && intent?.action === 'product_details';
        const aiWantsProductSummaryRaw = !forcedSearch && intent?.action === 'product_summary';
        const prefersSummaryForMoreDetails = /\bmore\s+details\b/i.test(userMessage) && !/\b(open|view)\b/i.test(userMessage);
        const aiWantsProductDetails = aiWantsProductDetailsRaw && !prefersSummaryForMoreDetails;
        const aiWantsProductSummary = aiWantsProductSummaryRaw || (aiWantsProductDetailsRaw && prefersSummaryForMoreDetails);
        const lastList = Array.isArray(session.lastProducts) ? session.lastProducts : [];
        const fromAiIndex = ((aiWantsProductDetails || aiWantsProductSummary) && intent?.index && lastList[intent.index - 1])
            ? lastList[intent.index - 1]
            : null;
        const aiSku = ((aiWantsProductDetails || aiWantsProductSummary) && intent?.sku)
            ? normalizeSkuToken(intent.sku)
            : null;
        const aiTargetCode = aiSku || (fromAiIndex?.code ? String(fromAiIndex.code).trim() : null);

        const productDetailsTargetText = extractDetailsTarget(userMessage);
        const productInfoOnlyTargetText = extractProductInfoTarget(userMessage);
        const productDetailsRequested = Boolean(productDetailsTargetText) || aiWantsProductDetails;
        const productInfoTarget = aiTargetCode || productInfoOnlyTargetText || productDetailsTargetText;
        if (productInfoTarget) {
            const twcBaseUrl = String(process.env.TWC_BASE_URL || 'https://www.thewhitecompany.com').trim() || 'https://www.thewhitecompany.com';
            const resolveTwcUrl = (u) => {
                const s = String(u || '').trim();
                if (!s) return '';
                if (/^https?:\/\//i.test(s)) return s;
                if (s.startsWith('//')) return `https:${s}`;
                if (s.startsWith('/')) return `${twcBaseUrl}${s}`;
                return s;
            };

            const fromLast = findProductByText(productInfoTarget, session.lastProducts);
            const idxFromText = parseIndexFromText(productInfoTarget);
            const fromLastByIndex = (!fromLast && idxFromText && Array.isArray(session.lastProducts) && session.lastProducts[idxFromText - 1])
                ? session.lastProducts[idxFromText - 1]
                : null;

            const fromLastByAiIndex = (!fromLast && fromAiIndex)
                ? fromAiIndex
                : null;

            const fromLastByAiSku = (!fromLast && aiSku)
                ? findProductByText(aiSku, session.lastProducts)
                : null;

            const skuFromText = extractSkuFromText(productInfoTarget);
            const fromLastBySku = (!fromLast && skuFromText)
                ? findProductByText(skuFromText, session.lastProducts)
                : null;

            const codeFromText = guessTwcBaseCode(productInfoTarget);
            const fromLastByCode = (!fromLast && codeFromText)
                ? findProductByText(codeFromText, session.lastProducts)
                : null;

            let resolved = {
                code: (fromLastByAiSku?.code || fromLastByCode?.code || fromLastBySku?.code || aiSku || codeFromText || skuFromText || fromLastByAiIndex?.code || fromLastByIndex?.code || fromLast?.code || ''),
                name: (fromLastByAiSku?.name || fromLastByCode?.name || fromLastBySku?.name || fromLastByAiIndex?.name || fromLastByIndex?.name || fromLast?.name || ''),
                price: (fromLastByAiSku?.price || fromLastByCode?.price || fromLastBySku?.price || fromLastByAiIndex?.price || fromLastByIndex?.price || fromLast?.price || ''),
                currency: (fromLastByAiSku?.currency || fromLastByCode?.currency || fromLastBySku?.currency || fromLastByAiIndex?.currency || fromLastByIndex?.currency || fromLast?.currency || ''),
                averageRating: (fromLastByAiSku?.averageRating ?? fromLastByCode?.averageRating ?? fromLastBySku?.averageRating ?? fromLastByAiIndex?.averageRating ?? fromLastByIndex?.averageRating ?? fromLast?.averageRating ?? null),
                image: (fromLastByAiSku?.image || fromLastByCode?.image || fromLastBySku?.image || fromLastByAiIndex?.image || fromLastByIndex?.image || fromLast?.image || ''),
                url: (fromLastByAiSku?.url || fromLastByCode?.url || fromLastBySku?.url || fromLastByAiIndex?.url || fromLastByIndex?.url || fromLast?.url || '')
            };

            // Even if we already have a code, do a lightweight lookup to populate a good PDP URL/image when missing.
            if (resolved.code && (!resolved.url || !resolved.image || !resolved.name || !resolved.price)) {
                try {
                    const r = await searchTwcProducts(resolved.code, { currentPage: 0, pageSize: 1 });
                    const payload = toPayload(r.products);
                    const first = payload?.[0];
                    if (first) {
                        resolved = {
                            ...resolved,
                            name: resolved.name || first.name,
                            price: resolved.price || first.price,
                            currency: resolved.currency || first.currency,
                            averageRating: resolved.averageRating ?? first.averageRating ?? null,
                            image: resolved.image || first.image,
                            url: resolved.url || first.url
                        };
                    }
                } catch {
                    // Non-fatal; keep whatever we have.
                }
            }

            // If we don't have a code yet, resolve via a 1-item search.
            if (!resolved.code) {
                const result = await searchTwcProducts(productInfoTarget, { currentPage: 0, pageSize: 1 });
                const payload = toPayload(result.products);
                const first = payload?.[0];
                if (first?.code) {
                    session.lastQuery = productInfoTarget;
                    session.lastPage = 0;
                    session.lastProducts = payload;
                    session.lastFacets = result.facets;
                    session.lastFilters = null;
                    session.lastPagination = result.pagination || null;
                    session.lastRevealCount = 1;
                    resolved = {
                        code: first.code,
                        name: first.name,
                        price: first.price,
                        currency: first.currency,
                        averageRating: first.averageRating ?? null,
                        image: first.image,
                        url: first.url
                    };
                }
            }

            const code = String(resolved.code || '').trim();
            if (!code) {
                return res.json({ reply: `I couldn't find a product called “${productInfoTarget}”. Try searching first, then ask for details.`, products: null });
            }

            // If the user explicitly asked to OPEN product details, skip the summary tile and open the PDP directly.
            if (productDetailsRequested && TWC_DIRECT_OPEN_DETAILS) {
                const viewUrl = resolveTwcUrl(resolved.url) || `${twcBaseUrl}/uk/search?q=${encodeURIComponent(code)}`;
                session.lastProductSummary = {
                    code,
                    name: stripHtml(resolved.name || '') || code,
                    price: String(resolved.price || '').trim(),
                    currency: String(resolved.currency || '').trim(),
                    averageRating: (typeof resolved.averageRating === 'number' && Number.isFinite(resolved.averageRating)) ? resolved.averageRating : null,
                    ratingCount: null,
                    image: resolveTwcUrl(resolved.image || ''),
                    url: viewUrl,
                    summary: null
                };
                return res.json({
                    reply: `Opening the product page for “${session.lastProductSummary.name}”.`,
                    products: null,
                    action: { type: 'open_url', url: viewUrl }
                });
            }

            let details;
            try {
                details = await getTwcProductDetails(code, { fields: 'FULL' });
            } catch (e) {
                // Some SKUs (e.g. fragrance oils/collections) may not resolve via the FULL product endpoint.
                // Fall back to a 1-item search so we can still show a useful summary + PDP link.
                try {
                    const r = await searchTwcProducts(code, { currentPage: 0, pageSize: 5 });
                    const payload = toPayload(r.products);

                    const wanted = normalizeSkuToken(code).toLowerCase();
                    const exact = payload.find(p => normalizeSkuToken(p?.code).toLowerCase() === wanted) || null;
                    if (exact?.code) {
                        const viewUrl = resolveTwcUrl(exact.url) || `${twcBaseUrl}/uk/search?q=${encodeURIComponent(exact.code)}`;
                        const fallbackSummary = String(exact?.summary || '').trim() || `Here’s what I found for ${stripHtml(exact.name || exact.code)} (${exact.code}).`;

                        session.lastProductSummary = {
                            code: exact.code,
                            name: stripHtml(exact.name || '') || exact.code,
                            price: String(exact.price || '').trim(),
                            currency: String(exact.currency || '').trim(),
                            averageRating: (typeof exact.averageRating === 'number' && Number.isFinite(exact.averageRating)) ? exact.averageRating : null,
                            ratingCount: null,
                            image: resolveTwcUrl(exact.image || ''),
                            url: viewUrl,
                            summary: fallbackSummary
                        };

                        return res.json({
                            reply: `Here’s what I found for “${session.lastProductSummary.name}”.`,
                            products: null,
                            productSummary: session.lastProductSummary
                        });
                    }

                    if (payload.length) {
                        // Avoid returning a mismatched summary tile; show search results instead.
                        session.lastQuery = code;
                        session.lastPage = 0;
                        session.lastProducts = payload;
                        session.lastFacets = r.facets;
                        session.lastFilters = null;
                        session.lastPagination = r.pagination || null;
                        session.lastRevealCount = Math.min(payload.length, DEFAULT_REVEAL_COUNT);
                        return res.json({
                            reply: `I couldn’t fetch full product details for “${code}”, but here are the top matches I found.`,
                            products: payload.slice(0, DEFAULT_REVEAL_COUNT),
                            facets: r.facets || null,
                        });
                    }
                } catch {
                    // ignore and fall through to error response
                }

                const msg = e?.response?.status
                    ? `TWC product API error (${e.response.status}).`
                    : `TWC product API error.`;
                return res.json({ reply: `${msg} I can still show the product link if you search for it.`, products: null });
            }

            const asNumber = (v) => {
                const n = typeof v === 'number' ? v : Number(String(v || '').trim());
                return Number.isFinite(n) ? n : null;
            };

            const detailsName = stripHtml(details?.name || details?.baseProduct?.name || '') || resolved.name || code;
            const detailsPrice =
                String(details?.price?.formattedValue || details?.priceRange?.minPrice?.formattedValue || details?.priceRange?.maxPrice?.formattedValue || resolved.price || '').trim();
            const detailsCurrency = String(details?.price?.currencyIso || resolved.currency || '').trim();
            const detailsRating = asNumber(details?.averageRating ?? details?.averageRatingValue ?? resolved.averageRating);
            const detailsRatingCount = asNumber(details?.numberOfReviews ?? details?.reviewCount ?? details?.numberOfRatings ?? null);
            const detailsDesc = stripHtml(details?.summary || details?.description || details?.longDescription || '');
            const detailsImage = (() => {
                const imgs = Array.isArray(details?.images) ? details.images : [];
                const best = imgs.find(i => String(i?.format || '').toLowerCase() === 'product') || imgs[0] || null;
                return resolveTwcUrl(best?.url || resolved.image || '');
            })();

            const viewUrl = resolveTwcUrl(resolved.url) || `${twcBaseUrl}/uk/search?q=${encodeURIComponent(code)}`;

            const fallbackSummary = (() => {
                const bits = [];
                if (detailsPrice) bits.push(`Price: ${detailsPrice}.`);
                if (detailsDesc) bits.push(detailsDesc);
                return bits.join(' ').trim() || `Here are the key details I have for ${detailsName} (${code}).`;
            })();

            let summaryText = fallbackSummary;
            if (genAI) {
                const prompt = [
                    'You are a helpful retail assistant.',
                    'Write ONE customer-friendly paragraph (3–4 sentences max) with a bit more helpful detail.',
                    'Only use facts present in the provided product data. Do NOT invent materials, sizes, availability, or review stats.',
                    'If ratings/reviews are missing, do not mention them. If price is present, you may include it naturally.',
                    'Return plain text only (no markdown, no bullet points).',
                    'Product data:',
                    JSON.stringify({
                        name: detailsName,
                        code,
                        price: detailsPrice || null,
                        averageRating: detailsRating,
                        ratingCount: detailsRatingCount,
                        description: detailsDesc || null
                    })
                ].join('\n');
                try {
                    const response = await genAI.models.generateContent({
                        model: modelName,
                        contents: [{ role: 'user', parts: [{ text: prompt }] }]
                    });
                    const raw = (response.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
                    if (raw) summaryText = raw.replace(/\s+/g, ' ').trim();
                } catch {
                    // Keep fallback
                }
            }

            const productSummary = {
                code,
                name: detailsName,
                price: detailsPrice,
                currency: detailsCurrency,
                averageRating: detailsRating,
                ratingCount: detailsRatingCount,
                image: detailsImage,
                url: viewUrl,
                summary: summaryText
            };

            session.lastProductSummary = productSummary;

            return res.json({
                reply: `Here’s a quick summary of “${detailsName}”.`,
                products: null,
                productSummary
            });
        }

        const ensureCart = async () => {
            if (!session.cart?.guid && !session.cart?.code) {
                session.cart = await createCart();
            }
            return session.cart;
        };

        const skuFromIndexOrName = (text, idx) => {
            if (idx && Array.isArray(session.lastProducts) && session.lastProducts[idx - 1]?.code) {
                return session.lastProducts[idx - 1].code;
            }
            // Try match by name against last shown products
            if (Array.isArray(session.lastProducts) && text) {
                const lowered = text.toLowerCase();
                const found = session.lastProducts.find(p => (p.name || '').toLowerCase().includes(lowered));
                return found?.code || null;
            }
            return null;
        };

        if (intent.action === 'show_cart' || intent.action === 'checkout') {
            const twcBagUrl = String(process.env.TWC_BAG_URL || 'https://www.thewhitecompany.com/uk/bag').trim();
            const local = formatLocalCart();

            // Prefer SAP cart if it exists; otherwise fall back to local demo cart.
            if (session.cart?.guid || session.cart?.code) {
                const cart = await getCart(session.cart);
                const entries = Array.isArray(cart?.entries) ? cart.entries : [];
                if (entries.length) {
                    const lines = entries.slice(0, 10).map(e => {
                        const code = e?.product?.code || '';
                        const name = stripHtml(e?.product?.name || '');
                        const quantity = e?.quantity ?? '';
                        const price = e?.totalPrice?.formattedValue || e?.basePrice?.formattedValue || '';
                        return `- ${name} (${code}) x${quantity} ${price}`.trim();
                    }).join('\n');
                    const total = cart?.totalPrice?.formattedValue ? `\nTotal: ${cart.totalPrice.formattedValue}` : '';
                    const prefix = intent.action === 'checkout' ? 'Checkout summary:' : 'Your cart:';
                    const suffix = intent.action === 'checkout'
                        ? '\n\nIf you want, say “add more” to continue shopping.'
                        : '';
                    return res.json({ reply: `${prefix}\n${lines}${total}${suffix}`, products: null });
                }
            }

            if (local) {
                const prefix = intent.action === 'checkout'
                    ? 'Checkout summary (demo cart — dummy step):'
                    : 'Your cart (demo cart — dummy step):';
                const suffix = intent.action === 'checkout'
                    ? `\n\nSay “add more” to keep shopping, or say “open bag” to open: ${twcBagUrl}`
                    : '';
                return res.json({ reply: `${prefix}\n${local.lines}${local.extra}${suffix}`, products: null });
            }

            return res.json({ reply: 'Your cart is empty.', products: null });
        }

        if (intent.action === 'open_bag') {
            const twcBagUrl = String(process.env.TWC_BAG_URL || 'https://www.thewhitecompany.com/uk/bag').trim();
            return res.json({
                reply: 'Opening The White Company bag page in a new tab (your browser session controls what you see there).',
                products: null,
                action: { type: 'open_url', url: twcBagUrl }
            });
        }

            if (intent.action === 'open_bag_api') {
                const base = String(process.env.TWC_BAG_UNIVERSAL_VARIABLE_URL || 'https://www.thewhitecompany.com/uk/api/common/universalVariable.json').trim();
                let url = base;
                try {
                    const u = new URL(base);
                    u.searchParams.set('url', '/uk/bag');
                    url = u.toString();
                } catch {
                    url = base.includes('?') ? `${base}&url=%2Fuk%2Fbag` : `${base}?url=%2Fuk%2Fbag`;
                }
                return res.json({
                    reply: 'Opening The White Company bag API JSON in a new tab (real-time for your browser session).',
                    products: null,
                    action: { type: 'open_url', url }
                });
            }

        if (intent.action === 'web_search') {
            const q = String(intent.query || extractSearchQuery(userMessage) || userMessage).trim().slice(0, 80);
            if (!q) return res.json({ reply: 'Tell me what you want me to search the web for.', products: null });
            if (!serperApiKey) {
                return res.json({
                    reply: 'Web search is not configured. Set SERPER_API_KEY in .env and restart the server.',
                    products: null
                });
            }

            const result = await serperSearch(q, { apiKey: serperApiKey, url: serperUrl });
            if (!result.ok) {
                const status = result.status;
                if (status === 401 || status === 403) {
                    return res.json({ reply: 'Serper rejected the API key. Update SERPER_API_KEY and restart.', products: null });
                }
                if (status === 429) {
                    return res.json({ reply: 'Serper rate limit / usage quota reached. Try again later or upgrade your Serper plan.', products: null });
                }
                return res.json({ reply: `Web search failed (Serper ${status}).`, products: null });
            }

            const top = formatSerperTopResults(result.data, { max: 3 });
            const reply = top
                ? `Top web results for “${q}”:\n${top}`
                : `I couldn't find web results for “${q}”.`;
            return res.json({ reply, products: null });
        }

        const runSearch = async (queryText, { currentPage = 0, pageSize = 3, filters } = {}) => {
            const result = await searchTwcProducts(queryText, { currentPage, pageSize, filters });

            const mapWithConcurrency = async (items, limit, fn) => {
                const list = Array.isArray(items) ? items : [];
                const lim = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(12, Number(limit))) : 4;
                const out = new Array(list.length);
                let idx = 0;
                const workers = new Array(Math.min(lim, list.length)).fill(0).map(async () => {
                    while (true) {
                        const i = idx++;
                        if (i >= list.length) return;
                        try {
                            out[i] = await fn(list[i], i);
                        } catch {
                            out[i] = null;
                        }
                    }
                });
                await Promise.all(workers);
                return out;
            };

            const pickPdpImage = (d) => {
                const images = Array.isArray(d?.images) ? d.images : [];
                const primary = images.find(i => String(i?.imageType || '').toUpperCase() === 'PRIMARY') || images[0];
                const url = String(primary?.url || '').trim();
                return resolveTwcUrl(url);
            };

            const buildTwcTileFromPdp = (searchProduct, details) => {
                const p = searchProduct || {};
                const d = details || null;

                const base = String(p?.baseCode || guessTwcBaseCode(p?.code || '') || d?.code || '').trim();
                const code = String(p?.code || '').trim() || base;

                const url = resolveTwcUrl(d?.url || p?.url || '');
                const image = pickPdpImage(d) || resolveTwcUrl(p?.image || '');

                const name = stripHtml(d?.name || p?.name || code || 'Product');
                const price = String(d?.price?.formattedValue || p?.price || '').trim();
                const currency = String(d?.price?.currencyIso || p?.currency || '').trim();
                const stock = String(d?.stock?.stockLevelStatus || p?.stock || '').trim();
                const averageRating = (typeof d?.averageRating === 'number' && Number.isFinite(d.averageRating))
                    ? d.averageRating
                    : (p?.averageRating ?? null);

                return {
                    code,
                    baseCode: base,
                    name,
                    stock,
                    price,
                    currency,
                    averageRating,
                    image,
                    url
                };
            };

            // Automatically fetch PDP details for each search result and use it to drive the tiles.
            // This improves SKU cleanliness (search sometimes returns display-string codes) and makes tiles richer.
            const rawProducts = Array.isArray(result.products) ? result.products : [];
            const pdpSettled = await mapWithConcurrency(rawProducts, 4, async (p) => {
                const base = String(p?.baseCode || guessTwcBaseCode(p?.code || '') || '').trim();
                if (!base) return { key: String(p?.code || '').trim() || null, details: null };
                const d = await getTwcProductDetails(base, { fields: 'FULL' });
                return { key: base, details: d };
            });

            const pdpByBaseCode = {};
            for (const row of pdpSettled) {
                const key = String(row?.key || '').trim();
                if (key && row?.details) pdpByBaseCode[key] = row.details;
            }

            const enrichedProducts = rawProducts.map(p => {
                const base = String(p?.baseCode || guessTwcBaseCode(p?.code || '') || '').trim();
                const d = base ? (pdpByBaseCode[base] || null) : null;
                return buildTwcTileFromPdp(p, d);
            });

            let productsPayload = toPayload(enrichedProducts);

            const fallbackOverview = (p) => {
                const name = stripHtml(p?.name || '') || 'This item';
                const price = String(p?.price || '').trim();
                if (price) return `${name} — ${price}.`;
                return `${name}.`;
            };

            // Enrich search results with a short customer-centric AI summary per item.
            // For demo: we do this in one Gemini call and attach as `summary` so UI tiles can match the product-summary tile.
            if (TWC_SEARCH_AI_OVERVIEW && genAI && productsPayload.length) {
                let pdpByCode = null;
                if (TWC_SEARCH_USE_PDP_FOR_SUMMARY) {
                    const targets = productsPayload.slice(0, 3);
                    const settled = await Promise.allSettled(targets.map(async (p) => {
                        const base = String(p?.baseCode || guessTwcBaseCode(p?.code || '') || '').trim();
                        if (!base) return null;
                        const d = pdpByBaseCode[base] || await getTwcProductDetails(base, { fields: 'FULL' });
                        const desc = stripHtml(d?.description || d?.summary || '').replace(/\s+/g, ' ').trim();
                        const sustainable = stripHtml(d?.sustainableStyle || '').replace(/\s+/g, ' ').trim();
                        return {
                            key: String(p?.code || '').trim(),
                            value: {
                                price: String(d?.price?.formattedValue || '').trim() || null,
                                averageRating: (typeof d?.averageRating === 'number' && Number.isFinite(d.averageRating)) ? d.averageRating : null,
                                descriptionSnippet: desc ? desc.slice(0, 240) : null,
                                sustainableSnippet: sustainable ? sustainable.slice(0, 200) : null,
                                category: String(d?.defaultCategory?.name || d?.parentCategory?.name || '').trim() || null
                            }
                        };
                    }));

                    pdpByCode = {};
                    for (const s of settled) {
                        if (s.status !== 'fulfilled') continue;
                        const row = s.value;
                        if (row?.key && row?.value) pdpByCode[row.key] = row.value;
                    }
                    if (!Object.keys(pdpByCode).length) pdpByCode = null;
                }

                const summaries = await generateSearchSummaries(productsPayload, queryText, pdpByCode);
                if (summaries) {
                    productsPayload = productsPayload.map(p => ({
                        ...p,
                        summary: typeof summaries[p.code] === 'string' ? summaries[p.code] : fallbackOverview(p)
                    }));
                } else {
                    productsPayload = productsPayload.map(p => ({
                        ...p,
                        summary: fallbackOverview(p)
                    }));
                }
            }

            session.lastProducts = productsPayload;
            session.lastFacets = result.facets;
            session.lastFilters = filters || null;
            session.lastPagination = result.pagination || null;
            session.lastRevealCount = Math.min(3, productsPayload.length);
            return { productsPayload, facets: result.facets, currency: result.currency, pagination: result.pagination };
        };

        if (intent.action === 'more_results') {
            if (!session.lastQuery) {
                return res.json({ reply: 'Tell me what product you want to search for first.', products: null });
            }
            // Prefer revealing more from the last API call (no new network request).
            const list = Array.isArray(session.lastProducts) ? session.lastProducts : [];
            const revealFrom = Number.isFinite(session.lastRevealCount) ? session.lastRevealCount : 0;
            const nextChunk = list.slice(revealFrom, revealFrom + 3);
            if (nextChunk.length) {
                session.lastRevealCount = revealFrom + nextChunk.length;
                return res.json({
                    reply: `More results for “${session.lastQuery}”.`,
                    products: nextChunk,
                    facets: session.lastFacets || [],
                    search: { text: session.lastQuery, filters: session.lastFilters || null },
                    meta: { fromCache: true }
                });
            }

            // If we don't have any cached items to reveal, fall back to fetching the next page.
            session.lastPage = Number.isFinite(session.lastPage) ? session.lastPage + 1 : 1;
            const { productsPayload, facets } = await runSearch(session.lastQuery, {
                currentPage: session.lastPage,
                pageSize: PREFETCH_PAGE_SIZE,
                filters: session.lastFilters || undefined
            });
            if (!productsPayload.length) {
                return res.json({ reply: `No more results for “${session.lastQuery}”. Try a new search.`, products: null });
            }
            return res.json({ reply: `More results for “${session.lastQuery}”.`, products: productsPayload, facets, search: { text: session.lastQuery, filters: session.lastFilters || null } });
        }

        if (intent.action === 'search') {
            const query = forcedSearch?.text
                ? String(forcedSearch.text).trim()
                : (intent.query || extractSearchQuery(userMessage) || heuristicSearchQuery(userMessage) || userMessage);

            const forcedFilters = forcedSearch?.filters && typeof forcedSearch.filters === 'object'
                ? forcedSearch.filters
                : null;

            const explicitNewSearch = Boolean(
                !forcedSearch && (
                    /^\s*(search\s*:|search\s+for\b|find\b|look\s+for\b|looking\s+for\b|i\s+(?:want|need)\b|can\s+you\s+(?:show|find)\s+me\b)/i.test(userMessage) ||
                    (typeof intent.query === 'string' && intent.query.trim()) ||
                    (extractSearchQuery(userMessage))
                )
            );

            // Natural-language refinement over the *previous* search.
            // Support simple follow-ups like "black", "XS", "under 50" based on last returned facets.
            // IMPORTANT: if the user explicitly asked to search again, do NOT refine the prior search.
            const facetFromTextCandidate = (!forcedSearch && !explicitNewSearch && session.lastQuery)
                ? extractFacetSelectionsFromText(userMessage, session.lastFacets)
                : null;
            const priceFromTextCandidate = (!forcedSearch && !explicitNewSearch && session.lastQuery)
                ? parsePriceFromText(userMessage)
                : null;
            const wantsRefine = Boolean(
                !forcedSearch && !explicitNewSearch && session.lastQuery && (
                    /\b(refine|filter|only|just)\b/i.test(userMessage) ||
                    facetFromTextCandidate ||
                    priceFromTextCandidate
                )
            );
            const facetFromText = wantsRefine ? facetFromTextCandidate : null;
            const priceFromText = wantsRefine ? priceFromTextCandidate : null;

            let queryToUse = wantsRefine ? session.lastQuery : query;
            queryToUse = normalizeFragranceQuery(queryToUse, userMessage);

            // For natural-language searches, proactively rewrite to a concise keyword query.
            if (!forcedSearch && !wantsRefine && genAI) {
                const looksNaturalLanguage = /\b(i\s+(want|need|am\s+looking|m\s+looking)|can\s+you|please|for\s+my|something\s+for)\b/i.test(userMessage) || userMessage.split(/\s+/).filter(Boolean).length >= 7;
                if (looksNaturalLanguage) {
                    try {
                        const rewritten = await rewriteQueryWithGemini(userMessage);
                        if (rewritten && rewritten.length >= 2) queryToUse = rewritten;
                    } catch {
                        // ignore
                    }
                }
            }
            const mergedFilters = forcedSearch
                ? (forcedFilters || {})
                : {
                    ...(session.lastFilters || {}),
                    ...(facetFromText || {}),
                    ...(priceFromText || {})
                };

            session.lastQuery = queryToUse;
            session.lastPage = 0;

            let { productsPayload, facets } = await runSearch(queryToUse, { currentPage: 0, pageSize: PREFETCH_PAGE_SIZE, filters: mergedFilters });
            // If zero results for natural phrases, try rewrite (only if not refining).
            if (!productsPayload.length && !wantsRefine && !forcedSearch) {
                const rewritten = await rewriteQueryWithGemini(queryToUse);
                if (rewritten && rewritten !== queryToUse) {
                    const rewritten2 = normalizeFragranceQuery(rewritten, userMessage);
                    session.lastQuery = rewritten2;
                    ({ productsPayload, facets } = await runSearch(rewritten2, { currentPage: 0, pageSize: PREFETCH_PAGE_SIZE, filters: mergedFilters }));
                }
            }

            // Extra safety: if no results and query had "saint/sent/send" (speech-to-text), retry with scent.
            if (!productsPayload.length && !wantsRefine && !forcedSearch) {
                const normalized = normalizeFragranceQuery(queryToUse, `${userMessage} fragrance scent`);
                if (normalized && normalized !== queryToUse) {
                    session.lastQuery = normalized;
                    ({ productsPayload, facets } = await runSearch(normalized, { currentPage: 0, pageSize: PREFETCH_PAGE_SIZE, filters: mergedFilters }));
                }
            }

            const reply = productsPayload.length
                ? `Here are the top results for “${session.lastQuery}”.`
                : `I couldn't find products for “${queryToUse}”. Try a different keyword.`;

            return res.json({
                reply,
                products: productsPayload,
                facets,
                search: { text: session.lastQuery, filters: session.lastFilters || null }
            });
        }

        if (intent.action === 'add_to_cart' || intent.action === 'buy') {
            const qty = Number.isFinite(intent.qty) ? intent.qty : 1;
            const idx = intent.index || parseIndexFromText(userMessage);
            const skuFromIndex = skuFromIndexOrName(userMessage, idx);
            const sku = resolveCartSku(intent.sku || skuFromIndex, userMessage) || null;
            if (!sku) {
                return res.json({
                    reply: 'Tell me the SKU to add, or search first and say “add/buy first/second/third”.',
                    products: null
                });
            }

            // If the user provided a base code (e.g. A15239), fetch PDP details to offer variant selection.
            // This avoids guessing a variant SKU.
            if (TWC_REAL_CART_ENABLED && isLikelyTwcBaseCode(sku)) {
                const baseCode = guessTwcBaseCode(sku) || sku;
                try {
                    const details = await getTwcDetailsForVariantPicker(baseCode);
                    const swatches = normalizeTwcVariantOptionsFromDetails(details);
                    if (swatches.length) {
                        return res.json({
                            reply: `Choose a colour and size for ${stripHtml(details?.name || baseCode)}.`,
                            products: null,
                            variantPicker: {
                                baseCode,
                                name: stripHtml(details?.name || baseCode),
                                swatches,
                                qty
                            }
                        });
                    }
                } catch (err) {
                    const status = err?.status || null;
                    const details = err?.details || null;
                    return res.status(502).json({
                        reply: `I can’t load variant options for ${baseCode}${status ? ` (${status})` : ''}. Try setting TWC_PRODUCT_REFERER and a full browser User-Agent in .env, then retry.`,
                        products: null,
                        error: { status, details }
                    });
                }

                // Base code without variants => don't attempt add.
                return res.json({
                    reply: `I need a specific variant (size/colour) to add ${baseCode} to the bag.`,
                    products: null
                });
            }

            // If the SKU is from the current TWC search results, use the local demo cart.
            const twcItem = findLastProduct(sku);
            if (twcItem) {
                // If the matched item is only a baseCode (no variant), offer variant picker.
                const isBaseOnly = isLikelyTwcBaseCode(twcItem?.code) || (twcItem?.baseCode && String(twcItem.code).trim().toLowerCase() === String(twcItem.baseCode).trim().toLowerCase());
                if (TWC_REAL_CART_ENABLED && isBaseOnly) {
                    const baseCode = String(twcItem.baseCode || twcItem.code || '').trim();
                    try {
                        const refererUrl = resolveTwcUrl(twcItem?.url || '');
                        const details = await getTwcDetailsForVariantPicker(baseCode, { refererUrl });
                        const swatches = normalizeTwcVariantOptionsFromDetails(details);
                        if (swatches.length) {
                            return res.json({
                                reply: `Choose a colour and size for ${stripHtml(details?.name || baseCode)}.`,
                                products: null,
                                variantPicker: {
                                    baseCode,
                                    name: stripHtml(details?.name || baseCode),
                                    swatches,
                                    qty
                                }
                            });
                        }
                    } catch (err) {
                        const status = err?.status || null;
                        const details = err?.details || null;
                        return res.status(502).json({
                            reply: `I can’t load variant options for ${baseCode}${status ? ` (${status})` : ''}. Try setting TWC_PRODUCT_REFERER and a full browser User-Agent in .env, then retry.`,
                            products: null,
                            error: { status, details }
                        });
                    }

                    return res.json({
                        reply: `I need a specific variant (size/colour) to add ${baseCode} to the bag.`,
                        products: null
                    });
                }

                if (TWC_REAL_CART_ENABLED) {
                    try {
                        const refererUrl = resolveTwcUrl(twcItem?.url || '');
                        const { miniCart } = await twcAddToCartForSession({ session, sku: twcItem.code, qty, refererUrl });
                        const reply = `Added “${miniCart?.product?.name || twcItem.code}” to your bag.`;
                        return res.json({ reply, products: null, miniCart });
                    } catch (err) {
                        if (TWC_REAL_CART_STRICT) {
                            const status = err?.status || err?.response?.status || null;
                            const details = err?.details || err?.response?.data || err?.message || null;
                            return res.status(502).json({
                                reply: `Live add-to-bag failed${status ? ` (${status})` : ''}.`,
                                products: null,
                                error: { status, details }
                            });
                        }
                    }
                }

                const added = addToLocalCartFromLast(sku, qty);
                session.lastCartAdd = { sku, qty: added?.qty || qty, at: new Date().toISOString(), cart: 'local' };
                const followUp = 'Do you want to “checkout” (demo summary only — dummy step) or “add more” items?';
                const reply = `Added ${sku} to your demo cart (dummy step). ${followUp}`;
                return res.json({ reply, products: null });
            }

            // If it looks like a TWC SKU, try a 1-item lookup and add to the local demo cart.
            // This avoids pushing TWC SKUs into SAP OCC (which can validly 400).
            try {
                const r = await searchTwcProducts(sku, { currentPage: 0, pageSize: 5 });
                const payload = toPayload(r.products);
                const wanted = normalizeSkuToken(sku).toLowerCase();
                const exact = payload.find(p => normalizeSkuToken(p?.code).toLowerCase() === wanted) || payload[0] || null;
                if (exact?.code) {
                    if (TWC_REAL_CART_ENABLED) {
                        try {
                            const refererUrl = resolveTwcUrl(exact?.url || '');
                            const { miniCart } = await twcAddToCartForSession({ session, sku: exact.code, qty, refererUrl });
                            return res.json({ reply: `Added “${miniCart?.product?.name || exact.code}” to your bag.`, products: null, miniCart });
                        } catch (err) {
                            if (TWC_REAL_CART_STRICT) {
                                const status = err?.status || err?.response?.status || null;
                                const details = err?.details || err?.response?.data || err?.message || null;
                                return res.status(502).json({
                                    reply: `Live add-to-bag failed${status ? ` (${status})` : ''}.`,
                                    products: null,
                                    error: { status, details }
                                });
                            }
                        }
                    }
                    session.localCart = Array.isArray(session.localCart) ? session.localCart : [];
                    for (let i = 0; i < qty; i++) {
                        session.localCart.push({
                            code: exact.code,
                            name: exact.name,
                            price: exact.price,
                            currency: exact.currency,
                            url: exact.url,
                            image: exact.image,
                            addedAt: new Date().toISOString()
                        });
                    }
                    session.lastCartAdd = { sku: exact.code, qty, at: new Date().toISOString(), cart: 'local' };
                    const followUp = 'Do you want to “checkout” (demo summary only — dummy step) or “add more” items?';
                    return res.json({ reply: `Added ${exact.code} to your demo cart (dummy step). ${followUp}`, products: null });
                }
            } catch {
                // ignore and fall through to SAP
            }

            // Otherwise, fall back to SAP cart.
            await ensureCart();
            await addToCart(sku, qty, session.cart);
            session.lastCartAdd = { sku, qty, at: new Date().toISOString(), cart: 'sap' };
            const reply = intent.action === 'buy'
                ? `Added ${sku} to your cart. Say “checkout” to review your cart.`
                : `I've added item ${sku} to your cart.`;
            return res.json({ reply, products: null });
        }

        if (intent.action === 'smalltalk') {
            if (!genAI) {
                return res.json({ reply: 'Gemini is not configured. Try a product search, or use “web: …” for a web lookup.', products: null });
            }
            const prompt = [
                'You are a helpful SAP Commerce shopping assistant. You CAN search products, add items to cart, show cart, and checkout summary.',
                'Keep replies short and guide the user to actions.',
                `User: ${userMessage}`
            ].join('\n');
            try {
                const response = await genAI.models.generateContent({
                    model: modelName,
                    contents: [{ role: 'user', parts: [{ text: prompt }] }]
                });
                const aiText = (response.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
                return res.json({ reply: aiText || 'How can I help you shop today?', products: null });
            } catch {
                return res.json({ reply: 'Gemini is temporarily unavailable. Try a product search or use “web: …”.', products: null });
            }
        }

        // Fallback: If it looks like a search, do it; otherwise do general chat.
        if (looksLikeFreeTextSearch(userMessage)) {
            session.lastQuery = userMessage;
            session.lastPage = 0;
            const { productsPayload, facets } = await runSearch(userMessage, { currentPage: 0, pageSize: PREFETCH_PAGE_SIZE, filters: session.lastFilters || undefined });
            const reply = productsPayload.length
                ? `Here are the top results for “${userMessage}”.`
                : `I couldn't find products for “${userMessage}”. Try a different keyword.`;
            return res.json({ reply, products: productsPayload, facets, search: { text: session.lastQuery, filters: session.lastFilters || null } });
        }

        if (genAI) {
            try {
                const response = await genAI.models.generateContent({
                    model: modelName,
                    contents: [{ role: 'user', parts: [{ text: userMessage }] }]
                });
                const aiText = (response.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
                return res.json({ reply: aiText || "I didn't catch that — can you rephrase?", products: null });
            } catch {
                return res.json({ reply: 'Gemini is temporarily unavailable. Try a product search or use “web: …”.', products: null });
            }
        }

        // No Gemini: last-resort fallback.
        return res.json({ reply: 'Try a product search, or use “web: …” to search the web.', products: null });
    } catch (err) {
        const status = err?.response?.status || err?.status;
        const rawMessage = err?.message || String(err);
        let parsedMessage;
        if (typeof rawMessage === 'string' && rawMessage.trim().startsWith('{')) {
            try {
                parsedMessage = JSON.parse(rawMessage);
            } catch {
                parsedMessage = undefined;
            }
        }
        const details = err?.response?.data || err?.error || err?.cause || parsedMessage;
        console.error('[ERROR] /chat failed', {
            message: rawMessage,
            status,
            details
        });
        console.log('[ERROR] /chat failed (stdout)', {
            message: rawMessage,
            status
        });
        res.status(500).json({ reply: "Error: " + (err?.message || String(err)) });
    }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Store running at http://localhost:${port}`));
