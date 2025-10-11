import express from 'express';
import cors from 'cors';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import admin from 'firebase-admin';

// --- Firebase Admin Setup ---
// Make sure you have the serviceAccountKey.json in the same directory
import serviceAccount from './serviceAccountKey.json' assert { type: 'json' };

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// --- Basic Server Setup ---
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// These maps will store connection status and active sockets for each user.
const userConnectionStatus = new Map();
const userSockets = new Map();


// --- Main WhatsApp Connection Logic ---
async function initializeWhatsAppConnection(userId) {
    // Clean up any existing connection for this user
    if (userSockets.has(userId)) {
        console.log(`[${userId}] Found existing connection. Terminating before creating a new one.`);
        try {
            await userSockets.get(userId).logout();
        } catch (e) {
            console.error(`[${userId}] Error logging out from existing socket:`, e);
        }
        userSockets.delete(userId);
    }
    
    const authDir = `auth_info_${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
    });

    userSockets.set(userId, sock); // Store the active socket

    // Listen for connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(`[${userId}] Connection opened successfully.`);
            userConnectionStatus.set(userId, 'connected');
        } else if (connection === 'close') {
            console.log(`[${userId}] Connection closed. Reason: ${lastDisconnect?.error?.toString()}`);
            userConnectionStatus.set(userId, 'disconnected');
            userSockets.delete(userId); // Remove socket on close
        }
    });

    // Listen for incoming messages to process rewards
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        // Ensure message is valid, new, and not from the user themselves
        if (!msg.key.fromMe && m.type === 'notify' && msg.message) {
            console.log(`[${userId}] Received a new message.`);
            try {
                const userRef = db.collection('users').doc(userId);
                const statsRef = db.collection('app_stats').doc('whatsapp');
                const taskReward = 0.63;

                await db.runTransaction(async (transaction) => {
                    const userDoc = await transaction.get(userRef);
                    if (!userDoc.exists) return;
                    
                    const userData = userDoc.data();

                    // 1. Update user's balance and message count
                    transaction.update(userRef, {
                        balance: admin.firestore.FieldValue.increment(taskReward),
                        whatsappMessageCount: admin.firestore.FieldValue.increment(1)
                    });

                    // 2. Update global message count
                    transaction.set(statsRef, { 
                        totalMessages: admin.firestore.FieldValue.increment(1) 
                    }, { merge: true });

                    // 3. Handle referral commission if a referrer exists
                    if (userData.referrerId) {
                        const commissionRate = 0.10; // 10% commission
                        const commissionAmount = taskReward * commissionRate;
                        const referrerRef = db.collection('users').doc(userData.referrerId);
                        
                        // Give commission to referrer
                        transaction.update(referrerRef, {
                            balance: admin.firestore.FieldValue.increment(commissionAmount)
                        });

                        // Update total commission earned in the referral document
                        const referralQuery = await db.collection("referrals")
                            .where("refereeId", "==", userId)
                            .where("referrerId", "==", userData.referrerId)
                            .limit(1).get();

                        if (!referralQuery.empty) {
                            const referralDocRef = referralQuery.docs[0].ref;
                            transaction.update(referralDocRef, {
                                totalCommissionEarned: admin.firestore.FieldValue.increment(commissionAmount)
                            });
                        }
                    }
                });
                console.log(`[${userId}] Successfully processed message reward.`);
            } catch (error) {
                console.error(`[${userId}] Error processing message reward:`, error);
            }
        }
    });

    // Save credentials whenever they are updated
    sock.ev.on('creds.update', saveCreds);
    
    return sock;
}

// --- API Endpoints ---
app.post('/request-pairing-code', async (req, res) => {
    const { phoneNumber, userId } = req.body;
    console.log(`[${userId}] Received pairing code request for ${phoneNumber}`);

    if (!phoneNumber || !userId) {
        return res.status(400).json({ error: 'Phone number and user ID are required.' });
    }
    
    try {
        const sock = await initializeWhatsAppConnection(userId);
        
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Check if socket is ready before requesting code
        if (!sock.ws.isOpen) {
             throw new Error("WebSocket connection is not open.");
        }

        const code = await sock.requestPairingCode(phoneNumber);
        const formattedCode = `${code.slice(0, 4)}-${code.slice(4, 8)}`;
        console.log(`[${userId}] Pairing code generated: ${formattedCode}`);
        
        userConnectionStatus.set(userId, 'pending');
        res.status(200).json({ pairingCode: formattedCode });

    } catch (error) {
        console.error(`[${userId}] Error requesting pairing code:`, error);
        userConnectionStatus.set(userId, 'error');
        res.status(500).json({ error: 'Failed to request pairing code. Please try again.' });
    }
});

app.get('/check-status/:userId', (req, res) => {
    const { userId } = req.params;
    const status = userConnectionStatus.get(userId) || 'not_found';
    console.log(`[${userId}] Status check requested. Current status: ${status}`);
    res.status(200).json({ status });
});

// --- Start the Server ---
app.listen(port, () => {
    console.log(`WhatsApp backend server listening on port ${port}`);
});

