const express = require('express');
const axios = require('axios');
require('dotenv').config(); // Load .env

const app = express();

async function sendTelegramNotification(message) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const CHAT_ID = process.env.CHAT_ID;
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('Telegram BOT_TOKEN or CHAT_ID not set in .env');
    return 'Error: Missing BOT_TOKEN or CHAT_ID';
  }

  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
    console.log('Telegram notification sent:', message);
    return 'Notification sent successfully!';
  } catch (error) {
    console.error('Telegram send error:', error.message);
    return `Error: ${error.message}`;
  }
}

// Test endpoint to trigger notification
app.get('/test', async (req, res) => {
  const result = await sendTelegramNotification('This is a test notification from the minimal server.js');
  res.send(result);
});

app.listen(3000, () => console.log('Test server running on http://localhost:3000/test'));