# CONTRAX Production Starter

This is a production-style starter for your contract reviewer web app.

## What it does
- Upload PDF or image files, or paste contract text
- Extracts text on the server
- Sends the contract to OpenAI for structured risk analysis
- Stores reports in PostgreSQL
- Shows a free scan first
- Uses Stripe Checkout to unlock the full report
- Uses a Stripe webhook to mark the report as paid

## Stack
- Node.js + Express
- PostgreSQL
- OpenAI API
- Stripe Checkout
- pdf-parse
- Tesseract.js
- HTML/CSS/vanilla JS frontend

## Setup
1. Create a PostgreSQL database.
2. Copy `.env.example` to `.env` and fill in your real keys.
3. Install packages:
   ```bash
   npm install
   ```
4. Initialize the database:
   ```bash
   psql "$DATABASE_URL" -f schema.sql
   ```
5. Start the app:
   ```bash
   npm run dev
   ```
6. Open `http://localhost:3000`

## Stripe setup
Create a one-time Stripe Price in your Stripe dashboard and put its ID into `STRIPE_SINGLE_PRICE_ID`.

Start the webhook locally with Stripe CLI:
```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```
Then copy the webhook signing secret into `.env` as `STRIPE_WEBHOOK_SECRET`.

## Important production notes
- This starter keeps the OpenAI key on the server only.
- Stripe Checkout is hosted by Stripe, so you do **not** collect raw card numbers yourself.
- For a full SaaS build, add user authentication before supporting monthly subscriptions or user dashboards.
- For cloud deployment, replace in-memory / temp upload handling with object storage such as S3 if you want file retention.

## Suggested next upgrades
- Add user auth
- Add report history dashboard
- Add admin usage analytics
- Add S3 file storage
- Add email receipts and report links
# contrax
