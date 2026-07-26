'use strict';
const nodemailer = require('nodemailer');
const { randomUUID } = require('crypto');

const SMTP_USER = process.env.SMTP_USER || 'rezoro.pro@rezoro.pro';
const SMTP_PASS = process.env.SMTP_PASS;

if (!SMTP_PASS) {
  throw new Error('SMTP_PASS environment variable is not set. Set it in Render before starting the server.');
}

const transporter = nodemailer.createTransport({
  host:   'smtp.hostinger.com',
  port:   465,
  secure: true,
  auth:   { user: SMTP_USER, pass: SMTP_PASS },
  tls:    { rejectUnauthorized: true, minVersion: 'TLSv1.2' }
});

const FROM   = `"Rezoro" <${SMTP_USER}>`;
const REPLY  = SMTP_USER;
const YEAR   = new Date().getFullYear();

// Escape user-supplied values before interpolating into email HTML.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function baseHeaders() {
  return {
    'X-Mailer':        'Rezoro Booking System v2.0',
    'X-Priority':      '3',
    'X-Entity-Ref-ID': randomUUID(),
    'List-Unsubscribe':'<mailto:rezoro.pro@rezoro.pro?subject=unsubscribe>',
    'List-Unsubscribe-Post':'List-Unsubscribe=One-Click',
    'Precedence':      'transactional',
    'MIME-Version':    '1.0'
  };
}

function emailWrap(previewText, body) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
</head>
<body style="margin:0;padding:0;background:#07070A;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;">${previewText}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07070A;padding:48px 20px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
<tr><td align="center" style="padding-bottom:36px;">
  <span style="font-size:28px;font-weight:800;letter-spacing:.06em;color:#F0ECE4;font-family:'Helvetica Neue',Arial,sans-serif;">
    REZ<span style="color:#C9A84C;">ORO</span>
  </span>
</td></tr>
${body}
<tr><td style="border-top:1px solid rgba(255,255,255,.07);padding-top:24px;"></td></tr>
<tr><td align="center" style="padding-top:8px;">
  <p style="margin:0 0 4px;font-size:12px;color:#5C5852;">© ${YEAR} Rezoro · Premium Celebrity Experiences</p>
  <p style="margin:0;font-size:11px;color:#3a3936;">rezoro.pro@rezoro.pro · rezoro.pro</p>
</td></tr>
</table></td></tr></table>
</body></html>`;
}

/* ── 1. Fan Card Email ───────────────────────────────────── */
async function sendFanCardEmail({ to, fanName, country, celebName, tier, ref, edition, cardBuffer, cardBackBuffer, certBuffer }) {
  fanName   = esc(fanName);
  celebName = esc(celebName);
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
  const tierColor = tier === 'gold' ? '#C9A84C' : tier === 'silver' ? '#A8B8C4' : '#C07848';
  const editionLabel = edition ? esc(edition) : 'Limited Edition';

  const body = `
<tr><td align="center" style="padding-bottom:10px;">
  <h1 style="margin:0;font-size:26px;font-weight:700;color:#F0ECE4;">Your Fan Card Has Arrived</h1>
</td></tr>
<tr><td align="center" style="padding-bottom:32px;">
  <p style="margin:0;font-size:15px;color:#9A9490;line-height:1.7;">
    Congratulations <strong style="color:#F0ECE4;">${fanName}</strong> —
    your <span style="color:${tierColor};font-weight:700;">${tierLabel} Tier</span>
    collectible featuring <strong style="color:#F0ECE4;">${celebName}</strong> is ready,
    numbered <strong style="color:${tierColor};">${editionLabel}</strong>.
  </p>
</td></tr>
<tr><td align="center" style="padding-bottom:14px;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
    <tr>
      <td style="padding:0 6px;">
        <img src="cid:fancard" alt="Fan card — front" width="230"
          style="width:100%;max-width:230px;border-radius:8px;display:block;border:1px solid rgba(201,168,76,.28);">
      </td>
      ${cardBackBuffer ? `<td style="padding:0 6px;">
        <img src="cid:fancardback" alt="Fan card — back" width="230"
          style="width:100%;max-width:230px;border-radius:8px;display:block;border:1px solid rgba(201,168,76,.28);">
      </td>` : ''}
    </tr>
  </table>
</td></tr>
<tr><td align="center" style="padding-bottom:32px;">
  <p style="margin:0;font-size:13px;color:#9A9490;line-height:1.7;">
    Attached are your print-ready files: the <strong style="color:#F0ECE4;">card front &amp; back</strong>
    and its matching <strong style="color:#F0ECE4;">Certificate of Authenticity</strong>.
  </p>
</td></tr>
<tr><td align="center" style="padding-bottom:32px;">
  <table role="presentation" cellpadding="0" cellspacing="0">
    <tr><td style="background:#0E0E13;border:1px solid rgba(201,168,76,.22);border-radius:10px;padding:16px 28px;text-align:center;">
      <div style="font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#5C5852;margin-bottom:6px;">Reference</div>
      <div style="font-size:20px;font-weight:800;letter-spacing:.1em;color:#C9A84C;font-family:'Courier New',monospace;">${ref}</div>
    </td></tr>
  </table>
</td></tr>`;

  const attachments = [{
    filename: `rezoro-fancard-${ref}-front.png`,
    content: cardBuffer,
    cid: 'fancard',
    contentType: 'image/png'
  }];
  if (cardBackBuffer) {
    attachments.push({
      filename: `rezoro-fancard-${ref}-back.png`,
      content: cardBackBuffer,
      cid: 'fancardback',
      contentType: 'image/png'
    });
  }
  if (certBuffer) {
    attachments.push({
      filename: `rezoro-certificate-${ref}.png`,
      content: certBuffer,
      contentType: 'image/png'
    });
  }

  await transporter.sendMail({
    from: FROM, to, replyTo: REPLY,
    subject: `Your ${tierLabel} Fan Card — ${celebName} · ${ref}`,
    messageId: `<${randomUUID()}@rezoro.pro>`,
    headers: baseHeaders(),
    text: `Hi ${fanName},\n\nYour ${tierLabel} fan card for ${celebName} (${editionLabel}) is attached — front and back — along with its Certificate of Authenticity.\nRef: ${ref}\n\n— Rezoro`,
    html: emailWrap(`Your ${tierLabel} fan card for ${celebName} · Ref: ${ref}`, body),
    attachments
  });
}

/* ── 2. Booking Confirmation (auto-sent on inquiry) ─────── */
async function sendBookingConfirmation({ to, name, celebName, ref, tier, tierType, price, days }) {
  name      = esc(name);
  celebName = esc(celebName);
  tier      = esc(tier);
  const body = `
<tr><td align="center" style="padding-bottom:10px;">
  <h1 style="margin:0;font-size:26px;font-weight:700;color:#F0ECE4;">Booking Request Received</h1>
</td></tr>
<tr><td align="center" style="padding-bottom:28px;">
  <p style="margin:0;font-size:15px;color:#9A9490;line-height:1.7;">
    Thank you <strong style="color:#F0ECE4;">${name}</strong> — we've received your booking request for
    <strong style="color:#C9A84C;">${celebName}</strong>. Our team will respond within <strong style="color:#F0ECE4;">24 hours</strong>.
  </p>
</td></tr>
<tr><td style="background:#0E0E13;border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:24px 28px;margin-bottom:28px;">
  <div style="font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#5C5852;margin-bottom:14px;">Booking Summary</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="padding:6px 0;font-size:13px;color:#5C5852;width:130px;">Reference</td>
        <td style="padding:6px 0;font-size:13px;color:#C9A84C;font-weight:700;font-family:'Courier New',monospace;">${ref}</td></tr>
    <tr><td style="padding:6px 0;font-size:13px;color:#5C5852;">Celebrity</td>
        <td style="padding:6px 0;font-size:13px;color:#F0ECE4;font-weight:600;">${celebName}</td></tr>
    <tr><td style="padding:6px 0;font-size:13px;color:#5C5852;">Tier</td>
        <td style="padding:6px 0;font-size:13px;color:#F0ECE4;font-weight:600;">${tier} (${tierType})</td></tr>
    <tr><td style="padding:6px 0;font-size:13px;color:#5C5852;">Duration</td>
        <td style="padding:6px 0;font-size:13px;color:#F0ECE4;font-weight:600;">${days} days</td></tr>
    <tr><td style="padding:6px 0;font-size:13px;color:#5C5852;">Investment</td>
        <td style="padding:6px 0;font-size:13px;color:#C9A84C;font-weight:700;">$${Number(price).toLocaleString()}</td></tr>
  </table>
</td></tr>
<tr><td style="padding:20px 0 28px;">
  <p style="margin:0;font-size:14px;color:#9A9490;line-height:1.7;">
    <span style="color:#C9A84C;">✦</span>&nbsp; Our concierge team reviews every request personally<br>
    <span style="color:#C9A84C;">✦</span>&nbsp; You'll receive a detailed response within 24 hours<br>
    <span style="color:#C9A84C;">✦</span>&nbsp; Questions? Reply directly to this email
  </p>
</td></tr>`;

  await transporter.sendMail({
    from: FROM, to, replyTo: REPLY,
    subject: `Booking Request Confirmed — ${celebName} · ${ref}`,
    messageId: `<${randomUUID()}@rezoro.pro>`,
    headers: baseHeaders(),
    text: `Hi ${name},\n\nWe've received your booking request for ${celebName}.\nRef: ${ref}\nTier: ${tier} (${tierType}) — ${days} days — $${Number(price).toLocaleString()}\n\nOur team will respond within 24 hours.\n\n— Rezoro`,
    html: emailWrap(`Booking request received for ${celebName} · Ref: ${ref}`, body)
  });
}

/* ── 3. Booking Accepted ─────────────────────────────────── */
async function sendBookingAccepted({ to, name, celebName, ref, tier, price, days, paymentLink }) {
  name      = esc(name);
  celebName = esc(celebName);
  tier      = esc(tier);
  const body = `
<tr><td align="center" style="padding-bottom:10px;">
  <div style="display:inline-block;background:rgba(62,207,142,.12);border:1px solid rgba(62,207,142,.3);border-radius:8px;padding:6px 18px;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#3ecf8e;margin-bottom:16px;">Booking Accepted</div>
  <h1 style="margin:0;font-size:26px;font-weight:700;color:#F0ECE4;">Your Booking is Confirmed!</h1>
</td></tr>
<tr><td align="center" style="padding-bottom:28px;">
  <p style="margin:0;font-size:15px;color:#9A9490;line-height:1.7;">
    Great news <strong style="color:#F0ECE4;">${name}</strong> — your booking for
    <strong style="color:#C9A84C;">${celebName}</strong> has been accepted.
    Complete your payment below to secure the booking.
  </p>
</td></tr>
<tr><td style="background:#0E0E13;border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:24px 28px;margin-bottom:24px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="padding:6px 0;font-size:13px;color:#5C5852;width:130px;">Reference</td>
        <td style="padding:6px 0;font-size:13px;color:#C9A84C;font-weight:700;font-family:'Courier New',monospace;">${ref}</td></tr>
    <tr><td style="padding:6px 0;font-size:13px;color:#5C5852;">Celebrity</td>
        <td style="padding:6px 0;font-size:13px;color:#F0ECE4;font-weight:600;">${celebName}</td></tr>
    <tr><td style="padding:6px 0;font-size:13px;color:#5C5852;">Tier</td>
        <td style="padding:6px 0;font-size:13px;color:#F0ECE4;font-weight:600;">${tier}</td></tr>
    <tr><td style="padding:6px 0;font-size:13px;color:#5C5852;">Duration</td>
        <td style="padding:6px 0;font-size:13px;color:#F0ECE4;font-weight:600;">${days} days</td></tr>
    <tr><td style="padding:6px 0;font-size:13px;color:#5C5852;">Amount Due</td>
        <td style="padding:6px 0;font-size:15px;color:#C9A84C;font-weight:800;">$${Number(price).toLocaleString()}</td></tr>
  </table>
</td></tr>
<tr><td align="center" style="padding-bottom:28px;">
  <a href="${paymentLink}" style="display:inline-block;background:#C9A84C;color:#000;font-weight:700;font-size:14px;letter-spacing:.12em;text-transform:uppercase;padding:16px 40px;border-radius:8px;text-decoration:none;">
    Complete Payment →
  </a>
</td></tr>`;

  await transporter.sendMail({
    from: FROM, to, replyTo: REPLY,
    subject: `✅ Booking Accepted — ${celebName} · Complete Payment · ${ref}`,
    messageId: `<${randomUUID()}@rezoro.pro>`,
    headers: baseHeaders(),
    text: `Hi ${name},\n\nYour booking for ${celebName} has been accepted!\nRef: ${ref}\nAmount: $${Number(price).toLocaleString()}\n\nComplete payment: ${paymentLink}\n\n— Rezoro`,
    html: emailWrap(`Your booking for ${celebName} is accepted — complete payment`, body)
  });
}

/* ── 4. Booking Rejected ─────────────────────────────────── */
async function sendBookingRejected({ to, name, celebName, ref }) {
  name      = esc(name);
  celebName = esc(celebName);
  const body = `
<tr><td align="center" style="padding-bottom:10px;">
  <h1 style="margin:0;font-size:26px;font-weight:700;color:#F0ECE4;">Booking Update</h1>
</td></tr>
<tr><td align="center" style="padding-bottom:28px;">
  <p style="margin:0;font-size:15px;color:#9A9490;line-height:1.7;">
    Dear <strong style="color:#F0ECE4;">${name}</strong>, unfortunately
    <strong style="color:#C9A84C;">${celebName}</strong> is not available for your requested dates
    (Ref: <span style="color:#C9A84C;">${ref}</span>).
  </p>
</td></tr>
<tr><td style="padding:0 0 24px;">
  <p style="margin:0;font-size:14px;color:#9A9490;line-height:1.8;">
    <span style="color:#C9A84C;">✦</span>&nbsp; We can suggest alternative celebrities or dates — simply reply to this email<br>
    <span style="color:#C9A84C;">✦</span>&nbsp; Browse our full roster at <a href="https://rezoro.pro" style="color:#C9A84C;">rezoro.pro</a><br>
    <span style="color:#C9A84C;">✦</span>&nbsp; Our team is here to find the perfect match for your project
  </p>
</td></tr>`;

  await transporter.sendMail({
    from: FROM, to, replyTo: REPLY,
    subject: `Booking Update — ${celebName} · ${ref}`,
    messageId: `<${randomUUID()}@rezoro.pro>`,
    headers: baseHeaders(),
    text: `Hi ${name},\n\nUnfortunately ${celebName} is unavailable for your request (${ref}).\nPlease reply and we'll find alternatives.\n\n— Rezoro`,
    html: emailWrap(`Booking update for ${celebName} · ${ref}`, body)
  });
}

/* ── 5. Newsletter Welcome ───────────────────────────────── */
async function sendNewsletterWelcome({ to, name }) {
  name = esc(name);
  const body = `
<tr><td align="center" style="padding-bottom:10px;">
  <h1 style="margin:0;font-size:26px;font-weight:700;color:#F0ECE4;">Welcome to Rezoro</h1>
</td></tr>
<tr><td align="center" style="padding-bottom:28px;">
  <p style="margin:0;font-size:15px;color:#9A9490;line-height:1.7;">
    ${name ? `<strong style="color:#F0ECE4;">${name}</strong>, you're` : "You're"} now part of the world's most exclusive celebrity booking community.
    You'll be the first to know about new talent, exclusive offers and special events.
  </p>
</td></tr>
<tr><td align="center" style="padding-bottom:28px;">
  <a href="https://rezoro.pro" style="display:inline-block;background:#C9A84C;color:#000;font-weight:700;font-size:13px;letter-spacing:.12em;text-transform:uppercase;padding:14px 36px;border-radius:8px;text-decoration:none;">
    Explore Celebrities →
  </a>
</td></tr>`;

  await transporter.sendMail({
    from: FROM, to, replyTo: REPLY,
    subject: `Welcome to Rezoro — You're on the List`,
    messageId: `<${randomUUID()}@rezoro.pro>`,
    headers: baseHeaders(),
    text: `Welcome to Rezoro!\n\nYou're now subscribed to exclusive updates.\n\nVisit us at rezoro.pro\n\n— Rezoro`,
    html: emailWrap('Welcome to the world\'s most exclusive celebrity booking platform', body)
  });
}

/* ── 6. Newsletter Broadcast ─────────────────────────────── */
async function sendNewsletter({ to, subject, html, text }) {
  await transporter.sendMail({
    from: FROM, to, replyTo: REPLY,
    subject,
    messageId: `<${randomUUID()}@rezoro.pro>`,
    headers: { ...baseHeaders(), Precedence: 'bulk' },
    text: text || 'View this email in your browser.',
    html: emailWrap(subject, `<tr><td style="padding-bottom:28px;">${html}</td></tr>`)
  });
}

module.exports = {
  sendFanCardEmail,
  sendBookingConfirmation,
  sendBookingAccepted,
  sendBookingRejected,
  sendNewsletterWelcome,
  sendNewsletter
};
