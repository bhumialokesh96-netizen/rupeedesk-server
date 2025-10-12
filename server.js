import express from 'express';
import cors from 'cors';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, WAMessageStubType } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { fileURLToPath } from 'url';
import path from 'path';

// --- Read Service Account Key ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');

let serviceAccount;
try {
    const rawData = fs.readFileSync(serviceAccountPath);
    serviceAccount = JSON.parse(rawData);
} catch (error) {
    console.error("FATAL ERROR: serviceAccountKey.json not found or invalid. Please ensure the file exists in the same directory as server.js.");
    process.exit(1);
}

// --- Firebase Admin Initialization ---
if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();

// --- Basic Server Setup ---
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// --- Global Connection Management ---
const activeConnections = new Map();
const userConnectionStatus = new Map();

// --- Main WhatsApp Connection Logic ---
async function initializeWhatsAppConnection(userId) {
    console.log(`[${userId}] Initializing or reconnecting WhatsApp connection...`);
    const authDir = `auth_info_${userId}`;
    
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
    });

    activeConnections.set(userId, sock);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrcode.toDataURL(qr, (err, url) => {
                if (err) {
                    console.error(`[${userId}] Error generating QR code`, err);
                    userConnectionStatus.set(userId, { status: 'error', reason: 'QR generation failed' });
                    return;
                }
                userConnectionStatus.set(userId, { status: 'pending_qr', qrCode: url });
            });
        }

        if (connection === 'open') {
            console.log(`[${userId}] Connection opened successfully.`);
            userConnectionStatus.set(userId, { status: 'connected' });
        } else if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`[${userId}] Connection closed. Reason: ${statusCode}`);
            activeConnections.delete(userId);
            userConnectionStatus.set(userId, { status: 'disconnected' });

            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`[${userId}] User logged out. Deleting auth info...`);
                if (fs.existsSync(authDir)) {
                    fs.rmSync(authDir, { recursive: true, force: true });
                }
                db.collection('users').doc(userId).update({ whatsAppBound: false });
            } else {
                console.log(`[${userId}] Attempting to reconnect...`);
                setTimeout(() => initializeWhatsAppConnection(userId), 10000);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || msg.messageStubType) {
             return;
        }

        const sender = msg.key.remoteJid;
        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || '[Non-text message]';
        
        console.log(`[FULL ACCESS LOG - User: ${userId}] Message from ${sender}: "${messageContent}"`);

        const rewardAmount = 0.63;
        try {
            const userRef = db.collection('users').doc(userId);
            const today = new Date().toISOString().slice(0, 10);

            await db.runTransaction(async (transaction) => {
                const userDoc = await transaction.get(userRef);
                if (!userDoc.exists) return;

                const userData = userDoc.data();
                const lastDate = userData.whatsappLastCountDate || '';
                let todayCount = userData.whatsappTodayCount || 0;
                
                if (lastDate !== today) {
                    todayCount = 0;
                }

                if (todayCount >= 200) {
                    console.log(`[${userId}] Daily message limit (200) reached. No reward.`);
                    return;
                }

                transaction.update(userRef, {
                    balance: FieldValue.increment(rewardAmount),
                    whatsappMessageCount: FieldValue.increment(1),
                    whatsappTodayCount: FieldValue.increment(1),
                    whatsappLastCountDate: today,
                });
            });
        } catch (error) {
            console.error(`[${userId}] Failed to process reward:`, error);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

async function reconnectExistingSessions() {
    console.log('Server starting... Reconnecting existing sessions.');
    try {
        const authDirs = fs.readdirSync('.', { withFileTypes: true })
            .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('auth_info_'))
            .map(dirent => dirent.name);

        for (const dir of authDirs) {
            const userId = dir.replace('auth_info_', '');
            console.log(`Found session for user: ${userId}. Reconnecting...`);
            await initializeWhatsAppConnection(userId).catch(err => {
                console.error(`[${userId}] Failed to reconnect on startup:`, err);
            });
        }
    } catch (error) {
        console.error("Could not read auth directories on startup:", error);
    }
}

// --- API Endpoints ---
app.post('/request-qr-code/:userId', async (req, res) => {
    const { userId } = req.params;
    if (activeConnections.has(userId)) return res.status(400).json({ error: 'Already connected.' });
    
    initializeWhatsAppConnection(userId).catch(err => console.error(`[${userId}] Init error:`, err));
    setTimeout(() => {
        const statusInfo = userConnectionStatus.get(userId);
        if (statusInfo && statusInfo.status === 'pending_qr') {
            res.status(200).json({ qrCode: statusInfo.qrCode });
        } else {
            res.status(500).json({ error: 'Failed to generate QR code.' });
        }
    }, 5000);
});

app.post('/request-pairing-code', async (req, res) => {
    const { phoneNumber, userId } = req.body;
    if (!phoneNumber || !userId) return res.status(400).json({ error: 'Phone number and user ID required.' });
    if (activeConnections.has(userId)) return res.status(400).json({ error: 'Already connected.' });
    
    try {
        const sock = makeWASocket({ logger: pino({ level: 'silent' }) });
        const code = await sock.requestPairingCode(phoneNumber);
        const formattedCode = `${code.slice(0, 4)}-${code.slice(4, 8)}`;
        
        initializeWhatsAppConnection(userId).catch(err => console.error(`[${userId}] Init error:`, err));
        
        res.status(200).json({ pairingCode: formattedCode });
    } catch (error) {
        console.error(`[${userId}] Pairing code error:`, error);
        res.status(500).json({ error: 'Failed to request pairing code.' });
    }
});

app.get('/check-status/:userId', (req, res) => {
    const { userId } = req.params;
    const statusInfo = userConnectionStatus.get(userId) || { status: 'not_found' };
    res.status(200).json(statusInfo);
});

// --- NEW ENDPOINT TO SEND MESSAGES ---
app.post('/send-message', async (req, res) => {
    const { userId, recipient, message } = req.body;

    // 1. Validate Input
    if (!userId || !recipient || !message) {
        return res.status(400).json({ error: 'Missing required fields: userId, recipient, message.' });
    }

    // 2. Find the Active Connection
    const sock = activeConnections.get(userId);
    if (!sock) {
        return res.status(404).json({ error: 'User is not connected. Please link the device first.' });
    }

    try {
        // 3. Format the recipient's phone number into a JID (WhatsApp ID)
        const jid = `${recipient}@s.whatsapp.net`;
        
        // 4. Send the message
        await sock.sendMessage(jid, { text: message });
        
        console.log(`[${userId}] Sent message to ${recipient}: "${message}"`);
        res.status(200).json({ success: true, message: 'Message sent successfully.' });
    } catch (error) {
        console.error(`[${userId}] Failed to send message:`, error);
        res.status(500).json({ error: 'Failed to send message.' });
    }
});


// --- Start the Server ---
app.listen(port, () => {
    console.log(`WhatsApp backend server listening on port ${port}`);
    reconnectExistingSessions();
});


