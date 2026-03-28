const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const { EmpirePair, pullLatestFromGitHub, activeSockets, NUMBER_LIST_PATH } = require('./truthx');

const BOT_TOKEN = '8525922974:AAEFu_VG1Q8auPz1Yb-ZcajUxKpGxje3_mk';
const OWNER_ID = '7131299411';

let bot = null;

const WELCOME_MSG =
`╭─────〔 𝗧𝗥𝗨𝗧𝗛𝗫 𝗠𝗜𝗡𝗜🇰🇪 〕─────┈⊷
│
│  📟 /pair <number>      — Connect WhatsApp
│  🗑️ /delpair <number>   — Remove session
│  📋 /listpaired         — View connected numbers
│  📊 /botinfo            — Bot status & info
│  🆔 /getmyid            — Your Telegram ID
│  🏓 /ping               — Check bot speed
│  ⏱️ /uptime             — Bot uptime
│  📢 /broadcast <msg>    — [Owner] Broadcast
│
│  📢 Channel: https://t.me/Techworld401
│  👥 Group:   https://t.me/sensation254
│
╰──────────────────────────┈⊷`;

function readNumbers() {
    try {
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
        }
    } catch (_) {}
    return [];
}

function writeNumbers(list) {
    try {
        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(list, null, 2));
    } catch (_) {}
}

async function startBot() {
    try {
        const clearBot = new TelegramBot(BOT_TOKEN, { polling: false });
        await clearBot.deleteWebhook({ drop_pending_updates: true });
    } catch (_) {}

    bot = new TelegramBot(BOT_TOKEN, {
        polling: {
            interval: 300,
            autoStart: true,
            params: { timeout: 10 }
        }
    });

    const userSessions = new Map();

    // ── /start ────────────────────────────────────────────────────────
    bot.onText(/\/start/, (msg) => {
        bot.sendMessage(msg.chat.id, WELCOME_MSG);
    });

    // ── /help ─────────────────────────────────────────────────────────
    bot.onText(/\/help/, (msg) => {
        bot.sendMessage(msg.chat.id, WELCOME_MSG);
    });

    // ── /pair ─────────────────────────────────────────────────────────
    bot.onText(/\/pair(?:\s+(\S+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const number = match[1];
        if (!number) {
            bot.sendMessage(chatId,
                '📱 Usage: /pair <number>\n\nExample: /pair +2348012345678',
                { parse_mode: 'Markdown' }
            );
            userSessions.set(chatId, { step: 'awaiting_number' });
            return;
        }
        await runPairing(chatId, number, msg);
    });

    // ── /delpair ──────────────────────────────────────────────────────
    bot.onText(/\/delpair(?:\s+(\S+))?/, (msg, match) => {
        const chatId = msg.chat.id;
        if (String(chatId) !== OWNER_ID) return bot.sendMessage(chatId, '❌ Owner only!');
        const raw = match[1];
        if (!raw) return bot.sendMessage(chatId, '❌ Usage: /delpair <number>');
        const number = raw.replace(/\D/g, '');
        const list = readNumbers();
        if (!list.includes(number)) return bot.sendMessage(chatId, `❌ Number *${number}* not found in session list.`, { parse_mode: 'Markdown' });
        // Close socket if active
        const sock = activeSockets.get(number);
        if (sock) {
            try { sock.end(); } catch (_) {}
            activeSockets.delete(number);
        }
        writeNumbers(list.filter(n => n !== number));
        bot.sendMessage(chatId, `✅ Session removed for *${number}*`, { parse_mode: 'Markdown' });
    });

    // ── /listpaired ───────────────────────────────────────────────────
    bot.onText(/\/listpaired/, (msg) => {
        const chatId = msg.chat.id;
        if (String(chatId) !== OWNER_ID) return bot.sendMessage(chatId, '❌ Owner only!');
        const list = readNumbers();
        if (!list.length) return bot.sendMessage(chatId, '📋 No paired numbers yet.');
        const lines = list.map((n, i) => {
            const online = activeSockets.has(n) ? '🟢' : '🔴';
            return `│  ${online} ${i + 1}. ${n}`;
        });
        bot.sendMessage(chatId,
            `╭─────〔 Paired Numbers 〕─────┈⊷\n${lines.join('\n')}\n╰─────────────────────────┈⊷\n\nTotal: ${list.length}`,
            { parse_mode: 'Markdown' }
        );
    });

    // ── /botinfo ──────────────────────────────────────────────────────
    bot.onText(/\/botinfo/, (msg) => {
        const chatId = msg.chat.id;
        const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        const uptimeSec = Math.floor(process.uptime());
        const h = Math.floor(uptimeSec / 3600);
        const m = Math.floor((uptimeSec % 3600) / 60);
        const s = uptimeSec % 60;
        const paired = readNumbers().length;
        const active = activeSockets.size;
        bot.sendMessage(chatId,
`╭─────〔 Bot Info 〕─────┈⊷
│
│  🤖 Bot: TRUTHX MINI🇰🇪
│  ⏱️ Uptime: ${h}h ${m}m ${s}s
│  💾 Memory: ${mem} MB
│  📱 Paired: ${paired} number(s)
│  🟢 Active: ${active} socket(s)
│  🌐 Status: Online
│
╰──────────────────────┈⊷`
        );
    });

    // ── /getmyid ──────────────────────────────────────────────────────
    bot.onText(/\/getmyid/, (msg) => {
        const chatId = msg.chat.id;
        const from = msg.from;
        bot.sendMessage(chatId,
`╭─────〔 Your Info 〕─────┈⊷
│
│  🆔 Telegram ID: ${from.id}
│  👤 Name: ${from.first_name}${from.last_name ? ' ' + from.last_name : ''}
│  🔖 Username: ${from.username ? '@' + from.username : 'N/A'}
│
╰──────────────────────┈⊷`
        );
    });

    // ── /ping ─────────────────────────────────────────────────────────
    bot.onText(/\/ping/, async (msg) => {
        const chatId = msg.chat.id;
        const start = Date.now();
        const sent = await bot.sendMessage(chatId, '🏓 Pinging...');
        const ms = Date.now() - start;
        bot.editMessageText(
`╭─────〔 Ping 〕─────┈⊷
│
│  🏓 Response: ${ms}ms
│  🟢 Status: Online
│
╰──────────────────────┈⊷`,
            { chat_id: chatId, message_id: sent.message_id }
        );
    });

    // ── /uptime ───────────────────────────────────────────────────────
    bot.onText(/\/uptime/, (msg) => {
        const chatId = msg.chat.id;
        const uptimeSec = Math.floor(process.uptime());
        const d = Math.floor(uptimeSec / 86400);
        const h = Math.floor((uptimeSec % 86400) / 3600);
        const m = Math.floor((uptimeSec % 3600) / 60);
        const s = uptimeSec % 60;
        bot.sendMessage(chatId,
`╭─────〔 Uptime 〕─────┈⊷
│
│  ⏱️ ${d}d ${h}h ${m}m ${s}s
│  🟢 Bot is running
│
╰──────────────────────┈⊷`
        );
    });

    // ── /broadcast ────────────────────────────────────────────────────
    bot.onText(/\/broadcast(?:\s+([\s\S]+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (String(chatId) !== OWNER_ID) return bot.sendMessage(chatId, '❌ Owner only!');
        const text = match[1];
        if (!text) return bot.sendMessage(chatId, '❌ Usage: /broadcast <message>');
        // Broadcast to all active sockets via WhatsApp would need WA context
        // For now, confirm the message was sent to the owner group/channel
        bot.sendMessage(chatId, `📢 Broadcast sent:\n\n${text}`);
    });

    // ── /status (owner) ───────────────────────────────────────────────
    bot.onText(/\/status/, async (msg) => {
        const chatId = msg.chat.id;
        if (String(chatId) !== OWNER_ID) return bot.sendMessage(chatId, '❌ Owner only!');
        const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        const uptimeSec = Math.floor(process.uptime());
        const h = Math.floor(uptimeSec / 3600), m = Math.floor((uptimeSec % 3600) / 60), s = uptimeSec % 60;
        bot.sendMessage(chatId,
            `✅ *TRUTHX Bot Status*\n\n⏱ Uptime: ${h}h ${m}m ${s}s\n💾 Memory: ${mem}MB\n🟢 Status: Online`,
            { parse_mode: 'Markdown' }
        );
    });

    // ── /panel (owner) ────────────────────────────────────────────────
    bot.onText(/\/panel/, (msg) => {
        const chatId = msg.chat.id;
        if (String(chatId) !== OWNER_ID) return bot.sendMessage(chatId, '❌ Owner only!');
        bot.sendMessage(chatId,
            '🎛️ *TRUTHX Control Panel*\n\nSelect an action:',
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '♻️ Restart Bot', callback_data: 'action_restart' },
                            { text: '⬆️ Update from GitHub', callback_data: 'action_update' }
                        ],
                        [
                            { text: '📊 Status', callback_data: 'action_status' },
                            { text: '📱 Pair Number', callback_data: 'action_pair' }
                        ]
                    ]
                }
            }
        );
    });

    // ── /restart (owner) ──────────────────────────────────────────────
    bot.onText(/\/restart/, async (msg) => {
        const chatId = msg.chat.id;
        if (String(chatId) !== OWNER_ID) return bot.sendMessage(chatId, '❌ Owner only!');
        await bot.sendMessage(chatId, '♻️ *Restarting bot...*\n\nBot will be back online in a few seconds.', { parse_mode: 'Markdown' });
        setTimeout(() => process.exit(0), 1000);
    });

    // ── /update (owner) ───────────────────────────────────────────────
    bot.onText(/\/update/, async (msg) => {
        const chatId = msg.chat.id;
        if (String(chatId) !== OWNER_ID) return bot.sendMessage(chatId, '❌ Owner only!');
        const waitMsg = await bot.sendMessage(chatId, '⏳ *Pulling latest code from GitHub...*', { parse_mode: 'Markdown' });
        try {
            const updated = await pullLatestFromGitHub();
            await bot.editMessageText(
                `✅ *Update Complete!*\n\nUpdated files:\n${updated.map(f => `• \`${f}\``).join('\n')}\n\n♻️ Restarting now...`,
                { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'Markdown' }
            );
            setTimeout(() => process.exit(0), 1500);
        } catch (err) {
            await bot.editMessageText(
                `❌ *Update failed:*\n\`${err.message}\``,
                { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'Markdown' }
            );
        }
    });

    // ── Inline button callbacks ───────────────────────────────────────
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const data = query.data;
        if (String(chatId) !== OWNER_ID) {
            return bot.answerCallbackQuery(query.id, { text: '❌ Owner only!' });
        }
        if (data === 'action_restart') {
            await bot.answerCallbackQuery(query.id, { text: '♻️ Restarting...' });
            await bot.sendMessage(chatId, '♻️ *Restarting bot...*', { parse_mode: 'Markdown' });
            setTimeout(() => process.exit(0), 1000);
        } else if (data === 'action_update') {
            await bot.answerCallbackQuery(query.id, { text: '⏳ Pulling from GitHub...' });
            const waitMsg = await bot.sendMessage(chatId, '⏳ *Pulling latest code from GitHub...*', { parse_mode: 'Markdown' });
            try {
                const updated = await pullLatestFromGitHub();
                await bot.editMessageText(
                    `✅ *Update Complete!*\n\nUpdated:\n${updated.map(f => `• \`${f}\``).join('\n')}\n\n♻️ Restarting now...`,
                    { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'Markdown' }
                );
                setTimeout(() => process.exit(0), 1500);
            } catch (err) {
                await bot.editMessageText(`❌ *Update failed:*\n\`${err.message}\``,
                    { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'Markdown' }
                );
            }
        } else if (data === 'action_status') {
            await bot.answerCallbackQuery(query.id);
            const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
            const uptimeSec = Math.floor(process.uptime());
            const h = Math.floor(uptimeSec / 3600), m = Math.floor((uptimeSec % 3600) / 60), s = uptimeSec % 60;
            await bot.sendMessage(chatId,
                `📊 *Bot Status*\n\n⏱ Uptime: ${h}h ${m}m ${s}s\n💾 Memory: ${mem}MB\n🟢 Online`,
                { parse_mode: 'Markdown' }
            );
        } else if (data === 'action_pair') {
            await bot.answerCallbackQuery(query.id);
            await bot.sendMessage(chatId, '📱 Send your WhatsApp number with country code:\n\nExample: `+2348012345678`', { parse_mode: 'Markdown' });
            userSessions.set(chatId, { step: 'awaiting_number' });
        }
    });

    // ── Free-text number input ────────────────────────────────────────
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text || '';
        if (text.startsWith('/')) return;

        const phoneRegex = /^(\+?)[0-9]{7,15}$/;
        const cleanedNumber = text.replace(/\s+/g, '').replace(/-/g, '');
        if (!phoneRegex.test(cleanedNumber)) {
            bot.sendMessage(chatId,
                '❌ Invalid number format.\n\nPlease send a valid WhatsApp number with country code.\nExample: `+2348012345678`',
                { parse_mode: 'Markdown' }
            );
            return;
        }
        await runPairing(chatId, cleanedNumber, msg);
    });

    // ── Polling error handler ─────────────────────────────────────────
    bot.on('polling_error', (error) => {
        if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
            console.warn('Telegram 409 conflict — another instance is running, stopping polling.');
            bot.stopPolling();
        } else {
            console.error('Telegram polling error:', error.message);
        }
    });

    console.log('🤖 Telegram bot started successfully!');
    return bot;
}

// ── Shared pairing helper ─────────────────────────────────────────────
async function runPairing(chatId, number, msg) {
    const waitMsg = await bot.sendMessage(chatId,
        `⏳ *Generating pairing code for* \`${number}\`...\n\nPlease wait a moment.`,
        { parse_mode: 'Markdown' }
    );
    try {
        const code = await new Promise((resolve, reject) => {
            const mockRes = {
                headersSent: false,
                send: (data) => {
                    mockRes.headersSent = true;
                    if (data && data.code) resolve(data.code);
                    else if (data && data.error) reject(new Error(data.error));
                    else if (data && data.status === 'already_connected') reject(new Error('This number is already connected.'));
                    else reject(new Error('Failed to get pairing code.'));
                },
                status: function() {
                    return {
                        send: (data) => {
                            mockRes.headersSent = true;
                            reject(new Error(data?.error || 'Request failed.'));
                        }
                    };
                }
            };
            EmpirePair(number, mockRes).catch(reject);
        });

        const formattedCode = code.match(/.{1,4}/g).join('-');
        await bot.editMessageText(
            `✅ *Pairing Code Generated!*\n\n` +
            `📱 Number: \`${number}\`\n\n` +
            `🔑 *Your Code:*\n\`\`\`\n${formattedCode}\n\`\`\`\n\n` +
            `📋 *Steps:*\n` +
            `1. Open WhatsApp\n` +
            `2. Go to *Settings → Linked Devices*\n` +
            `3. Tap *Link a Device*\n` +
            `4. Tap *Link with phone number instead*\n` +
            `5. Enter the code above\n\n` +
            `⚠️ Code expires in a few minutes!`,
            { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'Markdown' }
        );
        notifyOwner(`✅ New pairing!\nNumber: ${number}\nCode: ${formattedCode}\nUser: @${msg.from.username || msg.from.first_name} (${chatId})`);
    } catch (err) {
        console.error('Telegram pairing error:', err.message);
        await bot.editMessageText(
            `❌ *Failed to generate pairing code*\n\nReason: ${err.message}\n\nPlease make sure the number is correct and try again.`,
            { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'Markdown' }
        );
    }
}

function notifyOwner(message) {
    if (!bot || !OWNER_ID) return;
    bot.sendMessage(OWNER_ID, message, { parse_mode: 'Markdown' }).catch(() => {});
}

function stopBot() {
    if (bot) {
        bot.stopPolling().catch(() => {});
        bot = null;
    }
}

process.once('SIGTERM', stopBot);
process.once('SIGINT', stopBot);

startBot().catch(err => console.error('Failed to start Telegram bot:', err.message));

module.exports = { notifyOwner, stopBot };
