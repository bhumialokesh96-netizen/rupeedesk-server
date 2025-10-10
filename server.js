import express from 'express';
import cors from 'cors';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import QRCode from 'qrcode';

// --- Basic Server Setup ---
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// This map stores all session data for each user (status, sock, qr, etc.)
const sessionData = new Map();

// --- Main WhatsApp Connection Logic ---
async function initializeWhatsAppConnection(userId, isPairingCode = false, phoneNumber = null) {
    // Clean up any previous connection attempts for this user to avoid conflicts
    if (sessionData.has(userId) && sessionData.get(userId).sock) {
        console.log(`[${userId}] Closing existing socket before creating a new one.`);
        try {
            // This will trigger the 'connection.close' event for the old socket
            await sessionData.get(userId).sock.logout();
        } catch (error) {
            console.log(`[${userId}] Old socket already closed or failed to logout: ${error.message}`);
        }
    }

    // --- CRITICAL NOTE FOR RENDER USERS ---
    // The 'auth_info' folder is temporary on Render's free plan.
    // It will be DELETED when the server sleeps, logging you out.
    // For a permanent solution, use a server with persistent storage.
    const authDir = `auth_info_${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: !isPairingCode,
        browser: ["Chrome (Linux)", "", ""], // Helps identify the session
    });

    // Store the new socket and initial status
    sessionData.set(userId, { sock, status: 'initializing', qr: null, code: null });

    // If using pairing code, request it after a brief delay for the socket to init
    if (isPairingCode && phoneNumber) {
        setTimeout(async () => {
            try {
                if (sock.ws.isOpen) {
                    const code = await sock.requestPairingCode(phoneNumber);
                    const formattedCode = code.slice(0, 4) + '-' + code.slice(4, 8);
                    sessionData.get(userId).code = formattedCode;
                    sessionData.get(userId).status = 'code_ready';
                    console.log(`[${userId}] Pairing code generated: ${formattedCode}`);
                } else {
                     throw new Error("Socket not open, can't request pairing code.");
                }
            } catch (error) {
                 console.error(`[${userId}] Failed to request pairing code:`, error);
                 sessionData.get(userId).status = 'error';
            }
        }, 4000); // 4-second delay
    }

    // Listen for all connection events
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const session = sessionData.get(userId);
        if (!session) return; // If session was cleared, do nothing

        if (qr && !isPairingCode) {
            try {
                const qrCodeUrl = await QRCode.toDataURL(qr);
                session.qr = qrCodeUrl;
                session.status = 'qr_ready';
                console.log(`[${userId}] QR code is ready.`);
            } catch (err) {
                console.error(`[${userId}] Failed to generate QR code:`, err);
                session.status = 'error';
            }
        }

        if (connection === 'open') {
            session.status = 'connected';
            session.qr = null; // Clear QR/code data on successful connection
            session.code = null;
            console.log(`[${userId}] Connection opened successfully.`);
        } else if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            session.status = 'disconnected';
            console.log(`[${userId}] Connection closed. Reason: ${DisconnectReason[reason]}`);

            if (reason === DisconnectReason.loggedOut) {
                console.log(`[${userId}] User logged out. Clearing auth files.`);
                fs.rmSync(authDir, { recursive: true, force: true });
                sessionData.delete(userId); // Completely remove session on logout
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// --- API Endpoints ---

app.post('/start-qr', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'User ID is required.' });
    console.log(`[${userId}] Starting QR connection process.`);
    initializeWhatsAppConnection(userId, false);
    res.status(200).json({ message: 'QR connection process started.' });
});

app.post('/start-pairing', (req, res) => {
    const { userId, phoneNumber } = req.body;
    if (!userId || !phoneNumber) return res.status(400).json({ error: 'User ID and phone number are required.' });
    console.log(`[${userId}] Starting pairing code process for ${phoneNumber}.`);
    initializeWhatsAppConnection(userId, true, phoneNumber);
    res.status(200).json({ message: 'Pairing code process started.' });
});

app.get('/check-status/:userId', (req, res) => {
    const { userId } = req.params;
    const session = sessionData.get(userId);

    if (!session) {
        return res.status(200).json({ status: 'not_found', qr: null, code: null });
    }
    
    const response = { status: session.status, qr: session.qr, code: session.code };
    if (session.qr) session.qr = null; // Send QR only once to prevent re-use
    if (session.code) session.code = null; // Send code only once

    res.status(200).json(response);
});

app.post('/send-message', async (req, res) => {
    const { userId, phoneNumber, message } = req.body;
    const session = sessionData.get(userId);

    if (!session || session.status !== 'connected' || !session.sock) {
        return res.status(400).json({ error: 'WhatsApp not connected for this user.' });
    }
    
    let formattedNumber = phoneNumber.replace(/\D/g, '');
    if (formattedNumber.length === 10) formattedNumber = '91' + formattedNumber;
    const jid = `${formattedNumber}@s.whatsapp.net`;

    try {
        await session.sock.sendMessage(jid, { text: message });
        res.status(200).json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        console.error(`[${userId}] Error sending message:`, error);
        res.status(500).json({ error: 'Failed to send message.' });
    }
});

app.listen(port, () => {
    console.log(`WhatsApp Dual-Method server listening on port ${port}`);
});
