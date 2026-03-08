import axiosLib from 'axios';

const HTTP_LOG_ENABLED = !/^(0|false|no)$/i.test(String(process.env.HTTP_LOG ?? 'true'));
const HTTP_LOG_BODY_MAX = Math.max(0, Math.min(50_000, Number(process.env.HTTP_LOG_BODY_MAX ?? 800)));

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function redactHeaderValue(key, value) {
  const k = String(key || '').toLowerCase();
  if (!value) return value;
  if (
    k === 'authorization' ||
    k === 'cookie' ||
    k === 'set-cookie' ||
    k === 'x-api-key' ||
    k === 'apikey' ||
    k === 'api-key'
  ) {
    return '[redacted]';
  }
  return value;
}

function redactHeaders(headers) {
  const h = headers && typeof headers === 'object' ? headers : {};
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = redactHeaderValue(k, v);
  }
  return out;
}

function summarizeData(data) {
  if (data === null || data === undefined) return 'none';
  if (typeof data === 'string') {
    const s = data;
    const snippet = s.slice(0, HTTP_LOG_BODY_MAX);
    return `string len=${s.length}${snippet ? ` snippet=${safeJsonStringify(snippet)}` : ''}`;
  }
  if (Buffer.isBuffer(data)) return `buffer bytes=${data.byteLength}`;
  if (Array.isArray(data)) {
    const head = data.length ? data[0] : undefined;
    const headType = head === null ? 'null' : typeof head;
    return `array len=${data.length}${data.length ? ` headType=${headType}` : ''}`;
  }
  if (typeof data === 'object') {
    const keys = Object.keys(data);
    return `json keys=${keys.slice(0, 12).join(',')}${keys.length > 12 ? ',…' : ''}`;
  }
  return typeof data;
}

function buildUrl(config) {
  const baseURL = String(config?.baseURL || '').trim();
  const url = String(config?.url || '').trim();
  if (!url) return baseURL || '';
  if (/^https?:\/\//i.test(url)) return url;
  if (!baseURL) return url;
  return baseURL.replace(/\/$/, '') + (url.startsWith('/') ? url : `/${url}`);
}

let reqSeq = 0;
function nextReqId() {
  reqSeq = (reqSeq + 1) % 1_000_000;
  return String(reqSeq).padStart(6, '0');
}

export function installAxiosLogging(instance, { name = 'EXT' } = {}) {
  if (!HTTP_LOG_ENABLED) return instance;
  const tag = String(name || 'EXT').toUpperCase();

  instance.interceptors.request.use((config) => {
    const id = nextReqId();
    config.__extLog = { id, start: Date.now() };

    const method = String(config.method || 'GET').toUpperCase();
    const fullUrl = buildUrl(config);

    let urlObj = null;
    try { urlObj = new URL(fullUrl); } catch { urlObj = null; }

    const path = urlObj ? `${urlObj.origin}${urlObj.pathname}` : fullUrl;
    const qKeys = urlObj ? Array.from(urlObj.searchParams.keys()) : [];

    const headers = redactHeaders(config.headers);
    const headerKeys = Object.keys(headers).slice(0, 12);

    const hasData = config.data !== undefined && config.data !== null;
    const dataSummary = hasData ? summarizeData(config.data) : 'none';

    console.log(`[EXT] --> [${tag}]#${id} ${method} ${path}${qKeys.length ? ` ?keys=${qKeys.slice(0, 12).join(',')}${qKeys.length > 12 ? ',…' : ''}` : ''} headers=${headerKeys.join(',')}${headerKeys.length ? '' : 'none'} body=${dataSummary}`);
    return config;
  });

  instance.interceptors.response.use(
    (response) => {
      const meta = response?.config?.__extLog;
      const id = meta?.id || '??????';
      const ms = meta?.start ? (Date.now() - meta.start) : null;
      const status = response?.status;
      const dataSummary = summarizeData(response?.data);
      const bytes = (() => {
        const d = response?.data;
        if (typeof d === 'string') return d.length;
        if (Buffer.isBuffer(d)) return d.byteLength;
        return null;
      })();
      console.log(`[EXT] <-- [${tag}]#${id} ${status}${ms !== null ? ` ${ms}ms` : ''}${bytes !== null ? ` bytes=${bytes}` : ''} ${dataSummary}`);
      return response;
    },
    (err) => {
      const meta = err?.config?.__extLog;
      const id = meta?.id || '??????';
      const ms = meta?.start ? (Date.now() - meta.start) : null;
      const status = err?.response?.status || err?.status || 'ERR';
      const dataSummary = summarizeData(err?.response?.data);
      const message = String(err?.message || 'request failed');
      console.log(`[EXT] <-- [${tag}]#${id} ${status}${ms !== null ? ` ${ms}ms` : ''} error=${safeJsonStringify(message)} resp=${dataSummary}`);
      throw err;
    }
  );

  return instance;
}

export function createLoggedAxios(name, axiosOptions = {}) {
  const instance = axiosLib.create(axiosOptions);
  return installAxiosLogging(instance, { name });
}

export async function withExternalLog(name, meta, fn) {
  if (!HTTP_LOG_ENABLED) return await fn();
  const tag = String(name || 'EXT').toUpperCase();
  const id = nextReqId();
  const start = Date.now();
  const m = meta && typeof meta === 'object' ? meta : {};
  const summaryBits = Object.entries(m)
    .filter(([k, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .slice(0, 10)
    .map(([k, v]) => `${k}=${String(v).slice(0, 120)}`)
    .join(' ');

  console.log(`[EXT] --> [${tag}]#${id} ${summaryBits || ''}`.trim());
  try {
    const out = await fn();
    const ms = Date.now() - start;
    console.log(`[EXT] <-- [${tag}]#${id} ok ${ms}ms result=${summarizeData(out)}`);
    return out;
  } catch (e) {
    const ms = Date.now() - start;
    console.log(`[EXT] <-- [${tag}]#${id} fail ${ms}ms error=${safeJsonStringify(e?.message || String(e))}`);
    throw e;
  }
}
