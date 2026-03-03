const axios = require('axios');
const { proto, generateWAMessageFromContent } = require('@whiskeysockets/baileys');

const PAIR_API = 'https://web-production-a554.up.railway.app/code';

async function pairCommand(sock, chatId, message) {
    try {
        const messageText = message?.message?.conversation || message?.message?.extendedTextMessage?.text || '';
        const phoneNumber = messageText.split(' ')[1]?.replace(/[^0-9]/g, '');

        if (!phoneNumber) {
            await sock.sendMessage(chatId, {
                text: "❌ Please provide a phone number!\nExample: .pair 254743XXXXXX"
            });
            return;
        }

        await sock.sendMessage(chatId, {
            text: "🔄 Generating pairing code, please wait..."
        });

        const res = await axios.get(PAIR_API, {
            params: { number: phoneNumber },
            timeout: 60000
        });

        const code = res.data?.code;

        if (!code || code === 'Please provide a phone number') {
            await sock.sendMessage(chatId, {
                text: "❌ Failed to generate pairing code. Please check the number and try again."
            });
            return;
        }

        const formatted = code.includes('-') ? code : (code.match(/.{1,4}/g)?.join('-') || code);

        const bodyText = `╔══════════════════╗\n║  *TRUTH-MD PAIRING*  ║\n╚══════════════════╝\n\n` +
            `📱 *Phone:* +${phoneNumber}\n` +
            `🔑 *Code:* ${formatted}\n\n` +
            `📚 *How to link:*\n` +
            `1. Open WhatsApp → Settings → Linked Devices\n` +
            `2. Tap "Link a Device"\n` +
            `3. Select "Link with phone number"\n` +
            `4. Enter the code above\n\n` +
            `⏳ Code valid for *2 minutes*.\n` +
            `📩 Your SESSION_ID will be sent here once linked.`;

        const msg = generateWAMessageFromContent(chatId, proto.Message.fromObject({
            interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                body: proto.Message.InteractiveMessage.Body.fromObject({ text: bodyText }),
                footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: '© TRUTH-MD Bot' }),
                nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                    buttons: [
                        {
                            name: 'cta_copy',
                            buttonParamsJson: JSON.stringify({
                                display_text: '📋 Tap to Copy Code',
                                copy_code: formatted
                            })
                        }
                    ]
                })
            })
        }), { quoted: message });

        await sock.relayMessage(chatId, msg.message, { messageId: msg.key.id });

    } catch (error) {
        console.error('Pair command error:', error.message || error);
        await sock.sendMessage(chatId, {
            text: "❌ Error generating pairing code. The pairing server might be starting up — try again in a minute."
        });
    }
}

module.exports = pairCommand;
