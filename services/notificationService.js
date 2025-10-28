const axios = require('axios');
const { withTimeout } = require('../utils');

async function sendTelegramNotification(firstMessage, secondMessage, symbol) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const CHAT_ID = process.env.CHAT_ID;
  const CHANNEL_ID = process.env.CHANNEL_ID;
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    const sendSingle = async (text, targetChatId = CHAT_ID) => {
      const response = await withTimeout(axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: targetChatId, text, parse_mode: 'Markdown'
      }), 5000);
      console.log(symbol, `Telegram sent to ${targetChatId}`, 'telegram');
      return response.data.result.message_id;
    };
    const firstMsgId = await sendSingle(firstMessage);
    if (CHANNEL_ID) {
      try {
        await withTimeout(axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`, {
          chat_id: CHANNEL_ID, from_chat_id: CHAT_ID, message_id: firstMsgId
        }), 5000);
        console.log(symbol, 'Forwarded to channel', 'telegram');
      } catch (fwdError) {
        console.error(`Forward error ${symbol}:`, fwdError.message);
      }
    }
    await sendSingle(secondMessage);
  } catch (error) {
    console.error(`Telegram error ${symbol}:`, error.message);
  }
}

module.exports = { sendTelegramNotification };