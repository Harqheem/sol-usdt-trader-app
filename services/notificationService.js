// services/notificationService.js - FIXED: Optional channel forwarding

const axios = require('axios');
const { withTimeout } = require('../utils');

/**
 * Send Telegram notification
 * @param {string} firstMessage - Main message to send
 * @param {string} secondMessage - Detailed follow-up message
 * @param {string} symbol - Trading symbol
 * @param {boolean} forwardToChannel - Whether to forward to channel (default: false)
 */
async function sendTelegramNotification(firstMessage, secondMessage, symbol, forwardToChannel = false) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const CHAT_ID = process.env.CHAT_ID;
  const CHANNEL_ID = process.env.CHANNEL_ID;
  
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('Telegram bot token or chat ID not configured');
    return;
  }
  
  try {
    // Helper function to send a single message
    const sendSingle = async (text, targetChatId = CHAT_ID) => {
      const response = await withTimeout(
        axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: targetChatId, 
          text, 
          parse_mode: 'Markdown'
        }), 
        5000
      );
      console.log(`${symbol}: Telegram sent to ${targetChatId}`, 'telegram');
      return response.data.result.message_id;
    };
    
    // Send first message to chat
    const firstMsgId = await sendSingle(firstMessage);
    
    // ✅ FIX: Only forward to channel if explicitly requested
    if (forwardToChannel && CHANNEL_ID) {
      try {
        await withTimeout(
          axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`, {
            chat_id: CHANNEL_ID, 
            from_chat_id: CHAT_ID, 
            message_id: firstMsgId
          }), 
          5000
        );
        console.log(`${symbol}: Forwarded to channel`, 'telegram');
      } catch (fwdError) {
        console.error(`Forward error ${symbol}:`, fwdError.message);
      }
    }
    
    // Send second message to chat
    await sendSingle(secondMessage);
    
  } catch (error) {
    console.error(`Telegram error ${symbol}:`, error.message);
  }
}

module.exports = { sendTelegramNotification };