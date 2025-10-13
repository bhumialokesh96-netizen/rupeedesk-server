import express from 'express';
import cors from 'cors';
// This import now correctly points to the 'baileys-mod' package
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import { Boom } from '@hapi/boom';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { fileURLToPath } from 'url';
import path from 'path';
import https from 'https';

// --- Firebase and Server Setup ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath));

if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();

const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const activeConnections = new Map();

// --- Message Listener Logic ---
function addMessageListener(sock, userId) {
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || msg.messageStubType) return;
        
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
                if (lastDate !== today) todayCount = 0;
                if (todayCount >= 200) return;

                transaction.update(userRef, {
                    balance: FieldValue.increment(rewardAmount),
                    whatsappMessageCount: FieldValue.increment(1),
                    whatsappTodayCount: FieldValue.increment(1),
                    whatsappLastCountDate: today,
                });
            });
        } catch (error) { console.error(`[${userId}] Failed to process reward:`, error); }
    });
}

// --- Main WhatsApp Connection Logic ---
async function initializeWhatsAppConnection(userId) {
    const authDir = `auth_info_${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, logger: pino({ level: 'silent' }), auth: state, printQRInTerminal: false, browser: ['Rupeedesk', 'Desktop', '1.0.0'] });
    
    activeConnections.set(userId, sock);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(`[${userId}] Connection successful.`);
            const whatsappNumber = sock.user.id.split(':')[0];
            await db.collection('users').doc(userId).update({ whatsAppNumber });
            addMessageListener(sock, userId);
        } else if (connection === 'close') {
            activeConnections.delete(userId);
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut) {
                if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
                await db.collection('users').doc(userId).update({ whatsAppNumber: null });
            } else {
                // Attempt to reconnect for other reasons
                setTimeout(() => initializeWhatsAppConnection(userId), 10000);
            }
        }
    });
    sock.ev.on('creds.update', saveCreds);
}

// --- Reconnect on Server Start ---
async function reconnectExistingSessions() {
    const authDirs = fs.readdirSync('.', { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith('auth_info_')).map(d => d.name);
    for (const dir of authDirs) {
        const userId = dir.replace('auth_info_', '');
        await initializeWhatsAppConnection(userId).catch(err => console.error(`[${userId}] Failed to reconnect:`, err));
    }
}

// --- API Endpoints ---
app.get('/', (req, res) => res.status(200).json({ status: 'online', message: 'Rupeedesk server is running with baileys-mod.' }));

app.post('/request-pairing-code', async (req, res) => {
    let { phoneNumber, userId } = req.body;
    if (!phoneNumber || !userId) return res.status(400).json({ error: 'Phone number and user ID are required.' });
    
    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
    if (phoneNumber.length === 10) phoneNumber = '91' + phoneNumber;

    if (activeConnections.has(userId)) await activeConnections.get(userId).logout().catch(() => {});
    const authDir = `auth_info_${userId}`;
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, logger: pino({ level: 'silent' }), auth: state, printQRInTerminal: false, browser: ['Rupeedesk', 'Desktop', '1.0.0'] });

    sock.ev.on('connection.update', (update) => {
        if (update.connection === 'open') {
            initializeWhatsAppConnection(userId);
        }
    });
    sock.ev.on('creds.update', saveCreds);

    try {
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Define your custom 8-digit code
        const customPairingCode = "77777777";
        // Pass the custom code as the second argument
        const code = await sock.requestPairingCode(phoneNumber, customPairingCode);
        
        const formattedCode = `${code.slice(0, 4)}-${code.slice(4, 8)}`;
        
        res.status(200).json({ pairingCode: formattedCode });
    } catch (error) {
        console.error(`[${userId}] Failed to request pairing code:`, error);
        res.status(500).json({ error: 'Failed to request pairing code. Please try again.' });
    }
});

// --- Server Start and Keep-Alive ---
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    reconnectExistingSessions();
    if (process.env.RENDER_EXTERNAL_HOSTNAME) {
        const RENDER_URL = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
        setInterval(() => https.get(RENDER_URL).on('error', (err) => console.error("Ping Error:", err.message)), 10 * 60 * 1000);
    }
});
