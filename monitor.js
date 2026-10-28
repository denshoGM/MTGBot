const fs = require("node:fs");

// ============ CONFIGURAZIONE ============

const MAX_PRICE = Number(process.env.MAX_PRICE) || 90; // soglia per i mazzi standard
const MAX_COLLECTOR_PRICE = Number(process.env.MAX_COLLECTOR_PRICE) || 150; // soglia per le Collector's
const MIN_PRICE = 10; // sotto questa cifra il "prezzo" trovato è quasi certamente spazzatura (spedizione, prezzo unitario...)
const HEALTH_ALERT_AFTER = 12; // dopo quanti run consecutivi falliti una fonte ti avvisa su Telegram

// Per aggiungere un prodotto basta incollare qui il link completo.
const AMAZON_URLS = [
  "https://www.amazon.it/Magic-Gathering-Universes-Beyond-Warhammer/dp/B09ZJBPB34",
  "https://www.amazon.it/Magic-Gathering-Universes-Beyond-Warhammer/dp/B09ZJC7VGB",
  "https://www.amazon.de/Magic-Gathering-Universes-Warhammer-Commander/dp/B09ZJC7VGB?th=1",
  "https://www.amazon.de/Magic-Gathering-Beyond-Multiverse-Corruption/dp/B0BMLWH9GX",
  "https://www.amazon.fr/Magic-Gathering-Universes-Beyond-Warhammer/dp/B09ZJC7VGB?th=1",
  "https://www.amazon.fr/Magic-Gathering-Universes-Beyond-Warhammer/dp/B09ZJBPB34?th=1",
  "https://www.amazon.es/Magic-Gathering-Multiverse-Warhammer-Commanders/dp/B09ZJC7VGB?th=1",
  "https://www.amazon.es/Magic-Gathering-Multiverse-Warhammer-Commanders/dp/B09ZJBPB34?th=1",
];

const CARDTRADER_URLS = [
  "https://www.cardtrader.com/en-EU/cards/211580-universes-beyond-warhammer-40-000-necron-dynasties-deck-universes-beyond-warhammer-40-000",
  "https://www.cardtrader.com/en-EU/cards/211581-universes-beyond-warhammer-40-000-necron-dynasties-deck-collector-s-edition-universes-beyond-warhammer-40-000",
  "https://www.cardtrader.com/en-EU/cards/211576-universes-beyond-warhammer-40-000-tyranid-swarm-deck-universes-beyond-warhammer-40-000",
  "https://www.cardtrader.com/en-EU/cards/211577-universes-beyond-warhammer-40-000-tyranid-swarm-deck-collector-s-edition-universes-beyond-warhammer-40-000",
];

// Pagina degli annunci Wizards: ti avvisa quando compare un NUOVO articolo che nomina una di queste parole.
const WIZARDS_ANNOUNCEMENTS_URL = "https://magic.wizards.com/en/news/announcements";
const WIZARDS_KEYWORDS = /warhammer|40k|40,000/i;

// ============ FINE CONFIGURAZIONE ============

const STATE_FILE = "state.json";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CARDTRADER_TOKEN = process.env.CARDTRADER_TOKEN;

const CARDTRADER_LANGS = (process.env.CARDTRADER_LANGS || "en,it")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Costruisce l'elenco prodotti.
const PRODUCTS = [
  ...AMAZON_URLS.map((url) => {
    const asin = url.match(/\/dp\/([A-Z0-9]{10})/)?.[1] || url;
    const site = new URL(url).hostname.split(".").pop();

    return {
      source: "amazon",
      url,
      id: `amazon-${site}-${asin}`,
      name: `Amazon.${site} ${asin}`,
      maxPrice: MAX_PRICE,
    };
  }),

  ...CARDTRADER_URLS.map((url) => {
    const [, blueprintId, slug] =
      url.match(/\/cards\/(\d+)-([^/?#]+)/) || [];

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

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error("Mancano TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID.");
  }

  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
      signal: AbortSignal.timeout(30000),
    }
  );

  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json.ok) {
    throw new Error(
      `Telegram HTTP ${res.status}: ${json.description || "errore"}`
    );
  }
}

function stripTags(html) {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// "1.234,56 €" / "49,90" / "49.90" -> numero
function parsePrice(text) {
  let t = String(text ?? "").replace(/[^\d.,]/g, "");

  if (!t || !/\d/.test(t)) return null;

  const comma = t.lastIndexOf(",");
  const dot = t.lastIndexOf(".");

  if (comma >= 0 && dot >= 0) {
    const decimalSeparator = comma > dot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";

    t = t.split(thousandsSeparator).join("");
    t = t.replace(decimalSeparator, ".");
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? "," : ".";
    const parts = t.split(separator);
    const decimals = parts[parts.length - 1];

    if (decimals.length === 1 || decimals.length === 2) {
      t = parts.slice(0, -1).join("") + "." + decimals;
    } else {
      t = parts.join("");
    }
  }

  const value = Number(t);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Notifica solo la prima volta che il prezzo scende sotto soglia.
async function handleResult(product, price, state) {
  const ok = price >= MIN_PRICE && price <= product.maxPrice;

  if (ok && !state[product.id]?.notified) {
    await sendTelegram(
      `Possibile offerta: ${product.name}\n` +
        `Prezzo: €${price.toFixed(2)}\n` +
        `Spedizione: da verificare\n` +
        `Link: ${product.url}\n\n` +
        `Verifica disponibilità, lingua e condizioni del venditore.`
    );

    console.log("Notifica inviata.");
  }

  state[product.id] = { notified: ok };
}

// Tiene il conto dei run consecutivi in cui una fonte non è leggibile,
// così un blocco silenzioso (captcha, token scaduto...) non passa inosservato.
async function trackHealth(state, id, label, ok) {
  state._health = state._health || {};
  const h = state._health[id] || { fails: 0, alerted: false };

  if (ok) {
    state._health[id] = { fails: 0, alerted: false };
    return;
  }

  h.fails += 1;

  if (h.fails >= HEALTH_ALERT_AFTER && !h.alerted) {
    try {
      await sendTelegram(
        `Attenzione: il monitor non riesce a leggere "${label}" da ${h.fails} controlli consecutivi. ` +
          `Controlla i log (possibile blocco anti-bot, token scaduto o pagina cambiata).`
      );
      h.alerted = true;
    } catch (e) {
      console.error(`Avviso salute non inviato: ${e.message}`);
    }
  }

  state._health[id] = h;
}

// ============ ANNUNCI UFFICIALI WIZARDS ============
// Ritorna true se la pagina è stata letta e interpretata.

async function checkWizardsAnnouncements(state) {
  const key = "wizards-announcements";

  const res = await fetch(WIZARDS_ANNOUNCEMENTS_URL, {
    signal: AbortSignal.timeout(30000),
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  console.log(`HTTP ${res.status}`);

  if (!res.ok) {
    console.log("Pagina non raggiungibile; stato invariato.");
    return false;
  }

  const html = await res.text();

  // Solo link a un articolo vero (con slug), ignora il link generico "Announcements".
  const links = [
    ...html.matchAll(
      /href=["'](?:https?:\/\/magic\.wizards\.com)?(\/en\/news\/announcements\/[a-z0-9][a-z0-9-]*)\/?["']/gi
    ),
  ];

  const articles = new Map();

  links.forEach((m, i) => {
    const end = Math.min(links[i + 1]?.index ?? Infinity, m.index + 3000);
    const text = stripTags(html.slice(m.index, end));
    articles.set(m[1], `${articles.get(m[1]) || ""} ${text}`);
  });

  if (articles.size === 0) {
    console.log(
      "Nessun articolo trovato: struttura della pagina cambiata; stato invariato."
    );
    return false;
  }

  console.log(`Articoli letti: ${articles.size}`);

  // Primo run: memorizza gli articoli esistenti senza notificare vecchie notizie.
  if (!state[key]) {
    state[key] = { seen: [...articles.keys()].slice(0, 100) };
    console.log("Primo avvio: articoli esistenti memorizzati, nessuna notifica.");
    return true;
  }

  const seen = state[key].seen || [];
  const fresh = [...articles.keys()].filter((path) => !seen.includes(path));

  const matches = fresh.filter((path) =>
    WIZARDS_KEYWORDS.test(`${path} ${articles.get(path)}`)
  );

  console.log(
    `Nuovi: ${fresh.length}, che nominano Warhammer: ${matches.length}`
  );

  const notified = new Set();

  for (const path of matches) {
    const title = path.split("/").pop().replace(/-/g, " ");

    try {
      await sendTelegram(
        `Nuovo annuncio ufficiale Wizards che cita Warhammer:\n` +
          `${title}\nLink: https://magic.wizards.com${path}`
      );
      notified.add(path);
      console.log(`Notifica inviata: ${path}`);
    } catch (e) {
      // Non segnarlo come "visto": riproverà al prossimo giro.
      console.error(`Notifica fallita per ${path}: ${e.message}`);
    }
  }

  const toMark = [...articles.keys()].filter(
    (p) => !matches.includes(p) || notified.has(p)
  );

  state[key] = {
    seen: [...new Set([...toMark, ...seen])].slice(0, 100),
  };

  return true;
}

// ============ AMAZON ============
// Ritorna true se la pagina prodotto è stata letta davvero.

const AMAZON_UNAVAILABLE =
  /non disponibile|no disponible|esaurito|agotado|indisponible|rupture de stock|nicht verfügbar|nicht auf lager|ausverkauft|unavailable|out of stock/i;

function amazonLanguage(url) {
  const langs = {
    de: "de-DE,de;q=0.9,en;q=0.7",
    fr: "fr-FR,fr;q=0.9,en;q=0.7",
    es: "es-ES,es;q=0.9,en;q=0.7",
  };

  return (
    langs[new URL(url).hostname.split(".").pop()] ||
    "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7"
  );
}

// Indicatori tipici di pagine di verifica o anti-bot.
function isAmazonChallenge(html) {
  return (
    /<form\b[^>]*action\s*=\s*["']?[^"'\s>]*(?:validateCaptcha|captcha)/i.test(html) ||
    /id=["']captchacharacters["']/i.test(html) ||
    /name=["']amzn-captcha-verify["']/i.test(html) ||
    /enter the characters you see below/i.test(html) ||
    /sorry.{0,80}robot/i.test(html) ||
    /to discuss automated access/i.test(html)
  );
}

// Opzionale: servizio esterno (ScraperAPI, ZenRows, ScrapingBee...) o proxy residenziale che
// scarica la pagina al posto tuo. Esempio di secret/variabile:
//   AMAZON_FETCH_URL_TEMPLATE=https://api.scraperapi.com/?api_key=LATUACHIAVE&url={url}
const AMAZON_FETCH_TEMPLATE = process.env.AMAZON_FETCH_URL_TEMPLATE;

function amazonTarget(url) {
  return AMAZON_FETCH_TEMPLATE
    ? AMAZON_FETCH_TEMPLATE.replace("{url}", encodeURIComponent(url))
    : url;
}

// Cookie di sessione per marketplace. Dopo il "Continua con gli acquisti" Amazon
// assegna i cookie che permettono di vedere le pagine prodotto: li riusiamo per tutti i link dello stesso sito.
const jars = new Map();

function jarFor(host) {
  if (!jars.has(host)) jars.set(host, new Map());
  return jars.get(host);
}

function storeCookies(host, res) {
  const set =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [];
  const jar = jarFor(host);

  for (const c of set) {
    const pair = c.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }

  return set.length;
}

function cookieHeader(host) {
  return [...jarFor(host)].map(([k, v]) => `${k}=${v}`).join("; ");
}

function amazonHeaders(url) {
  const host = new URL(url).hostname;

  const headers = {
    "User-Agent": UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": amazonLanguage(url),
    "Cache-Control": "max-age=0",
    "Upgrade-Insecure-Requests": "1",
    "sec-ch-ua":
      '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    Referer: `https://${host}/`,
  };

  const cookie = cookieHeader(host);
  if (cookie) headers.Cookie = cookie;

  return headers;
}

// GET con redirect gestiti a mano, per non perdere i cookie impostati nei passaggi intermedi.
async function amazonGet(url, maxHops = 6) {
  let current = url;

  for (let hop = 0; hop <= maxHops; hop++) {
    const host = new URL(current).hostname;

    const res = await fetch(hop === 0 ? amazonTarget(current) : current, {
      redirect: AMAZON_FETCH_TEMPLATE ? "follow" : "manual",
      signal: AbortSignal.timeout(45000),
      headers: amazonHeaders(current),
    });

    storeCookies(host, res);

    const loc = res.headers.get("location");

    if (!AMAZON_FETCH_TEMPLATE && res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).href;
      continue;
    }

    return { res, html: await res.text() };
  }

  throw new Error("Troppi redirect");
}

// Riassunto breve di una pagina non riconosciuta, per capire dai log cosa risponde Amazon.
function describeHtml(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  const body = stripTags(html).slice(0, 160);
  return `title="${stripTags(title).slice(0, 80)}" testo="${body}"`;
}

// La pagina "Fai clic sul pulsante qui sotto per continuare a fare acquisti" non è un captcha vero:
// è un form con campi nascosti che basta inviare. Un captcha vero (con immagine) invece no.
function isAmazonClickThrough(html) {
  return (
    isAmazonChallenge(html) &&
    !/captchacharacters|amzn-captcha-verify|enter the characters/i.test(html)
  );
}

async function passAmazonClickThrough(html, pageUrl) {
  const form = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/i)?.[0];

  if (!form) {
    console.log("Interstitial Amazon senza form: non so come proseguire.");
    return false;
  }

  const decode = (s) => s.replace(/&amp;/g, "&");

  const formTag = form.match(/<form\b[^>]*>/i)[0];
  const action = decode(
    formTag.match(/action\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)?.slice(1).find(Boolean) ||
      "/errors/validateCaptcha"
  );

  const target = new URL(action, pageUrl);

  // Legge un attributo con o senza virgolette: name="x" / name='x' / name=x
  const attr = (tag, key) => {
    const m = tag.match(
      new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
    );
    return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
  };

  for (const m of form.matchAll(/<input\b[^>]*>/gi)) {
    const name = attr(m[0], "name");
    const value = attr(m[0], "value") ?? "";

    if (name) target.searchParams.set(name, decode(value));
  }

  const host = new URL(pageUrl).hostname;

  const { res } = await amazonGet(target.href);

  console.log(
    `Click su "Continua": HTTP ${res.status}, cookie in sessione: ${jarFor(host).size}`
  );

  return true;
}

async function fetchAmazonHtml(url) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { res, html } = await amazonGet(url);

      console.log(
        `Tentativo ${attempt}: HTTP ${res.status}, ${html.length} caratteri`
      );

      const isProduct =
        /id=["'](?:productTitle|add-to-cart-button|corePrice_feature_div)["']/i.test(
          html
        ) || /id=["']availability["']/i.test(html);

      if (res.ok && isProduct) return html;

      console.log(`Risposta: ${describeHtml(html)}`);

      if (res.status === 404) {
        console.log("404: ASIN non esistente su questo marketplace.");
        return null;
      }

      if (isAmazonClickThrough(html)) {
        console.log('Pagina "continua con gli acquisti": invio il form.');
        await passAmazonClickThrough(html, url);
        continue; // riprova subito con i cookie appena ottenuti
      }

      if (isAmazonChallenge(html)) {
        console.log("Captcha vero di Amazon: da questo IP non si passa.");
      }

      if (attempt < maxAttempts) await sleep(attempt * 4000);
    } catch (e) {
      console.log(`Errore di rete al tentativo ${attempt}: ${e.message}`);
      if (attempt < maxAttempts) await sleep(attempt * 4000);
    }
  }

  return null;
}

// Estrae il prezzo dalle sole zone della pagina che contengono l'offerta principale.
// NON si cerca in tutta la pagina: caroselli e "prodotti correlati" darebbero falsi positivi.
function extractAmazonPrice(html) {
  const anchors = [
    "corePrice_feature_div",
    "corePriceDisplay_desktop_feature_div",
    "apex_desktop",
    "priceToPay",
    "desktop_buybox",
    "buybox",
    "qualifiedBuybox",
    "centerCol",
  ];

  for (const id of anchors) {
    const pos = html.search(new RegExp(`id=["']${id}["']`, "i"));
    if (pos < 0) continue;

    const slice = html.slice(pos, pos + (id === "centerCol" ? 8000 : 4000));

    for (const m of slice.matchAll(
      /class=["'][^"']*\ba-offscreen\b[^"']*["'][^>]*>([^<]*)</gi
    )) {
      const parsed = parsePrice(stripTags(m[1]));
      if (parsed !== null) return parsed;
    }
  }

  return null;
}

async function checkAmazon(product, state) {
  const html = await fetchAmazonHtml(product.url);

  if (!html) {
    console.log(
      "Pagina prodotto non ottenuta (probabile blocco anti-bot); stato invariato."
    );
    return false;
  }

  const title = html.match(
    /id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i
  );

  if (title) {
    product.name = `Amazon: ${stripTags(title[1]).slice(0, 100)}`;
  }

  const pos = html.search(/id=["']availability["']/i);
  const textStart = pos >= 0 ? html.indexOf(">", pos) + 1 : -1;

  const availText =
    textStart > 0
      ? stripTags(html.slice(textStart, textStart + 6000))
          // Elimina eventuali frammenti di tag rimasti (stripTags non li toglie se il tag è tagliato).
          .replace(/<[^>]{0,2000}>?/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase()
          .slice(0, 300)
      : "";
  
  console.log(`Disponibilità: ${availText.slice(0, 120) || "(vuoto)"}`);

  const hasCartButton = /id=["'](?:add-to-cart-button|buy-now-button)["']/i.test(html);
  const hasOutOfStockBlock = /id=["']outOfStock["']/i.test(html);

  // Se c'è un pulsante di acquisto l'articolo è acquistabile; senza pulsante e con
  // testo "non disponibile" (o senza alcun testo di disponibilità) non lo è.
  if (!hasCartButton &&(hasOutOfStockBlock || AMAZON_UNAVAILABLE.test(availText) || !availText)) {
    state[product.id] = { notified: false };
    console.log("Non disponibile.");
    return true;
  }

  const price = extractAmazonPrice(html);

  if (price === null) {
    // Pagina letta bene ma senza prezzo e senza pulsante di acquisto: nessuna offerta diretta.
    if (!hasCartButton) {
      state[product.id] = { notified: false };
      console.log("Nessuna offerta acquistabile (niente pulsante di acquisto né prezzo).");
      return true;
    }

    // C'è il pulsante ma non trovo il prezzo: struttura cambiata, da segnalare.
    console.log("Pulsante di acquisto presente ma prezzo non trovato; stato invariato.");
    return false;
  }

  console.log(`Prezzo: €${price.toFixed(2)}`);

  await handleResult(product, price, state);
  return true;
}

// ============ CARDTRADER (API ufficiale) ============
// L'endpoint restituisce solo le 25 offerte più economiche per blueprint e
// nella valuta del venditore (spesso USD): quindi filtriamo la lingua lato
// server e convertiamo in EUR.

const rateCache = new Map();

async function rateToEur(currency) {
  if (currency === "EUR") return 1;
  if (rateCache.has(currency)) return rateCache.get(currency);

  let rate = null;

  try {
    const res = await fetch(
      `https://api.frankfurter.app/latest?from=${encodeURIComponent(currency)}&to=EUR`,
      { signal: AbortSignal.timeout(15000) }
    );
    const json = await res.json();
    rate = Number(json?.rates?.EUR) || null;
  } catch (e) {
    console.log(`Cambio ${currency}->EUR non disponibile: ${e.message}`);
  }

  rateCache.set(currency, rate);
  return rate;
}

async function checkCardtrader(product, state) {
  if (!CARDTRADER_TOKEN) {
    console.log("Manca CARDTRADER_TOKEN; salto.");
    return false;
  }

  if (!product.blueprintId) {
    console.log("Impossibile ricavare il blueprint id dal link; salto.");
    return false;
  }

  const raw = [];
  let okCalls = 0;
  let totalSeen = 0;

  for (const lang of CARDTRADER_LANGS) {
    const res = await fetch(
      `https://api.cardtrader.com/api/v2/marketplace/products?blueprint_id=${product.blueprintId}&language=${encodeURIComponent(lang)}`,
      {
        headers: {
          Authorization: `Bearer ${CARDTRADER_TOKEN}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(30000),
      }
    );

    console.log(`[${lang}] HTTP ${res.status}`);

    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      console.log(`Errore API (401 = token errato, 429 = troppe richieste): ${body}`);
      await sleep(500);
      continue;
    }

    okCalls++;

    const data = await res.json();
    const list = Array.isArray(data) ? data : Object.values(data).flat();
    totalSeen += list.length;

    for (const o of list) {
      const cents = o.price?.cents ?? o.price_cents;
      const currency = String(
        o.price?.currency ?? o.price_currency ?? "EUR"
      ).toUpperCase();
      const offerLang = o.properties_hash?.mtg_language;

      if (typeof cents !== "number") continue;
      if (offerLang && !CARDTRADER_LANGS.includes(offerLang)) continue;
      if (o.quantity != null && o.quantity < 1) continue;

      raw.push({ value: cents / 100, currency });
    }

    await sleep(300);
  }

  if (okCalls === 0) return false;

  const currencies = [...new Set(raw.map((r) => r.currency))].join(",") || "-";
  console.log(
    `Offerte ${CARDTRADER_LANGS.join("/")}: ${raw.length} valide su ${totalSeen} (valute: ${currencies})`
  );

  const prices = [];

  for (const r of raw) {
    const rate = await rateToEur(r.currency);
    if (rate) prices.push(r.value * rate);
  }

  if (prices.length === 0) {
    state[product.id] = { notified: false };
    console.log("Nessuna offerta valida.");
    return true;
  }

  const best = Math.min(...prices);
  console.log(`Prezzo minimo: €${best.toFixed(2)}`);

  await handleResult(product, best, state);
  return true;
}

// ============ MAIN ============

async function main() {
  const state = loadState();
  const results = [];

  console.log(
    `Monitor Warhammer - soglie: standard €${MAX_PRICE}, collector €${MAX_COLLECTOR_PRICE}`
  );

  console.log("\nAnnunci ufficiali Wizards");

  try {
    const ok = await checkWizardsAnnouncements(state);
    results.push(ok);
    await trackHealth(state, "wizards-announcements", "annunci Wizards", ok);
  } catch (e) {
    console.error(`Errore: ${e.message}`);
    results.push(false);
    await trackHealth(state, "wizards-announcements", "annunci Wizards", false);
  }

  saveState(state);

  for (const product of PRODUCTS) {
    console.log(`\n${product.name}`);

    let ok = false;

    try {
      ok =
        product.source === "amazon"
          ? await checkAmazon(product, state)
          : await checkCardtrader(product, state);
    } catch (e) {
      console.error(`Errore: ${e.message}`);
    }

    results.push(ok);
    await trackHealth(state, product.id, product.name, ok);
    saveState(state);

    if (product.source === "amazon") await sleep(2000);
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\nControlli riusciti: ${results.length - failed}/${results.length}`);

  // Se tutto fallisce il run diventa rosso su GitHub Actions invece di sembrare "ok".
  if (failed === results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("Errore fatale:", e);
  process.exitCode = 1;
});
