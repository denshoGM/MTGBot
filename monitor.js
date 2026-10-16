const fs = require("node:fs");

const MAX_PRICE = 90; // soglia per i mazzi standard
const MAX_COLLECTOR_PRICE = 150; // soglia per le Collector's Edition
const STATE_FILE = "state.json";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CARDTRADER_TOKEN = process.env.CARDTRADER_TOKEN;
// Lingue accettate su Cardtrader (codici minuscoli, separati da virgola)
const CARDTRADER_LANGS = (process.env.CARDTRADER_LANGS || "en,it").split(",").map((s) => s.trim());

const AMZ = "https://www.amazon.it/Magic-Gathering-Universes-Beyond-Warhammer/dp/";
const CT = "https://www.cardtrader.com/en-EU/cards/";

const PRODUCTS = [
  { id: "necron-amazon", source: "amazon", name: "Necron Dynasties - Amazon", url: AMZ + "B09ZJBPB34" },
  { id: "tyranid-amazon", source: "amazon", name: "Tyranid Swarm - Amazon", url: AMZ + "B09ZJC7VGB" },

  { id: "necron-cardtrader", source: "cardtrader", blueprintId: 211580, name: "Necron Dynasties - Cardtrader", url: CT + "211580" },
  {
    id: "necron-collector-cardtrader",
    source: "cardtrader",
    blueprintId: 211581,
    name: "Necron Dynasties (Collector's) - Cardtrader",
    url: CT + "211581",
    maxPrice: MAX_COLLECTOR_PRICE,
  },
  { id: "tyranid-cardtrader", source: "cardtrader", blueprintId: 211576, name: "Tyranid Swarm - Cardtrader", url: CT + "211576" },
  {
    id: "tyranid-collector-cardtrader",
    source: "cardtrader",
    blueprintId: 211577,
    name: "Tyranid Swarm (Collector's) - Cardtrader",
    url: CT + "211577",
    maxPrice: MAX_COLLECTOR_PRICE,
  },
];

// ---------- utilità ----------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

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
  const prev = state[product.id] || {};
  const limit = product.maxPrice ?? MAX_PRICE;
  const ok = price !== null && price <= limit;

  if (ok && !prev.notified) {
    await sendTelegram(
      `Possibile offerta: ${product.name}\nPrezzo: €${price.toFixed(2)}\nSpedizione: da verificare\n` +
        `Link: ${product.url}\n\nVerifica disponibilità, lingua e condizioni del venditore.`
    );
    console.log("Notifica inviata.");
  }

  state[product.id] = { notified: ok, lastPrice: price, checkedAt: new Date().toISOString() };
}

// ---------- Amazon ----------

async function checkAmazon(product, state) {
  const res = await fetch(product.url, {
    signal: AbortSignal.timeout(30000),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept-Language": "it-IT,it;q=0.9",
    },
  });
  const html = await res.text();
  console.log(`HTTP ${res.status}, ${html.length} caratteri`);
  if (!res.ok) return console.log("Risposta non valida; stato invariato.");
  if (!/id=["']productTitle["']/.test(html)) return console.log("Pagina prodotto non trovata (captcha?); stato invariato.");

  const block = html.match(/id=["']availability["'][^>]*>([\s\S]{0,3000}?)<\/div>/i);
  const availText = block ? stripTags(block[1]).toLowerCase() : "";
  console.log(`Disponibilità: ${availText.slice(0, 120) || "(vuoto)"}`);

  if (/non disponibile|esaurito|unavailable|out of stock/.test(availText)) {
    state[product.id] = { notified: false, lastPrice: null, checkedAt: new Date().toISOString() };
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

// ---------- Cardtrader (API ufficiale) ----------

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
    state[product.id] = { notified: false, lastPrice: null, checkedAt: new Date().toISOString() };
    return console.log("Nessuna offerta valida.");
  }

  const best = Math.min(...prices);
  console.log(`Prezzo minimo: €${best.toFixed(2)}`);
  await handleResult(product, best, state);
}

// ---------- main ----------

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
