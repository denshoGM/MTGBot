
const https = require("https");

const MAX_PRICE = 90;

// Amazon Italia: link fornito da te.
// Nota: il prodotto potrebbe non essere uno dei due mazzi specifici.
const PRODUCTS = [
  {
    name: "Necron Dynasties - Amazon",
    url: "https://www.amazon.it/Magic-Gathering-Universes-Warhammer-Commander/dp/B09ZJBPB34",
  },
  {
    name: "Tyranid Swarm - Amazon",
    url: "https://www.amazon.it/Magic-Gathering-Universes-Beyond-Warhammer/dp/B09ZJC7VGB",
  },
  {
    name: "Necron Dynasties - Cardmarket",
    url: "https://www.cardmarket.com/en/Magic/Products/Preconstructed-Decks/Universes-Beyond-Warhammer-40000-Necron-Dynasties-Commander-Deck",
  },
  {
    name: "Tyranid Swarm - Cardmarket",
    url: "https://www.cardmarket.com/en/Magic/Products/Preconstructed-Decks/Universes-Beyond-Warhammer-40000-Tyranid-Swarm-Commander-Deck",
  },
];

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function getPage(url) {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; PriceMonitor/1.0)",
          "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
        },
      },
      (res) => {
        let data = "";

        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          } else {
            resolve(data);
          }
        });
      }
    ).on("error", reject);
  });
}

function extractPrices(html) {
  const prices = [];
  const regex = /(?:€\s*|EUR\s*)(\d{1,4}(?:[.,]\d{2})?)/gi;

  for (const match of html.matchAll(regex)) {
    const price = Number(match[1].replace(",", "."));

    if (Number.isFinite(price) && price >= 1 && price <= 2000) {
      prices.push(price);
    }
  }

  return prices;
}

function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    if (!BOT_TOKEN || !CHAT_ID) {
      return reject(
        new Error("Configura TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID su GitHub.")
      );
    }

    const payload = JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
    });

    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`Telegram HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve();
          }
        });
      }
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  for (const product of PRODUCTS) {
    try {
      console.log(`Controllo: ${product.name}`);

      const html = await getPage(product.url);
      const prices = extractPrices(html);
      const eligible = prices.filter((price) => price <= MAX_PRICE);

      if (eligible.length > 0) {
        const lowest = Math.min(...eligible);

        const message =
          `Possibile offerta: ${product.name}\n` +
          `Prezzo rilevato: €${lowest.toFixed(2)}\n` +
          `Soglia: €${MAX_PRICE}\n` +
          `Link: ${product.url}\n\n` +
          `Verifica manualmente disponibilità, venditore e spedizione.`;

        console.log(message);
        await sendTelegram(message);
      } else {
        console.log("Nessun prezzo sotto soglia rilevato.");
      }
    } catch (error) {
      console.error(`Errore su ${product.name}: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

