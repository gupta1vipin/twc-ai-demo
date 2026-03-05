import axios from 'axios';

const DEFAULT_SERPER_URL = 'https://google.serper.dev/search';

export async function serperSearch(query, { apiKey, url, signal } = {}) {
    const q = String(query || '').trim();
    if (!q) {
        return { ok: false, status: 400, error: 'Missing query' };
    }
    const key = String(apiKey || '').trim();
    if (!key) {
        return { ok: false, status: 401, error: 'Missing SERPER_API_KEY' };
    }

    const endpoint = String(url || process.env.SERPER_URL || DEFAULT_SERPER_URL).trim() || DEFAULT_SERPER_URL;

    try {
        const resp = await axios.request({
            method: 'post',
            url: endpoint,
            headers: {
                'X-API-KEY': key,
                'Content-Type': 'application/json'
            },
            data: { q },
            signal,
            timeout: 20_000,
            maxBodyLength: Infinity
        });
        return { ok: true, status: resp.status, data: resp.data };
    } catch (err) {
        const status = err?.response?.status;
        const data = err?.response?.data;
        const message = err?.message || String(err);
        return { ok: false, status: status || 500, error: message, details: data };
    }
}

export function formatSerperTopResults(serperData, { max = 3 } = {}) {
    const organic = Array.isArray(serperData?.organic) ? serperData.organic : [];
    const top = organic.slice(0, Math.max(0, Number(max) || 0));
    const lines = top.map((r, i) => {
        const title = String(r?.title || '').trim();
        const link = String(r?.link || '').trim();
        const snippet = String(r?.snippet || '').trim();
        const head = `${i + 1}. ${title || link || 'Result'}`.trim();
        const parts = [head];
        if (snippet) parts.push(`   ${snippet}`);
        if (link) parts.push(`   ${link}`);
        return parts.join('\n');
    });
    return lines.join('\n');
}
