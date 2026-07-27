'use strict';

const { generatePrintCard, generatePrintCardBack } = require('./fancard-print');
const { generateCertificate } = require('./certificate');
const { sendFanCardEmail } = require('./mailer');

// Generates the print-ready card + certificate, emails them, and records the
// order as delivered. Called only after payment is verified — see
// server/payments/membership-gate.js, the sole caller in the new payment
// system (previously called directly from server.js's Flutterwave-only
// verify/webhook handlers, which now also route through the gate).
async function fulfillFancardOrder(store, order) {
  let celebImageSrc = null;
  if (order.celebId) {
    const photo = await store.celebrities.getPhoto(order.celebId);
    if (photo) celebImageSrc = photo.buffer;
  }

  const edNum   = await store.editions.next(`${order.tier}:${order.celebName.toLowerCase()}`);
  const edition = `No. ${String(edNum).padStart(3, '0')}`;

  const photoSrc = order.photo ? order.photo.buffer : null;

  const issued = new Date();

  // Front: the celebrity. Back: the collector. Printed as one double-sided card.
  const cardBuffer = await generatePrintCard({
    fanName: order.fanName, country: order.country || '', celebName: order.celebName,
    celebWiki: order.celebWiki || '', celebImageSrc, tier: order.tier, ref: order.ref, edition
  });
  const cardBackBuffer = await generatePrintCardBack({
    fanName: order.fanName, country: order.country || '', celebName: order.celebName,
    tier: order.tier, ref: order.ref, edition, issued, photoSrc
  });
  const certBuffer = generateCertificate({
    fanName: order.fanName, celebName: order.celebName, tier: order.tier, ref: order.ref, edition, issued
  });

  // The card itself is already generated at this point — a failed email
  // must never leave the order looking unpaid (the payment_attempt is
  // already PAID by the time this runs). Mark it paid either way, and record
  // whether delivery actually succeeded so admin can see a card that needs
  // a manual resend instead of an order that silently never got here.
  let delivered = true;
  try {
    await sendFanCardEmail({
      to: order.email, fanName: order.fanName, country: order.country || '', celebName: order.celebName,
      tier: order.tier, ref: order.ref, edition, cardBuffer, cardBackBuffer, certBuffer
    });
  } catch (e) {
    delivered = false;
    console.error(`[FANCARD] ${order.ref} — email delivery failed, card was still generated:`, e.message);
  }

  if (order.userId) {
    await store.fancards.add(order.userId, {
      ref: order.ref, celebName: order.celebName, tier: order.tier, fanName: order.fanName,
      country: order.country || '', edition, createdAt: new Date().toISOString()
    });
  }

  await store.fancardOrders.markPaid(order.ref, { edition, delivered });
  console.log(`[FANCARD] ${order.ref} — ${order.celebName} for ${order.fanName} (paid, ${delivered ? 'delivered' : 'DELIVERY FAILED — needs manual resend'})`);
}

module.exports = { fulfillFancardOrder };
