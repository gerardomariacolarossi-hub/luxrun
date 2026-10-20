const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;

const config = {
  api: {
    bodyParser: false,
  },
};
module.exports.config = config;

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata;

    // 1) Save to Airtable
    // Generate unique cancellation token
    const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
    const cancelUrl = `${process.env.SITE_URL}/?cancel=${token}`;

    try {
      console.log('Saving to Airtable — Base:', AIRTABLE_BASE);
      console.log('Token present:', !!AIRTABLE_TOKEN);
      console.log('Meta:', JSON.stringify(meta));
      
      const airtableRes = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/Participants`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fields: {
            'Full Name': `${meta.firstName} ${meta.lastName}`,
            'Email': meta.email,
            'Tour Date': meta.date,
            'Number of People': parseInt(meta.people),
            'Food Allergies': meta.allergies,
            'Earphone Rental': meta.earphones === 'true',
            'Payment Confirmed': true,
            'Cancellation Token': token,
            'Stripe Payment Intent': session.payment_intent,
          },
        }),
      });
      const airtableData = await airtableRes.json();
      console.log('Airtable response status:', airtableRes.status);
      console.log('Airtable response:', JSON.stringify(airtableData));
    } catch (err) {
      console.error('Airtable error:', err);
    }

    // Update Booked Spots in Sessions
    try {
      // Extract ISO date from meta.date (could be "2026-11-08" or text format)
      let sessionDate = meta.date;
      if (sessionDate.length === 10 && sessionDate.includes('-')) {
        // Already ISO format
      } else if (sessionDate.includes('T')) {
        sessionDate = sessionDate.split('T')[0];
      } else {
        sessionDate = sessionDate.split(' at ')[0].replace(/^[A-Za-z]+,\s*/, '').trim();
      }
      console.log('Looking for session date:', sessionDate);
      const sessionRes = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE}/Sessions?filterByFormula={Date}="${sessionDate}"`,
        { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
      );
      const sessionData = await sessionRes.json();
      const session = sessionData.records?.[0];
      if (session) {
        const currentBooked = session.fields['Booked Spots'] || 0;
        await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/Sessions/${session.id}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fields: { 'Booked Spots': currentBooked + parseInt(meta.people) },
          }),
        });
      }
    } catch (err) {
      console.error('Session update error:', err);
    }

    // 2) Send confirmation email to participant
    try {
      await resend.emails.send({
        from: 'LuxRun <onboarding@resend.dev>',
        to: meta.email,
        subject: 'Your LuxRun booking is confirmed!',
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px">
            <img src="https://luxrunv3-1.vercel.app/logo.png" alt="LuxRun" style="height:40px;margin-bottom:32px">
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">You're in, ${meta.firstName}!</h1>
            <p style="color:#555;line-height:1.7;margin-bottom:24px">Your spot on the Luxembourg City Running Tour is confirmed. Here are your details:</p>
            <div style="background:#F7F6F1;border-radius:12px;padding:20px;margin-bottom:24px">
              <p style="margin:0 0 8px"><strong>Date:</strong> ${meta.date}</p>
              <p style="margin:0 0 8px"><strong>Time:</strong> ${meta.time}</p>
              <p style="margin:0 0 8px"><strong>Participants:</strong> ${meta.people}</p>
              <p style="margin:0 0 8px"><strong>Meeting point:</strong> Coque Sports Centre, Kirchberg</p>
              ${meta.earphones === 'true' ? '<p style="margin:0"><strong>Earphones:</strong> Rental included</p>' : ''}
            </div>
            <p style="color:#555;line-height:1.7;margin-bottom:16px"><strong>Important:</strong> The day before your tour, you will receive a separate email with your personal QR code to access the audio experience. Download the app in advance — it works fully offline via GPS, no internet needed during the run.</p>
            <p style="color:#555;line-height:1.7;margin-bottom:24px">Please arrive 5 minutes before the start time and look for the LuxRun guide.</p>
            <a href="${cancelUrl}" style="display:inline-block;margin-top:16px;background:#18180F;color:#fff;padding:12px 24px;border-radius:100px;font-family:sans-serif;font-size:14px;font-weight:600;text-decoration:none">Cancel booking</a>
            <p style="color:#999;font-size:13px;margin-top:12px">Free cancellation up to 24 hours before the tour.</p>
            <hr style="border:none;border-top:1px solid #E0E0E0;margin:24px 0">
            <p style="color:#999;font-size:12px">© 2026 LuxRun. Luxembourg City.</p>
          </div>
        `,
      });
    } catch (err) {
      console.error('Email error:', err);
    }

    // 3) Send notification email to organizer
    try {
      await resend.emails.send({
        from: 'LuxRun <onboarding@resend.dev>',
        to: process.env.ORGANIZER_EMAIL,
        subject: `New booking — ${meta.date}`,
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px">
            <h2 style="font-size:20px;margin-bottom:16px">New booking received</h2>
            <p><strong>Name:</strong> ${meta.firstName} ${meta.lastName}</p>
            <p><strong>Email:</strong> ${meta.email}</p>
            <p><strong>Date:</strong> ${meta.date} at ${meta.time}</p>
            <p><strong>Participants:</strong> ${meta.people}</p>
            <p><strong>Allergies:</strong> ${meta.allergies}</p>
            <p><strong>Earphones:</strong> ${meta.earphones === 'true' ? 'Yes' : 'No'}</p>
            <p><strong>Amount paid:</strong> €${(session.amount_total / 100).toFixed(2)}</p>
          </div>
        `,
      });
    } catch (err) {
      console.error('Organizer email error:', err);
    }
  }

  res.status(200).json({ received: true });
};
