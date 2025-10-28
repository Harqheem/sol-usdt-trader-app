function validateEnv() {
  const required = ['BOT_TOKEN', 'CHAT_ID'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!process.env.CHANNEL_ID) console.warn('⚠️  CHANNEL_ID not set');
  console.log('✅ Environment variables validated');
}

module.exports = validateEnv;