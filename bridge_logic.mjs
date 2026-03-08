import { createLoggedAxios } from './http_log.mjs';
import dotenv from "dotenv";
dotenv.config();

const axios = createLoggedAxios('SAP');

const SAP_BASE_URL = (process.env.SAP_BASE_URL || '').trim();
const SAP_SITE_ID = (process.env.SAP_SITE_ID || '').trim();
const OCC_PATH = (SAP_BASE_URL && SAP_SITE_ID) ? `${SAP_BASE_URL}/occ/v2/${SAP_SITE_ID}` : null;

function requireOccConfig() {
  if (!SAP_BASE_URL) throw new Error('Missing SAP_BASE_URL');
  if (!SAP_SITE_ID) throw new Error('Missing SAP_SITE_ID');
  if (!OCC_PATH) throw new Error('Missing SAP configuration (SAP_BASE_URL/SAP_SITE_ID)');
}

function hasRealSapUserCreds() {
  const username = process.env.SAP_USERNAME;
  const password = process.env.SAP_PASSWORD;
  return Boolean(
    username &&
    password &&
    !String(username).startsWith('your-') &&
    !String(password).startsWith('your-')
  );
}

function getOccUserId() {
  if (hasRealSapUserCreds()) return String(process.env.SAP_USERNAME);
  const configured = (process.env.SAP_USER_ID || '').trim();
  return configured || 'anonymous';
}

function getOccCartIdForUrl(cart) {
  // For anonymous carts, OCC typically expects GUID as the cart identifier.
  if (!hasRealSapUserCreds() && cart?.guid) return cart.guid;
  return cart?.code || cart?.guid;
}

async function getSapToken() {
  if (!SAP_BASE_URL) {
    throw new Error('Missing SAP_BASE_URL');
  }

  const authUrl = `${SAP_BASE_URL}/authorizationserver/oauth/token`;
  const clientId = process.env.SAP_CLIENT_ID;
  const clientSecret = process.env.SAP_CLIENT_SECRET;
  const username = process.env.SAP_USERNAME;
  const password = process.env.SAP_PASSWORD;

  if (!clientId || !clientSecret) {
    throw new Error('Missing SAP_CLIENT_ID or SAP_CLIENT_SECRET');
  }

  // Prefer client_credentials unless real user creds are provided.
  const grantType = hasRealSapUserCreds() ? 'password' : 'client_credentials';

  const params = new URLSearchParams({ grant_type: grantType });
  if (grantType === 'password') {
    if (!username || !password) {
      throw new Error('Missing SAP_USERNAME or SAP_PASSWORD for password grant');
    }
    params.set('username', username);
    params.set('password', password);
  }
  if (process.env.SAP_OAUTH_SCOPE) {
    params.set('scope', process.env.SAP_OAUTH_SCOPE);
  }

  const res = await axios.post(authUrl, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    auth: clientId && clientSecret ? { username: clientId, password: clientSecret } : undefined
  });
  return res.data.access_token;
}

export async function checkSapOAuthAndOcc() {
  const checkedAt = new Date().toISOString();
  try {
    requireOccConfig();
    const token = await getSapToken();
    // Verify the token also works against OCC (lightweight call).
    const res = await axios.get(`${OCC_PATH}/products/search`, {
      params: {
        query: 'camera',
        currentPage: 0,
        pageSize: 1,
        fields: 'products(name,code)'
      },
      headers: { Authorization: `Bearer ${token}` }
    });

    const count = Array.isArray(res.data?.products) ? res.data.products.length : 0;
    return { ok: true, checkedAt, details: { token: true, occ: true, sampleCount: count } };
  } catch (err) {
    return {
      ok: false,
      checkedAt,
      error: err?.response?.data || err?.message || String(err)
    };
  }
}

export async function searchProducts(query, { currentPage = 0, pageSize = 3 } = {}) {
  requireOccConfig();
  const token = await getSapToken();
  const res = await axios.get(`${OCC_PATH}/products/search`, {
    params: {
      query,
      currentPage,
      pageSize,
      fields: 'products(name,code,price(formattedValue),stock(stockLevelStatus),images(DEFAULT,url,format))'
    },
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data?.products || [];
}

export async function createCart() {
  requireOccConfig();
  const token = await getSapToken();
  const userId = encodeURIComponent(getOccUserId());
  const res = await axios.post(
    `${OCC_PATH}/users/${userId}/carts`,
    {},
    {
      params: { fields: 'DEFAULT' },
      headers: { Authorization: `Bearer ${token}` }
    }
  );
  return { code: res.data?.code, guid: res.data?.guid };
}

export async function addToCart(sku, qty, cart) {
  requireOccConfig();
  const token = await getSapToken();
  const userId = encodeURIComponent(getOccUserId());
  const cartIdForUrl = getOccCartIdForUrl(cart);
  if (!cartIdForUrl) {
    throw new Error('Missing cart id (guid/code)');
  }
  return await axios.post(
    `${OCC_PATH}/users/${userId}/carts/${encodeURIComponent(cartIdForUrl)}/entries`,
    { product: { code: sku }, quantity: qty },
    {
      params: cart?.guid ? { guid: cart.guid } : undefined,
      headers: { Authorization: `Bearer ${token}` }
    }
  );
}

export async function getCart(cart) {
  requireOccConfig();
  const token = await getSapToken();
  const userId = encodeURIComponent(getOccUserId());
  const cartIdForUrl = getOccCartIdForUrl(cart);
  if (!cartIdForUrl) {
    throw new Error('Missing cart id (guid/code)');
  }
  const res = await axios.get(
    `${OCC_PATH}/users/${userId}/carts/${encodeURIComponent(cartIdForUrl)}`,
    {
      params: {
        fields: 'FULL',
        ...(cart?.guid ? { guid: cart.guid } : {})
      },
      headers: { Authorization: `Bearer ${token}` }
    }
  );
  return res.data;
}
