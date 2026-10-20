const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;

module.exports = async (req, res) => {
  // Allow CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const response = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/Sessions?sort[0][field]=Date&sort[0][direction]=asc`,
      {
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
      }
    );
    
    const data = await response.json();
    
    if (!response.ok) {
      console.error('Airtable sessions error:', JSON.stringify(data));
      return res.status(500).json({ error: 'Failed to fetch sessions' });
    }

    const sessions = data.records.map(record => ({
      id: record.id,
      date: record.fields['Date'],
      startTime: record.fields['Start Time'] || '10:00',
      availableSpots: record.fields['Available Spots'] || 12,
      bookedSpots: record.fields['Booked Spots'] || 0,
      spotsLeft: (record.fields['Available Spots'] || 12) - (record.fields['Booked Spots'] || 0),
    }));

    return res.status(200).json({ sessions });
  } catch (err) {
    console.error('Sessions error:', err);
    return res.status(500).json({ error: err.message });
  }
};
