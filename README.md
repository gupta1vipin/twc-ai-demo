# TWC AI Demo (SAP Commerce + Gemini)

Small Node/Express demo that combines:
- SAP Commerce OCC (product search + add-to-cart)
- Gemini (general chat / intent routing)
- A simple browser chatbot UI with product tiles, images, and “Add to cart”

## Prerequisites
- Node.js 18+ (recommended: latest LTS)
- SAP Commerce OCC + OAuth endpoints reachable
- A Gemini API key

## Setup
Install dependencies:

```bash
npm install
```

Create a `.env` file in the project root:

```ini
# Gemini
GEMINI_API_KEY=YOUR_KEY
GENAI_MODEL=gemini-2.5-flash-lite

# Optional: Serper (web search)
# Enables chat messages like: "web: apple inc" to return top web results.
SERPER_API_KEY=YOUR_SERPER_KEY

# TWC search
TWC_BASE_URL=https://www.thewhitecompany.com
TWC_SEARCH_URL=https://www.thewhitecompany.com/uk/search/async/search

# Optional: enrich TWC search results with AI-generated 1–2 sentence summaries
TWC_SEARCH_AI_OVERVIEW=true

# Optional: if user asks "show/open product details", open the PDP directly (skip summary tile)
TWC_DIRECT_OPEN_DETAILS=true

# Optional: log TWC API payloads
TWC_DEBUG_LOG=false
TWC_LOG_RAW_RESPONSE=false
TWC_LOG_RAW_MAX_CHARS=12000

# SAP Commerce
SAP_BASE_URL=https://your-sap-host:9002
SAP_SITE_ID=electronics-spa
SAP_CLIENT_ID=your-client-id
SAP_CLIENT_SECRET=your-client-secret

# If you have a real user, set these (enables password grant)
SAP_USERNAME=your-user
SAP_PASSWORD=your-pass

# Optional: if you don't have a real user, the demo uses anonymous by default.
# SAP_USER_ID=anonymous

# Optional
PORT=3000
SAP_OAUTH_SCOPE=
```

## Run
Start the server:

```bash
npm start
```

Open:
- http://localhost:3000

Dev mode (auto-reload):

```bash
npm run dev
```

## Demo usage
- Type (or use the mic button) `tripod` / `show me camera`
- The agent returns up to **3** products as **vertical tiles**, including image + price + stock
- Click **Add to cart** on a tile

The UI shows a “Working…” indicator while backend calls are in-flight.

## API endpoints
- `POST /chat` → `{ reply, products }`
	- `products` is an array of `{ code, name, price, stock, image }` when a product search is detected
- `POST /cart/add` → `{ ok, sku, qty }`
	- Body: `{ "sku": "3429337", "qty": 1 }`
- `GET /cart/sap` → raw SAP OCC cart JSON for the current session (real-time)
- `GET /health/sap` → last SAP OAuth + OCC connectivity check (no Gemini usage)

## Cart behavior
- For SAP items, `show cart`/`checkout` calls SAP OCC in real time (GET cart).
- For TWC items, add-to-cart uses an in-memory demo cart stored in the server session (dummy step; no real checkout).

### Optional: TWC live add-to-cart (server-side proxy)
- If you want the demo to create a *real* bag on `thewhitecompany.com`, set `TWC_REAL_CART_ENABLED=true`.
- The server will first try a no-cookie session seed (GET) and then POST to add-to-cart. If that’s blocked, set `TWC_CART_COOKIE` to a valid Cookie header string from an active browser session.
- When live add-to-cart succeeds, the chat UI renders a small “mini cart” card immediately.

### TWC real-time bag details (browser)
- Say `bag api` (or `bag json`) to open TWC's bag JSON endpoint in a new tab.
- This uses your browser session/cookies on `thewhitecompany.com`, so it reflects what *your browser* sees.
- If you enable the optional live add-to-cart proxy, the demo *can* call `POST /uk/cart/entries` server-side, but it typically requires supplying `TWC_CART_COOKIE`.

## Notes
- `.env` and `node_modules/` are ignored via `.gitignore`.
- For anonymous carts, SAP Commerce OCC typically expects the cart `guid` for add-to-cart operations; this demo handles that.

## Serper web search
- Set `SERPER_API_KEY` and restart.
- In chat, type `web: your query` (or `google: ...`, `serper: ...`).
- If you see rate-limit/quota errors, Serper will return HTTP 429 and the demo will show a friendly message.