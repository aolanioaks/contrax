import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import Tesseract from 'tesseract.js';
import Stripe from 'stripe';
import OpenAI from 'openai';
import { Pool } from 'pg';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 5
  }
});

const requiredEnv = [
  'DATABASE_URL',
  'OPENAI_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_SINGLE_PRICE_ID',
  'STRIPE_SUBSCRIPTION_PRICE_ID',
  'APP_BASE_URL'
];

const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.warn(`Missing env vars: ${missingEnv.join(', ')}`);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PORT = process.env.PORT || 3000;
const appBaseUrl = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const ReportSchema = z.object({
  summary: z.string().min(20),
  overall_risk_level: z.enum(['Low Risk', 'Moderate Risk', 'High Risk']),
  risk_score_1_to_10: z.number().min(1).max(10),
  flagged_clauses: z.array(z.object({
    clause_name: z.string().min(1),
    severity: z.enum(['low', 'medium', 'high']),
    quoted_text: z.string().min(1),
    why_it_matters: z.string().min(1),
    plain_english_explanation: z.string().min(1),
    suggested_revision: z.string().min(1)
  })).max(12),
  missing_protections: z.array(z.string().min(1)).max(8),
  final_recommendation: z.string().min(1)
});

/**
 * IMPORTANT:
 * Before using this file, run these SQL changes once in your database:
 *
 * CREATE TABLE IF NOT EXISTS users (
 *   id SERIAL PRIMARY KEY,
 *   email TEXT UNIQUE NOT NULL,
 *   password TEXT,
 *   stripe_customer_id TEXT,
 *   subscription_status TEXT DEFAULT 'inactive',
 *   created_at TIMESTAMP DEFAULT NOW()
 * );
 *
 * ALTER TABLE reports ADD COLUMN IF NOT EXISTS user_id INTEGER;
 * ALTER TABLE reports ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
 *
 * Optional foreign key:
 * ALTER TABLE reports
 * ADD CONSTRAINT reports_user_id_fkey
 * FOREIGN KEY (user_id) REFERENCES users(id)
 * ON DELETE SET NULL;
 */

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['stripe-signature'];

    const event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const reportId = session.metadata?.reportId;
      const plan = session.metadata?.plan || 'single';
      const email = session.customer_details?.email || session.customer_email || null;
      const stripeCustomerId =
        typeof session.customer === 'string' ? session.customer : session.customer?.id || null;

      console.log('Webhook event type:', event.type);
      console.log('Webhook session id:', session.id);
      console.log('Webhook session metadata:', session.metadata);
      

      let user = null;

      if (email) {
        const existingUser = await pool.query(
          'SELECT * FROM users WHERE email = $1',
          [email]
        );

        if (existingUser.rows.length) {
          user = existingUser.rows[0];

          await pool.query(
            `UPDATE users
             SET stripe_customer_id = COALESCE($1, stripe_customer_id),
                 subscription_status = CASE WHEN $2 = 'monthly' THEN 'active' ELSE subscription_status END
             WHERE id = $3`,
            [stripeCustomerId, plan, user.id]
          );
        } else {
          const createdUser = await pool.query(
            `INSERT INTO users (email, stripe_customer_id, subscription_status)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [email, stripeCustomerId, plan === 'monthly' ? 'active' : 'inactive']
          );
          user = createdUser.rows[0];
        }
      }

      if (reportId) {
        await pool.query(
          `UPDATE reports
           SET unlocked = TRUE,
               stripe_checkout_session_id = $2,
               stripe_payment_status = $3,
               stripe_subscription_id = $4,
               stripe_customer_id = $5,
               customer_email = COALESCE($6, customer_email),
               user_id = COALESCE($7, user_id)
           WHERE id = $1`,
          [
            reportId,
            session.id,
            session.payment_status || 'paid',
            session.subscription || null,
            stripeCustomerId,
            email,
            user?.id || null
          ]
        );

        await pool.query(
          `INSERT INTO payments (
             report_id,
             stripe_checkout_session_id,
             stripe_payment_status,
             amount_cents,
             currency
           )
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (stripe_checkout_session_id)
           DO UPDATE SET stripe_payment_status = EXCLUDED.stripe_payment_status,
                         amount_cents = EXCLUDED.amount_cents,
                         currency = EXCLUDED.currency`,
          [
            reportId,
            session.id,
            session.payment_status || 'paid',
            session.amount_total || null,
            session.currency || 'usd'
          ]
        );
      } else {
        console.warn('Webhook received checkout.session.completed without metadata.reportId');
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, 'public')));

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/reports/analyze', upload.array('files', 5), async (req, res) => {
  try {
    const textInput = (req.body.contractText || '').trim();
    const files = req.files || [];

    if (!files.length && textInput.length < 50) {
      return res.status(400).json({ error: 'Upload a file or paste at least 50 characters of contract text.' });
    }

    const extraction = await extractContractText({ files, textInput });

    if (extraction.text.length < 80) {
      return res.status(400).json({ error: 'Not enough readable contract text was found.' });
    }

    const analysis = await analyzeWithOpenAI(extraction.text);

    const insert = await pool.query(
      `INSERT INTO reports (
        source_type,
        original_filename,
        contract_text,
        summary,
        risk_level,
        risk_score,
        top_risks,
        flagged_clauses,
        missing_protections,
        final_recommendation
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id, created_at`,
      [
        extraction.sourceType,
        extraction.originalFilename,
        extraction.text,
        analysis.summary,
        analysis.overall_risk_level,
        Number(analysis.risk_score_1_to_10.toFixed(1)),
        JSON.stringify(analysis.flagged_clauses.slice(0, 2)),
        JSON.stringify(analysis.flagged_clauses),
        JSON.stringify(analysis.missing_protections),
        analysis.final_recommendation
      ]
    );

    res.json({
      reportId: insert.rows[0].id,
      sourceType: extraction.sourceType,
      fileName: extraction.originalFilename,
      freeResult: {
        summary: analysis.summary,
        overallRiskLevel: analysis.overall_risk_level,
        riskScoreLabel: labelFromRisk(analysis.overall_risk_level),
        topRisks: analysis.flagged_clauses.slice(0, 2),
        totalFlaggedClauses: analysis.flagged_clauses.length,
        wordCount: extraction.text.split(/\s+/).filter(Boolean).length,
        extractedTextPreview: extraction.text.slice(0, 1200)
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Analysis failed.' });
  }
});

app.post('/api/payments/create-checkout-session', async (req, res) => {
  try {
    const { reportId, customerEmail, plan } = req.body;

    if (!reportId) {
      return res.status(400).json({ error: 'Missing reportId.' });
    }

    const reportResult = await pool.query(
      'SELECT id, unlocked FROM reports WHERE id = $1',
      [reportId]
    );
    const report = reportResult.rows[0];

    if (!report) {
      return res.status(404).json({ error: 'Report not found.' });
    }

    if (report.unlocked) {
      return res.json({ alreadyUnlocked: true, redirectUrl: `${appBaseUrl}/?report=${reportId}` });
    }

    const isSubscription = plan === 'monthly';

    let user = null;
    let stripeCustomerId = null;

    if (customerEmail) {
      const existing = await pool.query(
        'SELECT * FROM users WHERE email = $1',
        [customerEmail]
      );

      if (existing.rows.length) {
        user = existing.rows[0];
        stripeCustomerId = user.stripe_customer_id || null;
      } else {
        const created = await pool.query(
          `INSERT INTO users (email)
           VALUES ($1)
           RETURNING *`,
          [customerEmail]
        );
        user = created.rows[0];
      }

      if (!stripeCustomerId) {
        const customer = await stripe.customers.create({
          email: customerEmail
        });

        stripeCustomerId = customer.id;

        await pool.query(
          `UPDATE users
           SET stripe_customer_id = $1
           WHERE id = $2`,
          [stripeCustomerId, user.id]
        );
      }
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer: stripeCustomerId || undefined,
      customer_email: stripeCustomerId ? undefined : customerEmail || undefined,
      line_items: [
        {
          price: isSubscription
            ? process.env.STRIPE_SUBSCRIPTION_PRICE_ID
            : process.env.STRIPE_SINGLE_PRICE_ID,
          quantity: 1
        }
      ],
      mode: isSubscription ? 'subscription' : 'payment',
      metadata: {
        reportId: String(reportId),
        plan: isSubscription ? 'monthly' : 'single',
        userId: user ? String(user.id) : ''
      },
      success_url: `${appBaseUrl}/?report=${reportId}&payment=success`,
      cancel_url: `${appBaseUrl}/?report=${reportId}&payment=cancelled`
    });
    console.log('Stripe checkout session URL:', session.url);
    


    await pool.query(
      `UPDATE reports
       SET stripe_checkout_session_id = $2,
           stripe_customer_id = COALESCE($3, stripe_customer_id),
           customer_email = COALESCE($4, customer_email),
           user_id = COALESCE($5, user_id)
       WHERE id = $1`,
      [reportId, session.id, stripeCustomerId, customerEmail || null, user?.id || null]
    );

    res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Could not create Stripe checkout session.' });
  }
});

app.post('/api/create-billing-portal', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const userResult = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = userResult.rows[0];

    if (!user.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer found for this user.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: appBaseUrl
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Could not create billing portal session.' });
  }
});

app.get('/api/reports/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, source_type, original_filename, summary, risk_level, risk_score, top_risks,
              flagged_clauses, missing_protections, final_recommendation, contract_text, unlocked,
              stripe_payment_status, created_at, user_id
       FROM reports
       WHERE id = $1`,
      [req.params.id]
    );

    const report = result.rows[0];

    if (!report) {
      return res.status(404).json({ error: 'Report not found.' });
    }

    if (!report.unlocked) {
      return res.json({
        id: report.id,
        unlocked: false,
        sourceType: report.source_type,
        fileName: report.original_filename,
        summary: report.summary,
        riskLevel: report.risk_level,
        riskScoreLabel: labelFromRisk(report.risk_level),
        topRisks: report.top_risks,
        totalFlaggedClauses: Array.isArray(report.flagged_clauses) ? report.flagged_clauses.length : 0,
        extractedTextPreview: report.contract_text.slice(0, 1200),
        createdAt: report.created_at
      });
    }

    return res.json({
      id: report.id,
      unlocked: true,
      sourceType: report.source_type,
      fileName: report.original_filename,
      summary: report.summary,
      riskLevel: report.risk_level,
      riskScore: Number(report.risk_score),
      flaggedClauses: report.flagged_clauses,
      missingProtections: report.missing_protections,
      finalRecommendation: report.final_recommendation,
      contractText: report.contract_text,
      createdAt: report.created_at,
      userId: report.user_id || null
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not load report.' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CONTRAX running on http://localhost:${PORT}`);
});

async function extractContractText({ files, textInput }) {
  if (textInput.length >= 50) {
    return {
      text: normalizeText(textInput),
      sourceType: 'text',
      originalFilename: null
    };
  }

  if (!files.length) {
    throw new Error('No contract text or files provided.');
  }

  const first = files[0];
  const mime = first.mimetype || '';

  if (mime === 'application/pdf' || first.originalname.toLowerCase().endsWith('.pdf')) {
    const data = await pdfParse(first.buffer);
    return {
      text: normalizeText(data.text || ''),
      sourceType: 'pdf',
      originalFilename: first.originalname
    };
  }

  if (mime.startsWith('image/')) {
    let combined = '';
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const result = await Tesseract.recognize(file.buffer, 'eng');
      combined += `\n\n[Image ${i + 1}]\n${result.data.text}`;
    }

    return {
      text: normalizeText(combined),
      sourceType: 'image',
      originalFilename: files.map((f) => f.originalname).join(', ')
    };
  }

  throw new Error('Unsupported file type. Use PDF, image, or pasted text.');
}

function normalizeText(text) {
  return String(text)
    .replace(/\u0000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function analyzeWithOpenAI(contractText) {
  const prompt = `Analyze the following contract and return ONLY valid JSON with this shape:
{
  "summary": string,
  "overall_risk_level": "Low Risk" | "Moderate Risk" | "High Risk",
  "risk_score_1_to_10": number,
  "flagged_clauses": [
    {
      "clause_name": string,
      "severity": "low" | "medium" | "high",
      "quoted_text": string,
      "why_it_matters": string,
      "plain_english_explanation": string,
      "suggested_revision": string
    }
  ],
  "missing_protections": string[],
  "final_recommendation": string
}

Rules:
- Focus on business and legal risk signals.
- Do not claim to be a lawyer.
- Keep the summary under 140 words.
- Keep quoted_text short and directly copied from the contract when possible.
- Score 1 to 10 where 10 is the highest risk.
- Return no markdown fences, no commentary, no prose outside JSON.

Contract:\n${contractText.slice(0, 120000)}`;

  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    input: prompt,
    temperature: 0.2
  });

  const rawText = response.output_text || '';
  const parsed = extractJson(rawText);
  return ReportSchema.parse(parsed);
}

function extractJson(rawText) {
  try {
    return JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('The model did not return valid JSON.');
    }
    return JSON.parse(match[0]);
  }
}

function labelFromRisk(riskLevel) {
  if (riskLevel === 'High Risk') return 'Careful review recommended';
  if (riskLevel === 'Moderate Risk') return 'Some concerning terms found';
  return 'Lower apparent risk';
}
