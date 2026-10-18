const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { date, time, people, earphones, firstName, lastName, email, allergies } = req.body;

    const lineItems = [
      {
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Luxembourg City Running Tour',
            description: `${date} at ${time} — ${people} participant${people > 1 ? 's' : ''}`,
          },
          unit_amount: 2000,
        },
        quantity: parseInt(people),
      },
    ];

    if (earphones) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Earphone Rental',
            description: 'Earphones for the tour — returned at the end',
          },
          unit_amount: 300,
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${process.env.SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}/#detail`,
      customer_email: email,
      metadata: {
        date,
        time,
        people: String(people),
        earphones: String(earphones),
        firstName,
        lastName,
        email,
        allergies: allergies || 'None',
      },
    });

    res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
};
