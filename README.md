# S&B Fabrics

| Address | What it is | Who uses it |
|---|---|---|
| `https://<your-github-name>.github.io/sandbfabrics/` | The online shop | Customers |
| `https://<your-github-name>.github.io/sandbfabrics/app/` | The staff app: till, stock, orders, quotations and invoices | Staff |

All data lives in the business Google Sheet. This repo only holds the screens.

## One-time setup
1. Open `config.js` (shop) **and** `app/config.js` (staff app) and paste your Apps Script web app address (ends in `/exec`) between the quotes.
2. Settings → Pages → Deploy from a branch → `main` / `(root)` → Save.
3. In the staff app: **Admin → Settings → ShopURL** = `https://<your-github-name>.github.io/sandbfabrics/`, so share buttons and the QR code use this address.
4. For a picture preview when the shop link is shared on WhatsApp/Facebook: in `index.html` change `content="og-image.png"` to the full address, `content="https://<your-github-name>.github.io/sandbfabrics/og-image.png"`.
5. Connect each staff phone/laptop at `…/sandbfabrics/app/` with a setup code, then install it (**Add to Home screen**). It installs as **S&B Fabrics Staff**; the shop installs separately.

## Updating
Upload the new files over the old ones. Keep your two `config.js` files (they hold your web app address).
