const axios = require('axios');

const API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${API_KEY}`;

async function moderate(text) {
  if (!API_KEY) return false; // skip if no key
  try {
    const response = await axios.post(GEMINI_URL, {
      contents: [{ parts: [{ text: `Analyze the following text for toxicity, harassment, hate speech, etc. Return only "negative" or "positive".\nText: "${text}"` }] }]
    });
    const result = response.data.candidates[0].content.parts[0].text.trim().toLowerCase();
    return result === 'negative';
  } catch (err) {
    console.error('Gemini API error:', err.message);
    return false;
  }
}

module.exports = { moderate };
