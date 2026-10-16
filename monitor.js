
const https = require("https");
const { chromium } = require("playwright");

const MAX_PRICE = 90;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const AMAZON_PRODUCTS = [
  {
    name: "Necron Dynasties - Amazon",
    url: "https://www.amazon.it/Magic-Gathering-Universes-Warhammer-Commander/dp/B09ZJBPB34",
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

  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}`);
  }
}

function notifyOffer(product, lowest) {
  const message =
    `Possibile offerta: ${product.name}\n` +
    `Prezzo rilevato: €${lowest.toFixed(2)}\n` +
    `Soglia: €${MAX_PRICE}\n` +
    `Link: ${product.url}\n\n` +
    `Verifica manualmente disponibilità, venditore e spedizione.`;

  console.log(message);
  return sendTelegram(message);
}

// Amazon: richiesta HTTP diretta, senza Playwright.
function getPage(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
          "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
        },
      },
      (response) => {
        let html = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => (html += chunk));
        response.on("end", () => {
          if (response.statusCode >= 400) {
            reject(new Error(`HTTP ${response.statusCode}: ${url}`));
          } else {
            resolve(html);
          }
        });
      }
    );

    request.setTimeout(30000, () => {
      request.destroy(new Error("Timeout"));
    });

    request.on("error", reject);
  });
}

// Estrae un prezzo soltanto da un elemento selezionato.
async function extractProductPrice(page) {
  const selectors = [
    "#corePrice_feature_div .a-price .a-offscreen",
    "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
    "#price_inside_buybox",
    "[data-testid='price-container']",
    ".article-price",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    try {
      const text = await locator.textContent({ timeout: 1500 });

      if (text) {
        const match = text.replace(/\s/g, "").match(/(\d{1,4}(?:\.\d{3})*,\d{2})/);

        if (match) {
          const price = Number(
            match[1].replace(/\./g, "").replace(",", ".")
          );

          if (Number.isFinite(price) && price > 0) {
            return price;
          }
        }
      }
    } catch {
      console.log("Il selettore può non essere presente sulla pagina.");
    }
  }

  return null;
}

async function checkAmazon(product) {
  console.log(`\nControllo Amazon via HTTP: ${product.name}`);

  try {
    const html = await getPage(product.url);

    // Amazon può restituire pagine di blocco o CAPTCHA.
    if (
      /captcha|robot check|automated access|sorry.*interrupted/i.test(html)
    ) {
      console.log("Amazon ha restituito una pagina di verifica.");
      return;
    }

    // La richiesta HTTP non fornisce un DOM Playwright.
    // Usiamo solo i contenitori prezzo noti di Amazon.
    const priceMatch =
      html.match(
        /id="corePrice_feature_div"[\s\S]{0,5000}?class="a-offscreen">\s*([^<]+)</i
      ) ||
      html.match(
        /id="corePriceDisplay_desktop_feature_div"[\s\S]{0,5000}?class="a-offscreen">\s*([^<]+)</i
      );

    if (!priceMatch) {
      console.log("Prezzo Amazon non individuato in modo affidabile.");
      return;
    }

    const match = priceMatch[1].match(/([\d.]+,\d{2})/);

    if (!match) {
      console.log("Formato del prezzo Amazon non riconosciuto.");
      return;
    }

    const price = Number(match[1].replace(/\./g, "").replace(",", "."));

    if (!Number.isFinite(price) || price <= 0) {
      console.log("Prezzo Amazon non valido.");
      return;
    }

    console.log(`Prezzo Amazon rilevato: €${price.toFixed(2)}`);

    if (price <= MAX_PRICE) {
      await notifyOffer(product, price);
    }
  } catch (error) {
    console.error(`Errore Amazon ${product.name}: ${error.message}`);
  }
}

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
      console.log("Cardmarket ha negato o limitato l'accesso.");
      return;
    }

    if (status >= 400) {
      console.log(`Pagina non disponibile: HTTP ${status}`);
      return;
    }

    await page.waitForTimeout(2000);

    const title = await page.title();
    console.log(`Titolo pagina: ${title}`);

    const bodyText = await page.locator("body").innerText()
      .catch(() => "");

    if (/captcha|access denied|verify you are human/i.test(bodyText)) {
      console.log("Cardmarket richiede una verifica aggiuntiva.");
      return;
    }

    const price = await extractProductPrice(page);

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

async function main() {
  console.log("Avvio monitor Warhammer.");

  // Amazon usa HTTP diretto, non Playwright.
  for (const product of AMAZON_PRODUCTS) {
    await checkAmazon(product);
  }

  // Chromium è usato soltanto per Cardmarket.
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
  console.error(error);
  process.exitCode = 1;
});
