
const fs = require("node:fs");
const { chromium } = require("playwright");

const MAX_PRICE = 70;
const STATE_FILE = "state.json";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CARDMARKET_USERNAME = process.env.CARDMARKET_USERNAME;
const CARDMARKET_PASSWORD = process.env.CARDMARKET_PASSWORD;

const AMAZON_PRODUCTS = [
  {
    id: "necron-amazon",
    name: "Necron Dynasties - Amazon",
    url: "https://www.amazon.it/Magic-Gathering-Universes-Beyond-Warhammer/dp/B09ZJBPB34",
  },
  {
    id: "tyranid-amazon",
    name: "Tyranid Swarm - Amazon",
    url: "https://www.amazon.it/Magic-Gathering-Universes-Beyond-Warhammer/dp/B09ZJC7VGB",
  },
];

const CARDMARKET_PRODUCTS = [
  {
    id: "necron-cardmarket",
    name: "Necron Dynasties - Cardmarket",
    url: "https://www.cardmarket.com/en/Magic/Products/Preconstructed-Decks/Universes-Beyond-Warhammer-40000-Necron-Dynasties-Commander-Deck",
  },
  {
    id: "tyranid-cardmarket",
    name: "Tyranid Swarm - Cardmarket",
    url: "https://www.cardmarket.com/en/Magic/Products/Preconstructed-Decks/Universes-Beyond-Warhammer-40000-Tyranid-Swarm-Commander-Deck",
  },
];

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

async function sendTelegram(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error("Mancano TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message }),
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.ok) {
    throw new Error(
      `Errore Telegram HTTP ${response.status}: ${
        result.description || "invio non riuscito"
      }`
    );
  }
}

function decodeHtml(value) {
  return String(value)
    .replace(/&euro;|&#8364;|&#x20ac;/gi, "€")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(value) {
  return decodeHtml(String(value).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(value) {
  if (!value) return null;

  const text = decodeHtml(value)
    .replace(/\s/g, "")
    .replace(/[^\d.,]/g, "");

  let normalized;

  if (/^\d{1,3}(?:\.\d{3})+,\d{2}$/.test(text)) {
    normalized = text.replace(/\./g, "").replace(",", ".");
  } else if (/^\d+,\d{2}$/.test(text)) {
    normalized = text.replace(",", ".");
  } else if (/^\d+\.\d{2}$/.test(text)) {
    normalized = text;
  } else {
    return null;
  }

  const price = Number(normalized);
  return Number.isFinite(price) && price > 0 ? price : null;
}

async function notifyIfNeeded(product, price, shipping, state) {
  const previous = state[product.id] || {};
  const qualifies = price !== null && price <= MAX_PRICE;

  if (!qualifies) {
    state[product.id] = {
      ...previous,
      notified: false,
      lastPrice: price,
      checkedAt: new Date().toISOString(),
    };
    return;
  }

  if (previous.notified !== true) {
    const shippingText =
      shipping !== null
        ? `Spedizione: €${shipping.toFixed(2)}\n`
        : "";

    const totalText =
      shipping !== null
        ? `Totale prodotto + spedizione: €${(price + shipping).toFixed(2)}\n`
        : "";

    await sendTelegram(
      `Possibile offerta: ${product.name}\n` +
        `Prezzo rilevato: €${price.toFixed(2)}\n` +
        shippingText +
        totalText +
        `Link: ${product.url}\n\n` +
        "Verifica disponibilità, lingua del prodotto e condizioni del venditore."
    );

    console.log(`Notifica Telegram inviata: ${product.name}`);
  } else {
    console.log(`Offerta già notificata: ${product.name}`);
  }

  state[product.id] = {
    notified: true,
    lastPrice: price,
    checkedAt: new Date().toISOString(),
  };
}

// -------------------- AMAZON --------------------

async function getAmazonPage(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  return {
    status: response.status,
    finalUrl: response.url,
    html: await response.text(),
  };
}

function extractAmazonAvailability(html) {
  const match = html.match(
    /<[^>]*id=["']availability["'][^>]*>([\s\S]{0,5000})/i
  );

  const details = match ? stripTags(match[1]).slice(0, 1000) : "";
  const text = details.toLowerCase();

  if (
    /attualmente non disponibile|temporaneamente esaurito|non disponibile|currently unavailable|out of stock|temporarily out of stock/.test(
      text
    )
  ) {
    return { status: "unavailable", details };
  }

  if (/disponibile|in stock|usually ships|spedito entro|consegna/.test(text)) {
    return { status: "available", details };
  }

  if (
    /id=["']add-to-cart-button["']/.test(html) &&
    !/non disponibile|out of stock/i.test(details)
  ) {
    return {
      status: "available",
      details: "Pulsante aggiunta al carrello presente",
    };
  }

  return { status: "unknown", details };
}

function extractAmazonPrice(html) {
  const ids = [
    "corePrice_feature_div",
    "corePriceDisplay_desktop_feature_div",
    "corePrice_desktop",
    "apex_desktop",
    "priceblock_ourprice",
    "priceblock_dealprice",
    "price_inside_buybox",
  ];

  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = html.match(
      new RegExp(`<[^>]*id=["']${escaped}["'][^>]*>`, "i")
    );

    if (!match || match.index === undefined) continue;

    const block = html.slice(match.index, match.index + 30000);

    for (const priceMatch of block.matchAll(
      /<span\b[^>]*class=["'][^"']*\ba-offscreen\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi
    )) {
      const price = parsePrice(stripTags(priceMatch[1]));
      if (price !== null) return price;
    }

    const whole = block.match(
      /class=["'][^"']*\ba-price-whole\b[^"']*["'][^>]*>\s*([\d.,]+)/
    );
    const fraction = block.match(
      /class=["'][^"']*\ba-price-fraction\b[^"']*["'][^>]*>\s*(\d{2})/
    );

    if (whole && fraction) {
      const price = parsePrice(
        `${whole[1].replace(/[.,]/g, "")},${fraction[1]}`
      );
      if (price !== null) return price;
    }
  }

  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const parsed = JSON.parse(match[1]);
      const objects = Array.isArray(parsed) ? parsed : [parsed];

      for (const object of objects) {
        const candidates = [
          object,
          ...(Array.isArray(object["@graph"]) ? object["@graph"] : []),
        ];

        for (const candidate of candidates) {
          const offers = Array.isArray(candidate.offers)
            ? candidate.offers
            : candidate.offers
              ? [candidate.offers]
              : [];

          for (const offer of offers) {
            if (String(offer.priceCurrency).toUpperCase() !== "EUR") continue;
            const price = parsePrice(offer.price);
            if (price !== null) return price;
          }
        }
      }
    } catch {
      // Ignora JSON-LD non valido.
    }
  }

  return null;
}

async function checkAmazon(product, state) {
  console.log(`\nControllo Amazon: ${product.name}`);

  try {
    const { status, finalUrl, html } = await getAmazonPage(product.url);

    console.log(`HTTP: ${status}; HTML: ${html.length} caratteri`);

    if (status < 200 || status >= 300) {
      console.log("Controllo Amazon fallito: risposta HTTP non valida.");
      return;
    }

    if (
      /captcha|robot check|validatecaptcha|automated access|continua con gli acquisti/i.test(
        html
      ) &&
      !/id=["']productTitle["']/.test(html)
    ) {
      console.log("Amazon ha restituito una pagina di verifica.");
      return;
    }

    if (!/B09ZJBPB34|B09ZJC7VGB|productTitle/i.test(html)) {
      console.log(`La pagina potrebbe non essere quella del prodotto: ${finalUrl}`);
    }

    const availability = extractAmazonAvailability(html);
    console.log(`Disponibilità: ${availability.status}`);

    if (availability.details) {
      console.log(`Dettagli: ${availability.details}`);
    }

    if (availability.status === "unknown") {
      console.log("Disponibilità non verificabile; stato invariato.");
      return;
    }

    if (availability.status === "unavailable") {
      console.log("Prodotto non disponibile.");
      state[product.id] = {
        notified: false,
        lastPrice: null,
        checkedAt: new Date().toISOString(),
      };
      return;
    }

    const price = extractAmazonPrice(html);

    if (price === null) {
      console.log("Disponibile, ma prezzo non trovato; stato invariato.");
      return;
    }

    console.log(`Prezzo Amazon: €${price.toFixed(2)}`);
    await notifyIfNeeded(product, price, null, state);
  } catch (error) {
    console.error(`Errore Amazon ${product.name}: ${error.message}`);
  }
}

// -------------------- CARDMARKET LOGIN --------------------

async function firstVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    try {
      if (await locator.isVisible({ timeout: 1000 })) {
        return locator;
      }
    } catch {
      // Prova il selettore successivo.
    }
  }

  return null;
}

async function loginCardmarket(context) {
  if (!CARDMARKET_USERNAME || !CARDMARKET_PASSWORD) {
    throw new Error(
      "Mancano i secrets CARDMARKET_USERNAME e CARDMARKET_PASSWORD."
    );
  }

  const page = await context.newPage();

  try {
    console.log("Apro la pagina di login Cardmarket.");

    const response = await page.goto(
      "https://www.cardmarket.com/en/Magic/Account/Login",
      {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      }
    );

    const status = response ? response.status() : 0;
    console.log(`HTTP login Cardmarket: ${status}`);

    if (status === 403 || status === 429) {
      throw new Error(
        `Cardmarket ha rifiutato la pagina di login (HTTP ${status}).`
      );
    }

    if (status >= 400) {
      throw new Error(`Pagina di login non accessibile (HTTP ${status}).`);
    }

    const bodyText = await page.locator("body").innerText().catch(() => "");

    if (/captcha|access denied|verify you are human/i.test(bodyText)) {
      throw new Error(
        "Cardmarket richiede una verifica di sicurezza. Login automatico interrotto."
      );
    }

    const usernameInput = await firstVisibleLocator(page, [
      'input[name="username"]',
      'input[name="email"]',
      'input[name="user"]',
      'input[id*="username" i]',
      'input[id*="email" i]',
      'input[autocomplete="username"]',
      'input[type="email"]',
      'input[type="text"]',
    ]);

    const passwordInput = await firstVisibleLocator(page, [
      'input[name="password"]',
      'input[id*="password" i]',
      'input[autocomplete="current-password"]',
      'input[type="password"]',
    ]);

    if (!usernameInput || !passwordInput) {
      throw new Error(
        "Non trovo i campi di login attesi. La pagina o i selettori potrebbero essere cambiati."
      );
    }

    await usernameInput.fill(CARDMARKET_USERNAME);
    await passwordInput.fill(CARDMARKET_PASSWORD);

    const submitButton = await firstVisibleLocator(page, [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'button:has-text("Accedi")',
    ]);

    if (submitButton) {
      await submitButton.click();
    } else {
      await passwordInput.press("Enter");
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(
      () => {}
    );
    await page.waitForTimeout(2000);

    const afterText = await page.locator("body").innerText().catch(() => "");

    if (/captcha|access denied|verify you are human/i.test(afterText)) {
      throw new Error(
        "Cardmarket ha richiesto una verifica di sicurezza dopo il login."
      );
    }

    const passwordStillVisible = await page
      .locator('input[type="password"]')
      .first()
      .isVisible()
      .catch(() => false);

    if (passwordStillVisible) {
      const errorText = await page
        .locator(
          '[role="alert"], .alert-danger, .invalid-feedback, .form-error'
        )
        .allInnerTexts()
        .catch(() => []);

      throw new Error(
        "Login non confermato. " +
          (errorText.join(" ").trim() || "Controlla credenziali e struttura della pagina.")
      );
    }

    console.log("Login Cardmarket completato (da verificare sulle pagine prodotto).");
  } finally {
    await page.close();
  }
}

// -------------------- CARDMARKET PRICES --------------------

async function checkCardmarket(context, product, state) {
  console.log(`\nControllo Cardmarket: ${product.name}`);

  const page = await context.newPage();

  try {
    const response = await page.goto(product.url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    const status = response ? response.status() : 0;
    console.log(`HTTP Cardmarket: ${status}`);

    if (status === 403 || status === 429) {
      console.log("Cardmarket ha rifiutato o limitato la richiesta; stato invariato.");
      return;
    }

    if (status >= 400) {
      console.log(`Controllo fallito: HTTP ${status}; stato invariato.`);
      return;
    }

    const bodyText = await page.locator("body").innerText().catch(() => "");

    if (/captcha|access denied|verify you are human/i.test(bodyText)) {
      console.log("Cardmarket richiede una verifica; stato invariato.");
      return;
    }

    const title = await page.title().catch(() => "");
    console.log(`Titolo pagina: ${title}`);

    const table = page.locator("div.table.article-table");
    const tableCount = await table.count();

    if (tableCount === 0) {
      console.log(
        "Tabella offerte non trovata. Potrebbe essere una pagina di login, un layout cambiato o un prodotto senza offerte; stato invariato."
      );
      return;
    }

    const containers = table.locator(".price-container");
    const count = await containers.count();

    console.log(`Contenitori prezzo trovati: ${count}`);

    if (count === 0) {
      console.log("Nessun prezzo leggibile; stato invariato.");
      return;
    }

    const offers = [];

    for (let i = 0; i < count; i++) {
      const container = containers.nth(i);

      const priceText = await container
        .locator(".color-primary")
        .first()
        .innerText()
        .catch(() => "");

      const shippingText = await container
        .locator(".ms-1")
        .first()
        .innerText()
        .catch(() => "");

      const price = parsePrice(priceText);
      const shipping = parsePrice(shippingText);

      if (price === null) continue;

      offers.push({
        price,
        shipping,
        total: price + (shipping ?? 0),
      });
    }

    if (offers.length === 0) {
      console.log("Nessun prezzo valido trovato; stato invariato.");
      return;
    }

    offers.sort((a, b) => a.total - b.total);
    const best = offers[0];

    console.log(`Offerte valide: ${offers.length}`);
    console.log(`Prezzo articolo: €${best.price.toFixed(2)}`);
    console.log(
      `Spedizione: ${
        best.shipping === null ? "non rilevata" : `€${best.shipping.toFixed(2)}`
      }`
    );
    console.log(`Totale minimo: €${best.total.toFixed(2)}`);

    await notifyIfNeeded(product, best.price, best.shipping, state);
  } catch (error) {
    console.error(`Errore Cardmarket ${product.name}: ${error.message}`);
  } finally {
    await page.close();
  }
}

// -------------------- MAIN --------------------

async function main() {
  console.log("Avvio monitor Warhammer.");
  console.log(`Prezzo massimo articolo: €${MAX_PRICE.toFixed(2)}`);

  const state = loadState();

  for (const product of AMAZON_PRODUCTS) {
    await checkAmazon(product, state);
    saveState(state);
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      locale: "en-GB",
      viewport: { width: 1365, height: 900 },
    });

    try {
      await loginCardmarket(context);

      for (const product of CARDMARKET_PRODUCTS) {
        await checkCardmarket(context, product, state);
        saveState(state);
      }
    } catch (error) {
      console.error(`Login/sessione Cardmarket non disponibile: ${error.message}`);
      console.error(
        "I controlli Cardmarket vengono saltati; lo stato delle offerte non viene azzerato."
      );
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }

  console.log("\nControllo terminato.");
}

main().catch((error) => {
  console.error("Errore fatale:", error);
  process.exitCode = 1;
});
