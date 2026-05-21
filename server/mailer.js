'use strict';
const nodemailer = require('nodemailer');
const { randomUUID } = require('crypto');

/* ─────────────────────────────────────────────────────────
   SMTP Transport
   SPF:  Add  v=spf1 include:smtp.hostinger.com ~all  to rezoro.pro DNS TXT
   DKIM: Hostinger auto-signs outbound mail from their SMTP relay.
         If you self-host, uncomment the dkim block below and add your key.
───────────────────────────────────────────────────────── */
const transporter = nodemailer.createTransport({
  host:   'smtp.hostinger.com',
  port:   465,
  secure: true,                   // TLS on connect (port 465)
  auth: {
    user: 'rezoro.pro@rezoro.pro',
    pass: 'Fabian921@'
  },
  tls: {
    rejectUnauthorized: true,     // enforce valid cert
    minVersion: 'TLSv1.2'
  },

  /* ── Optional: self-managed DKIM signing ──────────────
     Uncomment and supply your private key if Hostinger DKIM
     is not enabled. Generate with:
       openssl genrsa -out dkim-private.pem 2048
     Then publish the public key as a DNS TXT record.

  dkim: {
    domainName:   'rezoro.pro',
    keySelector:  'mail',         // matches DNS: mail._domainkey.rezoro.pro
    privateKey:   require('fs').readFileSync('./dkim-private.pem', 'utf8')
  }
  ─────────────────────────────────────────────────────── */
});

/**
 * Send the fan card email.
 * @param {object} opts
 * @param {string} opts.to          Fan email
 * @param {string} opts.fanName     Fan display name
 * @param {string} opts.country     Fan country
 * @param {string} opts.celebName   Celebrity name
 * @param {string} opts.tier        gold | silver | bronze
 * @param {string} opts.ref         Booking reference
 * @param {Buffer} opts.cardBuffer  PNG image buffer
 */
async function sendFanCardEmail({ to, fanName, country, celebName, tier, ref, cardBuffer }) {
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
  const tierColor = tier === 'gold' ? '#C9A84C' : tier === 'silver' ? '#A8B8C4' : '#C07848';
  const msgId     = `<${randomUUID()}@rezoro.pro>`;
  const now       = new Date();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Your Rezoro Fan Card — ${ref}</title>
</head>
<body style="margin:0;padding:0;background:#07070A;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
    Your ${tierLabel} fan card for ${celebName} is ready · Ref: ${ref}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07070A;padding:48px 20px;">
  <tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

    <!-- Logo -->
    <tr><td align="center" style="padding-bottom:36px;">
      <span style="font-size:30px;font-weight:800;letter-spacing:.06em;color:#F0ECE4;font-family:'Helvetica Neue',Arial,sans-serif;">
        REZ<span style="color:#C9A84C;">ORO</span>
      </span>
    </td></tr>

    <!-- Headline -->
    <tr><td align="center" style="padding-bottom:10px;">
      <h1 style="margin:0;font-size:28px;font-weight:700;color:#F0ECE4;letter-spacing:-.02em;line-height:1.2;">
        Your Fan Card Has Arrived
      </h1>
    </td></tr>
    <tr><td align="center" style="padding-bottom:36px;">
      <p style="margin:0;font-size:15px;color:#9A9490;line-height:1.7;">
        Congratulations <strong style="color:#F0ECE4;">${fanName}</strong> —
        your exclusive <span style="color:${tierColor};font-weight:700;">${tierLabel} Tier</span>
        fan card featuring <strong style="color:#F0ECE4;">${celebName}</strong> is ready.
      </p>
    </td></tr>

    <!-- Fan Card Image -->
    <tr><td align="center" style="padding-bottom:36px;">
      <img src="cid:fancard" alt="Rezoro Fan Card — ${celebName}"
        width="560"
        style="width:100%;max-width:560px;border-radius:14px;display:block;border:1px solid rgba(201,168,76,.28);box-shadow:0 20px 60px rgba(0,0,0,.6);">
    </td></tr>

    <!-- Reference pill -->
    <tr><td align="center" style="padding-bottom:36px;">
      <table role="presentation" cellpadding="0" cellspacing="0">
        <tr><td style="background:#0E0E13;border:1px solid rgba(201,168,76,.22);border-radius:10px;padding:18px 32px;text-align:center;">
          <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#5C5852;margin-bottom:8px;font-family:'Helvetica Neue',Arial,sans-serif;">Booking Reference</div>
          <div style="font-size:22px;font-weight:800;letter-spacing:.1em;color:#C9A84C;font-family:'Courier New',monospace;">${ref}</div>
        </td></tr>
      </table>
    </td></tr>

    <!-- Details block -->
    <tr><td style="background:#0E0E13;border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:28px 32px;margin-bottom:36px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#5C5852;margin-bottom:18px;">Booking Details</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:7px 0;font-size:13px;color:#5C5852;width:140px;">Fan Name</td>
          <td style="padding:7px 0;font-size:13px;color:#F0ECE4;font-weight:600;">${fanName}</td>
        </tr>
        <tr>
          <td style="padding:7px 0;font-size:13px;color:#5C5852;">Country</td>
          <td style="padding:7px 0;font-size:13px;color:#F0ECE4;font-weight:600;">${country || '—'}</td>
        </tr>
        <tr>
          <td style="padding:7px 0;font-size:13px;color:#5C5852;">Celebrity</td>
          <td style="padding:7px 0;font-size:13px;color:#F0ECE4;font-weight:600;">${celebName}</td>
        </tr>
        <tr>
          <td style="padding:7px 0;font-size:13px;color:#5C5852;">Tier</td>
          <td style="padding:7px 0;font-size:13px;font-weight:700;color:${tierColor};">${tierLabel}</td>
        </tr>
        <tr>
          <td style="padding:7px 0;font-size:13px;color:#5C5852;">Date</td>
          <td style="padding:7px 0;font-size:13px;color:#F0ECE4;font-weight:600;">${now.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</td>
        </tr>
      </table>
    </td></tr>

    <!-- Next steps -->
    <tr><td style="padding:0 0 36px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#5C5852;margin-bottom:14px;">What Happens Next</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:6px 0;font-size:14px;color:#9A9490;line-height:1.6;">
          <span style="color:#C9A84C;">✦</span>&nbsp; Our concierge team will confirm your booking within <strong style="color:#F0ECE4;">24 hours</strong>
        </td></tr>
        <tr><td style="padding:6px 0;font-size:14px;color:#9A9490;line-height:1.6;">
          <span style="color:#C9A84C;">✦</span>&nbsp; Save your fan card — it's your exclusive <strong style="color:#F0ECE4;">collectible</strong>
        </td></tr>
        <tr><td style="padding:6px 0;font-size:14px;color:#9A9490;line-height:1.6;">
          <span style="color:#C9A84C;">✦</span>&nbsp; Questions? Simply reply to this email
        </td></tr>
      </table>
    </td></tr>

    <!-- Divider -->
    <tr><td style="border-top:1px solid rgba(255,255,255,.07);padding-top:28px;"></td></tr>

    <!-- Footer -->
    <tr><td align="center" style="padding-top:0;">
      <p style="margin:0 0 6px;font-size:12px;color:#5C5852;line-height:1.8;">
        © ${now.getFullYear()} Rezoro &nbsp;·&nbsp; Premium Celebrity Experiences
      </p>
      <p style="margin:0;font-size:12px;color:#3a3936;">
        rezoro.pro@rezoro.pro &nbsp;·&nbsp; rezoro.pro
      </p>
      <p style="margin:8px 0 0;font-size:11px;color:#3a3936;">
        You're receiving this because you made a booking at rezoro.pro
      </p>
    </td></tr>

  </table>
  </td></tr>
  </table>
</body>
</html>`;

  const textBody = `REZORO — Your Fan Card

Hi ${fanName},

Your ${tierLabel} Tier fan card featuring ${celebName} has been generated and is attached to this email.

Booking Reference: ${ref}
Fan Name: ${fanName}
Country: ${country || '—'}
Celebrity: ${celebName}
Tier: ${tierLabel}
Date: ${now.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}

Our concierge team will confirm your booking within 24 hours.

— Rezoro Team
rezoro.pro@rezoro.pro
`;

  await transporter.sendMail({
    // ── Core headers ──────────────────────────────────────
    from:       '"Rezoro" <rezoro.pro@rezoro.pro>',
    to,
    replyTo:    'rezoro.pro@rezoro.pro',
    subject:    `Your ${tierLabel} Fan Card — ${celebName} · ${ref}`,
    messageId:  msgId,
    date:       now,

    // ── Deliverability headers ────────────────────────────
    headers: {
      // Identify the sending application
      'X-Mailer':           'Rezoro Booking System v1.0',
      // Normal priority (1=high, 3=normal, 5=low)
      'X-Priority':         '3',
      'X-MS-Exchange-Organization-SCL': '-1',   // skip spam filter on Exchange
      // Prevent auto-threading in Gmail / Outlook
      'X-Entity-Ref-ID':   randomUUID(),
      // Feedback loop / unsubscribe (improves sender reputation)
      'List-Unsubscribe':  '<mailto:rezoro.pro@rezoro.pro?subject=unsubscribe>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      // Mark as transactional (not bulk) — boosts inbox placement
      'Precedence':         'transactional',
      // MIME
      'MIME-Version':       '1.0',
    },

    // ── Body ──────────────────────────────────────────────
    text: textBody,   // plain-text fallback (required for deliverability)
    html,

    // ── Attachment (fan card inline + download) ───────────
    attachments: [
      {
        filename:    `rezoro-fancard-${ref}.png`,
        content:     cardBuffer,
        cid:         'fancard',         // referenced as src="cid:fancard" in HTML
        contentType: 'image/png'
      }
    ]
  });
}

module.exports = { sendFanCardEmail };
