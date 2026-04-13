const form = document.getElementById('analyze-form');
const fileInput = document.getElementById('file-input');
const textInput = document.getElementById('contract-text');
const messageBox = document.getElementById('form-message');
const results = document.getElementById('results');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('Analyzing contract... this can take a moment for OCR or long PDFs.');

  results.innerHTML = `
    <section class="card analysis-loading">
      <div style="text-align:center; padding: 48px 20px;">
        <div style="font-size:48px; margin-bottom:16px;">⏳</div>
        <h2 style="color:white;">Analyzing your contract</h2>
        <p style="color:#d7e2ea;">This usually takes 15–30 seconds</p>
      </div>
    </section>
  `;
  results.classList.remove('hidden');
  scrollToResults();

  const payload = new FormData();
  for (const file of fileInput.files) payload.append('files', file);
  payload.append('contractText', textInput.value);

  try {
    const response = await fetch('/api/reports/analyze', {
      method: 'POST',
      body: payload
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Analysis failed.');

    const params = new URLSearchParams(window.location.search);
    params.set('report', data.reportId);
    history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);

    renderFreeResult(data.reportId, data.freeResult, data.fileName, data.sourceType);
    clearMessage();
  } catch (error) {
    setMessage(error.message, true);
    results.classList.add('hidden');
  }
});

window.addEventListener('load', async () => {
  const params = new URLSearchParams(window.location.search);
  const reportId = params.get('report');
  const payment = params.get('payment');

  if (!reportId) return;

  if (payment === 'success') {
    setMessage('Payment received. Unlocking your report...');
    await pollForUnlock(reportId);
    return;
  }

  if (payment === 'cancelled') {
    setMessage('Checkout was cancelled.');
  }

  await loadReport(reportId);
});

async function loadReport(reportId) {
  try {
    const response = await fetch(`/api/reports/${reportId}`);
    const data = await response.json();

    if (!response.ok) throw new Error(data.error || 'Could not load report.');

    if (data.unlocked) {
      renderFullResult(data);
    } else {
      renderFreeResult(reportId, data, data.fileName, data.sourceType);
    }

    clearMessage();
  } catch (error) {
    setMessage(error.message, true);
  }
}

async function pollForUnlock(reportId) {
  const started = Date.now();

  while (Date.now() - started < 30000) {
    const response = await fetch(`/api/reports/${reportId}`);
    const data = await response.json();

    if (response.ok && data.unlocked) {
      renderFullResult(data);
      clearMessage();
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  setMessage('Payment succeeded, but the webhook has not unlocked the report yet. Refresh in a few seconds.', true);
}

function renderFreeResult(reportId, data, fileName, sourceType) {
  results.innerHTML = `
    <section class="card">
      <div class="inline-row">
        <div>
          <div class="eyebrow">Free scan result</div>
          <h2>${escapeHtml(fileName || 'Pasted contract')}</h2>
          <p>Source: ${escapeHtml((sourceType || data.sourceType || 'text').toUpperCase())}</p>
        </div>
        ${riskBadge(data.overallRiskLevel || data.riskLevel)}
      </div>
      <p>${escapeHtml(data.summary)}</p>
    </section>

    <section class="panel-grid">
      <div class="card">
        <h2>Risk Summary</h2>
        ${(data.topRisks || []).map((risk) => `
          <div class="risk-item">
            <strong>${escapeHtml(risk.clause_name)}</strong>
            <p><strong>Severity:</strong> ${escapeHtml(risk.severity)}</p>
            <p>${escapeHtml(risk.plain_english_explanation)}</p>
          </div>
        `).join('') || '<p>No clauses were flagged in the free scan.</p>'}
      </div>

      <div class="card unlock-box">
        <h2>Unlock Full Report</h2>
        <p>Get the full numeric score, all flagged clauses, suggested revisions, and the full contract text.</p>

        <label class="label">Email for receipt</label>
        <input id="customer-email" type="email" placeholder="you@example.com" />

        <div class="inline-row" style="margin-top: 16px;">
          <button class="btn btn-gold" id="pay-once-btn" type="button">Pay $5 / Contract</button>
          <button class="btn btn-outline-light" id="subscribe-btn" type="button">Subscribe $8 / Month</button>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Text Preview</h2>
      <pre>${escapeHtml(data.extractedTextPreview || '')}</pre>
    </section>
  `;

  results.classList.remove('hidden');

  document.getElementById('pay-once-btn').addEventListener('click', () => {
    startCheckout(reportId, 'single');
  });

  document.getElementById('subscribe-btn').addEventListener('click', () => {
    startCheckout(reportId, 'monthly');
  });

  scrollToResults();
}

async function startCheckout(reportId, plan) {
  const customerEmail = document.getElementById('customer-email')?.value.trim() || '';
  setMessage('Creating Stripe checkout...');

  try {
    const response = await fetch('/api/payments/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportId, customerEmail, plan })
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Could not start checkout.');
    }

    if (payload.redirectUrl) {
      window.location.href = payload.redirectUrl;
      return;
    }
    console.log('Checkout payload:', payload);
    console.log('Redirecting to:', payload.url);
    
    window.location.href = payload.url;
  } catch (error) {
    setMessage(error.message, true);
  }
}

function renderFullResult(data) {
  results.innerHTML = `
    <section class="card">
      <div class="inline-row">
        <div>
          <div class="eyebrow">Full report</div>
          <h2>${escapeHtml(data.fileName || 'Contract report')}</h2>
        </div>
        ${riskBadge(data.riskLevel)}
      </div>
      <p>${escapeHtml(data.summary)}</p>
      <p><strong>Risk score:</strong> ${escapeHtml(String(data.riskScore))}/10</p>
      <p><strong>Recommendation:</strong> ${escapeHtml(data.finalRecommendation)}</p>

      <div class="inline-row" style="margin-top:16px;">
        <button class="btn btn-gold" id="download-report-btn" type="button">Download Report</button>
        <button class="btn btn-navy" id="manage-billing-btn" type="button">Manage Billing</button>
      </div>
    </section>

    <section class="card">
      <h2>Flagged Clauses</h2>
      ${(data.flaggedClauses || []).map((clause) => `
        <div class="clause-item">
          <strong>${escapeHtml(clause.clause_name)} · ${escapeHtml(clause.severity.toUpperCase())}</strong>
          <p><strong>Quoted text:</strong> ${escapeHtml(clause.quoted_text)}</p>
          <p><strong>Why it matters:</strong> ${escapeHtml(clause.why_it_matters)}</p>
          <p><strong>Plain English:</strong> ${escapeHtml(clause.plain_english_explanation)}</p>
          <p><strong>Suggested revision:</strong> ${escapeHtml(clause.suggested_revision)}</p>
        </div>
      `).join('') || '<p>No flagged clauses.</p>'}
    </section>

    <section class="panel-grid">
      <div class="card">
        <h2>Missing Protections</h2>
        <ul class="feature-list">
          ${(data.missingProtections || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('') || '<li>No missing protections listed.</li>'}
        </ul>
      </div>

      <div class="card">
        <h2>Full Contract Text</h2>
        <pre>${escapeHtml(data.contractText || '')}</pre>
      </div>
    </section>
  `;

  results.classList.remove('hidden');

  document.getElementById('download-report-btn')?.addEventListener('click', () => {
    downloadReport(data);
  });

  document.getElementById('manage-billing-btn')?.addEventListener('click', async () => {
    await openBillingPortal(data);
  });

  scrollToResults();
}

function downloadReport(data) {
  const filename = (data.fileName || 'contract-report')
    .replace(/[^a-z0-9_\-.]/gi, '_')
    .replace(/_+/g, '_');

  const clausesHtml = (data.flaggedClauses || []).map((clause) => `
    <div class="report-clause">
      <h3>${escapeHtml(clause.clause_name)} · ${escapeHtml(clause.severity.toUpperCase())}</h3>
      <p><strong>Quoted text:</strong> ${escapeHtml(clause.quoted_text)}</p>
      <p><strong>Why it matters:</strong> ${escapeHtml(clause.why_it_matters)}</p>
      <p><strong>Plain English:</strong> ${escapeHtml(clause.plain_english_explanation)}</p>
      <p><strong>Suggested revision:</strong> ${escapeHtml(clause.suggested_revision)}</p>
    </div>
  `).join('');

  const missingProtectionsHtml = (data.missingProtections || []).length
    ? `<ul>${data.missingProtections.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '<p>No missing protections listed.</p>';

  const reportHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <title>CONTRAX Report</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          max-width: 900px;
          margin: 40px auto;
          padding: 0 20px;
          color: #1f2937;
          line-height: 1.6;
        }
        h1, h2, h3 {
          margin-bottom: 10px;
          color: #0c2d3f;
        }
        .badge {
          display: inline-block;
          padding: 8px 14px;
          border-radius: 999px;
          background: #f5e7b6;
          color: #6b4f08;
          font-weight: bold;
          margin-bottom: 20px;
        }
        .section {
          margin-top: 28px;
          padding: 18px 20px;
          border: 1px solid #e5e7eb;
          border-radius: 12px;
        }
        .report-clause {
          padding: 16px 0;
          border-bottom: 1px solid #e5e7eb;
        }
        .report-clause:last-child {
          border-bottom: none;
        }
        pre {
          white-space: pre-wrap;
          background: #f8fafc;
          border: 1px solid #e5e7eb;
          border-radius: 10px;
          padding: 14px;
        }
      </style>
    </head>
    <body>
      <h1>CONTRAX Full Report</h1>
      <div class="badge">${escapeHtml(data.riskLevel)} · ${escapeHtml(String(data.riskScore))}/10</div>

      <div class="section">
        <h2>Summary</h2>
        <p>${escapeHtml(data.summary)}</p>
        <p><strong>Recommendation:</strong> ${escapeHtml(data.finalRecommendation)}</p>
      </div>

      <div class="section">
        <h2>Flagged Clauses</h2>
        ${clausesHtml || '<p>No flagged clauses.</p>'}
      </div>

      <div class="section">
        <h2>Missing Protections</h2>
        ${missingProtectionsHtml}
      </div>

      <div class="section">
        <h2>Full Contract Text</h2>
        <pre>${escapeHtml(data.contractText || '')}</pre>
      </div>
    </body>
    </html>
  `;

  const blob = new Blob([reportHtml], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}_full_report.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function openBillingPortal(data) {
  try {
    const email = prompt(
      'Enter the email used for billing:',
      data.customerEmail || ''
    )?.trim();

    if (!email) return;

    setMessage('Opening billing portal...');

    const response = await fetch('/api/create-billing-portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Could not open billing portal.');
    }

    clearMessage();
    window.location.href = payload.url;
  } catch (error) {
    setMessage(error.message, true);
  }
}

function riskBadge(level) {
  const normalized = (level || 'Moderate Risk').toLowerCase();
  const klass = normalized.includes('high')
    ? 'high'
    : normalized.includes('low')
      ? 'low'
      : 'moderate';

  return `<div class="badge ${klass}">${escapeHtml(level || 'Moderate Risk')}</div>`;
}

function scrollToResults() {
  setTimeout(() => {
    document.getElementById('results')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }, 150);
}

function setMessage(text, isError = false) {
  messageBox.textContent = text;
  messageBox.classList.remove('hidden');
  messageBox.style.background = isError ? '#fdecea' : '#fff4d6';
  messageBox.style.color = isError ? '#b93a2f' : '#6b4f08';
}

function clearMessage() {
  messageBox.classList.add('hidden');
  messageBox.textContent = '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}