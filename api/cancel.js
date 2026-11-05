const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;

function wallTime(v) {
  // Airtable returns Start Time as a full date-time (e.g. 2026-11-08T10:00:00.000Z).
  // The digits are the time typed in Airtable (the field is kept in GMT), so we just keep HH:MM.
  const m = String(v || '').match(/(\d{1,2}):(\d{2})/);
  return m ? m[1].padStart(2, '0') + ':' + m[2] : '10:00';
}

// Real instant (ms) of a tour start, where the time is Luxembourg wall-clock time.
function luxStartInstant(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (t) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Luxembourg',
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(t));
    const g = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour, +g.minute, +g.second) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}

async function airtable(path, options = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return res.json();
}

async function findBookingByToken(token) {
  const formula = encodeURIComponent(`{Cancellation Token}="${token}"`);
  const data = await airtable(`/Participants?filterByFormula=${formula}`);
  return data.records?.[0] || null;
}

async function findSession(dateStr) {
  // Date fields cannot be filtered with a text formula, so we filter here.
  const data = await airtable('/Sessions');
  return data.records?.find((r) => r.fields['Date'] === dateStr) || null;
}

// Works out when the tour really starts and how many hours are left.
async function getTiming(booking) {
  const raw = String(booking.fields['Tour Date'] || '');
  const m = raw.match(/^\d{4}-\d{2}-\d{2}/);
  if (!m) {
    // Old test bookings with an unusual date format: treat as cancellable.
    return { dateStr: raw, time: null, hoursUntil: 999, session: null };
  }
  const dateStr = m[0];
  const session = await findSession(dateStr);
  const time = session ? wallTime(session.fields['Start Time']) : '10:00';
  const hoursUntil = (luxStartInstant(dateStr, time) - Date.now()) / 36e5;
  return { dateStr, time, hoursUntil, session };
}

module.exports = async (req, res) => {
  const { token, action } = req.method === 'GET' ? req.query : req.body || {};

  if (!token || !/^[A-Za-z0-9]+$/.test(String(token))) {
    return res.status(400).json({ error: 'Missing or invalid token' });
  }

  try {
    const booking = await findBookingByToken(token);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    if (booking.fields['Payment Confirmed'] === false) {
      return res.status(400).json({ error: 'Booking already cancelled' });
    }

    const timing = await getTiming(booking);

    // Show the booking on the cancel overlay
    if (req.method === 'GET' || action === 'check') {
      return res.status(200).json({
        name: booking.fields['Full Name'],
        date: timing.dateStr,
        time: timing.time,
        people: booking.fields['Number of People'],
        canCancel: timing.hoursUntil > 24,
        hoursUntilTour: Math.round(timing.hoursUntil),
      });
    }

    // Confirm the cancellation
    if (req.method === 'POST' && action === 'confirm') {
      if (timing.hoursUntil <= 24) {
        return res.status(400).json({ error: 'Cancellation window expired' });
      }

      try {
        const paymentIntentId = booking.fields['Stripe Payment Intent'];
        if (paymentIntentId) {
          await stripe.refunds.create({ payment_intent: paymentIntentId });
        }
      } catch (err) {
        console.error('Stripe refund error:', err);
        return res.status(500).json({ error: 'Refund failed' });
      }

      // Remove the booking row
      await airtable(`/Participants/${booking.id}`, { method: 'DELETE' });

      // Free the spots in the session
      try {
        if (timing.session) {
          const booked = timing.session.fields['Booked Spots'] || 0;
          const people = booking.fields['Number of People'] || 1;
          await airtable(`/Sessions/${timing.session.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ fields: { 'Booked Spots': Math.max(0, booked - people) } }),
          });
        }
      } catch (err) {
        console.error('Session decrement error:', err);
      }

      // Confirmation email
      try {
        const when = `${timing.dateStr}${timing.time ? ' at ' + timing.time : ''}`;
        await resend.emails.send({
          from: 'LuxRun <onboarding@resend.dev>',
          to: booking.fields['Email'],
          subject: 'Your LuxRun booking has been cancelled',
          html: `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px">
              <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Booking cancelled</h1>
              <p style="color:#555;line-height:1.7;margin-bottom:24px">Your booking for the Luxembourg City Running Tour on <strong>${when}</strong> has been cancelled.</p>
              <p style="color:#555;line-height:1.7;margin-bottom:24px">Your refund has been processed and will appear on your statement within 5-10 business days.</p>
              <p style="color:#555;line-height:1.7">We hope to see you on a future run!</p>
              <hr style="border:none;border-top:1px solid #E0E0E0;margin:24px 0">
              <p style="color:#999;font-size:12px">2026 LuxRun. Luxembourg City.</p>
            </div>`,
        });
      } catch (err) {
        console.error('Cancellation email error:', err);
      }

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Invalid request' });
  } catch (err) {
    console.error('Cancel error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
};
