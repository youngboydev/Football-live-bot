
import TelegramBot from 'node-telegram-bot-api';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
}

const bot = new TelegramBot(TOKEN);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const update = req.body;

    if (update?.message) {
      await bot.processUpdate(update);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[WEBHOOK ERROR]', error);
    return res.status(500).json({ ok: false });
  }
}
