const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');

const TELEGRAM_TOKEN   = '8566670151:AAH1sph3L1sslvS6wIGV5slPd872WTJtrqQ';
const TELEGRAM_CHAT_ID = '5052409399';
const MEDIA_DIR        = './saved_media';

const WATCH_PRIVATE  = true;
const WATCH_GROUPS   = false;
const WATCH_ONLY     = [];
const IGNORE_LIST    = [];

fs.ensureDirSync(MEDIA_DIR);

const telegram = new TelegramBot(TELEGRAM_TOKEN);
const client   = new Client({ 
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    }
});
const msgCache = new Map();

// ─── استخرج الاسم والرقم بشكل صح ───
async function getContactInfo(msg) {
    try {
        const contact = await msg.getContact();
        const name    = contact.pushname || contact.name || msg.notifyName || 'مجهول';
        const number  = contact.number   || contact.id?.user || msg.from.replace('@c.us','').replace('@lid','').replace('@g.us','');
        return { name, number };
    } catch (e) {
        return {
            name:   msg.notifyName || 'مجهول',
            number: msg.from.replace('@c.us','').replace('@lid','').replace('@g.us','')
        };
    }
}

// ─── فلتر ───
function shouldTrack(msg) {
    if (msg.fromMe) return false;
    if (msg.from.endsWith('@newsletter')) return false; // ← إضافة
    const isGroup   = msg.from.endsWith('@g.us');
    const isPrivate = msg.from.endsWith('@c.us') || msg.from.endsWith('@lid');
    if (isGroup   && !WATCH_GROUPS)  return false;
    if (isPrivate && !WATCH_PRIVATE) return false;
    const number = msg.from.replace('@c.us','').replace('@g.us','').replace('@lid','');
    if (WATCH_ONLY.length > 0 && !WATCH_ONLY.includes(number)) return false;
    if (IGNORE_LIST.some(x => msg.from.includes(x))) return false;
    return true;
}
// ─── حمّل وحفظ ميديا ───
async function saveMedia(msg) {
    try {
        if (!msg.hasMedia) return null;
        const media = await msg.downloadMedia();
        if (!media) return null;
        const ext      = media.mimetype.split('/')[1].split(';')[0];
        const filePath = path.join(MEDIA_DIR, `${msg.id._serialized}.${ext}`);
        fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));
        return { filePath, mimeType: media.mimetype };
    } catch (e) {
        console.log('خطأ في الميديا:', e.message);
        return null;
    }
}

client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    console.log('امسح الـ QR Code');
});

client.on('ready', () => {
    console.log('✅ البوت شغال');
    telegram.sendMessage(TELEGRAM_CHAT_ID, '✅ البوت اشتغل وبيراقب الواتساب');
});

client.on('disconnected', () => {
    console.log('❌ انقطع الاتصال');
    telegram.sendMessage(TELEGRAM_CHAT_ID, '❌ البوت انقطع عن الواتساب');
});

// ─── احفظ كل رسالة ───
client.on('message', async msg => {
    if (!shouldTrack(msg)) return;

    const { name, number }  = await getContactInfo(msg);
    const isViewOnce         = msg._data?.viewOnce === true || msg._data?.isViewOnce === true;
    const mediaData          = await saveMedia(msg);

    const entry = {
        body:      msg.body,
        type:      msg.type,
        from:      msg.from,
        fromName:  name,
        number:    number,
        time:      new Date().toLocaleString('ar-EG'),
        mediaPath: mediaData?.filePath || null,
        mimeType:  mediaData?.mimeType || null,
        viewOnce:  isViewOnce
    };

    if (isViewOnce && mediaData) {
        const caption =
            `👁️ *صورة View Once!*\n` +
            `👤 *من:* ${name}\n` +
            `📱 *رقمه:* +${number}\n` +
            `🕐 *الوقت:* ${entry.time}`;
        await sendToTelegram(mediaData.filePath, mediaData.mimeType, caption);
    }

    msgCache.set(msg.id._serialized, entry);
});

client.on('message_create', async msg => {
    if (msg.fromMe) return;
    
    const isViewOnce = msg._data?.viewOnce === true || msg._data?.isViewOnce === true;
    if (!isViewOnce) return;
    if (!msg.hasMedia) return;

    try {
        const media = await msg.downloadMedia();
        if (!media) return;

        const ext      = media.mimetype.split('/')[1].split(';')[0];
        const filePath = path.join(MEDIA_DIR, `${msg.id._serialized}.${ext}`);
        fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));

        const { name, number } = await getContactInfo(msg);
        const caption =
            `👁️ *صورة View Once!*\n` +
            `👤 *من:* ${name}\n` +
            `📱 *رقمه:* +${number}\n` +
            `🕐 *الوقت:* ${new Date().toLocaleString('ar-EG')}`;

        await sendToTelegram(filePath, media.mimetype, caption);
    } catch (e) {
        console.log('خطأ View Once:', e.message);
    }
});

// ─── رسالة اتمسحت ───
client.on('message_revoke_everyone', async (after, before) => {
    if (!before) return;
    if (!shouldTrack(before)) return;
    const cached = msgCache.get(before.id._serialized);
    if (!cached) return;

    const caption =
        `🚨 *رسالة اتمسحت!*\n\n` +
        `👤 *من:* ${cached.fromName}\n` +
        `📱 *رقمه:* +${cached.number}\n` +
        `🕐 *الوقت:* ${cached.time}\n` +
        `📝 *النوع:* ${cached.type}\n` +
        (cached.body ? `\n💬 *الكلام:*\n${cached.body}` : '');

    await sendToTelegram(cached.mediaPath, cached.mimeType, caption);
});

// ─── Read Receipt ───
client.on('message_ack', async (msg, ack) => {
    if (ack === 3 || ack === 4) {
        if (msg.fromMe) return;
        const { name, number } = await getContactInfo(msg);
        const text =
            `👁️ *حد قرأ رسالتك!*\n\n` +
            `👤 *مين:* ${name}\n` +
            `📱 *رقمه:* +${number}\n` +
            `💬 *الرسالة:* ${msg.body || '(ميديا)'}\n` +
            `🕐 *الوقت:* ${new Date().toLocaleString('ar-EG')}`;
        await telegram.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: 'Markdown' });
    }
});

// ─── دالة الإرسال ───
async function sendToTelegram(mediaPath, mimeType, caption) {
    try {
        if (mediaPath && fs.existsSync(mediaPath)) {
            const file = fs.readFileSync(mediaPath);
            if (mimeType?.startsWith('image/')) {
                await telegram.sendPhoto(TELEGRAM_CHAT_ID, file, { caption, parse_mode: 'Markdown' });
            } else if (mimeType?.startsWith('video/')) {
                await telegram.sendVideo(TELEGRAM_CHAT_ID, file, { caption, parse_mode: 'Markdown' });
            } else if (mimeType?.startsWith('audio/')) {
                await telegram.sendAudio(TELEGRAM_CHAT_ID, file, { caption, parse_mode: 'Markdown' });
            } else {
                await telegram.sendDocument(TELEGRAM_CHAT_ID, file, { caption, parse_mode: 'Markdown' });
            }
        } else {
            await telegram.sendMessage(TELEGRAM_CHAT_ID, caption, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        console.error('خطأ في التيليجرام:', e.message);
    }
}

client.initialize();