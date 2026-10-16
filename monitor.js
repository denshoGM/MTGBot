
const { chromium } = require("playwright");

const MAX_PRICE = 70;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const AMAZON_HOME = "https://www.amazon.it/";

const AMAZON_PRODUCTS = [
  {
    name: "Necron Dynasties - Amazon",
    url: "https://www.amazon.it/Magic-Gathering-Universes-Beyond-Warhammer/dp/B09ZJBPB34",
  },
  {
    name: "Tyranid Swarm - Amazon",
    url: "https://www.amazon.it/Magic-Gathering-Universes-Beyond-Warhammer/dp/B09ZJC7VGB",
  },
];

const CARDMARKET_PRODUCTS = [
  {
    name: "Necron Dynasties - Cardmarket",
    url: "https://www.cardmarket.com/en/Magic/Products/Preconstructed-Decks/Universes-Beyond-Warhammer-40000-Necron-Dynasties-Commander-Deck",
  },
  {
    name: "Tyranid Swarm - Cardmarket",
    url: "https://www.cardmarket.com/en/Magic/Products/Preconstructed-Decks/Universes-Beyond-Warhammer-40000-Tyranid-Swarm-Commander-Deck",
  },
];

// ---------------- TELEGRAM ----------------

async function sendTelegram(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error("Mancano TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
      }),
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

async function notifyOffer(product, price) {
  const message =
    `Possibile offerta: ${product.name}\n` +
    `Prezzo rilevato: €${price.toFixed(2)}\n` +
    `Soglia: €${MAX_PRICE}\n` +
    `Link: ${product.url}\n\n` +
    `Verifica manualmente disponibilità, venditore e spedizione.`;

  console.log("\n" + message);
  await sendTelegram(message);
}

// ---------------- AMAZON: HTTP DIRETTO ----------------

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
        "text/html,application/xhtml+xml,application/xml;q=0.9," +
        "image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
    },
  });

  return {
    status: response.status,
    finalUrl: response.url,
    html: await response.text(),
  };
}

async function warmUpAmazon() {
  console.log("\nVisita iniziale Amazon.it via HTTP");

  try {
    const { status, finalUrl, html } = await getAmazonPage(AMAZON_HOME);

    console.log(`Homepage HTTP status: ${status}`);
    console.log(`Homepage URL finale: ${finalUrl}`);
    console.log(`Homepage HTML: ${html.length} caratteri`);

    if (/captcha|robot check|validatecaptcha/i.test(html)) {
      console.log("Amazon ha restituito una verifica anche sulla homepage.");
    }
  } catch (error) {
    console.error(`Errore visita iniziale Amazon: ${error.message}`);
  }
}

// ---------------- ESTRAZIONE PREZZO ----------------

function decodeHtml(value) {
  return value
    .replace(/&euro;|&#8364;|&#x20ac;/gi, "€")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(value) {
  if (value == null) return null;

  const text = String(value)
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

function extractJsonLdPrice(html) {
  const scripts = html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  for (const script of scripts) {
    try {
      const parsed = JSON.parse(script[1].trim());
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
            if (
              String(offer.priceCurrency || "").toUpperCase() !== "EUR"
            ) {
              continue;
            }

            const price = parsePrice(offer.price);
            if (price !== null) return price;
          }
        }
      }
    } catch {
      // Ignora dati JSON-LD non validi.
    }
  }

  return null;
}

function extractAmazonPrice(html) {
  const containerIds = [
    "corePrice_feature_div",
    "corePriceDisplay_desktop_feature_div",
    "corePrice_desktop",
    "apex_desktop",
    "priceblock_ourprice",
    "priceblock_dealprice",
    "price_inside_buybox",
  ];

  for (const id of containerIds) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const match = html.match(
      new RegExp(
        `<[^>]*id=["']${escapedId}["'][^>]*>([\\s\\S]{0,20000}?)<\\/[^>]+>`,
        "i"
      )
    );

    if (!match) continue;

    const block = match[1];

    // Amazon normalmente presenta il prezzo leggibile in a-offscreen.
    for (const element of block.matchAll(
      /<span\b[^>]*class=["'][^"']*\ba-offscreen\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi
    )) {
      const price = parsePrice(stripTags(element[1]));
      if (price !== null) return price;
    }

    // Cerca i componenti del prezzo separati, ad esempio parte intera
    // e decimali. Li accetta solo se sono nello stesso contenitore prezzo.
    const wholeMatch = block.match(
      /class=["'][^"']*\ba-price-whole\b[^"']*["'][^>]*>\s*([\d.,]+)/
    );
    const fractionMatch = block.match(
      /class=["'][^"']*\ba-price-fraction\b[^"']*["'][^>]*>\s*(\d{2})/
    );

    if (wholeMatch && fractionMatch) {
      const whole = wholeMatch[1].replace(/[.,]/g, "");
      const price = parsePrice(`${whole},${fractionMatch[1]}`);
      if (price !== null) return price;
    }
  }

  return extractJsonLdPrice(html);
}

// ---------------- DIAGNOSTICA AMAZON ----------------

function diagnoseAmazonHtml(html) {
  console.log("\n--- DIAGNOSTICA PREZZO AMAZON ---");

  for (const term of [
    "€",
    "a-price",
    "priceToPay",
    "apexPriceToPay",
    "priceblock",
    "buyingPrice",
    "priceAmount",
    "priceCurrency",
    "corePrice",
  ]) {
    const index = html.toLowerCase().indexOf(term.toLowerCase());

    console.log(
      `${term}: ${
        index >= 0
          ? html
              .slice(Math.max(0, index - 250), index + 500)
              .replace(/\s+/g, " ")
          : "non trovato"
      }`
    );
  }

  // Stampa il contenuto dei contenitori di prezzo, non soltanto
  // il primo punto in cui compare la parola "corePrice".
  for (const id of [
    "corePrice_desktop",
    "corePrice_feature_div",
    "corePriceDisplay_desktop_feature_div",
    "apex_desktop",
    "buybox",
    "price",
  ]) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const match = html.match(
      new RegExp(
        `<[^>]*id=["']${escapedId}["'][^>]*>`,
        "i"
      )
    );

    console.log(`\n--- BLOCCO ${id} ---`);

    if (!match || match.index == null) {
      console.log("ID non trovato");
      continue;
    }

    console.log(
      html
        .slice(match.index, match.index + 12000)
        .replace(/\s+/g, " ")
    );
  }

  console.log("\n--- FINE DIAGNOSTICA ---\n");
}

async function checkAmazon(product) {
  console.log(`\nControllo Amazon via HTTP: ${product.name}`);

  try {
    const { status, finalUrl, html } = await getAmazonPage(product.url);

    console.log(`HTTP status: ${status}`);
    console.log(`URL finale: ${finalUrl}`);
    console.log(`Dimensione HTML: ${html.length} caratteri`);

    if (status < 200 || status >= 300) {
      console.log("Amazon non ha restituito una risposta valida.");
      return;
    }

    if (
      /captcha|robot check|validatecaptcha|automated access|sorry.*interrupted/i.test(
        html
      )
    ) {
      console.log("Amazon ha restituito una pagina di verifica.");
      console.log(`Inizio risposta: ${stripTags(html).slice(0, 300)}`);
      return;
    }

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

    console.log(
      `Titolo pagina: ${
        titleMatch ? stripTags(titleMatch[1]) : "non trovato"
      }`
    );

    const price = extractAmazonPrice(html);

    if (price === null) {
      console.log("Prezzo Amazon non individuato.");
      console.log(
        "Indicatori: " +
          JSON.stringify({
            hasProductTitle: /id=["']productTitle["']/i.test(html),
            hasCorePrice: /corePrice_feature_div/i.test(html),
            hasDesktopPrice: /corePriceDisplay_desktop_feature_div/i.test(html),
            hasOffscreenPrice: /a-offscreen/i.test(html),
            hasJsonLd: /application\/ld\+json/i.test(html),
            possibleUnavailable:
              /currently unavailable|temporarily out of stock|non disponibile/i.test(
                html
              ),
          })
      );

      diagnoseAmazonHtml(html);
      return;
    }

    console.log(`Prezzo Amazon rilevato: €${price.toFixed(2)}`);

    if (price <= MAX_PRICE) {
      await notifyOffer(product, price);
    } else {
      console.log("Prezzo superiore alla soglia.");
    }
  } catch (error) {
    console.error(`Errore Amazon ${product.name}: ${error.message}`);
  }
}

// ---------------- CARDMARKET: PLAYWRIGHT ----------------

async function checkCardmarket(browser, product) {
  console.log(`\nControllo Cardmarket via Playwright: ${product.name}`);

  const page = await browser.newPage({
    locale: "it-IT",
    viewport: { width: 1365, height: 900 },
  });

  try {
    const response = await page.goto(product.url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    const status = response ? response.status() : 0;
    console.log(`HTTP status: ${status}`);

    if (status === 403 || status === 429) {
      console.log(
        "Cardmarket ha rifiutato o limitato la richiesta. Prezzo non verificato."
      );
      return;
    }

    if (status >= 400) {
      console.log(`Pagina non disponibile: HTTP ${status}`);
      return;
    }

    const bodyText = await page.locator("body").innerText().catch(() => "");

    if (/captcha|access denied|verify you are human/i.test(bodyText)) {
      console.log("Cardmarket richiede una verifica aggiuntiva.");
      return;
    }

    const selectors = [
      ".article-price",
      ".price-container .price",
      "[data-testid='price-container']",
    ];

    let price = null;

    for (const selector of selectors) {
      try {
        const text = await page.locator(selector).first().innerText({
          timeout: 1500,
        });

        price = parsePrice(text);
        if (price !== null) break;
      } catch {
        // Prova il selettore successivo.
      }
    }

    if (price === null) {
      console.log("Prezzo Cardmarket non individuato in modo affidabile.");
      return;
    }

    console.log(`Prezzo Cardmarket rilevato: €${price.toFixed(2)}`);

    if (price <= MAX_PRICE) {
      await notifyOffer(product, price);
    }
  } catch (error) {
    console.error(`Errore Cardmarket ${product.name}: ${error.message}`);
  } finally {
    await page.close();
  }
}

// ---------------- AVVIO ----------------

async function main() {
  console.log("Avvio monitor Warhammer.");

  await warmUpAmazon();

  for (const product of AMAZON_PRODUCTS) {
    await checkAmazon(product);
  }

  const browser = await chromium.launch({ headless: true });

  try {
    for (const product of CARDMARKET_PRODUCTS) {
      await checkCardmarket(browser, product);
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
