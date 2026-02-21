import express from 'express';
import fs from 'fs-extra';
import pino from 'pino';
import pn from 'awesome-phonenumber';
import {
    makeWASocket, useMultiFileAuthState, delay,
    makeCacheableSignalKeyStore, Browsers, jidNormalizedUser,
    fetchLatestBaileysVersion, DisconnectReason
} from '@whiskeysockets/baileys';
import { upload as megaUpload } from './mega.js';

const router = express.Router();
const MAX_RECONNECT_ATTEMPTS = 3;
const SESSION_TIMEOUT = 5 * 60 * 1000;
const CLEANUP_DELAY = 5000;

const MESSAGE = `
*SESSION GENERATED SUCCESSFULLY* ✅

*GROQ--WHATSAPP* 🥀`;

async function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        await fs.remove(FilePath);
        return true;
    } catch (e) { console.error('Error removing file:', e); return false; }
}

function randomMegaId(len = 6, numLen = 4) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return `${out}${Math.floor(Math.random() * Math.pow(10, numLen))}`;
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    if (!num) {
        res.set('Content-Type', 'text/plain');
        return res.status(400).send('Phone number is required');
    }

    num = num.replace(/[^0-9]/g, '');
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        res.set('Content-Type', 'text/plain');
        return res.status(400).send('Invalid phone number.');
    }
    num = phone.getNumber('e164').replace('+', '');

    const sessionId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const dirs = `./auth_info_baileys/bot_session_${sessionId}`;

    let pairingCodeSent = false, sessionCompleted = false, isCleaningUp = false;
    let responseSent = false, reconnectAttempts = 0, currentSocket = null, timeoutHandle = null;

    async function cleanup(reason = 'unknown') {
        if (isCleaningUp) return;
        isCleaningUp = true;
        console.log(`🧹 Cleanup bot session ${sessionId} (${num}) - ${reason}`);
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        if (currentSocket) {
            try { currentSocket.ev.removeAllListeners(); await currentSocket.end(); } catch (e) {}
            currentSocket = null;
        }
        setTimeout(async () => { await removeFile(dirs); }, CLEANUP_DELAY);
    }

    async function initiateSession() {
        if (sessionCompleted || isCleaningUp) return;
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            if (!responseSent && !res.headersSent) {
                responseSent = true;
                res.set('Content-Type', 'text/plain');
                res.status(503).send('Connection failed after multiple attempts');
            }
            await cleanup('max_reconnects'); return;
        }
        try {
            if (!fs.existsSync(dirs)) await fs.mkdir(dirs, { recursive: true });
            const { state, saveCreds } = await useMultiFileAuthState(dirs);
            const { version } = await fetchLatestBaileysVersion();

            if (currentSocket) {
                try { currentSocket.ev.removeAllListeners(); await currentSocket.end(); } catch (e) {}
            }

            currentSocket = makeWASocket({
                version,
                auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })) },
                printQRInTerminal: false, logger: pino({ level: "silent" }),
                browser: Browsers.macOS('Chrome'), markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false, defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000, keepAliveIntervalMs: 30000, retryRequestDelayMs: 250, maxRetries: 3,
            });

            const sock = currentSocket;

            sock.ev.on('connection.update', async (update) => {
                if (isCleaningUp) return;
                const { connection, lastDisconnect, isNewLogin } = update;

                if (connection === 'open') {
                    if (sessionCompleted) return;
                    sessionCompleted = true;
                    try {
                        const credsFile = `${dirs}/creds.json`;
                        if (fs.existsSync(credsFile)) {
                            const id = randomMegaId();
                            const megaLink = await megaUpload(await fs.readFile(credsFile), `${id}.json`);
                            const megaSessionId = megaLink.replace('https://mega.nz/file/', '');
                            const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                            const msg = await sock.sendMessage(userJid, { text: megaSessionId });
                            await sock.sendMessage(userJid, { text: MESSAGE, quoted: msg });
                            await delay(1000);
                        }
                    } catch (err) { console.error('Error sending session:', err); }
                    finally { await cleanup('session_complete'); }
                }

                if (isNewLogin) console.log(`🔐 New bot login via pair code for ${num}`);

                if (connection === 'close') {
                    if (sessionCompleted || isCleaningUp) { await cleanup('already_complete'); return; }
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                        if (!responseSent && !res.headersSent) {
                            responseSent = true;
                            res.set('Content-Type', 'text/plain');
                            res.status(401).send('Invalid pairing code or session expired');
                        }
                        await cleanup('logged_out');
                    } else if (pairingCodeSent && !sessionCompleted) {
                        reconnectAttempts++;
                        await delay(2000); await initiateSession();
                    } else { await cleanup('connection_closed'); }
                }
            });

            if (!sock.authState.creds.registered && !pairingCodeSent && !isCleaningUp) {
                await delay(1500);
                try {
                    pairingCodeSent = true;
                    let code = await sock.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        // ✅ Plain text response — just the code, no JSON, no HTML
                        res.set('Content-Type', 'text/plain');
                        res.send(code);
                    }
                } catch (error) {
                    pairingCodeSent = false;
                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.set('Content-Type', 'text/plain');
                        res.status(503).send('Failed to get pairing code');
                    }
                    await cleanup('pairing_code_error');
                }
            }

            sock.ev.on('creds.update', saveCreds);

            timeoutHandle = setTimeout(async () => {
                if (!sessionCompleted && !isCleaningUp) {
                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.set('Content-Type', 'text/plain');
                        res.status(408).send('Pairing timeout');
                    }
                    await cleanup('timeout');
                }
            }, SESSION_TIMEOUT);

        } catch (err) {
            console.error(`❌ Error initializing bot session for ${num}:`, err);
            if (!responseSent && !res.headersSent) {
                responseSent = true;
                res.set('Content-Type', 'text/plain');
                res.status(503).send('Service Unavailable');
            }
            await cleanup('init_error');
        }
    }

    await initiateSession();
});

export default router;
