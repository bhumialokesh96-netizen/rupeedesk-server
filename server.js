import express from 'express';
import cors from 'cors';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import admin from 'firebase-admin';
import qrcode from 'qrcode';

// --- Firebase Admin Setup ---
const serviceAccount = JSON.parse(fs.readFileSync(new URL('./serviceAccountKey.json', import.meta.url)));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// --- Basic Server Setup ---
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// --- In-memory Storage for Connections & QR Codes ---
const userConnectionStatus = new Map();
const userSockets = new Map();
const userQrCodes = new Map();

// --- Main WhatsApp Connection Logic ---
async function initializeWhatsAppConnection(userId, isPairingCode = false) {
    if (userSockets.has(userId)) {
        console.log(`[${userId}] Terminating existing connection before creating a new one.`);
        try { await userSockets.get(userId).logout(); } catch (e) { console.error(`[${userId}] Error logging out from existing socket:`, e); }
        userSockets.delete(userId);
        userQrCodes.delete(userId);
    }
    
    const authDir = `auth_info_${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false, // We handle QR manually
        browser: ['Rupeedesk', 'Chrome', '1.0.0'], // Custom browser name
    });

    userSockets.set(userId, sock);
    userConnectionStatus.set(userId, 'pending');

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !isPairingCode) {
            console.log(`[${userId}] QR code received.`);
            try {
                const qrDataURL = await qrcode.toDataURL(qr);
                userQrCodes.set(userId, qrDataURL);
            } catch (qrErr) {
                console.error(`[${userId}] Error generating QR code:`, qrErr);
            }
        }

        if (connection === 'open') {
            console.log(`[${userId}] Connection opened successfully.`);
            userConnectionStatus.set(userId, 'connected');
            userQrCodes.delete(userId); // Clean up QR once connected
        } else if (connection === 'close') {
            const reason = lastDisconnect?.error?.toString() || 'Unknown';
            console.log(`[${userId}] Connection closed. Reason: ${reason}`);
            userConnectionStatus.set(userId, 'disconnected');
            userSockets.delete(userId);
            userQrCodes.delete(userId);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify' && msg.message) {
            console.log(`[${userId}] Processing new message for reward.`);
            try {
                const userRef = db.collection('users').doc(userId);
                const taskReward = 0.63;

                await db.runTransaction(async (transaction) => {
                    const userDoc = await transaction.get(userRef);
                    if (!userDoc.exists) throw new Error("User not found");
                    
                    const userData = userDoc.data();
                    const today = new Date().toISOString().slice(0, 10);
                    const todayCount = (userData.whatsappLastCountDate === today) ? (userData.whatsappTodayCount || 0) + 1 : 1;
                    
                    transaction.update(userRef, {
                        balance: admin.firestore.FieldValue.increment(taskReward),
                        whatsappMessageCount: admin.firestore.FieldValue.increment(1),
                        whatsappTodayCount: todayCount,
                        whatsappLastCountDate: today
                    });

                    if (userData.referrerId) {
                         const commissionAmount = taskReward * 0.10; // 10% commission
                         transaction.update(db.collection('users').doc(userData.referrerId), { balance: admin.firestore.FieldValue.increment(commissionAmount) });
                    }
                });
            } catch (error) {
                console.error(`[${userId}] Error processing reward:`, error);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
    return sock;
}

// --- API Endpoints ---
app.post('/request-pairing-code', async (req, res) => {
    const { phoneNumber, userId } = req.body;
    if (!phoneNumber || !userId) return res.status(400).json({ error: 'Phone number and user ID are required.' });
    
    try {
        const sock = await initializeWhatsAppConnection(userId, true);
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (!sock.ws.isOpen) throw new Error("WhatsApp connection failed to open.");

        const code = await sock.requestPairingCode(phoneNumber);
        const formattedCode = `${code.slice(0, 4)}-${code.slice(4, 8)}`;
        res.status(200).json({ pairingCode: formattedCode });
    } catch (error) {
        console.error(`[${userId}] Error with pairing code:`, error);
        userConnectionStatus.set(userId, 'error');
        res.status(500).json({ error: 'Failed to request pairing code. Please try again.' });
    }
});

app.get('/request-qr-code/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        await initializeWhatsAppConnection(userId, false);
        // Wait a few seconds for the QR code to be generated and stored
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const qrCodeData = userQrCodes.get(userId);
        if (qrCodeData) {
            res.status(200).json({ qrCode: qrCodeData });
        } else {
            throw new Error('QR code was not generated in time.');
        }
    } catch (error) {
        console.error(`[${userId}] Error requesting QR code:`, error);
        userConnectionStatus.set(userId, 'error');
        res.status(500).json({ error: 'Could not generate QR code. Please try again.' });
    }
});

app.get('/check-status/:userId', (req, res) => {
    const { userId } = req.params;
    const status = userConnectionStatus.get(userId) || 'not_found';
    res.status(200).json({ status });
});

app.listen(port, () => console.log(`WhatsApp backend server listening on port ${port}`));


