const fs = require("node:fs");

// ============ CONFIGURAZIONE ============

const MAX_PRICE = 90; // soglia per i mazzi standard
const MAX_COLLECTOR_PRICE = 150; // soglia per le Collector's (link Cardtrader con "collector" nel nome)

// Per aggiungere un prodotto basta incollare qui il link completo.
const AMAZON_URLS = [
  "https://www.amazon.it/Magic-Gathering-Universes-Beyond-Warhammer/dp/B09ZJBPB34",
  "https://www.amazon.it/Magic-Gathering-Universes-Beyond-Warhammer/dp/B09ZJC7VGB",
  "https://www.amazon.de/Magic-Gathering-Universes-Warhammer-Commander/dp/B09ZJC7VGB",
  "https://www.amazon.de/-/en/Magic-Gathering-Beyond-Multiverse-Corruption/dp/B0BMLWH9GX",
  "https://www.amazon.fr/Magic-Gathering-Universes-Beyond-Warhammer/dp/B09ZJC7VGB",
  "https://www.amazon.fr/Magic-Gathering-Universes-Beyond-Warhammer/dp/B09ZJC7VGB",
];

const CARDTRADER_URLS = [
  "https://www.cardtrader.com/en-EU/cards/211580-universes-beyond-warhammer-40-000-necron-dynasties-deck-universes-beyond-warhammer-40-000",
  "https://www.cardtrader.com/en-EU/cards/211581-universes-beyond-warhammer-40-000-necron-dynasties-deck-collector-s-edition-universes-beyond-warhammer-40-000",
  "https://www.cardtrader.com/en-EU/cards/211576-universes-beyond-warhammer-40-000-tyranid-swarm-deck-universes-beyond-warhammer-40-000",
  "https://www.cardtrader.com/en-EU/cards/211577-universes-beyond-warhammer-40-000-tyranid-swarm-deck-collector-s-edition-universes-beyond-warhammer-40-000",
];

// ============ FINE CONFIGURAZIONE ============

const STATE_FILE = "state.json";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CARDTRADER_TOKEN = process.env.CARDTRADER_TOKEN;
// Lingue accettate su Cardtrader (codici minuscoli, separati da virgola)
const CARDTRADER_LANGS = (process.env.CARDTRADER_LANGS || "en,it").split(",").map((s) => s.trim());

// Costruisce l'elenco prodotti partendo dai link (id, nome e soglia si ricavano dal link).
const PRODUCTS = [
  ...AMAZON_URLS.map((url) => {
    const asin = url.match(/\/dp\/([A-Z0-9]{10})/)?.[1] || url;
    return { source: "amazon", url, id: `amazon-${asin}`, name: `Amazon ${asin}`, maxPrice: MAX_PRICE };
  }),
  ...CARDTRADER_URLS.map((url) => {
    const [, blueprintId, slug] = url.match(/\/cards\/(\d+)-([^/?#]+)/) || [];
    const isCollector = /collector/i.test(slug || "");
    return {
      source: "cardtrader",
      url,
      id: `cardtrader-${blueprintId}`,
      blueprintId,
      name: `Cardtrader ${(slug || url).replace(/-/g, " ")}`,
      maxPrice: isCollector ? MAX_COLLECTOR_PRICE : MAX_PRICE,
    };
  }),
];

// ============ UTILITÀ ============

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

// Lo stato contiene solo { notified: true/false }, quindi il file cambia (e viene committato)
// solo quando una notifica scatta o si azzera.
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error("Mancano TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID.");
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(`Telegram HTTP ${res.status}: ${json.description || "errore"}`);
}

function stripTags(html) {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "1.234,56 €" / "49,90" / "49.90" -> numero
function parsePrice(text) {
  const t = String(text ?? "").replace(/[^\d.,]/g, "");
  let n;
  if (/^\d{1,3}(\.\d{3})+,\d{2}$/.test(t)) n = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d+,\d{2}$/.test(t)) n = t.replace(",", ".");
  else if (/^\d+\.\d{2}$/.test(t)) n = t;
  else return null;
  const v = Number(n);
  return v > 0 ? v : null;
}

// Notifica solo la prima volta che il prezzo scende sotto soglia.
async function handleResult(product, price, state) {
  const ok = price !== null && price <= product.maxPrice;

  if (ok && !state[product.id]?.notified) {
    await sendTelegram(
      `Possibile offerta: ${product.name}\nPrezzo: €${price.toFixed(2)}\nSpedizione: da verificare\n` +
        `Link: ${product.url}\n\nVerifica disponibilità, lingua e condizioni del venditore.`
    );
    console.log("Notifica inviata.");
  }

  state[product.id] = { notified: ok };
}

// ============ AMAZON ============

// Amazon a volte risponde con una pagina di verifica (breve, senza productTitle): riprova fino a 3 volte.
async function fetchAmazonHtml(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(30000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
          "Upgrade-Insecure-Requests": "1",
        },
      });
      const html = await res.text();
      console.log(`Tentativo ${attempt}: HTTP ${res.status}, ${html.length} caratteri`);
      if (res.ok && /id=["']productTitle["']/.test(html)) return html;
    } catch (e) {
      console.log(`Tentativo ${attempt}: ${e.message}`);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
  return null;
}

async function checkAmazon(product, state) {
  const html = await fetchAmazonHtml(product.url);
  if (!html) return console.log("Pagina prodotto non ottenuta (verifica anti-bot?); stato invariato.");

  // Nome leggibile dal titolo della pagina
  const title = html.match(/id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i);
  if (title) product.name = `Amazon: ${stripTags(title[1]).slice(0, 100)}`;

  // Testo subito dopo id="availability", senza script: i primi caratteri bastano.
  const pos = html.search(/id=["']availability["']/i);
  const availText = pos >= 0 ? stripTags(html.slice(pos, pos + 6000)).toLowerCase().slice(0, 300) : "";
  console.log(`Disponibilità: ${availText.slice(0, 120) || "(vuoto)"}`);

  const hasCartButton = /id=["']add-to-cart-button["']/.test(html);

  if (/non disponibile|esaurito|unavailable|out of stock/.test(availText) || (!availText && !hasCartButton)) {
    state[product.id] = { notified: false };
    return console.log("Non disponibile.");
  }

  const start = html.search(/id=["'](corePrice_feature_div|corePriceDisplay_desktop_feature_div|apex_desktop)["']/);
  let price = null;
  if (start >= 0) {
    for (const m of html.slice(start, start + 30000).matchAll(/class=["'][^"']*a-offscreen[^"']*["'][^>]*>([^<]*)</g)) {
      price = parsePrice(m[1]);
      if (price !== null) break;
    }
  }
  if (price === null) return console.log("Prezzo non trovato; stato invariato.");

  console.log(`Prezzo: €${price.toFixed(2)}`);
  await handleResult(product, price, state);
}

// ============ CARDTRADER (API ufficiale) ============

async function checkCardtrader(product, state) {
  if (!CARDTRADER_TOKEN) return console.log("Manca CARDTRADER_TOKEN; salto.");

  const res = await fetch(`https://api.cardtrader.com/api/v2/marketplace/products?blueprint_id=${product.blueprintId}`, {
    headers: { Authorization: `Bearer ${CARDTRADER_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  });
  console.log(`HTTP ${res.status}`);
  if (!res.ok) return console.log("Errore API (401 = token errato); stato invariato.");

  const data = await res.json();
  const list = Array.isArray(data) ? data : Object.values(data).flat();

  const prices = [];
  for (const o of list) {
    const cents = o.price?.cents ?? o.price_cents;
    const currency = String(o.price?.currency ?? o.price_currency ?? "EUR").toUpperCase();
    const lang = o.properties_hash?.mtg_language;
    if (typeof cents !== "number" || currency !== "EUR") continue;
    if (lang && !CARDTRADER_LANGS.includes(lang)) continue;
    if (o.quantity != null && o.quantity < 1) continue;
    prices.push(cents / 100);
  }

  console.log(`Offerte ${CARDTRADER_LANGS.join("/")} trovate: ${prices.length} (su ${list.length})`);
  if (prices.length === 0) {
    state[product.id] = { notified: false };
    return console.log("Nessuna offerta valida.");
  }

  const best = Math.min(...prices);
  console.log(`Prezzo minimo: €${best.toFixed(2)}`);
  await handleResult(product, best, state);
}

// ============ MAIN ============

async function main() {
  const state = loadState();
  console.log(`Monitor Warhammer - soglie: standard €${MAX_PRICE}, collector €${MAX_COLLECTOR_PRICE}`);

  for (const product of PRODUCTS) {
    console.log(`\n${product.name}`);
    try {
      if (product.source === "amazon") await checkAmazon(product, state);
      else await checkCardtrader(product, state);
    } catch (e) {
      console.error(`Errore: ${e.message}`);
    }
    saveState(state);
  }
}

main().catch((e) => {
  console.error("Errore fatale:", e);
  process.exitCode = 1;
});
