const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;

export const config = {
  api: { bodyParser: true },
};

async function findBookingByToken(token) {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/Participants?filterByFormula={Cancellation Token}="${token}"`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );
  const data = await res.json();
  return data.records?.[0] || null;
}

async function updateBooking(recordId, fields) {
  await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/Participants/${recordId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
}

async function updateSessionSpots(date, delta) {
  // Find the session by date
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/Sessions?filterByFormula={Date}="${date}"`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );
  const data = await res.json();
  const session = data.records?.[0];
  if (!session) return;

  const currentBooked = session.fields['Booked Spots'] || 0;
  await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/Sessions/${session.id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: { 'Booked Spots': Math.max(0, currentBooked + delta) },
    }),
  });
}

module.exports = async (req, res) => {
  const { token, action } = req.method === 'GET' ? req.query : req.body;

  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }

  // GET — fetch booking details to show on cancel page
  if (req.method === 'GET' || action === 'check') {
    const booking = await findBookingByToken(token);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    if (booking.fields['Payment Confirmed'] === false) {
      return res.status(400).json({ error: 'Booking already cancelled' });
    }

    // Parse date from text format "Sunday, 1 November 2026 at 10:00"
    const dateStr = booking.fields['Tour Date'];
    const cleanDate = dateStr.replace(/^[A-Za-z]+,\s*/, '').replace(' at ', ' ');
    const tourDate = new Date(cleanDate);
    const now = new Date();
    const hoursUntilTour = isNaN(tourDate) ? 999 : (tourDate - now) / (1000 * 60 * 60);
    const canCancel = hoursUntilTour > 24;

    return res.status(200).json({
      name: booking.fields['Full Name'],
      date: booking.fields['Tour Date'],
      people: booking.fields['Number of People'],
      canCancel,
      hoursUntilTour: Math.round(hoursUntilTour),
    });
  }

  // POST — process cancellation
  if (req.method === 'POST' && action === 'confirm') {
    const booking = await findBookingByToken(token);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    if (booking.fields['Payment Confirmed'] === false) {
      return res.status(400).json({ error: 'Already cancelled' });
    }

    const dateStr2 = booking.fields['Tour Date'];
    const cleanDate2 = dateStr2.replace(/^[A-Za-z]+,\s*/, '').replace(' at ', ' ');
    const tourDate = new Date(cleanDate2);
    const now = new Date();
    const hoursUntilTour = isNaN(tourDate) ? 999 : (tourDate - now) / (1000 * 60 * 60);

    if (hoursUntilTour <= 24) {
      return res.status(400).json({ error: 'Cancellation window expired' });
    }

    // Refund via Stripe
    try {
      const paymentIntentId = booking.fields['Stripe Payment Intent'];
      if (paymentIntentId) {
        await stripe.refunds.create({ payment_intent: paymentIntentId });
      }
    } catch (err) {
      console.error('Stripe refund error:', err);
      return res.status(500).json({ error: 'Refund failed' });
    }

    // Update Airtable
    // Delete the booking row from Airtable
    await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/Participants/${booking.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });

    // Decrement Booked Spots in Sessions
    try {
      const dateStr3 = booking.fields['Tour Date'];
      const cleanDate3 = dateStr3.replace(/^[A-Za-z]+,\s*/, '').replace(' at ', ' ').trim();
      const dateOnly = new Date(cleanDate3).toISOString().split('T')[0];
      const sessionRes = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE}/Sessions`,
        { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
      );
      const sessionData = await sessionRes.json();
      const sess = sessionData.records?.find(r => r.fields['Date'] === dateOnly);
      if (sess) {
        const currentBooked = sess.fields['Booked Spots'] || 0;
        await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/Sessions/${sess.id}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fields: { 'Booked Spots': Math.max(0, currentBooked - (booking.fields['Number of People'] || 1)) },
          }),
        });
      }
    } catch (err) {
      console.error('Session decrement error:', err);
    }

    // Free up the spot
    await updateSessionSpots(booking.fields['Tour Date'], -1);

    // Send cancellation confirmation email
    try {
      await resend.emails.send({
        from: 'LuxRun <onboarding@resend.dev>',
        to: booking.fields['Email'],
        subject: 'Your LuxRun booking has been cancelled',
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px">
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Booking cancelled</h1>
            <p style="color:#555;line-height:1.7;margin-bottom:24px">Your booking for the Luxembourg City Running Tour on <strong>${booking.fields['Tour Date']}</strong> has been successfully cancelled.</p>
            <p style="color:#555;line-height:1.7;margin-bottom:24px">Your refund has been processed and will appear on your statement within 5-10 business days.</p>
            <p style="color:#555;line-height:1.7">We hope to see you on a future run. Check our website for upcoming dates.</p>
            <hr style="border:none;border-top:1px solid #E0E0E0;margin:24px 0">
            <p style="color:#999;font-size:12px">2026 LuxRun. Luxembourg City.</p>
          </div>
        `,
      });
    } catch (err) {
      console.error('Cancellation email error:', err);
    }

    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: 'Invalid request' });
};
