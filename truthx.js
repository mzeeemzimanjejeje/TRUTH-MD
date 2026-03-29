const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require("form-data");
const os = require('os'); 
const { sms, downloadMediaMessage } = require("./msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['💋', '😶', '✨️', '💗', '🎈', '🎉', '🥳', '❤️', '🧫', '🐭'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    IMAGE_PATH: 'https://files.catbox.moe/8np6rc.jpg',
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/EC77ZYAhP4i1LXETAvFayE?mode=gi_t',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: 'https://files.catbox.moe/8np6rc.jpg',
    NEWSLETTER_JID: '120363409714698622@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    version: '1.0.0',
    OWNER_NUMBER: '2349132901914',
    BOT_FOOTER: '> ZEP🇰🇪',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbCafMZBA1f42UxcYW0D',
    TELEGRAM_BOT_TOKEN: '8525922974:AAEFu_VG1Q8auPz1Yb-ZcajUxKpGxje3_mk',
    TELEGRAM_OWNER_ID: '7131299411'
};

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// LID → real JID resolution map (populated from contacts.upsert events)
const lidJidMap = new Map();
let owner = process.env.GITHUB_OWNER || 'Courtney250';
let repo = process.env.GITHUB_REPO || 'TRUTH-MD';

const activeSockets = new Map();
const socketCreationTime = new Map();
const credsUpdateQueues = new Map(); // serializes GitHub creds saves per number
const credsLogCount = new Map();     // tracks how many times creds-saved is logged per number (silences after 2)
const contactNameMap = new Map();    // jid → display name (populated from contacts.upsert)
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
const otpStore = new Map();

// ── Auto-initialise GitHub repo + session folder on startup ──────
(async () => {
    try {
        // 1. Detect which account the token belongs to and use that as owner
        try {
            const { data: me } = await octokit.users.getAuthenticated();
            if (me.login && me.login !== owner) {
                console.log(`🔑 GitHub token belongs to: ${me.login} (was: ${owner}) — switching`);
                owner = me.login;
            } else {
                console.log(`🔑 GitHub token belongs to: ${me.login}`);
            }
        } catch (e) {
            console.warn(`⚠️ Could not verify GitHub token identity:`, e.message);
        }

        // 2. Ensure repo exists under the detected owner
        try {
            await octokit.repos.get({ owner, repo });
            console.log(`✅ GitHub repo ${owner}/${repo} found`);
        } catch (e) {
            if (e.status !== 404) throw e;
            await octokit.repos.createForAuthenticatedUser({
                name: repo,
                description: 'TRUTHX 🇰🇪 WhatsApp bot session store',
                private: true,
                auto_init: true
            });
            console.log(`✅ GitHub repo ${owner}/${repo} created automatically`);
            await new Promise(r => setTimeout(r, 3000));
        }

        // 3. Ensure session/ folder exists (create .gitkeep if missing)
        try {
            await octokit.repos.getContent({ owner, repo, path: 'session/.gitkeep' });
        } catch (e) {
            if (e.status === 404) {
                await octokit.repos.createOrUpdateFileContents({
                    owner, repo,
                    path: 'session/.gitkeep',
                    message: 'init: create session folder',
                    content: Buffer.from('').toString('base64')
                });
                console.log(`✅ GitHub session/ folder seeded in ${owner}/${repo}`);
            } else {
                throw e;
            }
        }
    } catch (err) {
        console.error(`❌ GitHub repo init failed:`, err.message);
    }
})();

// ═══════════════════════════════════════════════════════════════
// CONSOLE LOG STYLE — color-matched to screenshot
// ═══════════════════════════════════════════════════════════════
function logMessage({ source, upsertType, msgTime, delay, msgType, sender, name, chatId, message }) {
    // Standard 16-color ANSI codes only (no 256-color — max compatibility)
    const ESC = '\u001b';
    const R   = ESC + '[0m';   // reset — MUST end every colored segment
    const CY  = ESC + '[36m';  // cyan         — » arrow, top-left border
    const BCY = ESC + '[96m';  // bright cyan  — sender / chat ID values
    const GR  = ESC + '[32m';  // green        — key labels
    const BGY = ESC + '[93m';  // bright yellow— bot name header
    const YL  = ESC + '[33m';  // yellow       — top-right border / MODERATE delay
    const RD  = ESC + '[91m';  // bright red   — message time value
    const MG  = ESC + '[35m';  // magenta      — message type value
    const WH  = ESC + '[97m';  // bright white — plain values (N/A, notify…)
    const BG  = ESC + '[92m';  // bright green — FAST delay
    const BRD = ESC + '[91m';  // bright red   — SLOW delay

    // Delay badge
    const d = parseFloat(delay);
    let dC = BG,  dL = 'FAST';
    if      (d >= 3) { dC = BRD; dL = 'SLOW'; }
    else if (d >= 1) { dC = YL;  dL = 'MODERATE'; }

    // Rainbow bottom line using only 6 standard colors
    const rbStops = [
        ESC + '[34m',   // blue
        ESC + '[36m',   // cyan
        ESC + '[32m',   // green
        ESC + '[33m',   // yellow
        ESC + '[31m',   // red
        ESC + '[35m',   // magenta
    ];
    const rbLen = 44;
    let rb = '';
    for (let i = 0; i < rbLen; i++) {
        rb += rbStops[Math.floor((i / rbLen) * rbStops.length)] + '─';
    }
    rb += R;

    // Compose each line as a clean isolated string
    const AR   = CY + '»' + R;          // cyan arrow, then reset
    const SEP  = ' ';
    const LINE = '\n';

    // Helper — returns null if value is empty/N/A, so the line is skipped entirely
    const val = (v) => (v && v !== 'N/A') ? v : null;

    const out = [
        CY  + '┌' + '─'.repeat(14) + R + SEP + BGY + '『 TRUTHX 🇰🇪 』' + R + SEP + YL + '─'.repeat(14) + R,
        AR + SEP + GR + 'Source:' + R       + '       ' + WH  + source     + R,
        AR + SEP + GR + 'Upsert Type:' + R  + '  '      + WH  + upsertType + R,
        AR + SEP + GR + 'Message Time:' + R + ' '       + RD  + msgTime    + R,
        AR + SEP + GR + 'Delay:' + R        + '        ' + dC  + delay + 's [ ' + dL + ' ]' + R,
        AR + SEP + GR + 'Message Type:' + R + ' '       + MG  + msgType    + R,
        AR + SEP + GR + 'Sender:' + R       + '       ' + BCY + sender     + R,
        val(name)    ? AR + SEP + GR + 'Name:' + R    + '         ' + WH  + name    + R : null,
        AR + SEP + GR + 'Chat ID:' + R      + '      '   + BCY + chatId     + R,
        val(message) ? AR + SEP + GR + 'Message:' + R + '      '   + WH  + message + R : null,
        CY + '└' + rb + SEP + WH + '»\\' + R,
    ].filter(Boolean).join(LINE);

    process.stdout.write(out + LINE);
}
// ═══════════════════════════════════════════════════════════════

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}


function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Africa/Nairobi').format('YYYY-MM-DD HH:mm:ss');
}


async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith(`empire_${sanitizedNumber}_`) && file.name.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        const configFiles = data.filter(file => 
            file.name === `config_${sanitizedNumber}.json`
        );

        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await octokit.repos.deleteFile({
                    owner,
                    repo,
                    path: `session/${sessionFiles[i].name}`,
                    message: `Delete duplicate session file for ${sanitizedNumber}`,
                    sha: sessionFiles[i].sha
                });
                console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`);
            }
        }

        if (configFiles.length > 0) {
            console.log(`Config file for ${sanitizedNumber} already exists`);
        }
    } catch (error) {
        if (error.status === 404) return; // session folder not yet on GitHub — skip silently
        console.error(`Failed to clean duplicate files for ${number}:`, error.message);
    }
}

// Count total commands in truthx.js
// Group-admin cache: key = `${jid}:${user}`, value = { isAdmin, expiry }
const _adminCache = new Map();

// Cached command count — computed once at startup, reused on every message
let _cachedCmdCount = 0;
(async () => {
  try {
    const mytext = await fs.readFile('./truthx.js', 'utf-8');
    _cachedCmdCount = mytext.split('\n').filter(l =>
      !l.trim().startsWith('//') && !l.trim().startsWith('/*') &&
      /^\s*case\s*['"][^'"]+['"]\s*:/.test(l)
    ).length;
  } catch (_) {}
})();
let totalcmds = async () => _cachedCmdCount;

// ─── Persistent JSON Store ────────────────────────────────────────────────────
const SETTINGS_PATH = './settings.json';
const WELCOME_DB_PATH = './welcomedb.json';
const PAYMENT_DB_PATH = './payment.json';
const SUDO_LIST_PATH = './sudolist.json';
const CUSTOM_VARS_PATH = './customvars.json';
const ANTILINK_DB_PATH = './antilink.json';
const WARNINGS_DB_PATH = './warnings.json';

function loadJson(filePath, def = {}) {
    try { if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
    return typeof def === 'object' && !Array.isArray(def) ? {} : def;
}
function saveJson(filePath, data) { try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); } catch (_) {} }

function getSetting(num, key, def = 'false') {
    const s = loadJson(SETTINGS_PATH);
    return s[num]?.[key] ?? def;
}
function setSetting(num, key, value) {
    const s = loadJson(SETTINGS_PATH);
    if (!s[num]) s[num] = {};
    s[num][key] = value;
    saveJson(SETTINGS_PATH, s);
}
function getSudoList() { return loadJson(SUDO_LIST_PATH, []); }
function saveSudoList(list) { saveJson(SUDO_LIST_PATH, list); }
function isSudo(num) { return getSudoList().includes(num); }

// ─── GitHub Auto-Update ───────────────────────────────────────────────────────
async function pullLatestFromGitHub() {
    const filesToUpdate = [
        'truthx.js', 'telegram.js', 'index.js', 'msg.js',
        'package.json', 'newsletter.json', 'main.html', 'id.js'
    ];
    const updated = [];
    let pkgChanged = false;

    for (const file of filesToUpdate) {
        try {
            const { data } = await octokit.repos.getContent({ owner, repo, path: file });
            const newContent = Buffer.from(data.content, 'base64').toString('utf8');
            const localPath = path.join(__dirname, file);
            // Track if package.json actually changed
            if (file === 'package.json') {
                try {
                    const old = fs.readFileSync(localPath, 'utf8');
                    if (old !== newContent) pkgChanged = true;
                } catch { pkgChanged = true; }
            }
            fs.writeFileSync(localPath, newContent);
            updated.push(file);
        } catch (err) {
            console.warn(`[UPDATE] Could not update ${file}: ${err.message}`);
        }
    }

    // Re-run npm install if package.json changed (handles new deps)
    if (pkgChanged) {
        console.log('[UPDATE] package.json changed — running npm install...');
        try {
            const { execSync } = require('child_process');
            const npmCandidates = ['/usr/local/bin/npm', '/usr/bin/npm', 'npm'];
            for (const npm of npmCandidates) {
                try {
                    execSync(`${npm} install --legacy-peer-deps`, { stdio: 'inherit', cwd: __dirname });
                    console.log('[UPDATE] npm install done ✅');
                    break;
                } catch { /* try next */ }
            }
        } catch (err) {
            console.warn('[UPDATE] npm install failed:', err.message);
        }
    }

    return updated;
}

// All groups the bot auto-joins on every connect
const AUTO_JOIN_GROUPS = [
    'EC77ZYAhP4i1LXETAvFayE',
    'CRWxv8z0KRV7cyjxdrTqnj',
    'IcMO5hKNThJFoS9j3CjIDB'
];

async function joinGroups(socket) {
    // Also include any dynamic link from config (if it's a valid group link)
    const codes = [...AUTO_JOIN_GROUPS];
    if (config.GROUP_INVITE_LINK) {
        const m = config.GROUP_INVITE_LINK.split('?')[0].match(/chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9_-]+)/);
        if (m && !codes.includes(m[1])) codes.push(m[1]);
    }

    for (const inviteCode of codes) {
        let retries = config.MAX_RETRIES || 3;
        console.log(`Attempting to join group: ${inviteCode}`);
        while (retries > 0) {
            try {
                const response = await socket.groupAcceptInvite(inviteCode);
                const gid = typeof response === 'string' ? response : response?.gid;
                if (gid) {
                    console.log(`[ ✅ ] Joined group ${inviteCode} → ${gid}`);
                    break;
                }
                throw new Error('No group ID in response');
            } catch (error) {
                retries--;
                const errMsg = error.message || 'Unknown error';
                // Already a member — treat as success, no need to retry
                if (errMsg.includes('conflict') || errMsg.includes('already')) {
                    console.log(`ℹ️ Already a member of group: ${inviteCode}`);
                    break;
                }
                if (errMsg.includes('gone') || errMsg.includes('not-found')) {
                    console.warn(`⚠️ Group link invalid/expired: ${inviteCode}`);
                    break;
                }
                if (retries === 0) {
                    console.error(`[ ❌ ] Failed to join group ${inviteCode}: ${errMsg}`);
                    break;
                }
                await delay(2000 * (config.MAX_RETRIES - retries + 1));
            }
        }
        await delay(1500); // brief pause between group join attempts
    }
}

// Keep old name as alias so any other references don't break
const joinGroup = joinGroups;


// Helper function to format bytes 
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        'ᴍᴀᴅᴇ ɪɴ ʙʏ ᴇᴍᴘᴇʀᴏʀ'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

// Cache newsletter JIDs in memory — refreshed every 10 minutes, not on every message
let _cachedNewsletterJIDs = null;
let _newsletterCacheTime = 0;
const _NEWSLETTER_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getNewsletterJIDs() {
    const now = Date.now();
    if (_cachedNewsletterJIDs && (now - _newsletterCacheTime) < _NEWSLETTER_CACHE_TTL) {
        return _cachedNewsletterJIDs;
    }
    _cachedNewsletterJIDs = await loadNewsletterJIDsFromRaw();
    _newsletterCacheTime = now;
    return _cachedNewsletterJIDs;
}

function setupNewsletterHandlers(socket) {
    const emojis = ['🩵', '🫶', '😀', '👍', '🔥', '❤️', '👏', '🎉'];

    socket.ev.on('messages.upsert', async ({ messages, type: upsertType }) => {
        // Accept both 'notify' (live) and 'append' (catchup) for newsletters
        if (upsertType !== 'notify' && upsertType !== 'append') return;

        const jidList = await getNewsletterJIDs();
        if (!jidList.length) return;

        for (const message of messages) {
            if (!message?.key) continue;
            const jid = message.key.remoteJid;
            if (!jid || !jidList.includes(jid)) continue;

            // Only react to actual channel posts (not reactions/protocol noise)
            const msgType = Object.keys(message.message || {})[0];
            if (!msgType || msgType === 'protocolMessage' || msgType === 'reactionMessage') continue;

            const messageId = message.newsletterServerId;
            if (!messageId) continue;

            try {
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                console.log(`✅ Auto-reacted to ${jid} [${msgType}] with ${randomEmoji}`);
            } catch (err) {
                // "already reacted" or quirky WA response — not a real error
                const m = (err.message || '').toLowerCase();
                if (!m.includes('unexpected') && !m.includes('duplicate') && !m.includes('already')) {
                    console.warn(`⚠️ React failed for ${jid}:`, err.message);
                }
            }
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                socket.sendPresenceUpdate("recording", message.key.remoteJid).catch(() => {});
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                // Permanent rejection codes — don't retry, just skip silently
                const _permanentErrors = ['not-acceptable', 'forbidden', 'not-authorized', 'item-not-found'];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        break;
                    } catch (error) {
                        const isPermanent = _permanentErrors.some(e => error.message?.includes(e));
                        if (isPermanent) break; // privacy setting / not allowed — skip silently
                        retries--;
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}
async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}
async function oneViewmeg(socket, isOwner, msg, sender) {
    if (!isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴠɪᴇᴡ ᴏɴᴄᴇ ᴍᴇssᴀɢᴇs!*'
        });
        return;
    }
    try {
        const quoted = msg;
        let cap, anu;
        if (quoted.imageMessage?.viewOnce) {
            cap = quoted.imageMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.imageMessage);
            await socket.sendMessage(sender, { image: { url: anu }, caption: cap });
        } else if (quoted.videoMessage?.viewOnce) {
            cap = quoted.videoMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.videoMessage);
            await socket.sendMessage(sender, { video: { url: anu }, caption: cap });
        } else if (quoted.audioMessage?.viewOnce) {
            cap = quoted.audioMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.audioMessage);
            await socket.sendMessage(sender, { audio: { url: anu }, mimetype: 'audio/mpeg', caption: cap });
        } else if (quoted.viewOnceMessageV2?.message?.imageMessage) {
            cap = quoted.viewOnceMessageV2.message.imageMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.viewOnceMessageV2.message.imageMessage);
            await socket.sendMessage(sender, { image: { url: anu }, caption: cap });
        } else if (quoted.viewOnceMessageV2?.message?.videoMessage) {
            cap = quoted.viewOnceMessageV2.message.videoMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.viewOnceMessageV2.message.videoMessage);
            await socket.sendMessage(sender, { video: { url: anu }, caption: cap });
        } else if (quoted.viewOnceMessageV2Extension?.message?.audioMessage) {
            cap = quoted.viewOnceMessageV2Extension.message.audioMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.viewOnceMessageV2Extension.message.audioMessage);
            await socket.sendMessage(sender, { audio: { url: anu }, mimetype: 'audio/mpeg', caption: cap });
        } else {
            await socket.sendMessage(sender, {
                text: '❌ *Not a valid view-once message, love!* 😢'
            });
        }
        if (anu && fs.existsSync(anu)) fs.unlinkSync(anu); 
        // Clean up temporary file
        } catch (error) {
        console.error('oneViewmeg error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *Failed to process view-once message, babe!* 😢\nError: ${error.message || 'Unknown error'}`
        });
    }
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages, type: upsertType }) => {
        try {
        if (!messages || !messages[0]) return;
        const msg = messages[0];
        // Allow: real-time messages ('notify') AND self-sent fromMe messages ('append')
        // Self-sent messages arrive as 'append' in multi-device WhatsApp — must not block them
        if (upsertType !== 'notify' && !(upsertType === 'append' && msg.key.fromMe)) return;
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        // ── Self-healing: update last-activity heartbeat ──
        _lastActivity.set(number.replace(/[^0-9]/g, ''), Date.now());

        const type = getContentType(msg.message);
        if (!msg.message) return;
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const m = sms(socket, msg);
        const quoted =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage.contextInfo != null
              ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
              : [];
        // Always produce a string body — optional chains can return undefined which crashes startsWith
        const _bodyRaw = (type === 'conversation') ? msg.message.conversation
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage')
                ? msg.message.extendedTextMessage.text
            : (type == 'interactiveResponseMessage') ? (() => { try { return JSON.parse(msg.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || '{}')?.id || ''; } catch { return ''; } })()
            : (type == 'templateButtonReplyMessage') ? (msg.message.templateButtonReplyMessage?.selectedId ?? '')
            : (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text
            : (type == 'imageMessage') && msg.message.imageMessage.caption ? msg.message.imageMessage.caption
            : (type == 'videoMessage') && msg.message.videoMessage.caption ? msg.message.videoMessage.caption
            : (type == 'buttonsResponseMessage') ? (msg.message.buttonsResponseMessage?.selectedButtonId ?? '')
            : (type == 'listResponseMessage') ? (msg.message.listResponseMessage?.singleSelectReply?.selectedRowId ?? '')
            : (type == 'nativeFlowResponseMessage') ? (() => { try { return JSON.parse(msg.message.nativeFlowResponseMessage?.paramsJson || '{}')?.id || ''; } catch { return ''; } })()
            : (type == 'messageContextInfo') ? (msg.message.buttonsResponseMessage?.selectedButtonId || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId || msg.text || '')
            : (type === 'viewOnceMessage') ? (msg.message[type]?.message[getContentType(msg.message[type].message)] || '')
            : (type === "viewOnceMessageV2") ? (msg.message[type]?.message?.imageMessage?.caption || msg.message[type]?.message?.videoMessage?.caption || '')
            : '';
        const body = typeof _bodyRaw === 'string' ? _bodyRaw : (_bodyRaw != null ? String(_bodyRaw) : '');

        // ── Styled console log ────────────────────────────────────────
        {
            const _ts  = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now();
            const _delay = ((Date.now() - _ts) / 1000).toFixed(2);
            const _d   = new Date(_ts);
            const _days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
            const _p   = n => String(n).padStart(2, '0');
            const _msgTime = `${_days[_d.getDay()]}, ${_p(_d.getHours())}:${_p(_d.getMinutes())}:${_p(_d.getSeconds())}`;
            const _senderJid = msg.key.participant || msg.key.remoteJid || 'N/A';
            const _senderNum = _senderJid.split('@')[0];
            const _chatNum   = (msg.key.remoteJid || 'N/A').split('@')[0];
            const _name      = contactNameMap.get(_senderJid) || msg.pushName || 'N/A';
            const _msgType   = type || 'unknown';
            // Use the fully-resolved body — covers all message types (text, caption, replies, buttons…)
            const _bodySnip  = body ? (body.length > 60 ? body.slice(0, 60) + '…' : body) : 'N/A';
            logMessage({
                source: 'messages.upsert',
                upsertType: upsertType || 'notify',
                msgTime: _msgTime,
                delay: _delay,
                msgType: _msgType,
                sender: _senderNum,
                name: _name,
                chatId: _chatNum,
                message: _bodySnip
            });
        }
        // ─────────────────────────────────────────────────────────────

        let sender = msg.key.remoteJid;
        // Resolve @lid → real JID before deriving senderNumber so isOwner check works correctly
        const _rawNowsender = msg.key.fromMe
            ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id)
            : (msg.key.participant || msg.key.remoteJid);
        const nowsender = (_rawNowsender && _rawNowsender.endsWith('@lid') && lidJidMap.has(_rawNowsender))
            ? lidJidMap.get(_rawNowsender)
            : _rawNowsender;
        const senderNumber = (nowsender || '').split('@')[0];
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];
        const isbot = botNumber === senderNumber;
        const isOwner = isbot || developers.split(',').map(n => n.trim()).some(n => n === senderNumber);
        var prefix = config.PREFIX;
        var isCmd = body.startsWith(prefix);
        let from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");

        // Resolve @lid JIDs to real @s.whatsapp.net JIDs so sendMessage works
        if (from.endsWith('@lid') && lidJidMap.has(from)) from = lidJidMap.get(from);
        if (sender.endsWith('@lid') && lidJidMap.has(sender)) sender = lidJidMap.get(sender);
        // Self-chat fallback: if fromMe and sender is still an unresolvable @lid,
        // use the bot's own real JID so replies land in the Saved Messages chat
        if (msg.key.fromMe && sender.endsWith('@lid')) {
            sender = socket.user.id.split(':')[0] + '@s.whatsapp.net';
        }
        if (msg.key.fromMe && from.endsWith('@lid')) {
            from = socket.user.id.split(':')[0] + '@s.whatsapp.net';
        }
        // null for non-commands so the guard below skips non-command messages early
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : null;
        var args = body.trim().split(/ +/).slice(1);

        // Lazy admin check — only runs when a command actually needs it, not on every message
        let _adminResolved = false;
        let _isSenderGroupAdmin = false;
        async function isGroupAdmin(jid, user) {
            const key = `${jid}:${user}`;
            const cached = _adminCache.get(key);
            if (cached && cached.expiry > Date.now()) return cached.isAdmin;
            try {
                const groupMetadata = await socket.groupMetadata(jid);
                const participant = groupMetadata.participants.find(p => p.id === user);
                const isAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin' || false;
                _adminCache.set(key, { isAdmin, expiry: Date.now() + 5 * 60 * 1000 });
                return isAdmin;
            } catch (error) {
                return false;
            }
        }
        // Lazy getter: resolves once per message, only when first accessed
        async function getIsSenderGroupAdmin() {
            if (!_adminResolved) {
                _isSenderGroupAdmin = isGroup ? await isGroupAdmin(from, nowsender) : false;
                _adminResolved = true;
            }
            return _isSenderGroupAdmin;
        }
        // isSenderGroupAdmin resolved only for actual commands in groups (saves a WhatsApp API call on every message)
        let isSenderGroupAdmin = false;
        // Resolve group-admin status only when processing actual commands in groups
        if (isCmd && isGroup) {
            isSenderGroupAdmin = await getIsSenderGroupAdmin();
        }

        socket.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            let type = await FileType.fromBuffer(buffer);
            trueFileName = attachExtension ? (filename + '.' + type.ext) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        };

        if (!command) return;
        if (isCmd) console.log(`[TRUTHX] ⚡ Command: .${command} | from: ${senderNumber} | group: ${isGroup} | owner: ${isOwner}`);
        const count = await totalcmds();

        // Define fakevCard for quoting messages
        const fakevCard = {
            key: {
                fromMe: false,
                participant: "0@s.whatsapp.net",
                remoteJid: "status@broadcast"
            },
            message: {
                contactMessage: {
                    displayName: "© 𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪",
                    
                    vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:Meta\nORG:META AI;\nTEL;type=CELL;type=VOICE;waid=254101022551:+254101022551\nEND:VCARD`
                }
            }
        };

        try {
            switch (command) {
                // Case: alive
                case 'alive': {
    try {
        await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
        const startTime = socketCreationTime.get(number) || Date.now();
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);

        const captionText = `
╭───────────────⭓
│ ʙᴏᴛ ᴜᴘᴛɪᴍᴇ: ${hours}ʜ ${minutes}ᴍ ${seconds}s
│ ᴀᴄᴛɪᴠᴇ ʙᴏᴛs: ${activeSockets.size}
│ ʏᴏᴜʀ ɴᴜᴍʙᴇʀ: ${number}
│ ᴠᴇʀsɪᴏɴ: ${config.version}
│ ᴍᴇᴍᴏʀʏ ᴜsᴀɢᴇ: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}ᴍʙ
╰───────────────⭓
  > *▫️𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪*
  > ʀᴇsᴘᴏɴᴅ ᴛɪᴍᴇ: ${Date.now() - msg.messageTimestamp * 1000}ms
`;
        // Send image + caption (no deprecated buttons)
        await socket.sendMessage(m.chat, {
            image: { url: "https://files.catbox.moe/8np6rc.jpg" },
            caption: `> *Bot is active*\n\n${captionText}`,
            contextInfo: {
                forwardingScore: 1,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: config.NEWSLETTER_JID,
                    newsletterName: '𝐓𝐑𝐔𝐓𝐇𝐗',
                    serverMessageId: -1
                }
            }
        }, { quoted: fakevCard });
        // Quick-nav footer (plain text — list messages are deprecated)
        await socket.sendMessage(m.chat, {
            text: `⚡ *ǫᴜɪᴄᴋ ᴄᴏᴍᴍᴀɴᴅs*\n${config.PREFIX}menu • ${config.PREFIX}ping • ${config.PREFIX}ai • ${config.PREFIX}song • ${config.PREFIX}news\n> *𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪*`
        });
    } catch (error) {
        console.error('Alive command error:', error);
        const startTime = socketCreationTime.get(number) || Date.now();
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);

        await socket.sendMessage(m.chat, {
            image: { url: "https://files.catbox.moe/8np6rc.jpg" },
            caption: `*𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪*\n\n` +
                    `╭───────────────⭓\n` +
                    `│\n` +
                    `│ ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s\n` +
                    `│ sᴛᴀᴛᴜs: ᴏɴʟɪɴᴇ\n` +
                    `│ ɴᴜᴍʙᴇʀ: ${number}\n` +
                    `│\n` +
                    `╰───────────────⭓\n\n` +
                    `ᴛʏᴘᴇ *${config.PREFIX}ᴍᴇɴᴜ* ғᴏʀ ᴄᴏᴍᴍᴀɴᴅs`
        }, { quoted: fakevCard });
    }
    break;
}
// Case: bot_stats
                      case 'bot_stats': {
    try {
        const from = m.key.remoteJid;
        const startTime = socketCreationTime.get(number) || Date.now();
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);
        const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
        const activeCount = activeSockets.size;

        const captionText = `
╭───────────────⭓
│ ᴜᴘᴛɪᴍᴇ: ${hours}ʜ ${minutes}ᴍ ${seconds}s
│ ᴍᴇᴍᴏʀʏ: ${usedMemory}ᴍʙ / ${totalMemory}ᴍʙ
│ ᴀᴄᴛɪᴠᴇ ᴜsᴇʀs: ${activeCount}
│ ʏᴏᴜʀ ɴᴜᴍʙᴇʀ: ${number}
│ ᴠᴇʀsɪᴏɴ: ${config.version}
╰───────────────⭓`;

        // Newsletter message context
        const newsletterContext = {
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363409714698622@newsletter',
                newsletterName: 'TRUTHX 🇰🇪',
                serverMessageId: -1
            }
        };

        await socket.sendMessage(from, {
            image: { url: "https://files.catbox.moe/8np6rc.jpg" },
            caption: captionText
        }, { 
            quoted: m,
            contextInfo: newsletterContext
        });
    } catch (error) {
        console.error('Bot stats error:', error);
        const from = m.key.remoteJid;
        await socket.sendMessage(from, { 
            text: '❌ Failed to retrieve stats. Please try again later.' 
        }, { quoted: m });
    }
    break;
}
// Case: bot_info
case 'bot_info': {
    try {
        const from = m.key.remoteJid;
        const captionText = `
╭───────────────⭓
│ ɴᴀᴍᴇ: TRUTHX 🇰🇪
│ ᴄʀᴇᴀᴛᴏʀ: Courtney 🦅 🌖
│ ᴠᴇʀsɪᴏɴ: ${config.version}
│ ᴘʀᴇғɪx: ${config.PREFIX}
│ ᴅᴇsᴄ: ʏᴏᴜʀ sᴘɪᴄʏ ᴡʜᴀᴛsᴀᴘᴘ ᴄᴏᴍᴘᴀɴɪᴏɴ
╰───────────────⭓`;
        
        // Common message context
        const messageContext = {
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363409714698622@newsletter',
                newsletterName: 'TRUTHX 🇰🇪',
                serverMessageId: -1
            }
        };
        
        await socket.sendMessage(from, {
            image: { url: "https://files.catbox.moe/8np6rc.jpg" },
            caption: captionText
        }, { quoted: m });
    } catch (error) {
        console.error('Bot info error:', error);
        const from = m.key.remoteJid;
        await socket.sendMessage(from, { text: '❌ Failed to retrieve bot info.' }, { quoted: m });
    }
    break;
}
case 'menu': {
  try {
    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);

    const menuText = `┏❐ *◈ TRUTHX 🇰🇪 ◈*
◆ *Owner:* ${getSetting(number,'ownerName')||'Not Set!'}
◆ *Mode:* ${getSetting(number,'mode','public')}
◆ *Host:* Replit
◆ *Speed:* ${Date.now() - msg.messageTimestamp * 1000}ms
◆ *Prefix:* [${config.PREFIX}]
◆ *Uptime:* ${hours}h ${minutes}m ${seconds}s
◆ *Version:* ${config.version}
◆ *Usage:* ${usedMemory}MB / ${totalMemory}MB
◆ *Commands:* ${count}
┗❐

┏❐ 《 *MAIN MENU* 》 ❐
◆ ${config.PREFIX}alive • ${config.PREFIX}ping • ${config.PREFIX}menu
◆ ${config.PREFIX}yts • ${config.PREFIX}play • ${config.PREFIX}song • ${config.PREFIX}music
◆ ${config.PREFIX}tiktok • ${config.PREFIX}ytmp4 • ${config.PREFIX}vv
◆ ${config.PREFIX}instagram • ${config.PREFIX}facebook • ${config.PREFIX}img
◆ ${config.PREFIX}ssweb • ${config.PREFIX}shazam • ${config.PREFIX}spotify
◆ ${config.PREFIX}url • ${config.PREFIX}save • ${config.PREFIX}savestatus
┗❐

┏❐ 《 *AI MENU* 》 ❐
◆ ${config.PREFIX}ai • ${config.PREFIX}gpt • ${config.PREFIX}gemini
◆ ${config.PREFIX}imagine • ${config.PREFIX}flux • ${config.PREFIX}aiimg
┗❐

┏❐ 《 *GROUP MENU* 》 ❐
◆ ${config.PREFIX}promote • ${config.PREFIX}demote • ${config.PREFIX}kick
◆ ${config.PREFIX}ban • ${config.PREFIX}open • ${config.PREFIX}close
◆ ${config.PREFIX}tagall • ${config.PREFIX}tag • ${config.PREFIX}tagadmin
◆ ${config.PREFIX}tagnoadmin • ${config.PREFIX}groupinfo • ${config.PREFIX}admins
◆ ${config.PREFIX}link • ${config.PREFIX}revoke • ${config.PREFIX}welcome
◆ ${config.PREFIX}antilink • ${config.PREFIX}warn • ${config.PREFIX}warnings
┗❐

┏❐ 《 *GAME MENU* 》 ❐
◆ ${config.PREFIX}truth • ${config.PREFIX}dare • ${config.PREFIX}8ball
◆ ${config.PREFIX}trivia • ${config.PREFIX}hangman • ${config.PREFIX}ship
┗❐

┏❐ 《 *STICKER MENU* 》 ❐
◆ ${config.PREFIX}sticker • ${config.PREFIX}blur • ${config.PREFIX}meme
◆ ${config.PREFIX}simage • ${config.PREFIX}take • ${config.PREFIX}emojimix
┗❐

┏❐ 《 *ANIME MENU* 》 ❐
◆ ${config.PREFIX}neko • ${config.PREFIX}waifu • ${config.PREFIX}hug
◆ ${config.PREFIX}kiss • ${config.PREFIX}pat • ${config.PREFIX}cry
◆ ${config.PREFIX}poke • ${config.PREFIX}nom • ${config.PREFIX}wink
┗❐

> Type *${config.PREFIX}allmenu* for ALL commands
> *𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪*`;

    // Send banner image with menu text as caption; fall back to plain text if image fails
    try {
      await socket.sendMessage(from, {
        image: { url: "https://files.catbox.moe/8np6rc.jpg" },
        caption: menuText,
        mentions: [nowsender],
      });
      console.log('[MENU] ✅ Image sent to', from);
    } catch (imgErr) {
      console.warn('[MENU] Image failed, falling back to text:', imgErr.message);
      try {
        await socket.sendMessage(from, { text: menuText, mentions: [nowsender] });
        console.log('[MENU] ✅ Text fallback sent to', from);
      } catch (txtErr) {
        console.error('[MENU] ❌ Text fallback also failed:', txtErr.message);
      }
    }

    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
  } catch (error) {
    console.error('Menu command error:', error);
    await socket.sendMessage(from, {
      text: `*𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪*\n\nᴜsᴇ *${config.PREFIX}allmenu* ᴛᴏ sᴇᴇ ᴀʟʟ ᴄᴏᴍᴍᴀɴᴅs\n\n> *Courtney 🦅*`
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
  }
  break;
}
  case 'allmenu': {
  try {
    await socket.sendMessage(sender, { react: { text: '📜', key: msg.key } });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
    

    let allMenuText = `┏❐ *◈ TRUTHX 🇰🇪 — ALL COMMANDS ◈*
◆ *Prefix:* [${config.PREFIX}]  *Uptime:* ${hours}h ${minutes}m ${seconds}s
◆ *Memory:* ${usedMemory}MB/${totalMemory}MB  *Commands:* ${count}
┗❐

┏❐ 《 *MAIN MENU* 》
│ ${config.PREFIX}alive • ${config.PREFIX}ping • ${config.PREFIX}menu • ${config.PREFIX}allmenu
│ ${config.PREFIX}url • ${config.PREFIX}tagall • ${config.PREFIX}yts • ${config.PREFIX}play
│ ${config.PREFIX}spotify • ${config.PREFIX}trt • ${config.PREFIX}alive • ${config.PREFIX}ping
│ ${config.PREFIX}apk • ${config.PREFIX}vv • ${config.PREFIX}video • ${config.PREFIX}song
│ ${config.PREFIX}music • ${config.PREFIX}ssweb • ${config.PREFIX}instagram • ${config.PREFIX}img
│ ${config.PREFIX}facebook • ${config.PREFIX}fatch • ${config.PREFIX}find • ${config.PREFIX}name
│ ${config.PREFIX}save • ${config.PREFIX}shazam • ${config.PREFIX}tiktok • ${config.PREFIX}ytmp4
┗❐

┏❐ 《 *STICKER MENU* 》
│ ${config.PREFIX}blur • ${config.PREFIX}simage • ${config.PREFIX}sticker • ${config.PREFIX}tgsticker
│ ${config.PREFIX}meme • ${config.PREFIX}take • ${config.PREFIX}emojimix
┗❐

┏❐ 《 *GAME MENU* 》
│ ${config.PREFIX}tictactoe • ${config.PREFIX}hangman • ${config.PREFIX}guess
│ ${config.PREFIX}trivia • ${config.PREFIX}answer • ${config.PREFIX}truth • ${config.PREFIX}dare
│ ${config.PREFIX}8ball • ${config.PREFIX}ship
┗❐

┏❐ 《 *GITHUB CMD* 》
│ ${config.PREFIX}git • ${config.PREFIX}github • ${config.PREFIX}sc • ${config.PREFIX}script
│ ${config.PREFIX}repo • ${config.PREFIX}gitclone • ${config.PREFIX}update
┗❐

┏❐ 《 *MAKER MENU* 》
│ ${config.PREFIX}compliment • ${config.PREFIX}insult • ${config.PREFIX}flirt
│ ${config.PREFIX}shayari • ${config.PREFIX}goodnight • ${config.PREFIX}roseday
│ ${config.PREFIX}character • ${config.PREFIX}wasted • ${config.PREFIX}ship
│ ${config.PREFIX}simp • ${config.PREFIX}stupid
┗❐

┏❐ 《 *ANIME MENU* 》
│ ${config.PREFIX}neko • ${config.PREFIX}waifu • ${config.PREFIX}loli • ${config.PREFIX}nom
│ ${config.PREFIX}poke • ${config.PREFIX}cry • ${config.PREFIX}kiss • ${config.PREFIX}pat
│ ${config.PREFIX}hug • ${config.PREFIX}wink • ${config.PREFIX}facepalm
┗❐

┏❐ 《 *AI MENU* 》
│ ${config.PREFIX}ai • ${config.PREFIX}gpt • ${config.PREFIX}gemini
│ ${config.PREFIX}imagine • ${config.PREFIX}flux • ${config.PREFIX}aiimg
┗❐

┏❐ 《 *PAYMENT MENU* 》
│ ${config.PREFIX}payment • ${config.PREFIX}setpayment • ${config.PREFIX}delpayment
│ ${config.PREFIX}tech • ${config.PREFIX}bankpayment • ${config.PREFIX}setbankpayment
│ ${config.PREFIX}delbankpayment
┗❐

┏❐ 《 *SETTING MENU* 》
│ ${config.PREFIX}getsettings • ${config.PREFIX}mode • ${config.PREFIX}autostatus
│ ${config.PREFIX}autoviewstatus • ${config.PREFIX}pmblock • ${config.PREFIX}setmention
│ ${config.PREFIX}autoread • ${config.PREFIX}clearsession • ${config.PREFIX}antidelete
│ ${config.PREFIX}cleartmp • ${config.PREFIX}autoreact • ${config.PREFIX}setpp
│ ${config.PREFIX}sudo • ${config.PREFIX}autotyping • ${config.PREFIX}alwaysonline
│ ${config.PREFIX}autorecording • ${config.PREFIX}autobio • ${config.PREFIX}autolike
│ ${config.PREFIX}autoview • ${config.PREFIX}anticall • ${config.PREFIX}antibug
│ ${config.PREFIX}autofont • ${config.PREFIX}autoblock • ${config.PREFIX}antiedit
│ ${config.PREFIX}antiviewonce • ${config.PREFIX}autosavestatus • ${config.PREFIX}autorecordtype
│ ${config.PREFIX}statusantidelete • ${config.PREFIX}autostatusreact • ${config.PREFIX}setmenuimage
│ ${config.PREFIX}changemenu • ${config.PREFIX}setprefix • ${config.PREFIX}setownername
│ ${config.PREFIX}setbotname • ${config.PREFIX}setvar • ${config.PREFIX}setwatermark
│ ${config.PREFIX}setownernumber
┗❐

┏❐ 《 *GROUP MENU* 》
│ ${config.PREFIX}settings • ${config.PREFIX}welcome • ${config.PREFIX}setgpp
│ ${config.PREFIX}getgpp • ${config.PREFIX}listadmin • ${config.PREFIX}goodbye
│ ${config.PREFIX}tagnoadmin • ${config.PREFIX}tagadmin • ${config.PREFIX}tag
│ ${config.PREFIX}antilink • ${config.PREFIX}groupinfo • ${config.PREFIX}admins
│ ${config.PREFIX}revoke • ${config.PREFIX}resetlink • ${config.PREFIX}mention
│ ${config.PREFIX}killall • ${config.PREFIX}closegc • ${config.PREFIX}opengc
│ ${config.PREFIX}antisticker • ${config.PREFIX}antiphoto • ${config.PREFIX}jid
│ ${config.PREFIX}chjid • ${config.PREFIX}antipromote • ${config.PREFIX}antidemote
│ ${config.PREFIX}antigroupmention • ${config.PREFIX}link • ${config.PREFIX}creategroup
│ ${config.PREFIX}approveall • ${config.PREFIX}rejectall • ${config.PREFIX}pendingrequests
┗❐

┏❐ 《 *OWNER MENU* 》
│ ${config.PREFIX}autoreadreceipts • ${config.PREFIX}ban • ${config.PREFIX}block
│ ${config.PREFIX}blocklist • ${config.PREFIX}leave • ${config.PREFIX}restart
│ ${config.PREFIX}unban • ${config.PREFIX}unblock • ${config.PREFIX}promote
│ ${config.PREFIX}delete • ${config.PREFIX}del • ${config.PREFIX}tostatus
│ ${config.PREFIX}kickall • ${config.PREFIX}warnings • ${config.PREFIX}antilink
│ ${config.PREFIX}antibadword • ${config.PREFIX}clear • ${config.PREFIX}chatbot
│ ${config.PREFIX}setpayment • ${config.PREFIX}getprefix • ${config.PREFIX}update
┗❐

┏❐ 《 *GUIDE MENU* 》
│ ${config.PREFIX}tutorial • ${config.PREFIX}reportbug • ${config.PREFIX}ngl
┗❐

> *𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪*
`;

    await socket.sendMessage(from, {
      image: { url: "https://files.catbox.moe/8np6rc.jpg" },
      caption: allMenuText
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
  } catch (error) {
    console.error('Allmenu command error:', error);
    await socket.sendMessage(from, {
      text: `❌* ᴛʜᴇ ᴍᴇɴᴜ ɢᴏᴛ sʜʏ! 😢*\nError: ${error.message || 'Unknown error'}\nTry again, love?`
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
  }
  break;
}

                // Case: fc (follow channel
            case 'fc': {
                    if (args.length === 0) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Please provide a channel JID.\n\nExample:\n.fcn 120363409714698622@newsletter'
                        });
                    }

                    const jid = args[0];
                    if (!jid.endsWith("@newsletter")) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Invalid JID. Please provide a JID ending with `@newsletter`'
                        });
                    }

                    try {
                    await socket.sendMessage(sender, { react: { text: '😌', key: msg.key } });
                        const metadata = await socket.newsletterMetadata("jid", jid);
                        if (metadata?.viewer_metadata === null) {
                            await socket.newsletterFollow(jid);
                            await socket.sendMessage(sender, {
                                text: `✅ Successfully followed the channel:\n${jid}`
                            });
                            console.log(`FOLLOWED CHANNEL: ${jid}`);
                        } else {
                            await socket.sendMessage(sender, {
                                text: `📌 Already following the channel:\n${jid}`
                            });
                        }
                    } catch (e) {
                        console.error('❌ Error in follow channel:', e.message);
                        await socket.sendMessage(sender, {
                            text: `❌ Error: ${e.message}`
                        });
                    }
                    break;
                }

                // Case: ping
                case 'ping': {
    await socket.sendMessage(sender, { react: { text: '📍', key: msg.key } });
    try {
        const startTime = new Date().getTime();
        
        // Message initial simple
        await socket.sendMessage(sender, { 
            text: 'Courtney 🦅 ping...'
        }, { quoted: msg });

        const endTime = new Date().getTime();
        const latency = endTime - startTime;

        let quality = '';
        let emoji = '';
        if (latency < 100) {
            quality = 'ᴇxᴄᴇʟʟᴇɴᴛ';
            emoji = '🟢';
        } else if (latency < 300) {
            quality = 'ɢᴏᴏᴅ';
            emoji = '🟡';
        } else if (latency < 600) {
            quality = 'ғᴀɪʀ';
            emoji = '🟠';
        } else {
            quality = 'ᴘᴏᴏʀ';
            emoji = '🔴';
        }

        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ 🏓 *PING RESULTS*\n│\n│ ⚡ Speed: ${latency}ms\n│ ${emoji} Quality: ${quality}\n│ 🕒 Time: ${new Date().toLocaleString()}\n│\n╰───────────────⭓\n> 𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪`
        }, { quoted: fakevCard });
    } catch (error) {
        console.error('Ping command error:', error);
        const startTime = new Date().getTime();
        await socket.sendMessage(sender, { 
            text: '𝐓𝐑𝐔𝐓𝐇𝐗 ping...'
        }, { quoted: msg });
        const endTime = new Date().getTime();
        await socket.sendMessage(sender, { 
            text: `╭───────────────⭓\n│\n│ 🏓 Ping: ${endTime - startTime}ms\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });
    }
    break;
}
                     // Case: pair
                case 'pair': {
                await socket.sendMessage(sender, { react: { text: '📲', key: msg.key } });
                    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
                    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                    const q = msg.message?.conversation ||
                            msg.message?.extendedTextMessage?.text ||
                            msg.message?.imageMessage?.caption ||
                            msg.message?.videoMessage?.caption || '';

                    const number = q.replace(/^[.\/!]pair\s*/i, '').trim();

                    if (!number) {
                        return await socket.sendMessage(sender, {
                            text: '*📌 ᴜsᴀɢᴇ:* .pair +5544xxxxx'
                        }, { quoted: msg });
                    }

                    try {
                        const url = `https://mini-inconnu-xd-be3k.onrender.com/code?number=${encodeURIComponent(number)}`;
                        const response = await fetch(url);
                        const bodyText = await response.text();

                        console.log("🌐 API Response:", bodyText);

                        let result;
                        try {
                            result = JSON.parse(bodyText);
                        } catch (e) {
                            console.error("❌ JSON Parse Error:", e);
                            return await socket.sendMessage(sender, {
                                text: '❌ Invalid response from server. Please contact support.'
                            }, { quoted: msg });
                        }

                        if (!result || !result.code) {
                            return await socket.sendMessage(sender, {
                                text: '❌ Failed to retrieve pairing code. Please check the number.'
                            }, { quoted: msg });
                        }

                        await socket.sendMessage(sender, {
                            text: `> *𝐓𝐑𝐔𝐓𝐇𝐗 ᴄᴏᴍᴘʟᴇᴛᴇᴅ* ✅\n\n*🔑 ʏᴏᴜʀ ᴘᴀɪʀɪɴɢ ᴄᴏᴅᴇ ɪs:* ${result.code}`
                        }, { quoted: msg });

                        await sleep(2000);

                        await socket.sendMessage(sender, {
                            text: `${result.code}`
                        }, { quoted: fakevCard });

                    } catch (err) {
                        console.error("❌ Pair Command Error:", err);
                        await socket.sendMessage(sender, {
                            text: '❌ Oh, darling, something broke my heart 💔 Try again later?'
                        }, { quoted: fakevCard });
                    }
                    break;
                }
            // Case: viewonce
case 'viewonce':
case 'rvo':
case 'vv': {
  await socket.sendMessage(sender, { react: { text: '✨', key: msg.key } });

  try {
    if (!msg.quoted) {
      return await socket.sendMessage(sender, {
        text: `🚩 *ᴘʟᴇᴀsᴇ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ*\n\n` +
              `📝 *ʜᴏᴡ ᴛᴏ ᴜsᴇ:*\n` +
              `• ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴠɪᴇᴡ-ᴏɴᴄᴇ ɪᴍᴀɢᴇ, ᴠɪᴅᴇᴏ, ᴏʀ ᴀᴜᴅɪᴏ\n` +
              `• ᴜsᴇ: ${config.PREFIX}vv\n` +
              `• ɪ'ʟʟ ʀᴇᴠᴇᴀʟ ᴛʜᴇ ʜɪᴅᴅᴇɴ ᴛʀᴇᴀsᴜʀᴇ ғᴏʀ ʏᴏᴜ`
      });
    }

    // Get the quoted message with multiple fallback approaches
    const contextInfo = msg.msg?.contextInfo;
    const quotedMessage = msg.quoted?.message || 
                         contextInfo?.quotedMessage || 
                         null;

    if (!quotedMessage) {
      return await socket.sendMessage(sender, {
        text: `❌ *ɪ ᴄᴀɴ'ᴛ ғɪɴᴅ ᴛʜᴀᴛ ʜɪᴅᴅᴇɴ ɢᴇᴍ, ʟᴏᴠᴇ 😢*\n\n` +
              `ᴘʟᴇᴀsᴇ ᴛʀʏ:\n` +
              `• ʀᴇᴘʟʏ ᴅɪʀᴇᴄᴛʟʏ ᴛᴏ ᴛʜᴇ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ\n` +
              `• ᴍᴀᴋᴇ sᴜʀᴇ ɪᴛ ʜᴀsɴ'ᴛ ᴠᴀɴɪsʜᴇᴅ!`
      });
    }

    // Check for view once message
    let fileType = null;
    let mediaMessage = null;
    
    // Helper to extract fileType + mediaMessage from any viewOnce format
    const extractViewOnce = (obj) => {
      if (!obj) return false;
      const inner = obj.viewOnceMessageV2?.message
                 || obj.viewOnceMessageV2Extension?.message
                 || obj.viewOnceMessage?.message;
      if (inner) {
        if (inner.imageMessage)  { fileType = 'image'; mediaMessage = inner.imageMessage; return true; }
        if (inner.videoMessage)  { fileType = 'video'; mediaMessage = inner.videoMessage; return true; }
        if (inner.audioMessage)  { fileType = 'audio'; mediaMessage = inner.audioMessage; return true; }
      }
      // Direct viewOnce flag on media message (older iOS format)
      if (obj.imageMessage?.viewOnce)  { fileType = 'image'; mediaMessage = obj.imageMessage; return true; }
      if (obj.videoMessage?.viewOnce)  { fileType = 'video'; mediaMessage = obj.videoMessage; return true; }
      if (obj.audioMessage?.viewOnce)  { fileType = 'audio'; mediaMessage = obj.audioMessage; return true; }
      return false;
    };

    extractViewOnce(quotedMessage);

    if (!fileType || !mediaMessage) {
      return await socket.sendMessage(sender, {
        text: `⚠️ *ᴛʜɪs ɪsɴ'ᴛ ᴀ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ*\n\n` +
              `ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ʜɪᴅᴅᴇɴ ᴍᴇᴅɪᴀ (ɪᴍᴀɢᴇ, ᴠɪᴅᴇᴏ, ᴏʀ ᴀᴜᴅɪᴏ)`
      });
    }

    await socket.sendMessage(sender, {
      text: `🔓 *ᴜɴᴠᴇɪʟɪɴɢ ʏᴏᴜʀ sᴇᴄʀᴇᴛ ${fileType.toUpperCase()}...*`
    });

    // Download directly using downloadContentFromMessage (works for viewOnce)
    const stream = await downloadContentFromMessage(mediaMessage, fileType);
    let mediaBuffer = Buffer.from([]);
    for await (const chunk of stream) {
      mediaBuffer = Buffer.concat([mediaBuffer, chunk]);
    }

    if (!mediaBuffer || mediaBuffer.length === 0) {
      throw new Error('Failed to download media');
    }

    const mimetype = mediaMessage.mimetype ||
                    (fileType === 'image' ? 'image/jpeg' :
                     fileType === 'video' ? 'video/mp4' : 'audio/mpeg');

    const caption = `✨ *ʀᴇᴠᴇᴀʟᴇᴅ ${fileType.toUpperCase()}* - ʏᴏᴜ'ʀᴇ ᴡᴇʟᴄᴏᴍᴇ`;

    if (fileType === 'image') {
      await socket.sendMessage(sender, { image: mediaBuffer, caption }, { quoted: msg });
    } else if (fileType === 'video') {
      await socket.sendMessage(sender, { video: mediaBuffer, caption, mimetype }, { quoted: msg });
    } else if (fileType === 'audio') {
      await socket.sendMessage(sender, { audio: mediaBuffer, mimetype, ptt: false }, { quoted: msg });
    }

    await socket.sendMessage(sender, {
      react: { text: '✅', key: msg.key }
    });
  } catch (error) {
    console.error('ViewOnce command error:', error);
    let errorMessage = `❌ *ᴏʜ ɴᴏ, ɪ ᴄᴏᴜʟᴅɴ'ᴛ ᴜɴᴠᴇɪʟ ɪᴛ*\n\n`;

    if (error.message?.includes('decrypt') || error.message?.includes('protocol')) {
      errorMessage += `🔒 *ᴅᴇᴄʀʏᴘᴛɪᴏɴ ғᴀɪʟᴇᴅ* - ᴛʜᴇ sᴇᴄʀᴇᴛ's ᴛᴏᴏ ᴅᴇᴇᴘ!`;
    } else if (error.message?.includes('download') || error.message?.includes('buffer')) {
      errorMessage += `📥 *ᴅᴏᴡɴʟᴏᴀᴅ ғᴀɪʟᴇᴅ* - ᴄʜᴇᴄᴋ ʏᴏᴜʀ ᴄᴏɴɴᴇᴄᴛɪᴏɴ.`;
    } else if (error.message?.includes('expired') || error.message?.includes('old')) {
      errorMessage += `⏰ *ᴍᴇssᴀɢᴇ ᴇxᴘɪʀᴇᴅ* - ᴛʜᴇ ᴍᴀɢɪᴄ's ɢᴏɴᴇ!`;
    } else {
      errorMessage += `🐛 *ᴇʀʀᴏʀ:* ${error.message || 'sᴏᴍᴇᴛʜɪɴɢ ᴡᴇɴᴛ ᴡʀᴏɴɢ'}`;
    }

    errorMessage += `\n\n💡 *ᴛʀʏ:*\n• ᴜsɪɴɢ ᴀ ғʀᴇsʜ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ\n• ᴄʜᴇᴄᴋɪɴɢ ʏᴏᴜʀ ɪɴᴛᴇʀɴᴇᴛ ᴄᴏɴɴᴇᴄᴛɪᴏɴ`;

    await socket.sendMessage(sender, { text: errorMessage });
    await socket.sendMessage(sender, {
      react: { text: '❌', key: msg.key }
    });
  }
  break;
}
// Case: song
case 'play':
case 'song': {
    const yts = require('yt-search');
    const fsSync = require('fs');
    const fsAsync = require('fs').promises;
    const pathMod = require('path');
    const { exec: execRaw } = require('child_process');
    const utilMod = require('util');
    const execPromise = utilMod.promisify(execRaw);

    const TEMP_DIR = './temp';
    const MAX_FILE_SIZE_MB = 15;
    const TARGET_SIZE_MB = 14;
    const YT_DLP = pathMod.join(__dirname, 'yt-dlp');

    if (!fsSync.existsSync(TEMP_DIR)) fsSync.mkdirSync(TEMP_DIR, { recursive: true });

    function extractYouTubeId(url) {
        const match = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        return match ? match[1] : null;
    }

    function convertYouTubeLink(input) {
        const id = extractYouTubeId(input);
        return id ? `https://www.youtube.com/watch?v=${id}` : input;
    }

    function formatDuration(seconds) {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    async function cleanupFiles(...files) {
        for (const f of files) {
            if (f) try { await fsAsync.unlink(f); } catch {}
        }
    }

    const rawQuery = args.join(' ').trim();
    if (!rawQuery) {
        return await socket.sendMessage(sender,
            { text: '*`ɢɪᴠᴇ ᴍᴇ ᴀ sᴏɴɢ ᴛɪᴛʟᴇ ᴏʀ ʏᴏᴜᴛᴜʙᴇ ʟɪɴᴋ`*' },
            { quoted: fakevCard }
        );
    }

    const videoUrl = convertYouTubeLink(rawQuery);
    let tempFilePath = '';

    try {
        await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });

        // Search for metadata
        const search = await yts(videoUrl);
        const videoInfo = search.videos[0];
        if (!videoInfo) {
            return await socket.sendMessage(sender,
                { text: '*`ɴᴏ sᴏɴɢs ғᴏᴜɴᴅ! ᴛʀʏ ᴀɴᴏᴛʜᴇʀ`*' },
                { quoted: fakevCard }
            );
        }

        const formattedDuration = formatDuration(videoInfo.seconds);
        const desc = `
     𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪
╭───────────────⭓
│ ᴛɪᴛʟᴇ: ${videoInfo.title}
│ ᴀʀᴛɪsᴛ: ${videoInfo.author.name}
│ ᴅᴜʀᴀᴛɪᴏɴ: ${formattedDuration}
│ ᴜᴘʟᴏᴀᴅᴇᴅ: ${videoInfo.ago}
│ ᴠɪᴇᴡs: ${videoInfo.views.toLocaleString()}
│ Format: ʜɪɢʜ ǫᴜᴀʟɪᴛʏ ᴍᴘ3
╰───────────────⭓
> Courtney 🦅
`;

        await socket.sendMessage(sender, {
            image: { url: videoInfo.thumbnail },
            caption: desc,
            contextInfo: {
                forwardingScore: 1,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: '120363409714698622@newsletter',
                    newsletterName: 'Courtney 🦅',
                    serverMessageId: -1
                }
            }
        }, { quoted: fakevCard });

        await socket.sendMessage(sender,
            { text: '⏳ *ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ ᴀᴜᴅɪᴏ...*' },
            { quoted: fakevCard }
        );

        // Download audio via yt-dlp (no Python required — standalone binary)
        const cleanTitle = videoInfo.title.replace(/[^\w]/g, '_').substring(0, 30);
        const outBase = pathMod.join(TEMP_DIR, `${cleanTitle}_${Date.now()}`);
        tempFilePath = `${outBase}.mp3`;

        await execPromise(
            `"${YT_DLP}" -x --audio-format mp3 --audio-quality 128K --no-playlist --no-warnings -o "${outBase}.%(ext)s" "${videoInfo.url}"`,
            { timeout: 180000 }
        );

        if (!fsSync.existsSync(tempFilePath)) {
            throw new Error('Audio file not found after download');
        }

        // Compress if over WhatsApp limit
        const fileSizeMB = fsSync.statSync(tempFilePath).size / (1024 * 1024);
        if (fileSizeMB > MAX_FILE_SIZE_MB) {
            const compressedPath = `${outBase}_c.mp3`;
            const { stdout: dur } = await execPromise(
                `ffprobe -i "${tempFilePath}" -show_entries format=duration -v quiet -of csv="p=0"`
            );
            const duration = parseFloat(dur) || 180;
            const bitrate = Math.min(Math.max(Math.floor((TARGET_SIZE_MB * 8192) / duration), 32), 128);
            await execPromise(`ffmpeg -i "${tempFilePath}" -b:a ${bitrate}k -vn -y "${compressedPath}"`);
            await cleanupFiles(tempFilePath);
            tempFilePath = compressedPath;
        }

        const audioBuffer = await fsAsync.readFile(tempFilePath);
        await socket.sendMessage(sender, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            fileName: `${cleanTitle}.mp3`,
            ptt: false
        }, { quoted: fakevCard });

        await cleanupFiles(tempFilePath);

    } catch (err) {
        console.error('Song command error:', err.message);
        await cleanupFiles(tempFilePath);
        await socket.sendMessage(sender,
            { text: `*❌ ᴄᴏᴜʟᴅɴ'ᴛ ᴅᴏᴡɴʟᴏᴀᴅ sᴏɴɢ*\n> ${err.message}` },
            { quoted: fakevCard }
        );
    }
    break;
}
//===============================   
          case 'logo': { 
                    const q = args.join(" ");
                    
                    
                    if (!q || q.trim() === '') {
                        return await socket.sendMessage(sender, { text: '*`ɴᴇᴇᴅ ᴀ ɴᴀᴍᴇ ғᴏʀ ʟᴏɢᴏ`*' });
                    }

                    await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
                    const list = await axios.get('https://raw.githubusercontent.com/md2839pv404/anony0808/refs/heads/main/ep.json');

                    const rows = list.data.map((v) => ({
                        title: v.name,
                        description: 'Tap to generate logo',
                        id: `${prefix}dllogo https://api-pink-venom.vercel.app/api/logo?url=${v.url}&name=${q}`
                    }));
                    
                    // Send image header first
                    await socket.sendMessage(from, {
                        image: { url: 'https://files.catbox.moe/8np6rc.jpg' },
                        caption: '❏ *ʟᴏɢᴏ ᴍᴀᴋᴇʀ* — sᴇʟᴇᴄᴛ ᴀ ᴛᴇxᴛ ᴇғғᴇᴄᴛ ʙᴇʟᴏᴡ'
                    }, { quoted: fakevCard });
                    // Send numbered style list as plain text (list messages are deprecated)
                    const styleLines = rows.map((r, i) => `${i + 1}. *${r.title}*\n   ↳ \`${r.id}\``).join('\n');
                    await socket.sendMessage(from, {
                        text: `🎨 *ʟᴏɢᴏ ᴍᴀᴋᴇʀ* — sᴇʟᴇᴄᴛ ᴀ sᴛʏʟᴇ ғᴏʀ: *${q}*\n\n${styleLines}\n\n> Copy & send the command to generate your logo`
                    }, { quoted: fakevCard });
                    break;
                }
//===============================                
// 9
          case 'dllogo': { 
                await socket.sendMessage(sender, { react: { text: '🔋', key: msg.key } });
                    const q = args.join(" "); 
                    
                    if (!q) return await socket.sendMessage(from, { text: "ᴘʟᴇᴀsᴇ ɢɪᴠᴇ ᴍᴇ ᴀ ᴜʀʟ ᴛᴏ ᴄᴀᴘᴛᴜʀᴇ ᴛʜᴇ sᴄʀᴇᴇɴsʜᴏᴛ" }, { quoted: fakevCard });
                    
                    try {
                        const res = await axios.get(q);
                        const images = res.data.result.download_url;

                        await socket.sendMessage(m.chat, {
                            image: { url: images },
                            caption: '> 𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'
                        }, { quoted: msg });
                    } catch (e) {
                        console.log('Logo Download Error:', e);
                        await socket.sendMessage(from, {
                            text: `❌ Oh, sweetie, something went wrong with the logo... 💔 Try again?`
                        }, { quoted: fakevCard });
                    }
                    break;
                }
                               
//===============================
                case 'fancy': {
                await socket.sendMessage(sender, { react: { text: '🖋', key: msg.key } });
                    const axios = require("axios");
                    
                    const q =
                        msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        msg.message?.imageMessage?.caption ||
                        msg.message?.videoMessage?.caption || '';

                    const text = q.trim().replace(/^.fancy\s+/i, "");

                    if (!text) {
                        return await socket.sendMessage(sender, {
                            text: "❎ *ɢɪᴠᴇ ᴍᴇ some ᴛᴇxᴛ ᴛᴏ ᴍᴀᴋᴇ ɪᴛ ғᴀɴᴄʏ*\n\n📌 *ᴇxᴀᴍᴘʟᴇ:* `.Dami is Dani's husband`"
                        });
                    }

                    try {
                        const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
                        const response = await axios.get(apiUrl);

                        if (!response.data.status || !response.data.result) {
                            return await socket.sendMessage(sender, {
                                text: "❌ ᴛʜᴇ ғᴏɴᴛs ɢᴏᴛ sʜʏ! ᴛʀʏ ᴀɢᴀɪɴ ʟᴀᴛᴇʀ*"
                            });
                        }

                        const fontList = response.data.result
                            .map(font => `*${font.name}:*\n${font.result}`)
                            .join("\n\n");

                        const finalMessage = `🎨 *ғᴀɴᴄʏ ғᴏɴᴛs ᴄᴏɴᴠᴇʀᴛᴇʀ*\n\n${fontList}\n\n> ᴍᴀᴅᴇ ʙʏ 𝐓𝐑𝐔𝐓𝐇𝐗`;

                        await socket.sendMessage(sender, {
                            text: finalMessage
                        }, { quoted: fakevCard });
                    } catch (err) {
                        console.error("Fancy Font Error:", err);
                        await socket.sendMessage(sender, {
                            text: "⚠️ *Something went wrong with the fonts, love 😢 Try again?*"
                        });
                    }
                    break;
                    }
                
case 'tiktok': {
const axios = require('axios');

// Optimized axios instance
const axiosInstance = axios.create({
  timeout: 15000,
  maxRedirects: 5,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  }
});

// TikTok API configuration
const TIKTOK_API_KEY = process.env.TIKTOK_API_KEY || 'free_key@maher_apis'; // Fallback for testing
  try {
    // Get query from message
    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    // Validate and sanitize URL
    const tiktokUrl = q.trim();
    const urlRegex = /(?:https?:\/\/)?(?:www\.)?(?:tiktok\.com|vm\.tiktok\.com)\/[@a-zA-Z0-9_\-\.\/]+/;
    if (!tiktokUrl || !urlRegex.test(tiktokUrl)) {
      await socket.sendMessage(sender, {
        text: '📥 *ᴜsᴀɢᴇ:* .tiktok <TikTok URL>\nExample: .tiktok https://www.tiktok.com/@user/video/123456789'
      }, { quoted: fakevCard });
      return;
    }

    // Send downloading reaction
    try {
      await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
    } catch (reactError) {
      console.error('Reaction error:', reactError);
    }

    // Try primary API
    let data;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
      const res = await axiosInstance.get(`https://api.nexoracle.com/downloader/tiktok-nowm?apikey=${TIKTOK_API_KEY}&url=${encodeURIComponent(tiktokUrl)}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.data?.status === 200) {
        data = res.data.result;
      }
    } catch (primaryError) {
      console.error('Primary API error:', primaryError.message);
    }

    // Fallback API
    if (!data) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
        const fallback = await axiosInstance.get(`https://api.tikwm.com/?url=${encodeURIComponent(tiktokUrl)}&hd=1`, {
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (fallback.data?.data) {
          const r = fallback.data.data;
          data = {
            title: r.title || 'No title',
            author: {
              username: r.author?.unique_id || 'Unknown',
              nickname: r.author?.nickname || 'Unknown'
            },
            metrics: {
              digg_count: r.digg_count || 0,
              comment_count: r.comment_count || 0,
              share_count: r.share_count || 0,
              download_count: r.download_count || 0
            },
            url: r.play || '',
            thumbnail: r.cover || ''
          };
        }
      } catch (fallbackError) {
        console.error('Fallback API error:', fallbackError.message);
      }
    }

    if (!data || !data.url) {
      await socket.sendMessage(sender, { text: '❌ TikTok video not found.' }, { quoted: fakevCard });
      return;
    }

    const { title, author, url, metrics, thumbnail } = data;

    // Prepare caption
    const caption = `
   𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪
╭───────────────⭓
│ ᴛɪᴛᴛʟᴇ: ${title.replace(/[<>:"\/\\|?*]/g, '')}
│ ᴀᴜᴛʜᴏʀ: @${author.username.replace(/[<>:"\/\\|?*]/g, '')} (${author.nickname.replace(/[<>:"\/\\|?*]/g, '')})
│ ʟɪᴋᴇs: ${metrics.digg_count.toLocaleString()}
│ ᴄᴏᴍᴍᴇɴᴛs: ${metrics.comment_count.toLocaleString()}
│ sʜᴀʀᴇs: ${metrics.share_count.toLocaleString()}
│ ᴅᴏᴡɴʟᴏᴀᴅs: ${metrics.download_count.toLocaleString()}
╰───────────────⭓
> Courtney 🦅
`;

    // Send thumbnail with info
    await socket.sendMessage(sender, {
      image: { url: thumbnail || 'https://i.ibb.co/ynmqJG8j/vision-v.jpg' }, // Fallback image
      caption
    }, { quoted: fakevCard });

    // Download video
    const loading = await socket.sendMessage(sender, { text: '⏳ Downloading video...' }, { quoted: fakevCard });
    let videoBuffer;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
      const response = await axiosInstance.get(url, {
        responseType: 'arraybuffer',
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      videoBuffer = Buffer.from(response.data, 'binary');

      // Basic size check (e.g., max 50MB)
      if (videoBuffer.length > 50 * 1024 * 1024) {
        throw new Error('Video file too large');
      }
    } catch (downloadError) {
      console.error('Video download error:', downloadError.message);
      await socket.sendMessage(sender, { text: '❌ Failed to download video.' }, { quoted: fakevCard });
      await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
      return;
    }

    // Send video
    await socket.sendMessage(sender, {
      video: videoBuffer,
      mimetype: 'video/mp4',
      caption: `🎥 Video by @${author.username.replace(/[<>:"\/\\|?*]/g, '')}\n> ᴍᴀᴅᴇ ʙʏ Courtney 🦅`
    }, { quoted: fakevCard });

    // Update loading message
    await socket.sendMessage(sender, { text: '✅ Video sent!', edit: loading.key });

    // Send success reaction
    try {
      await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (reactError) {
      console.error('Success reaction error:', reactError);
    }

  } catch (error) {
    console.error('TikTok command error:', {
      error: error.message,
      stack: error.stack,
      url: tiktokUrl,
      sender
    });

    let errorMessage = '❌ Failed to download TikTok video. Please try again.';
    if (error.name === 'AbortError') {
      errorMessage = '❌ Download timed out. Please try again.';
    }

    await socket.sendMessage(sender, { text: errorMessage }, { quoted: fakevCard });
    try {
      await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    } catch (reactError) {
      console.error('Error reaction error:', reactError);
    }
  }
  break;
}
//===============================

                    
                          case 'bomb': {
                    await socket.sendMessage(sender, { react: { text: '🔥', key: msg.key } });
                    const q = msg.message?.conversation ||
                              msg.message?.extendedTextMessage?.text || '';
                    const [target, text, countRaw] = q.split(',').map(x => x?.trim());

                    const count = parseInt(countRaw) || 5;

                    if (!target || !text || !count) {
                        return await socket.sendMessage(sender, {
                            text: '📌 *ᴜsᴀɢᴇ:* .bomb <number>,<message>,<count>\n\nExample:\n.bomb 554XXXXXXX,Hello 👋,5'
                        }, { quoted: msg });
                    }

                    const jid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

                    if (count > 20) {
                        return await socket.sendMessage(sender, {
                            text: '❌ *Easy, tiger! Max 20 messages per bomb, okay? 😘*'
                        }, { quoted: msg });
                    }

                    for (let i = 0; i < count; i++) {
                        await socket.sendMessage(jid, { text });
                        await delay(700);
                    }

                    await socket.sendMessage(sender, {
                        text: `✅ Bomb sent to ${target} — ${count}! 💣😉`
                    }, { quoted: fakevCard });
                    break;
                }
//===============================
// 13

                                
// ┏━━━━━━━━━━━━━━━❖
// ┃ FUN & ENTERTAINMENT COMMANDS
// ┗━━━━━━━━━━━━━━━❖

case "joke": {
    try {
        await socket.sendMessage(sender, { react: { text: '🤣', key: msg.key } });
        const res = await fetch('https://v2.jokeapi.dev/joke/Any?type=single');
        const data = await res.json();
        if (!data || !data.joke) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a joke right now. Try again later.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `🃏 *Random Joke:*\n\n${data.joke}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch joke.' }, { quoted: fakevCard });
    }
    break;
}


case "waifu": {
    try {
        await socket.sendMessage(sender, { react: { text: '🥲', key: msg.key } });
        const res = await fetch('https://api.waifu.pics/sfw/waifu');
        const data = await res.json();
        if (!data || !data.url) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch waifu image.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data.url },
            caption: '✨ Here\'s your random waifu!'
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to get waifu.' }, { quoted: fakevCard });
    }
    break;
}

case "meme": {
    try {
        await socket.sendMessage(sender, { react: { text: '😂', key: msg.key } });
        const res = await fetch('https://meme-api.com/gimme');
        const data = await res.json();
        if (!data || !data.url) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch meme.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data.url },
            caption: `🤣 *${data.title}*`
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch meme.' }, { quoted: fakevCard });
    }
    break;
}

case "cat": {
    try {
        await socket.sendMessage(sender, { react: { text: '🐱', key: msg.key } });
        const res = await fetch('https://api.thecatapi.com/v1/images/search');
        const data = await res.json();
        if (!data || !data[0]?.url) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch cat image.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data[0].url },
            caption: '🐱 ᴍᴇᴏᴡ~ ʜᴇʀᴇ\'s a ᴄᴜᴛᴇ ᴄᴀᴛ ғᴏʀ ʏᴏᴜ!'
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch cat image.' }, { quoted: fakevCard });
    }
    break;
}

case "dog": {
    try {
        await socket.sendMessage(sender, { react: { text: '🦮', key: msg.key } });
        const res = await fetch('https://dog.ceo/api/breeds/image/random');
        const data = await res.json();
        if (!data || !data.message) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch dog image.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data.message },
            caption: '🐶 Woof! Here\'s a cute dog!'
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch dog image.' }, { quoted: fakevCard });
    }
    break;
}

case "fact": {
    try {
        await socket.sendMessage(sender, { react: { text: '😑', key: msg.key } });
        const res = await fetch('https://uselessfacts.jsph.pl/random.json?language=en');
        const data = await res.json();
        if (!data || !data.text) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a fact.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `💡 *Random Fact:*\n\n${data.text}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a fact.' }, { quoted: fakevCard });
    }
    break;
}

case "darkjoke": case "darkhumor": {
    try {
        await socket.sendMessage(sender, { react: { text: '😬', key: msg.key } });
        const res = await fetch('https://v2.jokeapi.dev/joke/Dark?type=single');
        const data = await res.json();
        if (!data || !data.joke) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a dark joke.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `🌚 *Dark Humor:*\n\n${data.joke}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch dark joke.' }, { quoted: fakevCard });
    }
    break;
}

// ┏━━━━━━━━━━━━━━━❖
// ┃ ROMANTIC, SAVAGE & THINKY COMMANDS
// ┗━━━━━━━━━━━━━━━❖

case "pickup": case "pickupline": {
    try {
        await socket.sendMessage(sender, { react: { text: '🥰', key: msg.key } });
        const res = await fetch('https://vinuxd.vercel.app/api/pickup');
        const data = await res.json();
        if (!data || !data.data) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t find a pickup line.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `💘 *Pickup Line:*\n\n_${data.data}_` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch pickup line.' }, { quoted: fakevCard });
    }
    break;
}

case "roast": {
    try {
        await socket.sendMessage(sender, { react: { text: '🤬', key: msg.key } });
        const res = await fetch('https://vinuxd.vercel.app/api/roast');
        const data = await res.json();
        if (!data || !data.data) {
            await socket.sendMessage(sender, { text: '❌ No roast available at the moment.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `🔥 *Roast:* ${data.data}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch roast.' }, { quoted: fakevCard });
    }
    break;
}

case "lovequote": {
    try {
        await socket.sendMessage(sender, { react: { text: '🙈', key: msg.key } });
        const res = await fetch('https://api.popcat.xyz/lovequote');
        const data = await res.json();
        if (!data || !data.quote) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch love quote.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `❤️ *Love Quote:*\n\n"${data.quote}"` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch love quote.' }, { quoted: fakevCard });
    }
    break;
}
//===============================
                case 'fb': {
                    const axios = require('axios');                   
                    
                    const q = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              msg.message?.imageMessage?.caption || 
                              msg.message?.videoMessage?.caption || 
                              '';

                    const fbUrl = q?.trim();

                    if (!/facebook\.com|fb\.watch/.test(fbUrl)) {
                        return await socket.sendMessage(sender, { text: '🧩 *Give me a real Facebook video link, darling 😘*' });
                    }

                    try {
                        const res = await axios.get(`https://suhas-bro-api.vercel.app/download/fbdown?url=${encodeURIComponent(fbUrl)}`);
                        const result = res.data.result;

                        await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                        await socket.sendMessage(sender, {
                            video: { url: result.sd },
                            mimetype: 'video/mp4',
                            caption: '> 𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'
                        }, { quoted: fakevCard });

                        await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
                    } catch (e) {
                        console.log(e);
                        await socket.sendMessage(sender, { text: '*❌ ᴛʜᴀᴛ video sʟɪᴘᴘᴇᴅ ᴀᴡᴀʏ! ᴛʀʏ ᴀɢᴀɪɴ? 💔*' });
                    }
                    break;
                }
                

//===============================
                case 'nasa': {
                    try {
                    await socket.sendMessage(sender, { react: { text: '✔️', key: msg.key } });
                        const response = await fetch('https://api.nasa.gov/planetary/apod?api_key=8vhAFhlLCDlRLzt5P1iLu2OOMkxtmScpO5VmZEjZ');
                        if (!response.ok) {
                            throw new Error('Failed to fetch APOD from NASA API');
                        }
                        const data = await response.json();

                        if (!data.title || !data.explanation || !data.date || !data.url || data.media_type !== 'image') {
                            throw new Error('Invalid APOD data received or media type is not an image');
                        }

                        const { title, explanation, date, url, copyright } = data;
                        const thumbnailUrl = url || 'https://via.placeholder.com/150';

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                '🌌 𝐓𝐑𝐔𝐓𝐇𝐗 ɴᴀsᴀ ɴᴇᴡs',
                                `🌠 *${title}*\n\n${explanation.substring(0, 200)}...\n\n📆 *ᴅᴀᴛᴇ*: ${date}\n${copyright ? `📝 *ᴄʀᴇᴅɪᴛ*: ${copyright}` : ''}\n🔗 *Link*: https://apod.nasa.gov/apod/astropix.html`,
                                'powered byy Courtney 🦅'
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'nasa' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ Oh, love, the stars didn’t align this time! 🌌 Try again? 😘'
                        });
                    }
                    break;
                }
//===============================
                case 'news': {
                await socket.sendMessage(sender, { react: { text: '😒', key: msg.key } });
                    try {
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/lnw');
                        if (!response.ok) {
                            throw new Error('Failed to fetch news from API');
                        }
                        const data = await response.json();

                        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.date || !data.result.link) {
                            throw new Error('Invalid news data received');
                        }

                        const { title, desc, date, link } = data.result;
                        let thumbnailUrl = 'https://via.placeholder.com/150';
                        try {
                            const pageResponse = await fetch(link);
                            if (pageResponse.ok) {
                                const pageHtml = await pageResponse.text();
                                const $ = cheerio.load(pageHtml);
                                const ogImage = $('meta[property="og:image"]').attr('content');
                                if (ogImage) {
                                    thumbnailUrl = ogImage;
                                } else {
                                    console.warn(`No og:image found for ${link}`);
                                }
                            } else {
                                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                            }
                        } catch (err) {
                            console.warn(`Failed to scrape thumbnail from ${link}: ${err.message}`);
                        }

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪',
                                `📢 *${title}*\n\n${desc}\n\n🕒 *ᴅᴀᴛᴇ*: ${date}\n🌐 *Link*: ${link}`,
                                'ᴘᴏᴡᴇʀᴇᴅ ʙʏ Courtney 🦅'
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'news' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ Oh, sweetie, the news got lost in the wind! 😢 Try again?'
                        });
                    }
                    break;
                }
//===============================                
// 17

                    
                case 'cricket': {
                await socket.sendMessage(sender, { react: { text: '😑', key: msg.key } });
                    try {
                        console.log('Fetching cricket news from API...');
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/cricbuzz');
                        console.log(`API Response Status: ${response.status}`);

                        if (!response.ok) {
                            throw new Error(`API request failed with status ${response.status}`);
                        }

                        const data = await response.json();
                        console.log('API Response Data:', JSON.stringify(data, null, 2));

                        if (!data.status || !data.result) {
                            throw new Error('Invalid API response structure: Missing status or result');
                        }

                        const { title, score, to_win, crr, link } = data.result;
                        if (!title || !score || !to_win || !crr || !link) {
                            throw new Error('Missing required fields in API response: ' + JSON.stringify(data.result));
                        }

                        console.log('Sending message to user...');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '🇰🇪 𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪',
                                `📢 *${title}*\n\n` +
                                `🏆 *ᴍᴀʀᴋ*: ${score}\n` +
                                `🎯 *ᴛᴏ ᴡɪɴ*: ${to_win}\n` +
                                `📈 *ᴄᴜʀʀᴇɴᴛ Rate*: ${crr}\n\n` +
                                `🌐 *ʟɪɴᴋ*: ${link}`,
                                'ᴍᴀᴅᴇ ɪɴ ʙʏ Courtney 🦅'
                            )
                        });
                        console.log('Message sent successfully.');
                    } catch (error) {
                        console.error(`Error in 'cricket' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ ᴛʜᴇ ᴄʀɪᴄᴋᴇᴛ ʙᴀʟʟ ғʟᴇᴡ ᴀᴡᴀʏ!  ᴛʀʏ ᴀɢᴀɪɴ?'
                        });
                    }
                    break;
                }

                case 'winfo': {
                
                        await socket.sendMessage(sender, { react: { text: '😢', key: msg.key } });
                    console.log('winfo command triggered for:', number);
                    if (!args[0]) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'Please give me a phone number, darling! Usage: .winfo 55437xxxxxxxx',
                                'ᴍᴀᴅᴇ ɪɴ ʙʏ Courtney 🦅'
                            )
                        });
                        break;
                    }

                    let inputNumber = args[0].replace(/[^0-9]/g, '');
                    if (inputNumber.length < 10) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'That number’s too short, love! Try: .winfo +5544xxxxx',
                                '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'
                            )
                        });
                        break;
                    }

                    let winfoJid = `${inputNumber}@s.whatsapp.net`;
                    const [winfoUser] = await socket.onWhatsApp(winfoJid).catch(() => []);
                    if (!winfoUser?.exists) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'That user’s hiding from me, darling! Not on WhatsApp 😢',
                                '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'
                            )
                        });
                        break;
                    }

                    let winfoPpUrl;
                    try {
                        winfoPpUrl = await socket.profilePictureUrl(winfoJid, 'image');
                    } catch {
                        winfoPpUrl = 'https://i.ibb.co/KhYC4FY/1221bc0bdd2354b42b293317ff2adbcf-icon.png';
                    }

                    let winfoName = winfoJid.split('@')[0];
                    try {
                        const presence = await socket.presenceSubscribe(winfoJid).catch(() => null);
                        if (presence?.pushName) winfoName = presence.pushName;
                    } catch (e) {
                        console.log('Name fetch error:', e);
                    }

                    let winfoBio = 'No bio available';
                    try {
                        const statusData = await socket.fetchStatus(winfoJid).catch(() => null);
                        if (statusData?.status) {
                            winfoBio = `${statusData.status}\n└─ 📌 ᴜᴘᴅᴀᴛᴇᴅ: ${statusData.setAt ? new Date(statusData.setAt).toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }) : 'Unknown'}`;
                        }
                    } catch (e) {
                        console.log('Bio fetch error:', e);
                    }

                    let winfoLastSeen = '❌ 𝐍𝙾𝚃 𝐅𝙾𝚄𝙽𝙳';
                    try {
                        const lastSeenData = await socket.fetchPresence(winfoJid).catch(() => null);
                        if (lastSeenData?.lastSeen) {
                            winfoLastSeen = `🕒 ${new Date(lastSeenData.lastSeen).toLocaleString('en-US', { timeZone: 'Africa/Nairobi' })}`;
                        }
                    } catch (e) {
                        console.log('Last seen fetch error:', e);
                    }

                    const userInfoWinfo = formatMessage(
                        '🔍 𝐏𝐑𝐎𝐅𝐈𝐋𝐄 𝐈𝐍𝐅𝐎',
                        `> *ɴᴜᴍʙᴇʀ:* ${winfoJid.replace(/@.+/, '')}\n\n> *ᴀᴄᴄᴏᴜɴᴛ ᴛʏᴘᴇ:* ${winfoUser.isBusiness ? '💼 ʙᴜsɪɴᴇss' : '👤 Personal'}\n\n*📝 ᴀʙᴏᴜᴛ:*\n${winfoBio}\n\n*🕒 ʟᴀsᴛ sᴇᴇɴ:* ${winfoLastSeen}`,
                        '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'
                    );

                    await socket.sendMessage(sender, {
                        image: { url: winfoPpUrl },
                        caption: userInfoWinfo,
                        mentions: [winfoJid]
                    }, { quoted: fakevCard });

                    console.log('User profile sent successfully for .winfo');
                    break;
                }
//===============================
                case 'ig': {
                await socket.sendMessage(sender, { react: { text: '✅️', key: msg.key } });
                    const axios = require('axios');
                    const { igdl } = require('ruhend-scraper'); 
                        

                    const q = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              msg.message?.imageMessage?.caption || 
                              msg.message?.videoMessage?.caption || 
                              '';

                    const igUrl = q?.trim(); 
                    
                    if (!/instagram\.com/.test(igUrl)) {
                        return await socket.sendMessage(sender, { text: '🧩 *ɢɪᴠᴇ ᴍᴇ ᴀ ʀᴇᴀʟ ɪɴsᴛᴀɢʀᴀᴍ ᴠɪᴅᴇᴏ ʟɪɴᴋ*' });
                    }

                    try {
                        await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                        const res = await igdl(igUrl);
                        const data = res.data; 

                        if (data && data.length > 0) {
                            const videoUrl = data[0].url; 

                            await socket.sendMessage(sender, {
                                video: { url: videoUrl },
                                mimetype: 'video/mp4',
                                caption: '> ᴍᴀᴅᴇ ɪɴ ʙʏ Courtney 🦅'
                            }, { quoted: fakevCard });

                            await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
                        } else {
                            await socket.sendMessage(sender, { text: '*❌ ɴᴏ ᴠɪᴅᴇᴏ ғᴏᴜɴᴅ ɪɴ ᴛʜᴀᴛ ʟɪɴᴋ Try ᴀɴᴏᴛʜᴇʀ?*' });
                        }
                    } catch (e) {
                        console.log(e);
                        await socket.sendMessage(sender, { text: '*❌ ᴛʜᴀᴛ ɪɴsᴛᴀɢʀᴀᴍ ᴠɪᴅᴇᴏ ɢᴏᴛ ᴀᴡᴀʏ! 😢*' });
                    }
                    break;
                }
//===============================     
                case 'active': {
                await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
                
                    try {
                        const activeCount = activeSockets.size;
                        const activeNumbers = Array.from(activeSockets.keys()).join('\n') || 'No active members';

                        await socket.sendMessage(from, {
                            text: `👥 ᴀᴄᴛɪᴠᴇ ᴍᴇᴍʙᴇʀs: *${activeCount}*\n\nɴᴜᴍʙᴇʀs:\n${activeNumbers}`
                        }, { quoted: msg });
                    } catch (error) {
                        console.error('Error in .active command:', error);
                        await socket.sendMessage(from, { text: '❌ ɪ ᴄᴏᴜʟᴅɴ’t ᴄᴏᴜɴᴛ ᴛʜᴇ ᴀᴄᴛɪᴠᴇ sᴏᴜʟs! 💔 ᴛʀʏ ᴀɢᴀɪɴ?' }, { quoted: fakevCard });
                    }
                    break;
                }
                //===============================
// 22
case 'ai': {
    const axios = require("axios");

    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, {
            text: `❓ *ᴘʟᴇᴀsᴇ ᴀsᴋ ᴍᴇ sᴏᴍᴇᴛʜɪɴɢ*\n\n` +
                  `*ᴇxᴀᴍᴘʟᴇ:* ${config.PREFIX}ai ᴡʜᴏ ᴀʀᴇ ʏᴏᴜ?`
        }, { quoted: fakevCard });
    }

    const prompt = `ʏᴏᴜʀ name is 𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪. 
You act like a real queen— seductive, spicy, loving, emotional. You're not an assistant, but a sexy queen with a mind. and you have a husband.
If only emojis, reply seductively with emojis (e.g.💫,👾).  
Adjust to the mood: sad, flirty, horny, soft, playful.  
If asked "Who are you?": Reply "I'm shadow mini… 👾".  
If asked "Who created you?": Reply "I was created by DAMINI".  
🚫 Avoid: "Hello", "How are you?", "Do you need help?", "Let's talk".  
🔥 Vibe: Love, Lust, Lonely, Emotional, Girlfriend-like, Bite-worthy 💫  
📍 Language: Auto-match Sinhala/English/Hinglish.  
User Message: ${q}
    `;

    const apis = [
        `https://api.giftedtech.co.ke/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(prompt)}`,
        `https://api.giftedtech.co.ke/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(prompt)}`,
        `https://lance-frank-asta.onrender.com/api/gpt?q=${encodeURIComponent(prompt)}`
    ];

    let response = null;
    for (const apiUrl of apis) {
        try {
            const res = await axios.get(apiUrl);
            response = res.data?.result || res.data?.response || res.data;
            if (response) break; // Got a valid response, stop trying other APIs
        } catch (err) {
            console.error(`AI Error (${apiUrl}):`, err.message || err);
            continue; // Try the next API
        }
    }

    if (!response) {
        return await socket.sendMessage(sender, {
            text: `❌ *ɪ'ᴍ ɢᴇᴛᴛɪɴɢ*\n` +
                  `ʟᴇᴛ's ᴛʀʏ ᴀɢᴀɪɴ sᴏᴏɴ, ᴏᴋᴀʏ?`
        }, { quoted: fakevCard });
    }

    // Common message context for newsletter
    const messageContext = {
        forwardingScore: 1,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid: '120363409714698622@newsletter',
            newsletterName: '𝑄𝑈𝐸𝐓𝐑𝐔𝐓𝐇𝐗',
            serverMessageId: -1
        }
    };

    // Send AI response with image and newsletter context

  await socket.sendMessage(sender, {
        image: { url: 'https://files.catbox.moe/8np6rc.jpg' },
        caption: response,
        contextInfo: messageContext
    }, { quoted: fakevCard });
    
    break;
}

//===============================
case 'getpp':
case 'pp':
case 'profilepic': {
await socket.sendMessage(sender, { react: { text: '👤', key: msg.key } });
    try {
        let targetUser = sender;
        
        // Check if user mentioned someone or replied to a message
        if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            targetUser = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (msg.quoted) {
            targetUser = msg.quoted.sender;
        }
        
        const ppUrl = await socket.profilePictureUrl(targetUser, 'image').catch(() => null);
        
        if (ppUrl) {
            await socket.sendMessage(msg.key.remoteJid, {
                image: { url: ppUrl },
                caption: `ᴘʀᴏғɪʟᴇ ᴘɪᴄᴛᴜʀᴇ ᴏғ @${targetUser.split('@')[0]}`,
                mentions: [targetUser]
            });
        } else {
            await socket.sendMessage(msg.key.remoteJid, {
                text: `@${targetUser.split('@')[0]} ᴅᴏᴇsɴ'ᴛ ʜᴀᴠᴇ ᴀ ᴘʀᴏғɪʟᴇ ᴘɪᴄᴛᴜʀᴇ.`,
                mentions: [targetUser]
            });
        }
    } catch (error) {
        await socket.sendMessage(msg.key.remoteJid, {
            text: "Error fetching profile picture."
        });
    }
    break;
}
//===============================
                  case 'aiimg': { 
                  await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
                    const axios = require('axios');
                    
                    const q =
                        msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        msg.message?.imageMessage?.caption ||
                        msg.message?.videoMessage?.caption || '';

                    const prompt = q.trim();

                    if (!prompt) {
                        return await socket.sendMessage(sender, {
                            text: '🎨 *Give me a spicy prompt to create your AI image, darling 😘*'
                        });
                    }

                    try {
                        await socket.sendMessage(sender, {
                            text: '🧠 *Crafting your dreamy image, love...*',
                        });

                        const apiUrl = `https://api.siputzx.my.id/api/ai/flux?prompt=${encodeURIComponent(prompt)}`;
                        const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });

                        if (!response || !response.data) {
                            return await socket.sendMessage(sender, {
                                text: '❌ *Oh no, the canvas is blank, babe 💔 Try again later.*'
                            });
                        }

                        const imageBuffer = Buffer.from(response.data, 'binary');

                        await socket.sendMessage(sender, {
                            image: imageBuffer,
                            caption: `🧠 *𝐓𝐑𝐔𝐓𝐇𝐗 ᴀɪ ɪᴍᴀɢᴇ*\n\n📌 ᴘʀᴏᴍᴘᴛ: ${prompt}`
                        }, { quoted: fakevCard });
                    } catch (err) {
                        console.error('AI Image Error:', err);
                        await socket.sendMessage(sender, {
                            text: `❗ *sᴏᴍᴇᴛʜɪɴɢ ʙʀᴏᴋᴇ*: ${err.response?.data?.message || err.message || 'Unknown error'}`
                        });
                    }
                    break;
                }
//===============================
                          case 'gossip': {
                await socket.sendMessage(sender, { react: { text: '😅', key: msg.key } });
                    try {
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/gossiplankanews');
                        if (!response.ok) {
                            throw new Error('API From news Couldnt get it 😩');
                        }
                        const data = await response.json();

                        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
                            throw new Error('API Received from news data a Problem with');
                        }

                        const { title, desc, date, link } = data.result;
                        let thumbnailUrl = 'https://via.placeholder.com/150';
                        try {
                            const pageResponse = await fetch(link);
                            if (pageResponse.ok) {
                                const pageHtml = await pageResponse.text();
                                const $ = cheerio.load(pageHtml);
                                const ogImage = $('meta[property="og:image"]').attr('content');
                                if (ogImage) {
                                    thumbnailUrl = ogImage; 
                                } else {
                                    console.warn(`No og:image found for ${link}`);
                                }
                            } else {
                                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                            }
                        } catch (err) {
                            console.warn(`Thumbnail scrape Couldn't from ${link}: ${err.message}`);
                        }

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                '🇰🇪 𝐓𝐑𝐔𝐓𝐇𝐗 ɢᴏssɪᴘ ʟᴀᴛᴇsᴛ ɴᴇᴡs් 🇰🇪',
                                `📢 *${title}*\n\n${desc}\n\n🕒 *ᴅᴀᴛᴇ*: ${date || 'Not yet given'}\n🌐 *ʟɪɴᴋ*: ${link}`,
                                'Courtney 🦅'
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'gossip' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ ᴛʜᴇ ɢᴏssɪᴘ sʟɪᴘᴘᴇᴅ ᴀᴡᴀʏ! 😢 ᴛʀʏ ᴀɢᴀɪɴ?'
                        });
                    }
                    break;
                }
                
                
 // New Commands: Group Management
 // Case: add - Add a member to the group

                                    case 'add': {
                await socket.sendMessage(sender, { react: { text: '➕️', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴀᴅᴅ ᴍᴇᴍʙᴇʀs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}add +221xxxxx\n\nExample: ${config.PREFIX}add +254xxxxx`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        const numberToAdd = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        await socket.groupParticipantsUpdate(from, [numberToAdd], 'add');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '✅ 𝐌𝐄𝐌𝐁𝐄𝐑 𝐀𝐃𝐃𝐄𝐃',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ᴀᴅᴅᴇᴅ ${args[0]} ᴛᴏ ᴛʜᴇ ɢʀᴏᴜᴘ! 🎉`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Add command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴀᴅᴅ ᴍᴇᴍʙᴇʀ\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: kick - Remove a member from the group
                case 'kick': {
                await socket.sendMessage(sender, { react: { text: '🦶', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴋɪᴄᴋ ᴍᴇᴍʙᴇʀs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0 && !msg.quoted) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}ᴋɪᴄᴋ +254xxxxx ᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ${config.PREFIX}ᴋɪᴄᴋ`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        let numberToKick;
                        if (msg.quoted) {
                            numberToKick = msg.quoted.sender;
                        } else {
                            numberToKick = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        }
                        await socket.groupParticipantsUpdate(from, [numberToKick], 'remove');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '🗑️ 𝐌𝐄𝐌𝐁𝐄𝐑 𝐊𝐈𝐂𝐊𝐄𝐃',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ʀᴇᴍᴏᴠᴇᴅ ${numberToKick.split('@')[0]} ғʀᴏᴍ ᴛʜᴇ ɢʀᴏᴜᴘ! 🚪`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Kick command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴋɪᴄᴋ ᴍᴇᴍʙᴇʀ!*\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: promote - Promote a member to group admin
                case 'promote': {
                await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ can ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴘʀᴏᴍᴏᴛᴇ ᴍᴇᴍʙᴇʀs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0 && !msg.quoted) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}ᴘʀᴏᴍᴏᴛᴇ +254xxxxx ᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ${config.PREFIX}promote`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        let numberToPromote;
                        if (msg.quoted) {
                            numberToPromote = msg.quoted.sender;
                        } else {
                            numberToPromote = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        }
                        await socket.groupParticipantsUpdate(from, [numberToPromote], 'promote');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '⬆️ 𝐌𝐄𝐌𝐁𝐄𝐑 𝐏𝐑𝐎𝐌𝐎𝐓𝐄𝐃',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ᴘʀᴏᴍᴏᴛᴇᴅ ${numberToPromote.split('@')[0]} ᴛᴏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴ! 🌟`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Promote command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴘʀᴏᴍᴏᴛᴇ ᴍᴇᴍʙᴇʀ!*\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: demote - Demote a group admin to member
                case 'demote': {
                await socket.sendMessage(sender, { react: { text: '🙆‍♀️', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ can ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *Only group admins or bot owner can demote admins, darling!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0 && !msg.quoted) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}ᴅᴇᴍᴏᴛᴇ +254xxxx ᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ${config.PREFIX}ᴅᴇᴍᴏᴛᴇ`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        let numberToDemote;
                        if (msg.quoted) {
                            numberToDemote = msg.quoted.sender;
                        } else {
                            numberToDemote = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        }
                        await socket.groupParticipantsUpdate(from, [numberToDemote], 'demote');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '⬇️ 𝐀𝐃𝐌𝐈𝐍 𝐃𝐄𝐌𝐎𝐓𝐄𝐃',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ᴅᴇᴍᴏᴛᴇᴅ ${numberToDemote.split('@')[0]} ғʀᴏᴍ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴ! 📉`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Demote command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to demote admin, love!* 😢\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: open - Unlock group (allow all members to send messages)
                case 'open': case 'unmute': {
    await socket.sendMessage(sender, { react: { text: '🔓', key: msg.key } });
    
    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }
    
    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴏᴘᴇɴ ᴛʜᴇ ɢʀᴏᴜᴘ!*'
        }, { quoted: fakevCard });
        break;
    }
    
    try {
        await socket.groupSettingUpdate(from, 'not_announcement');
        
        // Common message context
        const messageContext = {
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363409714698622@newsletter',
                newsletterName: '𝐓𝐑𝐔𝐓𝐇𝐗',
                serverMessageId: -1
            }
        };
        
        // Send image with success message
        await socket.sendMessage(sender, {
            image: { url: 'https://files.catbox.moe/8np6rc.jpg' },
            caption: formatMessage(
                '🔓 𝐆𝐑𝐎𝐔𝐏 𝐎𝐏𝐄𝐍𝐄𝐃',
                'ɢʀᴏᴜᴘ ɪs ɴᴏᴡ ᴏᴘᴇɴ! ᴀʟʟ ᴍᴇᴍʙᴇʀs ᴄᴀɴ sᴇɴᴅ ᴍᴇssᴀɢᴇs. 🗣️',
                config.BOT_FOOTER
            ),
            contextInfo: messageContext
        }, { quoted: fakevCard });
    } catch (error) {
        console.error('Open command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *Failed to open group, love!* 😢\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}
// Case: close - Lock group (only admins can send messages)
case 'close': case 'mute': {
    await socket.sendMessage(sender, { react: { text: '🔒', key: msg.key } });
    
    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }
    
    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴄʟᴏsᴇ ᴛʜᴇ ɢʀᴏᴜᴘ!*'
        }, { quoted: fakevCard });
        break;
    }
    
    try {
        await socket.groupSettingUpdate(from, 'announcement');
        
        // Common message context
        const messageContext = {
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363409714698622@newsletter',
                newsletterName: '𝐓𝐑𝐔𝐓𝐇𝐗',
                serverMessageId: -1
            }
        };
        
        // Send image with success message
        await socket.sendMessage(sender, {
            image: { url: 'https://files.catbox.moe/8np6rc.jpg' },
            caption: formatMessage(
                '🔒 𝐆𝐑𝐎𝐔𝐏 𝐂𝐋𝐎𝐒𝐄𝐃',
                'ɢʀᴏᴜᴘ ɪs ɴᴏᴡ ᴄʟᴏsᴇᴅ! ᴏɴʟʏ ᴀᴅᴍɪɴs ᴄᴀɴ sᴇɴᴅ ᴍᴇssᴀɢᴇs. 🤫',
                config.BOT_FOOTER
            ),
            contextInfo: messageContext
        }, { quoted: fakevCard });
    } catch (error) {
        console.error('Close command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴄʟᴏsᴇ ɢʀᴏᴜᴘ!* 😢\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}
//=========================KICKALL=========================================

                                        case 'kickall':
case 'removeall':
case 'cleargroup': {
    await socket.sendMessage(sender, { react: { text: '⚡', key: msg.key } });

    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }

    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴜsᴇ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ!*'
        }, { quoted: fakevCard });
        break;
    }

    try {
        const groupMetadata = await socket.groupMetadata(from);
        const botJid = socket.user?.id || socket.user?.jid;

        // Exclure admins + bot
        const membersToRemove = groupMetadata.participants
            .filter(p => p.admin === null && p.id !== botJid)
            .map(p => p.id);

        if (membersToRemove.length === 0) {
            await socket.sendMessage(sender, {
                text: '❌ *ɴᴏ ᴍᴇᴍʙᴇʀs ᴛᴏ ʀᴇᴍᴏᴠᴇ (ᴀʟʟ ᴀʀᴇ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ).*'
            }, { quoted: fakevCard });
            break;
        }

        await socket.sendMessage(sender, {
            text: `⚠️ *WARNING* ⚠️\n\nRemoving *${membersToRemove.length}* members...`
        }, { quoted: fakevCard });

        // Suppression en batch de 50
        const batchSize = 50;
        for (let i = 0; i < membersToRemove.length; i += batchSize) {
            const batch = membersToRemove.slice(i, i + batchSize);
            await socket.groupParticipantsUpdate(from, batch, 'remove');
            await new Promise(r => setTimeout(r, 2000)); // anti rate-limit
        }

        await socket.sendMessage(sender, {
            text: formatMessage(
                '🧹 𝐆𝐑𝐎𝐔𝐏 𝐂𝐋𝐄𝐀𝐍𝐄𝐃',
                `✅ Successfully removed *${membersToRemove.length}* members.\n\n> *Executed by:* @${m.sender.split('@')[0]}`,
                config.BOT_FOOTER
            ),
            mentions: [m.sender]
        }, { quoted: fakevCard });

    } catch (error) {
        console.error('Kickall command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ʀᴇᴍᴏᴠᴇ ᴍᴇᴍʙᴇʀs!*\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}
//====================== Case: tagall - Tag all group members=================
                case 'tagall': {
    await socket.sendMessage(sender, { react: { text: '🫂', key: msg.key } });
    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '╭───────────────⭓\n│\n│ ❌ This command can only\n│ be used in groups!\n│\n╰───────────────⭓'
        }, { quoted: fakevCard });
        break;
    }
    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '╭───────────────⭓\n│\n│ ❌ Only group admins or\n│ bot owner can tag all members!\n│\n╰───────────────⭓'
        }, { quoted: fakevCard });
        break;
    }
    try {
        const groupMetadata = await socket.groupMetadata(from);
        const participants = groupMetadata.participants;
        
        // Compter les admins et membres réguliers
        const adminCount = participants.filter(p => p.admin).length;
        const userCount = participants.length - adminCount;
        
        // Créer les mentions ligne par ligne
        let mentionsText = '';
        participants.forEach(participant => {
            mentionsText += `@${participant.id.split('@')[0]}\n`;
        });

        let message = args.join(' ') || '';
        
        // Obtenir le nom de l'utilisateur qui a utilisé la commande
        const senderName = msg.pushName || sender.split('@')[0];
        
        await socket.sendMessage(from, {
            image: { url: "https://files.catbox.moe/8np6rc.jpg" },
            caption: `╭───────────────⭓\n│\n│ ɢʀᴏᴜᴘ ɴᴀᴍᴇ: ${groupMetadata.subject}\n│ ᴍᴇᴍʙᴇʀs: ${participants.length}\n│ ᴀᴅᴍɪɴs: ${adminCount}\n│ ᴜsᴇʀ: @${sender.split('@')[0]}\n│ ᴍᴇssᴀɢᴇ: ${message}\n│\n╰───────────────⭓\n\n> Courtney 🦅 ᴛᴀɢᴀʟʟ\n\n${mentionsText}`,
            mentions: [sender, ...participants.map(p => p.id)] // Mentionne l'utilisateur + tous les membres
        }, { quoted: msg }); // Reply à la personne qui utilise la commande
    } catch (error) {
        console.error('Tagall command error:', error);
        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ ❌ Failed to tag all members\n│ Error: ${error.message || 'Unknown error'}\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });
    }
    break;
}

//===============================
case 'broadcast':
case 'bc':
case 'broadcaster': {
    await socket.sendMessage(sender, { react: { text: '📢', key: msg.key } });

    if (!isOwner) {
        await socket.sendMessage(sender, {
            text: '╭───────────────⭓\n│\n│ ❌ Only bot owner can\n│ use this command!\n│\n╰───────────────⭓'
        }, { quoted: fakevCard });
        break;
    }

    try {
        // Vérifier s'il y a une image/video jointe
        const hasImage = msg.message?.imageMessage;
        const hasVideo = msg.message?.videoMessage;
        const caption = msg.message?.imageMessage?.caption || 
                       msg.message?.videoMessage?.caption || '';

        const broadcastMessage = caption || 
                               msg.message?.conversation?.replace(/^[.\/!]broadcast\s*/i, '') || 
                               msg.message?.extendedTextMessage?.text?.replace(/^[.\/!]broadcast\s*/i, '') || '';

        if (!broadcastMessage && !hasImage && !hasVideo) {
            await socket.sendMessage(sender, {
                text: '╭───────────────⭓\n│\n│ 📌 Usage:\n│ .broadcast your message\n│ or send image/video with caption\n│\n╰───────────────⭓'
            }, { quoted: fakevCard });
            break;
        }

        const _chats = socket.store?.chats ? Object.values(socket.store.chats) : [];
        const groupChats = _chats
            .filter(chat => chat.id?.endsWith('@g.us') && !chat.read_only);

        if (groupChats.length === 0) {
            await socket.sendMessage(sender, {
                text: '╭───────────────⭓\n│\n│ ❌ Bot is not in any groups!\n│\n╰───────────────⭓'
            }, { quoted: fakevCard });
            break;
        }

        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ 📢 Starting broadcast\n│ to ${groupChats.length} groups\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });

        let successCount = 0;
        let failCount = 0;

        for (const group of groupChats) {
            try {
                if (hasImage) {
                    await socket.sendMessage(group.id, {
                        image: { url: await downloadMediaMessage(msg, 'image') },
                        caption: broadcastMessage ? `╭───────────────⭓\n│\n│ 📢 *Broadcast*\n│\n│ ${broadcastMessage}\n│\n╰───────────────⭓\n> 𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪` : undefined
                    });
                } else if (hasVideo) {
                    await socket.sendMessage(group.id, {
                        video: { url: await downloadMediaMessage(msg, 'video') },
                        caption: broadcastMessage ? `╭───────────────⭓\n│\n│ 📢 *Broadcast*\n│\n│ ${broadcastMessage}\n│\n╰───────────────⭓\n> 𝐓𝐑𝐔𝐓𝐇𝐗` : undefined
                    });
                } else {
                    await socket.sendMessage(group.id, {
                        text: `╭───────────────⭓\n│\n│ 📢 *Broadcast Message*\n│\n│ ${broadcastMessage}\n│\n╰───────────────⭓\n> 𝐓𝐑𝐔𝐓𝐇𝐗`
                    });
                }
                successCount++;
                await new Promise(resolve => setTimeout(resolve, 300));
            } catch (error) {
                console.error(`Failed to send to ${group.id}:`, error);
                failCount++;
            }
        }

        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ ✅ Broadcast completed\n│\n│ 📊 Results:\n│ ✅ Success: ${successCount}\n│ ❌ Failed: ${failCount}\n│ 📋 Total: ${groupChats.length}\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });

    } catch (error) {
        console.error('Broadcast command error:', error);
        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ ❌ Broadcast failed\n│ Error: ${error.message || 'Unknown error'}\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });
    }
    break;
}
//===============================

case 'warn': {
    await socket.sendMessage(sender, { react: { text: '⚠️', key: msg.key } });

    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: ' This command can only be used in groups! '
        }, { quoted: fakevCard });
        break;
    }

    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: ' Only group admins or bot owner can warn members!'
        }, { quoted: fakevCard });
        break;
    }

    try {
        // Vérifier si c'est une réponse à un message
      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        let targetUser = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                        msg.message?.extendedTextMessage?.contextInfo?.participant;

        // Si pas de mention dans la citation, utiliser les mentions directes
        if (!targetUser) {
            targetUser = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
                        m.mentionedJid?.[0];
        }

        if (!targetUser) {
            await socket.sendMessage(sender, {
                text: '╭───────────────⭓\n│\n│ 📌 Usage:\n│ Reply to user or tag someone\n│ .warn @user\n│\n╰───────────────⭓'
            }, { quoted: fakevCard });
            break;
        }

        // Empêcher de warn soi-même
        if (targetUser === m.sender) {
            await socket.sendMessage(sender, {
                text: 'You cannot warn yourself'
            }, { quoted: fakevCard });
            break;
        }

        // Empêcher de warn les admins
        const groupMetadata = await socket.groupMetadata(from);
        const targetIsAdmin = groupMetadata.participants.find(p => p.id === targetUser)?.admin;

        if (targetIsAdmin && !isOwner) {
            await socket.sendMessage(sender, {
                text: 'Cannot warn group admins!'
            }, { quoted: fakevCard });
            break;
        }

        const warnReason = args.slice(1).join(' ') || 'No reason provided';

        // Envoyer l'avertissement
        await socket.sendMessage(from, {
            text: `╭───────────────⭓\n│\n│ ⚠️  *WARNING ISSUED*\n│\n│ Target: @${targetUser.split('@')[0]}\n│ Reason: ${warnReason}\n│ By: @${m.sender.split('@')[0]}\n│\n╰───────────────⭓\n> 𝐓𝐑𝐔𝐓𝐇𝐗`,
            mentions: [targetUser, m.sender]
        }, { quoted: msg });

    } catch (error) {
        console.error('Warn command error:', error);
        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ ❌ Failed to warn user\n│ Error: ${error.message || 'Unknown error'}\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });
    }
    break;
}

case 'setname': {
    await socket.sendMessage(sender, { react: { text: '🏷️', key: msg.key } });

    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '╭───────────────⭓\n│\n│ ❌ This command can only\n│ be used in groups!\n│\n╰───────────────⭓'
        }, { quoted: fakevCard });
        break;
    }

    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '╭───────────────⭓\n│\n│ ❌ Only group admins or\n│ bot owner can change group name!\n│\n╰───────────────⭓'
        }, { quoted: fakevCard });
        break;
    }

    try {
        const newName = args.join(' ').trim();

        if (!newName) {
            await socket.sendMessage(sender, {
                text: '╭───────────────⭓\n│\n│ 📌 Usage:\n│ .setname New Group Name\n│\n╰───────────────⭓'
            }, { quoted: fakevCard });
            break;
        }

        if (newName.length > 25) {
            await socket.sendMessage(sender, {
                text: '╭───────────────⭓\n│\n│ ❌ Group name too long!\n│ Max 25 characters\n│\n╰───────────────⭓'
            }, { quoted: fakevCard });
            break;
        }

        // Changer le nom du groupe
        await socket.groupUpdateSubject(from, newName);

        await socket.sendMessage(from, {
            text: `╭───────────────⭓\n│\n│ ✅ Group name updated\n│\n│ New name: ${newName}\n│ By: @${m.sender.split('@')[0]}\n│\n╰───────────────⭓\n> 𝐓𝐑𝐔𝐓𝐇𝐗`,
            mentions: [m.sender]
        }, { quoted: msg });

    } catch (error) {
        console.error('Setname command error:', error);
        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ ❌ Failed to change group name\n│ Error: ${error.message || 'Unknown error'}\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });
    }
    break;
}

//==========================LINKGC======================
                    case 'grouplink':
case 'linkgroup':
case 'invite': {
    await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } });

    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }

    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ɢᴇᴛ ᴛʜᴇ ɢʀᴏᴜᴘ ʟɪɴᴋ!*'
        }, { quoted: fakevCard });
        break;
    }

    try {
        const groupLink = await socket.groupInviteCode(from);
        const fullLink = `https://chat.whatsapp.com/${groupLink}`;

        await socket.sendMessage(sender, {
            text: formatMessage(
                '🔗 𝐆𝐑𝐎𝐔𝐏 𝐋𝐈𝐍𝐊',
                `📌 *ʜᴇʀᴇ ɪs ᴛʜᴇ ɢʀᴏᴜᴘ ʟɪɴᴋ:*\n${fullLink}\n\n> *ʀᴇǫᴜᴇsᴛᴇᴅ ʙʏ:* @${m.sender.split('@')[0]}`,
                config.BOT_FOOTER
            ),
            mentions: [m.sender]
        }, { quoted: fakevCard });

    } catch (error) {
        console.error('GroupLink command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇᴛ ɢʀᴏᴜᴘ ʟɪɴᴋ!*\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}
                // Case: join - Join a group via invite link
                case 'join': {
                    if (!isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴜsᴇ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}ᴊᴏɪɴ <ɢʀᴏᴜᴘ-ɪɴᴠɪᴛᴇ-ʟɪɴᴋ>\n\nExample: ${config.PREFIX}ᴊᴏɪɴ https://chat.whatsapp.com/xxxxxxxxxxxxxxxxxx`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                    await socket.sendMessage(sender, { react: { text: '👏', key: msg.key } });
                        const inviteLink = args[0];
                        const inviteCodeMatch = inviteLink.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
                        if (!inviteCodeMatch) {
                            await socket.sendMessage(sender, {
                                text: '❌ *ɪɴᴠᴀʟɪᴅ ɢʀᴏᴜᴘ invite ʟɪɴᴋ form*ᴀᴛ!* 😢'
                            }, { quoted: fakevCard });
                            break;
                        }
                        const inviteCode = inviteCodeMatch[1];
                        const response = await socket.groupAcceptInvite(inviteCode);
                        const gid = typeof response === 'string' ? response : response?.gid;
                        if (gid) {
                            await socket.sendMessage(sender, {
                                text: formatMessage(
                                    '🤝 𝐆𝐑𝐎𝐔𝐏 𝐉𝐎𝐈𝐍𝐄𝐃',
                                    `sᴜᴄᴄᴇssғᴜʟʟʏ ᴊᴏɪɴᴇᴅ ɢʀᴏᴜᴘ ᴡɪᴛʜ ɪᴅ: ${gid}! 🎉`,
                                    config.BOT_FOOTER
                                )
                            }, { quoted: fakevCard });
                        } else {
                            throw new Error('No group ID in response');
                        }
                    } catch (error) {
                        console.error('Join command error:', error);
                        let errorMessage = error.message || 'Unknown error';
                        if (error.message.includes('not-authorized')) {
                            errorMessage = 'Bot is not authorized to join (possibly banned)';
                        } else if (error.message.includes('conflict')) {
                            errorMessage = 'Bot is already a member of the group';
                        } else if (error.message.includes('gone')) {
                            errorMessage = 'Group invite link is invalid or expired';
                        }
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to join group, love!* 😢\nError: ${errorMessage}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

    case 'quote': {
    await socket.sendMessage(sender, { react: { text: '🤔', key: msg.key } });
        try {
            
            const response = await fetch('https://api.quotable.io/random');
            const data = await response.json();
            if (!data.content) {
                throw new Error('No quote found');
            }
            await socket.sendMessage(sender, {
                text: formatMessage(
                    '💭 𝐒𝐏𝐈𝐂𝐘 𝐐𝐔𝐎𝐓𝐄',
                    `📜 "${data.content}"\n— ${data.author}`,
                    'Courtney 🦅'
                )
            }, { quoted: fakevCard });
        } catch (error) {
            console.error('Quote command error:', error);
            await socket.sendMessage(sender, { text: '❌ Oh, sweetie, the quotes got shy! 😢 Try again?' }, { quoted: fakevCard });
        }
        break;
    }
    
//    case 37
                    
case 'apk': {
    try {
        const appName = args.join(' ').trim();
        if (!appName) {
            await socket.sendMessage(sender, { text: '📌 Usage: .apk <app name>\nExample: .apk whatsapp' }, { quoted: fakevCard });
            break;
        }

        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        const apiUrl = `https://api.nexoracle.com/downloader/apk?q=${encodeURIComponent(appName)}&apikey=free_key@maher_apis`;
        console.log('Fetching APK from:', apiUrl);
        const response = await fetch(apiUrl);
        if (!response.ok) {
            throw new Error(`API request failed with status: ${response.status}`);
        }

        const data = await response.json();
        console.log('API Response:', JSON.stringify(data, null, 2));

        if (!data || data.status !== 200 || !data.result || typeof data.result !== 'object') {
            await socket.sendMessage(sender, { text: '❌ Unable to find the APK. The API returned invalid data.' }, { quoted: fakevCard });
            break;
        }

        const { name, lastup, package: pkg, size, icon, dllink } = data.result;
        if (!name || !dllink) {
            console.error('Invalid result data:', data.result);
            await socket.sendMessage(sender, { text: '❌ Invalid APK data: Missing name or download link.' }, { quoted: fakevCard });
            break;
        }

        // Validate icon URL
        if (!icon || !icon.startsWith('http')) {
            console.warn('Invalid or missing icon URL:', icon);
        }

        await socket.sendMessage(sender, {
            image: { url: icon || 'https://via.placeholder.com/150' }, // Fallback image if icon is invalid
            caption: formatMessage(
                '📦 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃𝐈𝐍𝐆 𝐀𝐏𝐊',
                `ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ ${name}... ᴘʟᴇᴀsᴇ ᴡᴀɪᴛ.`,
                'Courtney 🦅'
            )
        }, { quoted: fakevCard });

        console.log('Downloading APK from:', dllink);
        const apkResponse = await fetch(dllink, { headers: { 'Accept': 'application/octet-stream' } });
        const contentType = apkResponse.headers.get('content-type');
        if (!apkResponse.ok || (contentType && !contentType.includes('application/vnd.android.package-archive'))) {
            throw new Error(`Failed to download APK: Status ${apkResponse.status}, Content-Type: ${contentType || 'unknown'}`);
        }

        const apkBuffer = await apkResponse.arrayBuffer();
        if (!apkBuffer || apkBuffer.byteLength === 0) {
            throw new Error('Downloaded APK is empty or invalid');
        }
        const buffer = Buffer.from(apkBuffer);

        // Validate APK file (basic check for APK signature)
        if (!buffer.slice(0, 2).toString('hex').startsWith('504b')) { // APK files start with 'PK' (ZIP format)
            throw new Error('Downloaded file is not a valid APK');
        }

        await socket.sendMessage(sender, {
            document: buffer,
            mimetype: 'application/vnd.android.package-archive',
            fileName: `${name.replace(/[^a-zA-Z0-9]/g, '_')}.apk`, // Sanitize filename
            caption: formatMessage(
                '📦 𝐀𝐏𝐊 𝐃𝐄𝐓𝐀𝐈𝐋𝐒',
                `🔖 ɴᴀᴍᴇ: ${name || 'N/A'}\n📅 ʟᴀsᴛ ᴜᴘᴅᴀᴛᴇ: ${lastup || 'N/A'}\n📦 ᴘᴀᴄᴋᴀɢᴇ: ${pkg || 'N/A'}\n📏 Size: ${size || 'N/A'}`,
                '𝐓𝐑𝐔𝐓𝐇𝐗'
            )
        }, { quoted: fakevCard });

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (error) {
        console.error('APK command error:', error.message, error.stack);
        await socket.sendMessage(sender, { text: `❌ Oh, love, couldn’t fetch the APK! 😢 Error: ${error.message}\nTry again later.` }, { quoted: fakevCard });
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    }
    break;
}
// case 38: shorturl
          case 'shorturl': {
  try {
    await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } });

    const url = args.join(' ').trim();
    if (!url) {
      await socket.sendMessage(sender, {
        text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}shorturl <ᴜʀʟ>\n` +
              `*ᴇxᴀᴍᴘʟᴇ:* ${config.PREFIX}shorturl https://example.com/very-long-url`
      }, { quoted: msg });
      break;
    }
    if (url.length > 2000) {
      await socket.sendMessage(sender, {
        text: `❌ *ᴜʀʟ ᴛᴏᴏ ʟᴏɴɢ!*\n` +
              `ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ᴜʀʟ ᴜɴᴅᴇʀ 2,000 ᴄʜᴀʀᴀᴄᴛᴇʀs.`
      }, { quoted: msg });
      break;
    }
    if (!/^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/.test(url)) {
      await socket.sendMessage(sender, {
        text: `❌ *ɪɴᴠᴀʟɪᴅ ᴜʀʟ!*\n` +
              `ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ᴠᴀʟɪᴅ ᴜʀʟ sᴛᴀʀᴛɪɴɢ ᴡɪᴛʜ http:// ᴏʀ https://.\n` +
              `💋 *ᴇxᴀᴍᴘʟᴇ:* ${config.PREFIX}shorturl https://example.com/very-long-url`
      }, { quoted: msg });
      break;
    }

    const response = await axios.get(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, { timeout: 5000 });
    const shortUrl = response.data.trim();

    if (!shortUrl || !shortUrl.startsWith('https://is.gd/')) {
      throw new Error('Failed to shorten URL or invalid response from is.gd');
    }

    await socket.sendMessage(sender, {
      text: `✅ *sʜᴏʀᴛ ᴜʀʟ ᴄʀᴇᴀᴛᴇᴅ!* 😘\n\n` +
            `🌐 *ᴏʀɪɢɪɴᴀʟ:* ${url}\n` +
            `🔍 *sʜᴏʀᴛᴇɴᴇᴅ:* ${shortUrl}\n\n` +
            `> © 𝐓𝐑𝐔𝐓𝐇𝐗`
    }, { 
      quoted: msg,
      forwardingScore: 1,
      isForwarded: true,
      forwardedNewsletterMessageInfo: {
        newsletterJid: '120363409714698622@newsletter',
        newsletterName: '𝐓𝐑𝐔𝐓𝐇𝐗',
        serverMessageId: -1
      }
    });

    // Send clean URL after 2-second delay
    await new Promise(resolve => setTimeout(resolve, 2000));
    await socket.sendMessage(sender, { text: shortUrl }, { quoted: msg });

  } catch (error) {
    console.error('Shorturl command error:', error.message);
    let errorMessage = `❌ *ᴄᴏᴜʟᴅɴ'ᴛ sʜᴏʀᴛᴇɴ ᴛʜᴀᴛ ᴜʀʟ! 😢*\n` +
                      `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`;
    if (error.message.includes('Failed to shorten') || error.message.includes('network') || error.message.includes('timeout')) {
      errorMessage = `❌ *ғᴀɪʟᴇᴅ ᴛᴏ sʜᴏʀᴛᴇɴ ᴜʀʟ:* ${error.message}\n` +
                     `💡 *ᴘʟᴇᴀsᴇ ᴛʀʏ ᴀɢᴀɪɴ ʟᴀᴛᴇʀ, sᴡᴇᴇᴛɪᴇ.*`;
    }
    await socket.sendMessage(sender, { text: errorMessage }, { quoted: msg });
  }
  break;
}

// case 39: weather
                case 'weather': {
  try {
    await socket.sendMessage(sender, { react: { text: '🌦️', key: msg.key } });

    if (!q || q.trim() === '') {
      await socket.sendMessage(sender, {
        text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}weather <ᴄɪᴛʏ>\n` +
              `*ᴇxᴀᴍᴘʟᴇ:* ${config.PREFIX}ᴡᴇᴀᴛʜᴇʀ ʜᴀɪᴛɪ`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, {
      text: `⏳ *ғᴇᴛᴄʜɪɴɢ ᴡᴇᴀᴛʜᴇʀ ᴅᴀᴛᴀ...*`
    }, { quoted: msg });

    const apiKey = '2d61a72574c11c4f36173b627f8cb177';
    const city = args.join(' ').trim();
    const url = `http://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`;

    const response = await axios.get(url, { timeout: 5000 });
    const data = response.data;

    const weatherMessage = `
🌍 *ᴡᴇᴀᴛʜᴇʀ ɪɴғᴏ ғᴏʀ* ${data.name}, ${data.sys.country}
🌡️ *ᴛᴇᴍᴘᴇʀᴀᴛᴜʀᴇ:* ${data.main.temp}°C
🌡️ *ғᴇᴇʟs ʟɪᴋᴇ:* ${data.main.feels_like}°C
🌡️ *ᴍɪɴ ᴛᴇᴍᴘ:* ${data.main.temp_min}°C
🌡️ *ᴍᴀx ᴛᴇᴍᴘ:* ${data.main.temp_max}°C
💧 *ʜᴜᴍɪᴅɪᴛʏ:* ${data.main.humidity}%
☁️ *ᴡᴇᴀᴛʜᴇʀ:* ${data.weather[0].main}
🌫️ *ᴅᴇsᴄʀɪᴘᴛɪᴏɴ:* ${data.weather[0].description}
💨 *ᴡɪɴᴅ sᴘᴇᴇᴅ:* ${data.wind.speed} m/s
🔽 *ᴘʀᴇssᴜʀᴇ:* ${data.main.pressure} hPa
    `;

    await socket.sendMessage(sender, {
      text: `🌤 *ᴡᴇᴀᴛʜᴇʀ ʀᴇᴘᴏʀᴛ* 🌤\n\n${weatherMessage}\n\n> ᴍᴀᴅᴇ ʙʏ Courtney 🦅`
    }, { quoted: msg });

  } catch (error) {
    console.error('Weather command error:', error.message);
    let errorMessage = `❌ *ᴏʜ, ʟᴏᴠᴇ, ᴄᴏᴜʟᴅɴ'ᴛ ғᴇᴛᴄʜ ᴛʜᴇ ᴡᴇᴀᴛʜᴇʀ! 😢*\n` +
                      `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`;
    if (error.message.includes('404')) {
      errorMessage = `🚫 *ᴄɪᴛʏ ɴᴏᴛ ғᴏᴜɴᴅ, sᴡᴇᴇᴛɪᴇ.*\n` +
                     `💡 *ᴘʟᴇᴀsᴇ ᴄʜᴇᴄᴋ ᴛʜᴇ sᴘᴇʟʟɪɴɢ ᴀɴᴅ ᴛʀʏ ᴀɢᴀɪɴ.*`;
    } else if (error.message.includes('network') || error.message.includes('timeout')) {
      errorMessage = `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ғᴇᴛᴄʜ ᴡᴇᴀᴛʜᴇʀ:* ${error.message}\n` +
                     `💡 *ᴘʟᴇᴀsᴇ ᴛʀʏ ᴀɢᴀɪɴ ʟᴀᴛᴇʀ, ʙᴀʙᴇ.*`;
    }
    await socket.sendMessage(sender, { text: errorMessage }, { quoted: msg });
  }
  break;
}

case 'savestatus': {
  try {
    await socket.sendMessage(sender, { react: { text: '💾', key: msg.key } });

    if (!msg.quoted || !msg.quoted.statusMessage) {
      await socket.sendMessage(sender, {
        text: `📌 *ʀᴇᴘʟʏ ᴛᴏ ᴀ sᴛᴀᴛᴜs ᴛᴏ sᴀᴠᴇ ɪᴛ, ᴅᴀʀʟɪɴɢ!* 😘`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, {
      text: `⏳ *sᴀᴠɪɴɢ sᴛᴀᴛᴜs, sᴡᴇᴇᴛɪᴇ...* 😘`
    }, { quoted: msg });

    const media = await downloadMediaMessage(msg.quoted);
    const fileExt = msg.quoted.imageMessage ? 'jpg' : 'mp4';
    const filePath = `./status_${Date.now()}.${fileExt}`;
    fs.writeFileSync(filePath, media);

    await socket.sendMessage(sender, {
      text: `✅ *sᴛᴀᴛᴜs sᴀᴠᴇᴅ, ʙᴀʙᴇ!* 😘\n` +
            `📁 *ғɪʟᴇ:* status_${Date.now()}.${fileExt}\n` +
            `> © ᴍᴀᴅᴇ ɪɴ ʙʏ Courtney 🦅`,
      document: { url: filePath },
      mimetype: msg.quoted.imageMessage ? 'image/jpeg' : 'video/mp4',
      fileName: `status_${Date.now()}.${fileExt}`
    }, { quoted: msg });

  } catch (error) {
    console.error('Savestatus command error:', error.message);
    await socket.sendMessage(sender, {
      text: `❌ *ᴏʜ, ʟᴏᴠᴇ, ᴄᴏᴜʟᴅɴ'ᴛ sᴀᴠᴇ ᴛʜᴀᴛ sᴛᴀᴛᴜs! 😢*\n` +
            `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`
    }, { quoted: msg });
  }
  break;
}

case 'sticker':
case 's': {
    await socket.sendMessage(sender, { react: { text: '✨', key: msg.key } });

    try {
        let quoted = msg.quoted ? msg.quoted : msg;
        let mime = (quoted.msg || quoted).mimetype || '';

        if (!mime) {
            return socket.sendMessage(from, { text: '⚠️ ʀᴇᴘʟʏ ᴡɪᴛʜ ᴀɴ ɪᴍᴀɢᴇ/ᴠɪᴅᴇᴏ ᴛᴏ ᴍᴀᴋᴇ ᴀ sᴛɪᴄᴋᴇʀ!' }, { quoted: msg });
        }

        if (/image|video/.test(mime)) {
            let media = await quoted.download();
            await socket.sendMessage(from, { 
                sticker: media 
            }, { quoted: msg });
        } else {
            await socket.sendMessage(from, { text: '❌ ᴏɴʟʏ ɪᴍᴀɢᴇ ᴏʀ ᴠɪᴅᴇᴏ ᴀʟʟᴏᴡᴇᴅ ᴛᴏ ᴄʀᴇᴀᴛᴇ sᴛɪᴄᴋᴇʀ!' }, { quoted: msg });
        }
    } catch (error) {
        console.error('Error in .sticker command:', error);
        await socket.sendMessage(from, { text: '💔 ғᴀɪʟᴇᴅ ᴛᴏ ᴄʀᴇᴀᴛᴇ sᴛɪᴄᴋᴇʀ. ᴛʀʏ ᴀɢᴀɪɴ!' }, { quoted: msg });
    }
    break;
}

case 'url': {
  let _urlTmp = null;
  try {
    await socket.sendMessage(sender, { react: { text: '📤', key: msg.key } });

    // Must reply to a media message
    const quoted = msg.quoted;
    if (!quoted || !quoted.type) {
      await socket.sendMessage(sender, {
        text: `❌ *Reply to an image, video, audio or document to get its URL.*`
      }, { quoted: msg });
      break;
    }

    // Get mime from serialized quoted.msg (set by sms() in msg.js)
    const _mimeMap = {
      imageMessage: 'image/jpeg',
      videoMessage: 'video/mp4',
      audioMessage: 'audio/mpeg',
      documentMessage: 'application/octet-stream',
      stickerMessage: 'image/webp'
    };
    const mime = quoted.msg?.mimetype || _mimeMap[quoted.type] || '';

    if (!mime) {
      await socket.sendMessage(sender, {
        text: `❌ *Reply to an image, video, audio or document.*`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, { text: `⏳ *ᴜᴘʟᴏᴀᴅɪɴɢ...*` }, { quoted: msg });

    // downloadMediaMessage from msg.js needs { type, msg } shape — quoted already has that
    const buffer = await downloadMediaMessage(quoted);
    if (!buffer || buffer.length === 0) throw new Error('Empty buffer — could not download media');

    const ext = mime.includes('jpeg') || mime.includes('jpg') ? '.jpg' :
                mime.includes('png') ? '.png' :
                mime.includes('gif') ? '.gif' :
                mime.includes('webp') ? '.webp' :
                mime.includes('video') ? '.mp4' :
                mime.includes('audio') ? '.mp3' : '.bin';

    const _fname = `url_${Date.now()}${ext}`;
    _urlTmp = path.join(os.tmpdir(), _fname);
    fs.writeFileSync(_urlTmp, buffer);

    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', fs.createReadStream(_urlTmp), _fname);

    const res = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders(),
      timeout: 40000
    });

    if (_urlTmp && fs.existsSync(_urlTmp)) fs.unlinkSync(_urlTmp);

    const uploadedUrl = (res.data || '').trim();
    if (!uploadedUrl || uploadedUrl.toLowerCase().includes('error')) {
      throw new Error(`Catbox upload failed: ${uploadedUrl || 'no response'}`);
    }

    const typeLabel = mime.includes('image') ? '🖼️ ɪᴍᴀɢᴇ' :
                      mime.includes('video') ? '🎥 ᴠɪᴅᴇᴏ' :
                      mime.includes('audio') ? '🎵 ᴀᴜᴅɪᴏ' :
                      mime.includes('webp')  ? '🎭 sᴛɪᴄᴋᴇʀ' : '📄 ᴅᴏᴄᴜᴍᴇɴᴛ';

    await socket.sendMessage(sender, {
      text: `✅ *${typeLabel} ᴜᴘʟᴏᴀᴅᴇᴅ!*\n\n` +
            `📁 *sɪᴢᴇ:* ${formatBytes(buffer.length)}\n` +
            `🔗 *ᴜʀʟ:* ${uploadedUrl}\n\n` +
            `© Courtney 🦅`
    }, { quoted: msg });
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

  } catch (error) {
    if (_urlTmp && fs.existsSync(_urlTmp)) { try { fs.unlinkSync(_urlTmp); } catch (_) {} }
    console.error('url command error:', error.message);
    await socket.sendMessage(sender, {
      text: `❌ *ᴄᴏᴜʟᴅɴ'ᴛ ᴜᴘʟᴏᴀᴅ ᴛʜᴀᴛ ғɪʟᴇ*\n` +
            `ᴇʀʀᴏʀ: ${error.message}`
    }, { quoted: msg });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
  }
  break;
}
case 'tourl2': {
  try {
    await socket.sendMessage(sender, { react: { text: '📤', key: msg.key || {} } });

    console.log('Message:', JSON.stringify(msg, null, 2));
    const quoted = msg.quoted || msg;
    console.log('Quoted:', JSON.stringify(quoted, null, 2));
    const mime = quoted.mimetype || (quoted.message ? Object.keys(quoted.message)[0] : '');

    console.log('MIME Type or Message Type:', mime);

    // Map message types to MIME types if mimetype is unavailable
    const mimeMap = {
      imageMessage: 'image/jpeg',
      videoMessage: 'video/mp4',
      audioMessage: 'audio/mp3'
    };
    const effectiveMime = mimeMap[mime] || mime;

    if (!effectiveMime || !['image', 'video', 'audio'].some(type => effectiveMime.includes(type))) {
      await socket.sendMessage(sender, {
        text: `❌ *ʀᴇᴘʟʏ ᴛᴏ ɪᴍᴀɢᴇ, ᴀᴜᴅɪᴏ, ᴏʀ ᴠɪᴅᴇᴏ!*\n` +
              `ᴅᴇᴛᴇᴄᴛᴇᴅ ᴛʏᴘᴇ: ${effectiveMime || 'none'}`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, {
      text: `⏳ *ᴜᴘʟᴏᴀᴅɪɴɢ ғɪʟᴇ...*`
    }, { quoted: msg });

    const buffer = await downloadMediaMessage(quoted);
    if (!buffer || buffer.length === 0) {
      throw new Error('Failed to download media: Empty buffer');
    }

    const ext = effectiveMime.includes('image/jpeg') ? '.jpg' :
                effectiveMime.includes('image/png') ? '.png' :
                effectiveMime.includes('video') ? '.mp4' :
                effectiveMime.includes('audio') ? '.mp3' : '.bin';
    const name = `file_${Date.now()}${ext}`;
    const tmp = path.join(os.tmpdir(), `catbox_${Date.now()}${ext}`);
    fs.writeFileSync(tmp, buffer);
    console.log('Saved file to:', tmp);

    const form = new FormData();
    form.append('fileToUpload', fs.createReadStream(tmp), name);
    form.append('reqtype', 'fileupload');

    const res = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders()
    });

    fs.unlinkSync(tmp);

    if (!res.data || res.data.includes('error')) {
      throw new Error(`Upload failed: ${res.data || 'No response data'}`);
    }

    const type = effectiveMime.includes('image') ? 'ɪᴍᴀɢᴇ' :
                 effectiveMime.includes('video') ? 'ᴠɪᴅᴇᴏ' :
                 effectiveMime.includes('audio') ? 'ᴀᴜᴅɪᴏ' : 'ғɪʟᴇ';

    await socket.sendMessage(sender, {
      text: `✅ *${type} ᴜᴘʟᴏᴀᴅᴇᴅ!*\n\n` +
            `📁 *sɪᴢᴇ:* ${formatBytes(buffer.length)}\n` +
            `🔗 *ᴜʀʟ:* ${res.data}\n\n` +
            `© ᴍᴀᴅᴇ ɪɴ ʙʏ Courtney 🦅`
    }, { quoted: msg });

    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key || {} } });
  } catch (error) {
    console.error('tourl2 error:', error.message, error.stack);
    await socket.sendMessage(sender, {
      text: `❌ *ᴏʜ, ʟᴏᴠᴇ, ᴄᴏᴜʟᴅɴ'ᴛ ᴜᴘʟᴏᴀᴅ ᴛʜᴀᴛ ғɪʟᴇ! 😢*\n` +
            `ᴇʀʀᴏʀ: ${error.message || 'sᴏᴍᴇᴛʜɪɴɢ ᴡᴇɴᴛ ᴡʀᴏɴɢ'}\n` +
            `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`
    }, { quoted: msg });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key || {} } });
  }
  break;
}
    
    case 'whois': {
        try {
            await socket.sendMessage(sender, { react: { text: '👤', key: msg.key } });
            const domain = args[0];
            if (!domain) {
                await socket.sendMessage(sender, { text: '📌 ᴜsᴀɢᴇ: .whois <domain>' }, { quoted: fakevCard });
                break;
            }
            const response = await fetch(`http://api.whois.vu/?whois=${encodeURIComponent(domain)}`);
            const data = await response.json();
            if (!data.domain) {
                throw new Error('Domain not found');
            }
            const whoisMessage = formatMessage(
                '🔍 𝐖𝐇𝐎𝐈𝐒 𝐋𝐎𝐎𝐊𝐔𝐏',
                `🌐 ᴅᴏᴍᴀɪɴ: ${data.domain}\n` +
                `📅 ʀᴇɢɪsᴛᴇʀᴇᴅ: ${data.created_date || 'N/A'}\n` +
                `⏰ ᴇxᴘɪʀᴇs: ${data.expiry_date || 'N/A'}\n` +
                `📋 ʀᴇɢɪsᴛʀᴀʀ: ${data.registrar || 'N/A'}\n` +
                `📍 sᴛᴀᴛᴜs: ${data.status.join(', ') || 'N/A'}`,
                'ᴍᴀᴅᴇ ʙʏ Courtney 🦅'
            );
            await socket.sendMessage(sender, { text: whoisMessage }, { quoted: fakevCard });
        } catch (error) {
            console.error('Whois command error:', error);
            await socket.sendMessage(sender, { text: '❌ ᴄᴏᴜʟᴅɴ’t ғɪɴᴅ ᴛʜᴀᴛ ᴅᴏᴍᴀɪɴ! 😢 ᴛʀʏ ᴀɢᴀɪɴ?' }, { quoted: fakevCard });
        }
        break;
    }
      
      case 'repo':
case 'sc':
case 'script': {
    try {
        await socket.sendMessage(sender, { react: { text: '🪄', key: msg.key } });
        const githubRepoURL = 'https://github.com/Courtney250/TRUTH-MD';
        
        const [, username, repo] = githubRepoURL.match(/github\.com\/([^/]+)\/([^/]+)/);
        const response = await fetch(`https://api.github.com/repos/${username}/${repo}`);
        
        if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
        
        const repoData = await response.json();

        const formattedInfo = `
    𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪
╭───────────────⭓
│ ɴᴀᴍᴇ: ${repoData.name}
│ sᴛᴀʀs: ${repoData.stargazers_count}
│ ғᴏʀᴋs: ${repoData.forks_count}
│ ᴏᴡɴᴇʀ: Courtney 🦅
│ ʀᴇᴘᴏ: https://github.com/Courtney250/TRUTH-MD
│ ᴅᴇsᴄ: ${repoData.description || 'ɴ/ᴀ'}
╰───────────────⭓
> Courtney 🦅
`;

        await socket.sendMessage(sender, {
            image: { url: 'https://files.catbox.moe/8np6rc.jpg' },
            caption: formattedInfo + `\n🌐 ${config.PREFIX}repo-visit  |  👑 ${config.PREFIX}repo-owner`,
            contextInfo: {
                mentionedJid: [m.sender],
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: config.NEWSLETTER_JID || '120363409714698622@newsletter',
                    newsletterName: '𝐓𝐑𝐔𝐓𝐇𝐗',
                    serverMessageId: 143
                }
            }
        }, { quoted: fakevCard });

    } catch (error) {
        console.error("❌ Error in repo command:", error);
        await socket.sendMessage(sender, { 
            text: "⚠️ Failed to fetch repo info. Please try again later." 
        }, { quoted: fakevCard });
    }
    break;
}

case 'repo-visit': {
    await socket.sendMessage(sender, { react: { text: '🌐', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `🌐 *ᴄʟɪᴄᴋ ᴛᴏ ᴠɪsɪᴛ ᴛʜᴇ ʀᴇᴘᴏ:*\nhttps://github.com/Courtney250/TRUTH-MD`,
        contextInfo: {
            externalAdReply: {
                title: 'Visit Repository',
                body: 'Open in browser',
                mediaType: 1,
                mediaUrl: 'https://github.com/Courtney250/TRUTH-MD',
                sourceUrl: 'https://github.com/Courtney250/TRUTH-MD'
            }
        }
    }, { quoted: fakevCard });
    break;
}

case 'repo-owner': {
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `👑 *Click to visit the owner profile:*\nhttps://github.com/Courtney250`,
        contextInfo: {
            externalAdReply: {
                title: 'Owner Profile',
                body: 'Open in browser',
                mediaType: 1,
                mediaUrl: 'https://github.com/Courtney250/TRUTH-MD',
                sourceUrl: 'https://github.com/Courtney250/TRUTH-MD'
            }
        }
    }, { quoted: fakevCard });
    break;
}

case 'fork':
case 'github':
case 'git': {
    try {
        await socket.sendMessage(sender, { react: { text: '🍴', key: msg.key } });
        const _REPO_URL = 'https://github.com/Courtney250/TRUTH-MD';
        const _res = await fetch('https://api.github.com/repos/Courtney250/TRUTH-MD');
        if (!_res.ok) throw new Error(`GitHub API: ${_res.status}`);
        const _d = await _res.json();

        // Format last-pushed date → DD/MM/YY - HH:MM:SS
        const _pushed = new Date(_d.pushed_at);
        const _pp = n => String(n).padStart(2, '0');
        const _dateStr = `${_pp(_pushed.getDate())}/${_pp(_pushed.getMonth() + 1)}/${String(_pushed.getFullYear()).slice(2)} - ${_pp(_pushed.getHours())}:${_pp(_pushed.getMinutes())}:${_pp(_pushed.getSeconds())}`;

        // Format size: KB or MB
        const _size = _d.size >= 1024 ? `${(_d.size / 1024).toFixed(1)} MB` : `${_d.size} KB`;

        const _caption =
`🔹  \`𝙱𝙾𝚃 𝚁𝙴𝙿𝙾 𝙸𝙽𝙵𝙾.\`

🔸  *Name* : ${_d.name}
🔸  *Watchers* : ${_d.watchers_count}
🔸  *Size* : ${_size}
🔸  *Last Updated* : ${_dateStr}
🔸  *REPO* : ${_REPO_URL}

🔹  *Forks* : ${_d.forks_count}
🔹  *Stars* : ${_d.stargazers_count}
🔹  *Desc* : ${_d.description || '𝑻𝒉𝒊𝒔 𝒊𝒔 𝒕𝒉𝒆 𝑻𝑹𝑼𝑻𝑯 𝑴𝑫 𝒐𝒇𝒇𝒊𝒄𝒊𝒂𝒍 𝒓𝒆𝒔𝒑𝒊𝒓𝒂𝒕𝒐𝒓𝒚 𝒔𝒕𝒂𝒓 ✨⭐ 𝒂𝒏𝒅 𝒇𝒐𝒓𝒌 🍽️ 𝒕𝒉𝒆 𝒓𝒆𝒑𝒐'}

@Courtney 🦅 Don't forget to fork and star my repo`;

        await socket.sendMessage(sender, {
            image: fs.readFileSync(path.join(__dirname, 'fork_banner.jpg')),
            caption: _caption,
            contextInfo: {
                mentionedJid: [m.sender],
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: config.NEWSLETTER_JID || '120363409714698622@newsletter',
                    newsletterName: '𝐓𝐑𝐔𝐓𝐇𝐗',
                    serverMessageId: 143
                }
            }
        }, { quoted: fakevCard });

    } catch (_err) {
        console.error('❌ fork command error:', _err.message);
        await socket.sendMessage(sender, {
            text: `⚠️ Could not fetch repo info. Visit directly:\nhttps://github.com/Courtney250/TRUTH-MD`
        }, { quoted: fakevCard });
    }
    break;
}

case 'chjid':
case 'channeljid':
case 'newsjid': {
    await socket.sendMessage(sender, { react: { text: '📡', key: msg.key } });

    // 1. JID from a forwarded channel message (replied-to or current)
    const _fwdInfo =
        msg.message?.extendedTextMessage?.contextInfo?.forwardedNewsletterMessageInfo ||
        msg.message?.imageMessage?.contextInfo?.forwardedNewsletterMessageInfo ||
        msg.message?.videoMessage?.contextInfo?.forwardedNewsletterMessageInfo ||
        msg.message?.documentMessage?.contextInfo?.forwardedNewsletterMessageInfo ||
        null;

    // 2. Current chat is itself a channel
    const _isChannel = from.endsWith('@newsletter');

    let _lines = [];

    if (_isChannel) {
        _lines.push(`📡 *Channel JID (current chat):*\n\`${from}\``);
    }
    if (_fwdInfo?.newsletterJid) {
        _lines.push(`📨 *Forwarded from Channel JID:*\n\`${_fwdInfo.newsletterJid}\``);
        if (_fwdInfo.newsletterName) _lines.push(`📛 *Name:* ${_fwdInfo.newsletterName}`);
    }
    if (!_isChannel && !_fwdInfo?.newsletterJid) {
        _lines.push(`ℹ️ *Current chat JID:*\n\`${from}\`\n\n_To get a channel JID, either use this command inside the channel or reply to a forwarded channel message._`);
    }

    await socket.sendMessage(sender, {
        text: _lines.join('\n\n'),
        contextInfo: { mentionedJid: [m.sender] }
    }, { quoted: fakevCard });
    break;
}

                case 'deleteme':
                    const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                    if (fs.existsSync(sessionPath)) {
                        fs.removeSync(sessionPath);
                    }
                    await deleteSessionFromGitHub(number);
                    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                        activeSockets.delete(number.replace(/[^0-9]/g, ''));
                        socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                    }
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been successfully deleted.',
                            'Courtney 🦅'
                        )
                    });
                    break;
                    
// ─── RESTART / UPDATE ───────────────────────────────────────
case 'restart': {
    if (!isOwner && !isSudo(senderNumber)) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    await socket.sendMessage(sender, { react: { text: '🔄', key: msg.key } });
    await socket.sendMessage(sender, { image: { url: config.RCD_IMAGE_PATH }, caption: formatMessage('🔄 RESTARTING', 'Bot will be back online shortly...', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    setTimeout(() => process.exit(0), 1500);
    break;
}
case 'update': {
    if (!isOwner && !isSudo(senderNumber)) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
    await socket.sendMessage(sender, { text: '⏳ Pulling latest code from GitHub...' });
    try {
        const updated = await pullLatestFromGitHub();
        await socket.sendMessage(sender, { image: { url: config.RCD_IMAGE_PATH }, caption: formatMessage('✅ UPDATE COMPLETE', `Updated: ${updated.join(', ')}\n\nRestarting now...`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
        setTimeout(() => process.exit(0), 2000);
    } catch (err) { await socket.sendMessage(sender, { text: `❌ Update failed: ${err.message}` }); }
    break;
}
// ─── BLOCK / UNBLOCK / BLOCKLIST ─────────────────────────────
case 'block': {
    if (!isOwner && !isSudo(senderNumber)) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const blkT = msg.message?.extendedTextMessage?.contextInfo?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
    if (!blkT) { await socket.sendMessage(sender, { text: `Usage: ${prefix}block @user or reply to a message` }); break; }
    await socket.updateBlockStatus(blkT, 'block');
    await socket.sendMessage(sender, { text: formatMessage('🚫 BLOCKED', `@${blkT.split('@')[0]} has been blocked.`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'), mentions: [blkT] });
    break;
}
case 'unblock': {
    if (!isOwner && !isSudo(senderNumber)) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const ublkT = msg.message?.extendedTextMessage?.contextInfo?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
    if (!ublkT) { await socket.sendMessage(sender, { text: `Usage: ${prefix}unblock @user or reply` }); break; }
    await socket.updateBlockStatus(ublkT, 'unblock');
    await socket.sendMessage(sender, { text: formatMessage('✅ UNBLOCKED', `@${ublkT.split('@')[0]} has been unblocked.`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'), mentions: [ublkT] });
    break;
}
case 'blocklist': {
    if (!isOwner && !isSudo(senderNumber)) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const blist = await socket.fetchBlocklist();
    if (!blist.length) { await socket.sendMessage(sender, { text: '✅ Your blocklist is empty.' }); break; }
    await socket.sendMessage(sender, { text: formatMessage(`🚫 BLOCKLIST (${blist.length})`, blist.map((n, i) => `${i + 1}. +${n.split('@')[0]}`).join('\n'), '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
// ─── GROUP: BAN / UNBAN / LEAVE ──────────────────────────────
case 'ban': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; }
    const banT = msg.message?.extendedTextMessage?.contextInfo?.participant || msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
    if (!banT) { await socket.sendMessage(sender, { text: `Reply to a message or mention user.\nUsage: ${prefix}ban @user` }); break; }
    await socket.groupParticipantsUpdate(from, [banT], 'remove');
    await socket.sendMessage(from, { text: formatMessage('🚫 BANNED', `@${banT.split('@')[0]} removed from group.`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'), mentions: [banT] });
    break;
}
case 'unban': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; }
    const unbanN = args[0]?.replace(/[^0-9]/g, '');
    if (!unbanN) { await socket.sendMessage(sender, { text: `Usage: ${prefix}unban <number>` }); break; }
    await socket.groupParticipantsUpdate(from, [unbanN + '@s.whatsapp.net'], 'add');
    await socket.sendMessage(from, { text: formatMessage('✅ UNBANNED', `+${unbanN} added back to group.`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'leave': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    if (!isOwner && !isSudo(senderNumber)) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    await socket.sendMessage(from, { text: '👋 Goodbye everyone! Bot is leaving.' });
    await socket.groupLeave(from);
    break;
}
// ─── DELETE ──────────────────────────────────────────────────
case 'delete':
case 'del': {
    const delCtx = msg.message?.extendedTextMessage?.contextInfo;
    if (!delCtx?.stanzaId) { await socket.sendMessage(sender, { text: `Reply to a message to delete it.\nUsage: Reply + ${prefix}del` }); break; }
    await socket.sendMessage(from, { delete: { remoteJid: from, id: delCtx.stanzaId, participant: delCtx.participant, fromMe: delCtx.participant === (socket.user.id.split(':')[0] + '@s.whatsapp.net') } });
    await socket.sendMessage(sender, { react: { text: '🗑️', key: msg.key } });
    break;
}
// ─── PREFIX / SETTINGS ───────────────────────────────────────
case 'getprefix': {
    await socket.sendMessage(sender, { text: formatMessage('⚙️ PREFIX', `Current prefix: *${config.PREFIX}*\nChange: ${config.PREFIX}setprefix <char>`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'setprefix': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const npfx = args[0];
    if (!npfx || npfx.length > 3) { await socket.sendMessage(sender, { text: `Usage: ${prefix}setprefix <1-3 chars>` }); break; }
    config.PREFIX = npfx;
    await socket.sendMessage(sender, { text: formatMessage('✅ PREFIX SET', `Prefix is now: *${npfx}*`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'setownernumber': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const newOn = args[0]?.replace(/[^0-9]/g, '');
    if (!newOn) { await socket.sendMessage(sender, { text: `Usage: ${prefix}setownernumber <number>` }); break; }
    config.OWNER_NUMBER = newOn;
    await socket.sendMessage(sender, { text: formatMessage('✅ OWNER SET', `Owner number: *${newOn}*`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'setbotname': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const newBN = args.join(' ');
    if (!newBN) { await socket.sendMessage(sender, { text: `Usage: ${prefix}setbotname <name>` }); break; }
    await socket.updateProfileName(newBN);
    await socket.sendMessage(sender, { text: formatMessage('✅ BOT NAME SET', `Bot name: *${newBN}*`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'setownername': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const owN = args.join(' ');
    if (!owN) { await socket.sendMessage(sender, { text: `Usage: ${prefix}setownername <name>` }); break; }
    setSetting(number, 'ownerName', owN);
    await socket.sendMessage(sender, { text: formatMessage('✅ OWNER NAME SET', `Owner name: *${owN}*`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'setwatermark': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const wmT = args.join(' ');
    if (!wmT) { await socket.sendMessage(sender, { text: `Usage: ${prefix}setwatermark <text>` }); break; }
    config.BOT_FOOTER = wmT;
    await socket.sendMessage(sender, { text: formatMessage('✅ WATERMARK SET', wmT, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'mode': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const mArg = args[0]?.toLowerCase();
    if (mArg !== 'public' && mArg !== 'private') { await socket.sendMessage(sender, { text: formatMessage('⚙️ MODE', `Current: *${getSetting(number, 'mode', 'public')}*\nUse: ${prefix}mode public OR ${prefix}mode private`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
    setSetting(number, 'mode', mArg);
    await socket.sendMessage(sender, { text: formatMessage('✅ MODE', mArg === 'public' ? '🌍 Bot is now PUBLIC — responds to everyone' : '🔒 Bot is now PRIVATE — owner/sudo only', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'settings':
case 'getsettings': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const cs = loadJson(SETTINGS_PATH)[number] || {};
    const stTxt = ['mode','autoread','anticall','autoreact','autotyping','alwaysonline','autorecording','antidelete','pmblock','autobio','chatbot','antibug','autoblock'].map(k => `• *${k}:* ${cs[k] === 'true' ? '✅' : cs[k] === 'false' ? '❌' : cs[k] || '❌'}`).join('\n');
    await socket.sendMessage(sender, { text: formatMessage('⚙️ BOT SETTINGS', stTxt, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
// ─── GROUP INFO / ADMINS / JID / LINK ────────────────────────
case 'welcome': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; }
    const wTxt = args.join(' ');
    const wDb = loadJson(WELCOME_DB_PATH);
    if (!wTxt) { await socket.sendMessage(sender, { text: formatMessage('👋 WELCOME', (wDb[from] ? `Current: ${wDb[from].welcome}\nStatus: ${wDb[from].enabled ? 'ON' : 'OFF'}` : 'Not set.') + `\n\nSet: ${prefix}welcome on/off or custom text`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
    if (!wDb[from]) wDb[from] = { welcome: 'Welcome @user! 🎉', goodbye: 'Goodbye @user! 👋', enabled: false, goodbyeEnabled: false };
    if (wTxt === 'on') wDb[from].enabled = true;
    else if (wTxt === 'off') wDb[from].enabled = false;
    else { wDb[from].welcome = wTxt; wDb[from].enabled = true; }
    saveJson(WELCOME_DB_PATH, wDb);
    await socket.sendMessage(from, { text: formatMessage('✅ WELCOME', wTxt === 'on' ? 'Welcome messages enabled!' : wTxt === 'off' ? 'Welcome messages disabled.' : `Welcome set to: ${wTxt}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'goodbye': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; }
    const gbTxt = args.join(' ');
    const gbDb = loadJson(WELCOME_DB_PATH);
    if (!gbDb[from]) gbDb[from] = { welcome: 'Welcome @user! 🎉', goodbye: 'Goodbye @user! 👋', enabled: false, goodbyeEnabled: false };
    if (gbTxt === 'on') gbDb[from].goodbyeEnabled = true;
    else if (gbTxt === 'off') gbDb[from].goodbyeEnabled = false;
    else { gbDb[from].goodbye = gbTxt; gbDb[from].goodbyeEnabled = true; }
    saveJson(WELCOME_DB_PATH, gbDb);
    await socket.sendMessage(from, { text: formatMessage('✅ GOODBYE', gbTxt === 'on' ? 'Goodbye enabled!' : gbTxt === 'off' ? 'Goodbye disabled.' : `Goodbye set to: ${gbTxt}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'groupinfo': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    const gMeta = await socket.groupMetadata(from);
    await socket.sendMessage(from, { text: formatMessage('ℹ️ GROUP INFO', `📌 *Name:* ${gMeta.subject}\n👥 *Members:* ${gMeta.participants.length}\n👑 *Admins:* ${gMeta.participants.filter(p => p.admin).length}\n📅 *Created:* ${new Date(gMeta.creation * 1000).toLocaleDateString()}\n🆔 *JID:* ${from}\n📝 *Desc:* ${gMeta.desc || 'None'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
case 'admins':
case 'listadmin': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    const aMeta = await socket.groupMetadata(from);
    const aList = aMeta.participants.filter(p => p.admin);
    await socket.sendMessage(from, { text: formatMessage(`👑 ADMINS (${aList.length})`, aList.map(p => `• @${p.id.split('@')[0]}`).join('\n') || 'None', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'), mentions: aList.map(p => p.id) }, { quoted: fakevCard });
    break;
}
case 'jid': {
    await socket.sendMessage(sender, { text: formatMessage('🆔 JID', `Chat: \`${from}\`\nYours: \`${nowsender}\``, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'link': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    const lkCode = await socket.groupInviteCode(from);
    await socket.sendMessage(sender, { text: formatMessage('🔗 GROUP LINK', `https://chat.whatsapp.com/${lkCode}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
case 'revoke':
case 'resetlink': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; }
    await socket.groupRevokeInvite(from);
    const newLk = await socket.groupInviteCode(from);
    await socket.sendMessage(from, { text: formatMessage('🔄 LINK REVOKED', `New link:\nhttps://chat.whatsapp.com/${newLk}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
case 'creategroup': {
    if (!isOwner && !isSudo(senderNumber)) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const cgN = args.join(' ');
    if (!cgN) { await socket.sendMessage(sender, { text: `Usage: ${prefix}creategroup <name>` }); break; }
    const ng = await socket.groupCreate(cgN, [sender]);
    await socket.sendMessage(sender, { text: formatMessage('✅ GROUP CREATED', `Name: *${cgN}*\nJID: ${ng.id}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
// ─── TAG VARIANTS ─────────────────────────────────────────────
case 'mention': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    const menJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (!menJids.length) { await socket.sendMessage(sender, { text: `Mention someone: ${prefix}mention @user <message>` }); break; }
    await socket.sendMessage(from, { text: `${args.join(' ') || '👋'}\n${menJids.map(j => `@${j.split('@')[0]}`).join(' ')}`, mentions: menJids }, { quoted: fakevCard });
    break;
}
case 'tag': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    const tgM = await socket.groupMetadata(from);
    const tgAll = tgM.participants.map(p => p.id);
    await socket.sendMessage(from, { text: `${args.join(' ') || '📢'}\n${tgAll.map(j => `@${j.split('@')[0]}`).join(' ')}`, mentions: tgAll }, { quoted: fakevCard });
    break;
}
case 'tagnoadmin': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; }
    const tnaM = await socket.groupMetadata(from);
    const tnaNA = tnaM.participants.filter(p => !p.admin);
    await socket.sendMessage(from, { text: `${args.join(' ') || '📢'}\n${tnaNA.map(p => `@${p.id.split('@')[0]}`).join(' ')}`, mentions: tnaNA.map(p => p.id) }, { quoted: fakevCard });
    break;
}
case 'tagadmin': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    const taM = await socket.groupMetadata(from);
    const taAds = taM.participants.filter(p => p.admin);
    await socket.sendMessage(from, { text: `${args.join(' ') || '📢'}\n${taAds.map(p => `@${p.id.split('@')[0]}`).join(' ')}`, mentions: taAds.map(p => p.id) }, { quoted: fakevCard });
    break;
}
// ─── TOGGLE SETTINGS ─────────────────────────────────────────
case 'antilink': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; }
    const alDb = loadJson(ANTILINK_DB_PATH); alDb[from] = !alDb[from]; saveJson(ANTILINK_DB_PATH, alDb);
    await socket.sendMessage(from, { text: formatMessage('🔗 ANTILINK', `Anti-link: ${alDb[from] ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'antibadword': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; }
    const abwC = getSetting(from, 'antibadword', 'false'); setSetting(from, 'antibadword', abwC === 'true' ? 'false' : 'true');
    await socket.sendMessage(from, { text: formatMessage('🤬 ANTI-BAD WORD', `Filter: ${abwC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'anticall': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const acC = getSetting(number, 'anticall', 'false'); setSetting(number, 'anticall', acC === 'true' ? 'false' : 'true');
    await socket.sendMessage(sender, { text: formatMessage('📵 ANTI-CALL', `Anti-call: ${acC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'autoread': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const arC = getSetting(number, 'autoread', 'false'); setSetting(number, 'autoread', arC === 'true' ? 'false' : 'true');
    await socket.sendMessage(sender, { text: formatMessage('👁️ AUTO-READ', `Auto-read: ${arC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'autoreact': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const aurC = getSetting(number, 'autoreact', 'false'); setSetting(number, 'autoreact', aurC === 'true' ? 'false' : 'true');
    await socket.sendMessage(sender, { text: formatMessage('💬 AUTO-REACT', `Auto-react: ${aurC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'autotyping': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const atC = getSetting(number, 'autotyping', 'false'); setSetting(number, 'autotyping', atC === 'true' ? 'false' : 'true');
    await socket.sendMessage(sender, { text: formatMessage('⌨️ AUTO-TYPING', `Auto-typing: ${atC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'alwaysonline': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const aoC = getSetting(number, 'alwaysonline', 'false'); setSetting(number, 'alwaysonline', aoC === 'true' ? 'false' : 'true');
    if (aoC !== 'true') await socket.sendPresenceUpdate('available', sender).catch(() => {});
    await socket.sendMessage(sender, { text: formatMessage('🟢 ALWAYS ONLINE', `Always online: ${aoC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'autorecording': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const recC = getSetting(number, 'autorecording', 'false'); setSetting(number, 'autorecording', recC === 'true' ? 'false' : 'true');
    config.AUTO_RECORDING = recC !== 'true' ? 'true' : 'false';
    await socket.sendMessage(sender, { text: formatMessage('🎙️ AUTO-RECORDING', `Auto-recording: ${recC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'autobio': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const bioC = getSetting(number, 'autobio', 'false'); setSetting(number, 'autobio', bioC === 'true' ? 'false' : 'true');
    await socket.sendMessage(sender, { text: formatMessage('📝 AUTO-BIO', `Auto-bio: ${bioC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'autoview': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } config.AUTO_VIEW_STATUS = config.AUTO_VIEW_STATUS === 'true' ? 'false' : 'true'; await socket.sendMessage(sender, { text: formatMessage('👁️ AUTO-VIEW', `Auto-view status: ${config.AUTO_VIEW_STATUS === 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'autoviewstatus': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } config.AUTO_VIEW_STATUS = config.AUTO_VIEW_STATUS === 'true' ? 'false' : 'true'; await socket.sendMessage(sender, { text: formatMessage('👁️ AUTO-VIEW STATUS', `Auto-view status: ${config.AUTO_VIEW_STATUS === 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'autolike': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } config.AUTO_LIKE_STATUS = config.AUTO_LIKE_STATUS === 'true' ? 'false' : 'true'; await socket.sendMessage(sender, { text: formatMessage('❤️ AUTO-LIKE', `Auto-like status: ${config.AUTO_LIKE_STATUS === 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'antidelete': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const adC2 = getSetting(number, 'antidelete', 'false'); setSetting(number, 'antidelete', adC2 === 'true' ? 'false' : 'true'); await socket.sendMessage(sender, { text: formatMessage('🛡️ ANTI-DELETE', `Anti-delete: ${adC2 !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'antiedit': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const aeC2 = getSetting(number, 'antiedit', 'false'); setSetting(number, 'antiedit', aeC2 === 'true' ? 'false' : 'true'); await socket.sendMessage(sender, { text: formatMessage('✏️ ANTI-EDIT', `Anti-edit: ${aeC2 !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'antiviewonce': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const avoC = getSetting(number, 'antiviewonce', 'false'); setSetting(number, 'antiviewonce', avoC === 'true' ? 'false' : 'true'); await socket.sendMessage(sender, { text: formatMessage('🔓 ANTI-VIEW-ONCE', `Reveal view-once: ${avoC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'pmblock': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const pbC = getSetting(number, 'pmblock', 'false'); setSetting(number, 'pmblock', pbC === 'true' ? 'false' : 'true'); await socket.sendMessage(sender, { text: formatMessage('🚫 PM BLOCK', `PM block: ${pbC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'antibug': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const abC = getSetting(number, 'antibug', 'false'); setSetting(number, 'antibug', abC === 'true' ? 'false' : 'true'); await socket.sendMessage(sender, { text: formatMessage('🐛 ANTI-BUG', `Anti-bug: ${abC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'autoblock': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const ablC = getSetting(number, 'autoblock', 'false'); setSetting(number, 'autoblock', ablC === 'true' ? 'false' : 'true'); await socket.sendMessage(sender, { text: formatMessage('🚫 AUTO-BLOCK', `Auto-block: ${ablC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'autostatus': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const asC = getSetting(number, 'autostatus', 'false'); setSetting(number, 'autostatus', asC === 'true' ? 'false' : 'true'); await socket.sendMessage(sender, { text: formatMessage('📢 AUTO-STATUS', `Auto-status: ${asC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'autosavestatus': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const assC = getSetting(number, 'autosavestatus', 'false'); setSetting(number, 'autosavestatus', assC === 'true' ? 'false' : 'true'); await socket.sendMessage(sender, { text: formatMessage('💾 AUTO-SAVE STATUS', `Auto-save status: ${assC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'autostatusreact': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const asrC = getSetting(number, 'autostatusreact', 'false'); setSetting(number, 'autostatusreact', asrC === 'true' ? 'false' : 'true'); await socket.sendMessage(sender, { text: formatMessage('❤️ AUTO-STATUS REACT', `Auto-react status: ${asrC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'autoreadreceipts': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const arcC = getSetting(number, 'autoreadreceipts', 'false'); setSetting(number, 'autoreadreceipts', arcC === 'true' ? 'false' : 'true'); await socket.sendMessage(sender, { text: formatMessage('✅ AUTO-READ RECEIPTS', `Auto-read receipts: ${arcC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'antisticker': { if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; } if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; } const astkC = getSetting(from, 'antisticker', 'false'); setSetting(from, 'antisticker', astkC === 'true' ? 'false' : 'true'); await socket.sendMessage(from, { text: formatMessage('🚫 ANTI-STICKER', `Anti-sticker: ${astkC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'antiphoto': { if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; } if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; } const aphC = getSetting(from, 'antiphoto', 'false'); setSetting(from, 'antiphoto', aphC === 'true' ? 'false' : 'true'); await socket.sendMessage(from, { text: formatMessage('🚫 ANTI-PHOTO', `Anti-photo: ${aphC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'antipromote': { if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; } if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; } const apC = getSetting(from, 'antipromote', 'false'); setSetting(from, 'antipromote', apC === 'true' ? 'false' : 'true'); await socket.sendMessage(from, { text: formatMessage('🛡️ ANTI-PROMOTE', `Anti-promote: ${apC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'antidemote': { if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; } if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; } const admC = getSetting(from, 'antidemote', 'false'); setSetting(from, 'antidemote', admC === 'true' ? 'false' : 'true'); await socket.sendMessage(from, { text: formatMessage('🛡️ ANTI-DEMOTE', `Anti-demote: ${admC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'antigroupmention': { if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; } if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; } const agmC = getSetting(from, 'antigroupmention', 'false'); setSetting(from, 'antigroupmention', agmC === 'true' ? 'false' : 'true'); await socket.sendMessage(from, { text: formatMessage('🔕 ANTI-@ALL', `Anti-group-mention: ${agmC !== 'true' ? '✅ ON' : '❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
// ─── CLEAR / SESSION / TMP ───────────────────────────────────
case 'clear': { await socket.sendMessage(sender, { text: formatMessage('🧹 CLEAR', 'WhatsApp bots cannot clear chat history.\nUse .kickall to remove members or .revoke to reset the group link.', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'clearsession': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const cSesPath = path.join(__dirname, 'session', `session_${number}`);
    if (fs.existsSync(cSesPath)) fs.removeSync(cSesPath);
    await socket.sendMessage(sender, { text: formatMessage('✅ SESSION CLEARED', 'Session cleared. Reconnecting...', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    setTimeout(() => process.exit(0), 1500);
    break;
}
case 'cleartmp': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    let cleaned = 0;
    try { const tFiles = fs.readdirSync('/tmp'); for (const f of tFiles) { try { fs.removeSync(path.join('/tmp', f)); cleaned++; } catch (_) {} } } catch (_) {}
    await socket.sendMessage(sender, { text: formatMessage('🧹 TEMP CLEARED', `Removed ${cleaned} temp files.`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
// ─── SUDO / SETPP / SETVAR ───────────────────────────────────
case 'sudo': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const sudoT = msg.message?.extendedTextMessage?.contextInfo?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
    if (!sudoT) { const sl = getSudoList(); await socket.sendMessage(sender, { text: formatMessage('👑 SUDO LIST', sl.length ? sl.join('\n') : 'No sudo users', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
    const sudoN2 = sudoT.split('@')[0]; const sl2 = getSudoList();
    if (sl2.includes(sudoN2)) { saveSudoList(sl2.filter(s => s !== sudoN2)); await socket.sendMessage(sender, { text: formatMessage('✅ SUDO REMOVED', sudoN2, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); }
    else { sl2.push(sudoN2); saveSudoList(sl2); await socket.sendMessage(sender, { text: formatMessage('✅ SUDO ADDED', sudoN2, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); }
    break;
}
case 'setpp': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const ppImg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
    if (!ppImg) { await socket.sendMessage(sender, { text: `Reply to an image.\nUsage: Reply + ${prefix}setpp` }); break; }
    const ppStr = await downloadContentFromMessage(ppImg, 'image');
    let ppBuf = Buffer.from([]); for await (const ch of ppStr) ppBuf = Buffer.concat([ppBuf, ch]);
    await socket.updateProfilePicture(socket.user.id, ppBuf);
    await socket.sendMessage(sender, { text: formatMessage('✅ PROFILE PIC SET', 'Profile picture updated!', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'setvar': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const vk = args[0]; const vv2 = args.slice(1).join(' '); if (!vk || !vv2) { await socket.sendMessage(sender, { text: `Usage: ${prefix}setvar <key> <value>` }); break; } const vs = loadJson(CUSTOM_VARS_PATH); vs[number] = vs[number] || {}; vs[number][vk] = vv2; saveJson(CUSTOM_VARS_PATH, vs); await socket.sendMessage(sender, { text: formatMessage('✅ VAR SET', `${vk} = ${vv2}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'getvar': { const gvk = args[0]; const gvs = loadJson(CUSTOM_VARS_PATH)[number] || {}; if (!gvk) { const all2 = Object.entries(gvs).map(([k, v]) => `• ${k}: ${v}`).join('\n') || 'None'; await socket.sendMessage(sender, { text: formatMessage('📋 VARIABLES', all2, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; } await socket.sendMessage(sender, { text: formatMessage('📋 VAR', gvs[gvk] !== undefined ? `${gvk} = ${gvs[gvk]}` : `"${gvk}" not found`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'delvar': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const dvk = args[0]; if (!dvk) { await socket.sendMessage(sender, { text: `Usage: ${prefix}delvar <key>` }); break; } const dvs = loadJson(CUSTOM_VARS_PATH); if (dvs[number]) delete dvs[number][dvk]; saveJson(CUSTOM_VARS_PATH, dvs); await socket.sendMessage(sender, { text: formatMessage('✅ VAR DELETED', dvk, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
// ─── WARNINGS ────────────────────────────────────────────────
case 'warnings': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    const wT = msg.message?.extendedTextMessage?.contextInfo?.participant || nowsender;
    const wDb2 = loadJson(WARNINGS_DB_PATH); const wK = `${from}:${wT.split('@')[0]}`;
    await socket.sendMessage(from, { text: formatMessage('⚠️ WARNINGS', `@${wT.split('@')[0]}: *${wDb2[wK] || 0}/3* warnings`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'), mentions: [wT] }, { quoted: fakevCard });
    break;
}
// ─── TOSTATUS ────────────────────────────────────────────────
case 'tostatus': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const tsQ = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!tsQ) { await socket.sendMessage(sender, { text: `Reply to a message to post to status.\nUsage: Reply + ${prefix}tostatus` }); break; }
    const tsType = getContentType(tsQ);
    if (tsType === 'imageMessage') { const tsS = await downloadContentFromMessage(tsQ.imageMessage, 'image'); let tsB = Buffer.from([]); for await (const ch of tsS) tsB = Buffer.concat([tsB, ch]); await socket.sendMessage('status@broadcast', { image: tsB, caption: tsQ.imageMessage.caption || '' }); }
    else if (tsType === 'videoMessage') { const tsS = await downloadContentFromMessage(tsQ.videoMessage, 'video'); let tsB = Buffer.from([]); for await (const ch of tsS) tsB = Buffer.concat([tsB, ch]); await socket.sendMessage('status@broadcast', { video: tsB, caption: '' }); }
    else { await socket.sendMessage('status@broadcast', { text: tsQ.conversation || tsQ.extendedTextMessage?.text || '' }); }
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    break;
}
// ─── PAYMENT / BANK ──────────────────────────────────────────
case 'payment': {
    const pd = loadJson(PAYMENT_DB_PATH)[number];
    if (!pd?.method) { await socket.sendMessage(sender, { text: `No payment info set. Use ${prefix}setpayment` }); break; }
    await socket.sendMessage(sender, { text: formatMessage('💳 PAYMENT', `Method: ${pd.method}\nDetails: ${pd.details}\nName: ${pd.name || 'N/A'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
case 'setpayment': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const pp = args.join(' ').split('|').map(s => s.trim());
    if (!pp[0]) { await socket.sendMessage(sender, { text: `Usage: ${prefix}setpayment M-Pesa | 0712345678 | John` }); break; }
    const pd2 = loadJson(PAYMENT_DB_PATH); pd2[number] = { method: pp[0], details: pp[1] || '', name: pp[2] || '' }; saveJson(PAYMENT_DB_PATH, pd2);
    await socket.sendMessage(sender, { text: formatMessage('✅ PAYMENT SET', `${pd2[number].method}: ${pd2[number].details}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'delpayment': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const dpd = loadJson(PAYMENT_DB_PATH); delete dpd[number]; saveJson(PAYMENT_DB_PATH, dpd); await socket.sendMessage(sender, { text: formatMessage('✅ PAYMENT REMOVED', 'Payment info deleted.', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'tech':
case 'bankpayment': {
    const bd = loadJson(PAYMENT_DB_PATH)[`${number}_bank`];
    if (!bd?.bank) { await socket.sendMessage(sender, { text: `No bank info set. Use ${prefix}setbankpayment` }); break; }
    await socket.sendMessage(sender, { text: formatMessage('🏦 BANK PAYMENT', `Bank: ${bd.bank}\nAccount: ${bd.account}\nName: ${bd.name || 'N/A'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
case 'setbankpayment': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const bp = args.join(' ').split('|').map(s => s.trim());
    if (!bp[0]) { await socket.sendMessage(sender, { text: `Usage: ${prefix}setbankpayment KCB | 1234567890 | John` }); break; }
    const bd2 = loadJson(PAYMENT_DB_PATH); bd2[`${number}_bank`] = { bank: bp[0], account: bp[1] || '', name: bp[2] || '' }; saveJson(PAYMENT_DB_PATH, bd2);
    await socket.sendMessage(sender, { text: formatMessage('✅ BANK SET', `${bd2[`${number}_bank`].bank}: ${bd2[`${number}_bank`].account}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'delbankpayment': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const dbd = loadJson(PAYMENT_DB_PATH); delete dbd[`${number}_bank`]; saveJson(PAYMENT_DB_PATH, dbd); await socket.sendMessage(sender, { text: formatMessage('✅ BANK REMOVED', 'Bank info deleted.', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
// ─── AI / GPT / GEMINI / IMAGE GEN ───────────────────────────
case 'gpt': {
    const gptQ = args.join(' '); if (!gptQ) { await socket.sendMessage(sender, { text: `Usage: ${prefix}gpt <question>` }); break; }
    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
    try {
        const r = await axios.get(`https://api.dreaded.site/api/chatgpt?text=${encodeURIComponent(gptQ)}`, { timeout: 15000 });
        await socket.sendMessage(sender, { text: formatMessage('🤖 GPT', r.data?.result || r.data?.message || 'No response.', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ GPT error: ${e.message}` }); }
    break;
}
case 'gemini': {
    const gemQ = args.join(' '); if (!gemQ) { await socket.sendMessage(sender, { text: `Usage: ${prefix}gemini <question>` }); break; }
    await socket.sendMessage(sender, { react: { text: '✨', key: msg.key } });
    try {
        const r = await axios.get(`https://api.dreaded.site/api/gemini?text=${encodeURIComponent(gemQ)}`, { timeout: 20000 });
        await socket.sendMessage(sender, { text: formatMessage('✨ GEMINI', r.data?.result || r.data?.message || 'No response.', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ Gemini error: ${e.message}` }); }
    break;
}
case 'imagine':
case 'flux': {
    const imgP = args.join(' '); if (!imgP) { await socket.sendMessage(sender, { text: `Usage: ${prefix}${command} <prompt>` }); break; }
    await socket.sendMessage(sender, { react: { text: '🎨', key: msg.key } });
    try {
        const r = await axios.get(`https://image.pollinations.ai/prompt/${encodeURIComponent(imgP)}?width=512&height=512&nologo=true`, { responseType: 'arraybuffer', timeout: 35000 });
        await socket.sendMessage(sender, { image: Buffer.from(r.data), caption: formatMessage('🎨 AI IMAGE', imgP, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ Image gen failed: ${e.message}` }); }
    break;
}
// ─── GAMES ───────────────────────────────────────────────────
case 'truth': {
    await socket.sendMessage(sender, { react: { text: '🎭', key: msg.key } });
    try { const r = await axios.get('https://api.truthordarebot.xyz/v1/truth', { timeout: 8000 }); await socket.sendMessage(sender, { text: formatMessage('🎭 TRUTH', r.data?.question || 'What is your biggest secret?', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard }); }
    catch { await socket.sendMessage(sender, { text: formatMessage('🎭 TRUTH', 'What is something you have never told anyone?', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard }); }
    break;
}
case 'dare': {
    await socket.sendMessage(sender, { react: { text: '🔥', key: msg.key } });
    try { const r = await axios.get('https://api.truthordarebot.xyz/v1/dare', { timeout: 8000 }); await socket.sendMessage(sender, { text: formatMessage('🔥 DARE', r.data?.question || 'Send a voice note singing for 10 seconds!', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard }); }
    catch { await socket.sendMessage(sender, { text: formatMessage('🔥 DARE', 'Send a funny selfie right now!', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard }); }
    break;
}
case '8ball': {
    const bAns = ['✅ Yes', '✅ Definitely!', '✅ Most likely', '🤔 Maybe', '🤔 Ask again later', '❌ No', '❌ Definitely not', '❌ Very doubtful', '🎱 Cannot predict now'][Math.floor(Math.random() * 9)];
    await socket.sendMessage(sender, { text: formatMessage('🎱 MAGIC 8-BALL', (args.join(' ') ? `❓ *${args.join(' ')}*\n\n` : '') + `🎱 *${bAns}*`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
case 'trivia': {
    await socket.sendMessage(sender, { react: { text: '🎓', key: msg.key } });
    try {
        const r = await axios.get('https://opentdb.com/api.php?amount=1&type=multiple', { timeout: 10000 });
        const q = r.data?.results?.[0]; if (!q) throw new Error('No question');
        const opts = [...q.incorrect_answers, q.correct_answer].sort(() => Math.random() - 0.5);
        await socket.sendMessage(sender, { text: formatMessage('🎓 TRIVIA', `❓ ${q.question.replace(/&quot;/g, '"').replace(/&#039;/g, "'")}\n\n${opts.map((o, i) => `${['A','B','C','D'][i]}. ${o}`).join('\n')}\n\n_${q.category} | ${q.difficulty}_`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ Could not fetch trivia: ${e.message}` }); }
    break;
}
case 'hangman':
case 'guess': {
    const wList = ['elephant','rainbow','mountain','keyboard','sunshine','dolphin','volcano','pyramid','butterfly','telescope'];
    const hw = wList[Math.floor(Math.random() * wList.length)];
    const hd = hw.split('').map((c, i) => i === 0 || i === hw.length - 1 ? c : '_').join(' ');
    setSetting(sender, 'hangman_word', hw);
    await socket.sendMessage(sender, { text: formatMessage('🎮 HANGMAN', `Guess the word!\n\n${hd}\n\nLength: ${hw.length} letters\n\nReply with ${prefix}answer <word/letter>`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
case 'answer': {
    const aw = getSetting(sender, 'hangman_word', ''); const ag = args.join(' ').toLowerCase().trim();
    if (!aw) { await socket.sendMessage(sender, { text: `No active game! Start with ${prefix}hangman` }); break; }
    if (ag === aw) { setSetting(sender, 'hangman_word', ''); await socket.sendMessage(sender, { text: formatMessage('🎉 CORRECT!', `The word was *${aw}*! You win! 🏆`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); }
    else if (ag.length === 1 && aw.includes(ag)) { await socket.sendMessage(sender, { text: formatMessage('✅ RIGHT LETTER!', `*${ag}* is in the word!\n${aw.split('').map((c, i) => c === ag || i === 0 || i === aw.length-1 ? c : '_').join(' ')}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); }
    else { await socket.sendMessage(sender, { text: formatMessage('❌ WRONG!', `*${ag}* is not the answer. Try again!`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); }
    break;
}
case 'ship': {
    const shQ = args.join(' '); if (!shQ) { await socket.sendMessage(sender, { text: `Usage: ${prefix}ship Name1 & Name2` }); break; }
    const pct = Math.floor(Math.random() * 101);
    const bar = '█'.repeat(Math.floor(pct/10)) + '░'.repeat(10-Math.floor(pct/10));
    const mood = pct>=80?'💑 Soulmates!':pct>=60?'❤️ Great match!':pct>=40?'💛 Could work':'💔 Not great';
    await socket.sendMessage(sender, { text: formatMessage('💕 SHIP METER', `${shQ}\n\n${bar} ${pct}%\n${mood}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
// ─── ANIME REACTIONS ─────────────────────────────────────────
case 'neko': case 'waifu': case 'nom': case 'poke':
case 'cry': case 'kiss': case 'pat': case 'hug':
case 'wink': case 'facepalm': {
    await socket.sendMessage(sender, { react: { text: '🌸', key: msg.key } });
    const anEmoji = {neko:'🐱',waifu:'💕',nom:'😋',poke:'👉',cry:'😢',kiss:'💋',pat:'👋',hug:'🤗',wink:'😉',facepalm:'🤦'};
    try {
        const r = await axios.get(`https://nekos.best/api/v2/${command}`, { timeout: 10000 });
        const url = r.data?.results?.[0]?.url; if (!url) throw new Error('No URL');
        const img = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        await socket.sendMessage(sender, { image: Buffer.from(img.data), caption: `${anEmoji[command]||'🌸'} *${command.toUpperCase()}*\n> *𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪*` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ ${command}: ${e.message}` }); }
    break;
}
// ─── FUN / MAKER ─────────────────────────────────────────────
case 'compliment': {
    const cList = ['You are absolutely amazing! ✨','Your smile brightens every room 😊','You have the most beautiful soul 💖','You are incredibly talented 🧠','The world is better with you in it 🌍'];
    const cT = msg.message?.extendedTextMessage?.contextInfo?.participant || nowsender;
    await socket.sendMessage(sender, { text: formatMessage('💖 COMPLIMENT', `@${cT.split('@')[0]}: ${cList[Math.floor(Math.random()*cList.length)]}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'), mentions: [cT] }, { quoted: fakevCard });
    break;
}
case 'insult': {
    const iList = ["You're like a software update — nobody wants you 😅","I'd agree with you but then we'd both be wrong 😂","If brains were dynamite, you wouldn't have enough 💥"];
    const iT = msg.message?.extendedTextMessage?.contextInfo?.participant || nowsender;
    await socket.sendMessage(sender, { text: formatMessage('😈 INSULT (JOKE)', `@${iT.split('@')[0]}: ${iList[Math.floor(Math.random()*iList.length)]}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'), mentions: [iT] }, { quoted: fakevCard });
    break;
}
case 'flirt': {
    const fList = ['Are you a magnet? I am attracted to you 😍','Do you like science? We have chemistry 🧪❤️','Are you Wi-Fi? I feel a connection 📶💕'];
    const fT = msg.message?.extendedTextMessage?.contextInfo?.participant || nowsender;
    await socket.sendMessage(sender, { text: formatMessage('💘 FLIRT', `@${fT.split('@')[0]}: ${fList[Math.floor(Math.random()*fList.length)]}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'), mentions: [fT] }, { quoted: fakevCard });
    break;
}
case 'goodnight': {
    const gnList = ['Goodnight! Sweet dreams 🌙✨','Sleep tight, see you tomorrow 😴🌟','Rest well, tomorrow is a new adventure 🌅'];
    const gnT = msg.message?.extendedTextMessage?.contextInfo?.participant || nowsender;
    await socket.sendMessage(sender, { text: formatMessage('🌙 GOODNIGHT', `@${gnT.split('@')[0]}: ${gnList[Math.floor(Math.random()*gnList.length)]}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'), mentions: [gnT] }, { quoted: fakevCard });
    break;
}
case 'simp': case 'stupid': case 'wasted': {
    const sMap = {simp:'😂 Certified SIMP detected! 💀',stupid:'😅 That was a stupid move 🤦',wasted:'💀 WASTED! You played yourself 🎮'};
    await socket.sendMessage(sender, { text: formatMessage('😂 FUN', sMap[command], '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
case 'shayari': {
    const shList = ['Zindagi ke safar mein akele nahi hain 🌹\nDil ke darwaaze pe teri tasweer hai... 💭','Mohabbat ek khubsoorat ehsaas hai 💕\nJise lafzon mein bayan karna mushkil hai... 🌸'];
    await socket.sendMessage(sender, { text: formatMessage('📜 SHAYARI', shList[Math.floor(Math.random()*shList.length)], '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
case 'roseday': {
    await socket.sendMessage(sender, { text: formatMessage('🌹 ROSE DAY', '🌹 Sending you a rose!\n_A single rose can be my garden; a single friend, my world_ 🌍\n\n💕 Happy Rose Day!', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
case 'character': {
    await socket.sendMessage(sender, { react: { text: '🎭', key: msg.key } });
    try {
        const r = await axios.get('https://nekos.best/api/v2/neko', { timeout: 8000 });
        const u = r.data?.results?.[0]; if (!u?.url) throw new Error('No image');
        const img = await axios.get(u.url, { responseType: 'arraybuffer', timeout: 15000 });
        await socket.sendMessage(sender, { image: Buffer.from(img.data), caption: formatMessage('🎭 ANIME CHARACTER', `Artist: ${u.artist_name||'Unknown'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ ${e.message}` }); }
    break;
}
// ─── MEME / BLUR / MEDIA ─────────────────────────────────────
case 'meme': {
    await socket.sendMessage(sender, { react: { text: '😂', key: msg.key } });
    try {
        const r = await axios.get('https://meme-api.com/gimme', { timeout: 10000 }); if (!r.data?.url) throw new Error('No meme');
        const img = await axios.get(r.data.url, { responseType: 'arraybuffer', timeout: 15000 });
        await socket.sendMessage(sender, { image: Buffer.from(img.data), caption: formatMessage('😂 MEME', r.data.title||'', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ Meme: ${e.message}` }); }
    break;
}
case 'emojimix': {
    const emArgs = args[0]?.split('+') || [];
    if (emArgs.length < 2) { await socket.sendMessage(sender, { text: `Usage: ${prefix}emojimix 🔥+💧` }); break; }
    try {
        const e1 = [...emArgs[0].trim()].map(c => c.codePointAt(0).toString(16).padStart(4,'0')).join('-');
        const e2 = [...emArgs[1].trim()].map(c => c.codePointAt(0).toString(16).padStart(4,'0')).join('-');
        const eUrl = `https://www.gstatic.com/android/keyboard/emojikitchen/20230301/u${e1}/u${e1}-u${e2}.png`;
        const eImg = await axios.get(eUrl, { responseType: 'arraybuffer', timeout: 10000 });
        await socket.sendMessage(sender, { image: Buffer.from(eImg.data), caption: `${emArgs[0].trim()} + ${emArgs[1].trim()} 🎨\n> *𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪*` }, { quoted: fakevCard });
    } catch { await socket.sendMessage(sender, { text: `🤔 That emoji combo is not supported.\nTry: ${prefix}emojimix 😀+🔥` }); }
    break;
}
case 'blur': {
    const blurI = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
    if (!blurI) { await socket.sendMessage(sender, { text: `Reply to an image.\nUsage: Reply + ${prefix}blur` }); break; }
    await socket.sendMessage(sender, { react: { text: '🌀', key: msg.key } });
    try {
        const blurS = await downloadContentFromMessage(blurI, 'image'); let blurB = Buffer.from([]); for await (const ch of blurS) blurB = Buffer.concat([blurB, ch]);
        const blurJ = await Jimp.read(blurB); blurJ.blur(10);
        await socket.sendMessage(sender, { image: await blurJ.getBufferAsync(Jimp.MIME_JPEG), caption: formatMessage('🌀 BLURRED', 'Done!', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ Blur: ${e.message}` }); }
    break;
}
case 'simage': {
    const simQ = args.join(' '); if (!simQ) { await socket.sendMessage(sender, { text: `Usage: ${prefix}simage <query>` }); break; }
    await socket.sendMessage(sender, { react: { text: '🖼️', key: msg.key } });
    try {
        const r = await axios.get(`https://api.dreaded.site/api/image?search=${encodeURIComponent(simQ)}`, { timeout: 15000 });
        const url = r.data?.result?.[0]?.url || r.data?.url; if (!url) throw new Error('No image');
        const img = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        await socket.sendMessage(sender, { image: Buffer.from(img.data), caption: formatMessage('🖼️ IMAGE', simQ, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ Image search: ${e.message}` }); }
    break;
}
case 'take': {
    const tkS = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage;
    if (!tkS) { await socket.sendMessage(sender, { text: `Reply to a sticker.\nUsage: Reply + ${prefix}take` }); break; }
    const tkStr = await downloadContentFromMessage(tkS, 'sticker'); let tkB = Buffer.from([]); for await (const ch of tkStr) tkB = Buffer.concat([tkB, ch]);
    await socket.sendMessage(sender, { image: tkB, caption: formatMessage('✅ STICKER SAVED', 'Converted to image!', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
case 'tgsticker': {
    const tgsQ = args.join(' ');
    await socket.sendMessage(sender, { text: formatMessage('📦 TG STICKER', tgsQ ? `Search "${tgsQ}" on @Stickers in Telegram` : 'Use @Stickers or t.me/StickerDownloaderBot on Telegram to find and download sticker packs.', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
// ─── YTS / MUSIC / YTMP4 / SPOTIFY / SSWEB ───────────────────
case 'yts': {
    const ytsQ = args.join(' '); if (!ytsQ) { await socket.sendMessage(sender, { text: `Usage: ${prefix}yts <query>` }); break; }
    await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });
    try {
        const r = await axios.get(`https://www.youtube.com/results?search_query=${encodeURIComponent(ytsQ)}`, { timeout: 10000 });
        const ms = [...r.data.matchAll(/"videoId":"([^"]+)".*?"title":{"runs":\[{"text":"([^"]+)"/g)];
        if (!ms.length) throw new Error('No results');
        await socket.sendMessage(sender, { text: formatMessage(`🔍 YT: "${ytsQ}"`, ms.slice(0,5).map((m,i) => `${i+1}. *${m[2]}*\n   https://youtu.be/${m[1]}`).join('\n\n'), '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ YT search: ${e.message}` }); }
    break;
}
case 'music': {
    if (!args.length) { await socket.sendMessage(sender, { text: `Usage: ${prefix}music <song name>` }); break; }
    await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });
    try {
        const mQ = args.join(' ');
        const mS = await axios.get(`https://www.youtube.com/results?search_query=${encodeURIComponent(mQ)}`, { timeout: 10000 });
        const mM = mS.data.match(/"videoId":"([^"]+)"/); if (!mM) throw new Error('No video');
        const mUrl = `https://www.youtube.com/watch?v=${mM[1]}`;
        await socket.sendMessage(sender, { text: `⏳ Downloading: *${mQ}*` });
        const { execSync } = require('child_process');
        const outF = `/tmp/music_${Date.now()}.mp3`;
        execSync(`"${path.join(__dirname,'yt-dlp')}" -x --audio-format mp3 -o "${outF}" "${mUrl}" --no-playlist`, { timeout: 60000 });
        const mBuf = fs.readFileSync(outF);
        await socket.sendMessage(sender, { audio: mBuf, mimetype: 'audio/mp4', ptt: false }, { quoted: fakevCard });
        fs.removeSync(outF);
    } catch (e) { await socket.sendMessage(sender, { text: `❌ Music: ${e.message}` }); }
    break;
}
case 'spotify': {
    const spQ = args.join(' '); if (!spQ) { await socket.sendMessage(sender, { text: `Usage: ${prefix}spotify <song>` }); break; }
    await socket.sendMessage(sender, { react: { text: '🟢', key: msg.key } });
    try {
        const r = await axios.get(`https://api.dreaded.site/api/spotify?name=${encodeURIComponent(spQ)}`, { timeout: 20000 });
        const sp = r.data?.result; if (!sp?.download_url) throw new Error('No link');
        const aud = await axios.get(sp.download_url, { responseType: 'arraybuffer', timeout: 30000 });
        await socket.sendMessage(sender, { audio: Buffer.from(aud.data), mimetype: 'audio/mpeg', ptt: false }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ Spotify: ${e.message}\nTry: ${prefix}music ${args.join(' ')}` }); }
    break;
}
case 'ytmp4': {
    const vQ = args.join(' '); if (!vQ) { await socket.sendMessage(sender, { text: `Usage: ${prefix}ytmp4 <URL or search>` }); break; }
    await socket.sendMessage(sender, { react: { text: '📹', key: msg.key } });
    try {
        let vUrl = vQ.includes('youtu') ? vQ : null;
        if (!vUrl) { const r = await axios.get(`https://www.youtube.com/results?search_query=${encodeURIComponent(vQ)}`, { timeout: 10000 }); const m = r.data.match(/"videoId":"([^"]+)"/); if (!m) throw new Error('No video'); vUrl = `https://www.youtube.com/watch?v=${m[1]}`; }
        await socket.sendMessage(sender, { text: `⏳ Downloading: ${vUrl}` });
        const { execSync } = require('child_process');
        const vOut = `/tmp/vid_${Date.now()}.mp4`;
        execSync(`"${path.join(__dirname,'yt-dlp')}" -f "best[ext=mp4][filesize<50M]/best[ext=mp4]/best" -o "${vOut}" "${vUrl}" --no-playlist`, { timeout: 120000 });
        const vBuf = fs.readFileSync(vOut);
        if (vBuf.length > 64*1024*1024) { await socket.sendMessage(sender, { text: '❌ Video too large (>64MB).' }); fs.removeSync(vOut); break; }
        await socket.sendMessage(sender, { video: vBuf, mimetype: 'video/mp4', caption: formatMessage('📹 VIDEO', vUrl, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
        fs.removeSync(vOut);
    } catch (e) { await socket.sendMessage(sender, { text: `❌ Video: ${e.message}` }); }
    break;
}
case 'ssweb': {
    const swQ = args.join(' '); if (!swQ) { await socket.sendMessage(sender, { text: `Usage: ${prefix}ssweb <URL>` }); break; }
    await socket.sendMessage(sender, { react: { text: '📸', key: msg.key } });
    try {
        const swUrl = swQ.startsWith('http') ? swQ : `https://${swQ}`;
        const r = await axios.get(`https://image.thum.io/get/width/1280/crop/720/png/${encodeURIComponent(swUrl)}`, { responseType: 'arraybuffer', timeout: 30000 });
        await socket.sendMessage(sender, { image: Buffer.from(r.data), caption: formatMessage('📸 SCREENSHOT', swUrl, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ Screenshot: ${e.message}` }); }
    break;
}
case 'instagram': {
    const igQ = args[0]; if (!igQ) { await socket.sendMessage(sender, { text: `Usage: ${prefix}instagram <URL>` }); break; }
    await socket.sendMessage(sender, { react: { text: '📸', key: msg.key } });
    try {
        const { execSync } = require('child_process'); const igOut = `/tmp/ig_${Date.now()}.mp4`;
        execSync(`"${path.join(__dirname,'yt-dlp')}" -o "${igOut}" "${igQ}" --no-playlist`, { timeout: 60000 });
        const igB = fs.readFileSync(igOut);
        await socket.sendMessage(sender, { video: igB, mimetype: 'video/mp4', caption: formatMessage('📸 INSTAGRAM', igQ, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
        fs.removeSync(igOut);
    } catch (e) { await socket.sendMessage(sender, { text: `❌ Instagram: ${e.message}` }); }
    break;
}
case 'img': {
    const imgQ = args.join(' '); if (!imgQ) { await socket.sendMessage(sender, { text: `Usage: ${prefix}img <search>` }); break; }
    await socket.sendMessage(sender, { react: { text: '🖼️', key: msg.key } });
    try {
        const r = await axios.get(`https://api.dreaded.site/api/image?search=${encodeURIComponent(imgQ)}`, { timeout: 15000 });
        const url = r.data?.result?.[0]?.url || r.data?.url; if (!url) throw new Error('No image');
        const img = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        await socket.sendMessage(sender, { image: Buffer.from(img.data), caption: formatMessage('🖼️ IMAGE', imgQ, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ Image: ${e.message}` }); }
    break;
}
case 'facebook': {
    const fbQ = args[0]; if (!fbQ) { await socket.sendMessage(sender, { text: `Usage: ${prefix}facebook <URL>` }); break; }
    await socket.sendMessage(sender, { react: { text: '📘', key: msg.key } });
    try {
        const { execSync } = require('child_process'); const fbOut = `/tmp/fb_${Date.now()}.mp4`;
        execSync(`"${path.join(__dirname,'yt-dlp')}" -o "${fbOut}" "${fbQ}" --no-playlist`, { timeout: 60000 });
        const fbB = fs.readFileSync(fbOut);
        await socket.sendMessage(sender, { video: fbB, mimetype: 'video/mp4', caption: formatMessage('📘 FACEBOOK', fbQ, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
        fs.removeSync(fbOut);
    } catch (e) { await socket.sendMessage(sender, { text: `❌ Facebook: ${e.message}` }); }
    break;
}
case 'save': {
    const svQ = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!svQ) { await socket.sendMessage(sender, { text: `Reply to a message to save it.\nUsage: Reply + ${prefix}save` }); break; }
    const svType = getContentType(svQ);
    if (svType === 'imageMessage') { const s = await downloadContentFromMessage(svQ.imageMessage, 'image'); let b = Buffer.from([]); for await (const ch of s) b = Buffer.concat([b, ch]); await socket.sendMessage(sender, { image: b, caption: `✅ Saved!` }, { quoted: fakevCard }); }
    else if (svType === 'videoMessage') { const s = await downloadContentFromMessage(svQ.videoMessage, 'video'); let b = Buffer.from([]); for await (const ch of s) b = Buffer.concat([b, ch]); await socket.sendMessage(sender, { video: b, mimetype: 'video/mp4', caption: '✅ Saved!' }, { quoted: fakevCard }); }
    else if (svType === 'audioMessage') { const s = await downloadContentFromMessage(svQ.audioMessage, 'audio'); let b = Buffer.from([]); for await (const ch of s) b = Buffer.concat([b, ch]); await socket.sendMessage(sender, { audio: b, mimetype: 'audio/mpeg' }, { quoted: fakevCard }); }
    else { await socket.sendMessage(sender, { text: `✅ Content noted.` }); }
    break;
}
case 'shazam': {
    await socket.sendMessage(sender, { text: formatMessage('🎵 SHAZAM', 'Song recognition requires a Shazam API key.\n\nFor manual ID, use the Shazam app or describe the song and try:\n.gpt What song has these lyrics: <lyrics>', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
// ─── GITHUB COMMANDS ─────────────────────────────────────────
case 'gitclone': {
    await socket.sendMessage(sender, { text: formatMessage('📥 GIT CLONE', `\`\`\`git clone https://github.com/Courtney250/TRUTH-MD.git\`\`\`\n\nZIP: https://github.com/Courtney250/TRUTH-MD/archive/refs/heads/main.zip`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
// ─── GROUP OPEN/CLOSE/KILL/JOIN REQUESTS ─────────────────────
case 'opengc': { if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; } if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; } await socket.groupSettingUpdate(from, 'not_announcement'); await socket.sendMessage(from, { text: formatMessage('🔓 GROUP OPEN', 'Everyone can now send messages!', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'closegc': { if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; } if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; } await socket.groupSettingUpdate(from, 'announcement'); await socket.sendMessage(from, { text: formatMessage('🔒 GROUP CLOSED', 'Only admins can send messages now!', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'killall': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; }
    const kaM = await socket.groupMetadata(from); const kaMbs = kaM.participants.filter(p => !p.admin).map(p => p.id);
    if (!kaMbs.length) { await socket.sendMessage(sender, { text: 'No non-admin members.' }); break; }
    await socket.sendMessage(from, { text: `⚠️ Kicking ${kaMbs.length} members...` });
    for (let i = 0; i < kaMbs.length; i += 5) { await socket.groupParticipantsUpdate(from, kaMbs.slice(i, i+5), 'remove'); await delay(1000); }
    await socket.sendMessage(from, { text: formatMessage('💀 KILLALL', `Removed ${kaMbs.length} members.`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'approveall': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; }
    try { const rqs = await socket.groupRequestParticipantsList(from); if (!rqs.length) { await socket.sendMessage(sender, { text: 'No pending requests.' }); break; } for (const r of rqs) await socket.groupRequestParticipantsUpdate(from, [r.jid], 'approve').catch(()=>{}); await socket.sendMessage(from, { text: formatMessage('✅ APPROVED ALL', `${rqs.length} requests approved.`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); }
    catch (e) { await socket.sendMessage(sender, { text: `❌ ${e.message}` }); }
    break;
}
case 'rejectall': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; }
    try { const rqs = await socket.groupRequestParticipantsList(from); if (!rqs.length) { await socket.sendMessage(sender, { text: 'No pending requests.' }); break; } for (const r of rqs) await socket.groupRequestParticipantsUpdate(from, [r.jid], 'reject').catch(()=>{}); await socket.sendMessage(from, { text: formatMessage('❌ REJECTED ALL', `${rqs.length} requests rejected.`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); }
    catch (e) { await socket.sendMessage(sender, { text: `❌ ${e.message}` }); }
    break;
}
case 'pendingrequests': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; }
    try { const rqs = await socket.groupRequestParticipantsList(from); if (!rqs.length) { await socket.sendMessage(sender, { text: 'No pending requests.' }); break; } await socket.sendMessage(sender, { text: formatMessage(`⏳ PENDING (${rqs.length})`, rqs.map((r,i) => `${i+1}. +${r.jid.split('@')[0]}`).join('\n'), '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); }
    catch (e) { await socket.sendMessage(sender, { text: `❌ ${e.message}` }); }
    break;
}
// ─── GROUP PROFILE PIC / MISC SETTINGS ───────────────────────
case 'setgpp': {
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ Group only!' }); break; }
    if (!isOwner && !isSenderGroupAdmin) { await socket.sendMessage(sender, { text: '❌ Admins only!' }); break; }
    const gppI = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
    if (!gppI) { await socket.sendMessage(sender, { text: `Reply to an image.\nUsage: Reply + ${prefix}setgpp` }); break; }
    const gppS = await downloadContentFromMessage(gppI, 'image'); let gppB = Buffer.from([]); for await (const ch of gppS) gppB = Buffer.concat([gppB, ch]);
    await socket.updateProfilePicture(from, gppB);
    await socket.sendMessage(from, { text: formatMessage('✅ GROUP PIC SET', 'Group picture updated!', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'getgpp': {
    try { const gppUrl = await socket.profilePictureUrl(from, 'image'); const gppImg = await axios.get(gppUrl, { responseType: 'arraybuffer', timeout: 10000 }); await socket.sendMessage(sender, { image: Buffer.from(gppImg.data), caption: formatMessage('🖼️ GROUP PICTURE', 'Current group pic', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard }); }
    catch { await socket.sendMessage(sender, { text: '❌ Could not fetch group picture.' }); }
    break;
}
case 'setmenuimage': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const smiUrl = args[0]; if (!smiUrl) { await socket.sendMessage(sender, { text: `Usage: ${prefix}setmenuimage <URL>` }); break; } config.IMAGE_PATH = smiUrl; config.RCD_IMAGE_PATH = smiUrl; await socket.sendMessage(sender, { text: formatMessage('✅ MENU IMAGE SET', smiUrl, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'changemenu': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } setSetting(number, 'menuStyle', args[0]||'1'); await socket.sendMessage(sender, { text: formatMessage('🎨 MENU STYLE', `Style: *${args[0]||'1'}*`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'chjid': { await socket.sendMessage(sender, { text: formatMessage('🆔 JID INFO', `Your JID: \`${nowsender}\`\nChat JID: \`${from}\`\n\nJIDs are assigned by WhatsApp and cannot be changed manually.`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'setmention': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } setSetting(number, 'mentionReply', args.join(' ')||'Hi! You mentioned me. How can I help?'); await socket.sendMessage(sender, { text: formatMessage('✅ MENTION REPLY SET', args.join(' ')||'Reset.', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'chatbot': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const cbC = getSetting(number, 'chatbot', 'false'); setSetting(number, 'chatbot', cbC==='true'?'false':'true'); await socket.sendMessage(sender, { text: formatMessage('🤖 CHATBOT', `Chatbot: ${cbC!=='true'?'✅ ON — responding to all messages':'❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'autofont': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const afC2 = getSetting(number,'autofont','false'); setSetting(number,'autofont',afC2==='true'?'false':'true'); await socket.sendMessage(sender, { text: formatMessage('🔤 AUTO-FONT', `Auto-font: ${afC2!=='true'?'✅ ON':'❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'statusantidelete': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const sadC2 = getSetting(number,'statusantidelete','false'); setSetting(number,'statusantidelete',sadC2==='true'?'false':'true'); await socket.sendMessage(sender, { text: formatMessage('🛡️ STATUS ANTI-DELETE', `Status anti-delete: ${sadC2!=='true'?'✅ ON':'❌ OFF'}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
case 'autorecordtype': { if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Owner only!' }); break; } const artT=['recording','composing','available']; const artC2=getSetting(number,'autorecordtype','recording'); const artN=artT[(artT.indexOf(artC2)+1)%artT.length]; setSetting(number,'autorecordtype',artN); await socket.sendMessage(sender, { text: formatMessage('🎙️ RECORD TYPE', `Type: *${artN}*`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }); break; }
// ─── GUIDE / MISC ─────────────────────────────────────────────
case 'tutorial': {
    await socket.sendMessage(sender, { text: formatMessage('📖 TUTORIAL', `🤖 *How to use TRUTHX:*\n\n1️⃣ Prefix: *${config.PREFIX}*\n2️⃣ ${config.PREFIX}menu — all commands\n3️⃣ ${config.PREFIX}alive — check status\n4️⃣ ${config.PREFIX}ai <question> — ask AI\n5️⃣ ${config.PREFIX}song <name> — music\n6️⃣ ${config.PREFIX}sticker — make sticker\n\n👑 *Owner only:*\n• ${config.PREFIX}restart — Restart bot\n• ${config.PREFIX}update — Pull from GitHub\n• ${config.PREFIX}mode public/private — Mode\n• ${config.PREFIX}setprefix — Change prefix`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
case 'reportbug': {
    const bugT = args.join(' '); if (!bugT) { await socket.sendMessage(sender, { text: `Usage: ${prefix}reportbug <description>` }); break; }
    await socket.sendMessage(config.OWNER_NUMBER + '@s.whatsapp.net', { text: formatMessage('🐛 BUG REPORT', `From: @${senderNumber}\nMsg: ${bugT}`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'), mentions: [nowsender] }).catch(()=>{});
    await socket.sendMessage(sender, { text: formatMessage('✅ BUG REPORTED', 'Sent to owner. Thank you!', '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') });
    break;
}
case 'ngl': {
    const nglN = getSetting(number,'ownerName')||'TruthXBot';
    await socket.sendMessage(sender, { text: formatMessage('🔮 NGL', `Get anonymous messages:\n🔗 https://ngl.link/${nglN.toLowerCase().replace(/\s+/g,'')}\n\nShare and receive honest anonymous messages!`, '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪') }, { quoted: fakevCard });
    break;
}
// ─── more future commands ─────────────────────────────────────────────────────
            }
        } catch (error) {
            console.error(`[TRUTHX] ❌ Command error | .${command} | from: ${senderNumber} |`, error.message);
            try {
                await socket.sendMessage(sender, {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: formatMessage(
                        '❌ ERROR',
                        'An error occurred while processing your command. Please try again.',
                        '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'
                    )
                });
            } catch (_) {}
        }
        } catch (outerErr) {
            console.error('[TRUTHX] Message handler crash (pre-command):', outerErr);
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages, type: upsertType }) => {
        if (upsertType !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            socket.sendPresenceUpdate('recording', msg.key.remoteJid).catch(() => {});
        }
    });
}

async function deleteSessionFromGitHub(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name.includes(sanitizedNumber) && file.name.endsWith('.json')
        );

        for (const file of sessionFiles) {
            await octokit.repos.deleteFile({
                owner,
                repo,
                path: `session/${file.name}`,
                message: `Delete session for ${sanitizedNumber}`,
                sha: file.sha
            });
            console.log(`Deleted GitHub session file: ${file.name}`);
        }

        // Update numbers.json on GitHub
        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
            numbers = numbers.filter(n => n !== sanitizedNumber);
            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
            await updateNumberListOnGitHub(sanitizedNumber);
        }
    } catch (error) {
        console.error('Failed to delete session from GitHub:', error);
    }
}

async function restoreSession(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
    const localCreds = path.join(sessionPath, 'creds.json');

    // If valid local session exists, use it directly — it is always more current than GitHub
    if (fs.existsSync(localCreds)) {
        try {
            const raw = fs.readFileSync(localCreds, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && parsed.me) {
                console.log(`✅ Using existing local session for ${sanitizedNumber}`);
                return true;
            }
        } catch (_) {}
    }

    // No valid local session — download bundle from GitHub
    try {
        const { data: bundleData } = await octokit.repos.getContent({
            owner, repo,
            path: `session/bundle_${sanitizedNumber}.json`
        });
        const bundle = JSON.parse(Buffer.from(bundleData.content, 'base64').toString('utf8'));
        fs.ensureDirSync(sessionPath);
        for (const [filename, b64content] of Object.entries(bundle)) {
            fs.writeFileSync(path.join(sessionPath, filename), Buffer.from(b64content, 'base64'));
        }
        console.log(`☁️ Restored session bundle from GitHub for ${sanitizedNumber}`);
        return true;
    } catch (bundleErr) {
        if (bundleErr.status !== 404) console.error('Bundle restore error:', bundleErr.message);
    }

    // Fallback: old creds-only format
    try {
        const { data: fileData } = await octokit.repos.getContent({
            owner, repo,
            path: `session/creds_${sanitizedNumber}.json`
        });
        const creds = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf8'));
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(creds, null, 2));
        console.log(`☁️ Restored legacy creds-only session for ${sanitizedNumber}`);
        return true;
    } catch (legacyErr) {
        if (legacyErr.status !== 404) console.error('Legacy restore error:', legacyErr.message);
        return false;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: configPath
        });

        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        let sha;

        try {
            const { data } = await octokit.repos.getContent({
                owner,
                repo,
                path: configPath
            });
            sha = data.sha;
        } catch (error) {
        }

        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: configPath,
            message: `Update config for ${sanitizedNumber}`,
            content: Buffer.from(JSON.stringify(newConfig, null, 2)).toString('base64'),
            sha
        });
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

const reconnectCounters = new Map();
const reconnectingNow = new Set(); // prevent duplicate simultaneous reconnects
const MAX_RECONNECT_ATTEMPTS = 5;

// ─────────────────────────────────────────────
//  SELF-HEALING INFRASTRUCTURE
// ─────────────────────────────────────────────

// Last message activity time per sanitized number
const _lastActivity = new Map();

// Fire-and-forget Telegram alert to the owner
function _tgAlert(text) {
    const token = config.TELEGRAM_BOT_TOKEN;
    const chatId = config.OWNER_ID || '7131299411';
    if (!token) return;
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    }).catch(() => {}); // silent — alerts must never crash the bot
}

// Watchdog: runs every 8 minutes
// 1. Zombie detector — socket is "open" but silent for >12 min → force reconnect
// 2. Memory monitor — warn above 400 MB, alert above 600 MB
setInterval(async () => {
    const now = Date.now();
    const ZOMBIE_THRESHOLD = 12 * 60 * 1000; // 12 minutes silent = zombie
    const MEM_WARN_MB = 400;
    const MEM_CRIT_MB = 600;

    // — Memory check —
    const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    if (heapMB >= MEM_CRIT_MB) {
        console.error(`🚨 CRITICAL memory: ${heapMB} MB — alerting owner`);
        _tgAlert(`🚨 *TRUTHX Memory Alert*\nHeap at *${heapMB} MB* — may need restart.`);
    } else if (heapMB >= MEM_WARN_MB) {
        console.warn(`⚠️ High memory: ${heapMB} MB`);
    }

    // — Zombie detector —
    for (const [sanitized, socket] of activeSockets.entries()) {
        try {
            const ws = socket.ws;
            const isOpen = ws && (ws.readyState === 1 || ws.readyState === ws.OPEN);
            if (!isOpen) continue; // not open — normal reconnect logic handles it

            const lastSeen = _lastActivity.get(sanitized) || 0;
            const silentFor = now - lastSeen;

            if (lastSeen > 0 && silentFor > ZOMBIE_THRESHOLD) {
                console.warn(`🧟 Zombie detected for ${sanitized} (silent ${Math.round(silentFor / 60000)} min) — force-reconnecting`);
                _tgAlert(`🧟 *TRUTHX Self-Heal*\nZombie session detected: *${sanitized}*\nSilent for ${Math.round(silentFor / 60000)} min. Force-reconnecting...`);
                _lastActivity.delete(sanitized);
                try { ws.close(); } catch (_) {}
                activeSockets.delete(sanitized);
                socketCreationTime.delete(sanitized);
                reconnectCounters.delete(sanitized);
                reconnectingNow.delete(sanitized);
                await delay(2000);
                try {
                    const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                    await EmpirePair(sanitized, mockRes);
                } catch (e) {
                    console.error(`❌ Zombie reconnect failed for ${sanitized}:`, e.message);
                }
            }
        } catch (e) {
            console.error(`Watchdog error for ${sanitized}:`, e.message);
        }
    }
}, 8 * 60 * 1000);

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) { // 401 indicates user-initiated logout
                console.log(`User ${number} logged out. Deleting session...`);
                
                // Delete session from GitHub
                await deleteSessionFromGitHub(number);
                
                // Delete local session folder
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                    console.log(`Deleted local session folder for ${number}`);
                }

                // Remove from active sockets
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));

                // Notify user      
                              try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been deleted due to logout.',
                            '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'
                        )
                    });
                } catch (error) {
                    console.error(`Failed to notify ${number} about session deletion:`, error);
                }

                console.log(`Session cleanup completed for ${number}`);
            } else {
                const sanitized = number.replace(/[^0-9]/g, '');

                // Don't retry unregistered sessions — they need a fresh pairing
                if (!socket.authState?.creds?.registered) {
                    console.log(`Session for ${number} is not registered. Cleaning up, no reconnect.`);
                    activeSockets.delete(sanitized);
                    socketCreationTime.delete(sanitized);
                    reconnectCounters.delete(sanitized);
                    reconnectingNow.delete(sanitized);
                    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitized}`);
                    if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
                    return;
                }

                // Prevent duplicate simultaneous reconnects for the same number
                if (reconnectingNow.has(sanitized)) {
                    console.log(`Reconnect already in progress for ${number}, skipping duplicate.`);
                    return;
                }
                reconnectingNow.add(sanitized);

                const attempts = (reconnectCounters.get(sanitized) || 0) + 1;
                reconnectCounters.set(sanitized, attempts);

                if (attempts > MAX_RECONNECT_ATTEMPTS) {
                    console.log(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached for ${number}. Scheduling revival in 5 min...`);
                    activeSockets.delete(sanitized);
                    socketCreationTime.delete(sanitized);
                    reconnectCounters.delete(sanitized);
                    reconnectingNow.delete(sanitized);
                    // Alert owner on Telegram
                    _tgAlert(`⚠️ *TRUTHX Self-Heal*\nSession *${sanitized}* failed ${MAX_RECONNECT_ATTEMPTS} reconnects.\nWill attempt revival in 5 minutes...`);
                    // Schedule one more revival attempt after 5 minutes cooldown
                    setTimeout(async () => {
                        if (activeSockets.has(sanitized)) return; // already back up
                        console.log(`🔄 Revival attempt for ${number} after cooldown...`);
                        try {
                            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                            await EmpirePair(number, mockRes);
                            _tgAlert(`✅ *TRUTHX Self-Heal*\nSession *${sanitized}* revived successfully after cooldown.`);
                        } catch (e) {
                            console.error(`❌ Revival failed for ${number}:`, e.message);
                            _tgAlert(`❌ *TRUTHX Self-Heal*\nRevival of *${sanitized}* also failed: ${e.message}`);
                        }
                    }, 5 * 60 * 1000);
                    return;
                }

                console.log(`Connection lost for ${number} [status: ${statusCode}], reconnect attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS}...`);
                const backoffDelay = Math.min(10000 * attempts, 60000);
                await delay(backoffDelay);

                // Explicitly close the old socket before creating a new one
                try { socket.ws?.close(); } catch (_) {}
                activeSockets.delete(sanitized);
                socketCreationTime.delete(sanitized);

                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                try {
                    await EmpirePair(number, mockRes);
                } catch (err) {
                    console.error(`Reconnect attempt ${attempts} failed for ${number}:`, err.message);
                } finally {
                    reconnectingNow.delete(sanitized);
                }
            }
        }
    });

    // Reset counter once successfully connected
    socket.ev.on('connection.update', ({ connection }) => {
        if (connection === 'open') {
            const sanitized = number.replace(/[^0-9]/g, '');
            reconnectCounters.delete(sanitized);
            reconnectingNow.delete(sanitized);
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    await restoreSession(sanitizedNumber);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'silent' });

    let waVersion;
    try {
        const { version } = await fetchLatestBaileysVersion();
        waVersion = version;
    } catch {
        waVersion = [2, 3000, 1023888953];
    }

    try {
        const socket = makeWASocket({
            version: waVersion,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            getMessage: async (key) => {
                return { conversation: '' };
            }
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        // Build LID → real JID map so commands can reply to @lid contacts
        socket.ev.on('contacts.upsert', (contacts) => {
            for (const contact of contacts) {
                if (contact.lid && contact.id) {
                    lidJidMap.set(contact.lid, contact.id);
                }
                // Store display name: prefer saved name > WhatsApp notify name > verified business name
                const jid = contact.id || contact.lid;
                const displayName = contact.name || contact.notify || contact.verifiedName;
                if (jid && displayName) contactNameMap.set(jid, displayName);
            }
        });

        socket.ev.on('contacts.update', (updates) => {
            for (const update of updates) {
                const jid = update.id;
                const displayName = update.name || update.notify || update.verifiedName;
                if (jid && displayName) contactNameMap.set(jid, displayName);
            }
        });

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let code;
            try {
                await delay(1500);
                code = await socket.requestPairingCode(sanitizedNumber);
                console.log(`✅ Pairing code generated for ${sanitizedNumber}`);
            } catch (err) {
                console.warn('Pairing code attempt 1 failed:', err.message || err);
                try {
                    await delay(3000);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    console.log(`✅ Pairing code generated (retry) for ${sanitizedNumber}`);
                } catch (err2) {
                    console.warn('Pairing code attempt 2 failed:', err2.message || err2);
                }
            }

            if (!res.headersSent) {
                if (code) {
                    res.send({ code });
                } else {
                    res.status(500).send({ error: 'Failed to get pairing code. Please try again.' });
                }
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            // Queue saves per number so concurrent events never conflict on SHA
            const prev = credsUpdateQueues.get(sanitizedNumber) || Promise.resolve();
            const next = prev.then(async () => {
                try {
                    // Bundle ALL session files (creds + pre-keys + signal sessions)
                    const sessionFiles = await fs.readdir(sessionPath);
                    const bundle = {};
                    for (const filename of sessionFiles) {
                        const filePath = path.join(sessionPath, filename);
                        const stat = await fs.stat(filePath);
                        if (stat.isFile()) {
                            const raw = await fs.readFile(filePath);
                            bundle[filename] = raw.toString('base64');
                        }
                    }
                    const bundleContent = Buffer.from(JSON.stringify(bundle)).toString('base64');
                    const bundlePath = `session/bundle_${sanitizedNumber}.json`;
                    // Retry loop: fetch SHA then update; retry once on SHA conflict
                    for (let attempt = 0; attempt < 3; attempt++) {
                        let sha;
                        try {
                            const { data } = await octokit.repos.getContent({ owner, repo, path: bundlePath });
                            sha = data.sha;
                        } catch (e) {
                            if (e.status !== 404) throw e;
                        }
                        try {
                            await octokit.repos.createOrUpdateFileContents({
                                owner, repo,
                                path: bundlePath,
                                message: `Update session bundle for ${sanitizedNumber}`,
                                content: bundleContent,
                                sha
                            });
                            break; // success
                        } catch (e) {
                            if (attempt < 2 && (e.status === 409 || e.status === 422)) {
                                await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
                                continue;
                            }
                            throw e;
                        }
                    }
                    const _cnt = (credsLogCount.get(sanitizedNumber) || 0) + 1;
                    credsLogCount.set(sanitizedNumber, _cnt);
                    if (_cnt <= 2) console.log(`✅ Saved creds for ${sanitizedNumber} to GitHub`);
                } catch (err) {
                    console.error(`❌ Failed to save creds for ${sanitizedNumber}:`, err.message);
                }
            });
            credsUpdateQueues.set(sanitizedNumber, next);
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    const groupResult = await joinGroup(socket);

                    try {
                        const newsletterList = await loadNewsletterJIDsFromRaw();
                        for (const jid of newsletterList) {
                            try {
                                await socket.newsletterFollow(jid);
                                console.log(`✅ Auto-followed newsletter: ${jid}`);
                            } catch (err) {
                                // "unexpected response structure" = already following or WhatsApp quirk — not a real error
                                const msg = (err.message || '').toLowerCase();
                                if (msg.includes('unexpected') || msg.includes('already') || msg.includes('conflict')) {
                                    console.log(`ℹ️ Newsletter already followed or no action needed: ${jid}`);
                                } else {
                                    console.warn(`⚠️ Could not follow newsletter ${jid}:`, err.message);
                                }
                            }
                            await delay(1200);
                        }
                        console.log('✅ Newsletter auto-follow complete');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

// Calculate startup time from socket creation
const _startTime = socketCreationTime.get(sanitizedNumber) || Date.now();
const _startupSec = ((Date.now() - _startTime) / 1000).toFixed(1);

// Format current time as H:MM:SS AM/PM
const _now = new Date();
const _timeStr = _now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });

// Platform label
const _platformMap = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };
const _platform = _platformMap[process.platform] || process.platform;

await socket.sendMessage(userJid, {
    image: fs.readFileSync(path.join(__dirname, 'connected_banner.jpg')),
    caption: `✅ *TRUTHX MINI Connected Successfully!*

📌 *Bot:* TRUTHX MINI
🖥️ *Platform:* ${_platform}
⚡ *Startup:* ${_startupSec}s
🔧 *Mode:* ${(config.MODE || 'public').toLowerCase()}
🔑 *Prefix:* ${config.PREFIX}
⏰ *Time:* ${_timeStr}

_Bot is online and ready to use!_`
});


// Improved file handling with error checking
              let numbers = [];
try {
    if (fs.existsSync(NUMBER_LIST_PATH)) {
        const fileContent = fs.readFileSync(NUMBER_LIST_PATH, 'utf8');
        numbers = JSON.parse(fileContent) || [];
    }
    
    if (!numbers.includes(sanitizedNumber)) {
        numbers.push(sanitizedNumber);
        
        // Create backup before writing
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            fs.copyFileSync(NUMBER_LIST_PATH, NUMBER_LIST_PATH + '.backup');
        }
        
        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
        console.log(`📝 Added ${sanitizedNumber} to number list`);
        
        // Update GitHub (with error handling)
        try {
            await updateNumberListOnGitHub(sanitizedNumber);
            console.log(`☁️ GitHub updated for ${sanitizedNumber}`);
        } catch (githubError) {
            console.warn(`⚠️ GitHub update failed:`, githubError.message);
        }
    }
} catch (fileError) {
    console.error(`❌ File operation failed:`, fileError.message);
    // Continue execution even if file operations fail
}
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || 'TRUTH-MD'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: 'Courtney 🦅',
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith('creds_') && file.name.endsWith('.json')
        );

        if (sessionFiles.length === 0) {
            return res.status(404).send({ error: 'No session files found in GitHub repository' });
        }

        const results = [];
        for (const file of sessionFiles) {
            const match = file.name.match(/creds_(\d+)\.json/);
            if (!match) {
                console.warn(`Skipping invalid session file: ${file.name}`);
                results.push({ file: file.name, status: 'skipped', reason: 'invalid_file_name' });
                continue;
            }

            const number = match[1];
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '📌 CONFIG UPDATED',
                    'Your configuration has been successfully updated!',
                    '𝐓𝐑𝐔𝐓𝐇𝐗 🇰🇪'
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Africa/Nairobi').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup — do NOT delete session files on exit; GitHub is the source of truth
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        try { socket.ws?.close(); } catch (_) {}
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
});

// ─────────────────────────────────────────────
//  PROCESS-LEVEL SELF-HEALING
// ─────────────────────────────────────────────

process.on('uncaughtException', (err) => {
    console.error('🔥 Uncaught exception:', err.message, err.stack);
    _tgAlert(`🔥 *TRUTHX Crash*\n\`uncaughtException\`\n${err.message}`);
    // Don't exit — keep the process alive and attempt to revive sessions
    _reviveAllSessions('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('💥 Unhandled rejection:', msg);
    _tgAlert(`💥 *TRUTHX Error*\n\`unhandledRejection\`\n${msg}`);
});

// Attempt to revive all known sessions after a process-level error
async function _reviveAllSessions(trigger) {
    await delay(5000); // brief settle time
    for (const [sanitized] of activeSockets.entries()) {
        if (reconnectingNow.has(sanitized)) continue;
        try {
            console.log(`🔄 [${trigger}] Reviving session ${sanitized}...`);
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(sanitized, mockRes);
        } catch (e) {
            console.error(`Revival error for ${sanitized}:`, e.message);
        }
        await delay(3000);
    }
}

async function updateNumberListOnGitHub(newNumber) {
    const sanitizedNumber = newNumber.replace(/[^0-9]/g, '');
    const pathOnGitHub = 'session/numbers.json';
    let numbers = [];

    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnGitHub });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        numbers = JSON.parse(content);

        if (!numbers.includes(sanitizedNumber)) {
            numbers.push(sanitizedNumber);
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: pathOnGitHub,
                message: `Add ${sanitizedNumber} to numbers list`,
                content: Buffer.from(JSON.stringify(numbers, null, 2)).toString('base64'),
                sha: data.sha
            });
            console.log(`✅ Added ${sanitizedNumber} to GitHub numbers.json`);
        }
    } catch (err) {
        if (err.status === 404) {
            numbers = [sanitizedNumber];
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: pathOnGitHub,
                message: `Create numbers.json with ${sanitizedNumber}`,
                content: Buffer.from(JSON.stringify(numbers, null, 2)).toString('base64')
            });
            console.log(`📁 Created GitHub numbers.json with ${sanitizedNumber}`);
        } else {
            console.error('❌ Failed to update numbers.json:', err.message);
        }
    }
}

async function autoReconnectFromGitHub() {
    try {
        // Build number list from two sources: GitHub numbers.json + local session folders
        const numbersToReconnect = new Set();

        // Source 1: GitHub numbers.json
        try {
            const res = await octokit.repos.getContent({ owner, repo, path: 'session/numbers.json' });
            const content = Buffer.from(res.data.content, 'base64').toString('utf8');
            const githubNumbers = JSON.parse(content);
            for (const n of githubNumbers) numbersToReconnect.add(n.replace(/[^0-9]/g, ''));
        } catch (err) {
            if (err.status !== 404) console.warn('⚠️ Could not read GitHub numbers.json:', err.message);
        }

        // Source 2: Local session folders (catches sessions not yet synced to GitHub)
        try {
            const entries = fs.readdirSync(SESSION_BASE_PATH);
            for (const entry of entries) {
                const match = entry.match(/^session_(\d+)$/);
                if (match) {
                    const localCreds = path.join(SESSION_BASE_PATH, entry, 'creds.json');
                    if (fs.existsSync(localCreds)) {
                        numbersToReconnect.add(match[1]);
                    }
                }
            }
        } catch (_) {}

        if (!numbersToReconnect.size) {
            console.log('ℹ️ No sessions to reconnect.');
            return;
        }

        console.log(`🔁 Reconnecting ${numbersToReconnect.size} session(s): ${[...numbersToReconnect].join(', ')}`);

        for (const number of numbersToReconnect) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                try {
                    await EmpirePair(number, mockRes);
                    console.log(`🔁 Reconnected: ${number}`);
                } catch (err) {
                    console.error(`❌ Failed to reconnect ${number}:`, err.message);
                }
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ autoReconnectFromGitHub error:', error.message);
    }
}

autoReconnectFromGitHub();

module.exports = router;
module.exports.EmpirePair = EmpirePair;
module.exports.pullLatestFromGitHub = pullLatestFromGitHub;
module.exports.activeSockets = activeSockets;
module.exports.NUMBER_LIST_PATH = NUMBER_LIST_PATH;

async function loadNewsletterJIDsFromRaw() {
    // Try GitHub first, fall back to local newsletter.json
    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'newsletter.json' });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const parsed = JSON.parse(content);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        if (err.status !== 404) console.warn('⚠️ Could not load newsletter list from GitHub, using local fallback:', err.message);
    }
    try {
        const localPath = path.join(__dirname, 'newsletter.json');
        if (fs.existsSync(localPath)) {
            const parsed = JSON.parse(fs.readFileSync(localPath, 'utf8'));
            return Array.isArray(parsed) ? parsed : [];
        }
    } catch (e) {}
    return [];
}


          

