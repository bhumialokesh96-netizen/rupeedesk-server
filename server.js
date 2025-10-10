import express from 'express';
import cors from 'cors';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';

// --- Basic Server Setup ---
const app = express();
// Render sets the PORT environment variable, so we use that.
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// These maps store session data in memory. They are cleared when the server restarts.
const userConnectionStatus = new Map();
const activeSockets = new Map();

// --- Main WhatsApp Connection Logic ---
async function initializeWhatsAppConnection(userId) {
    if (activeSockets.has(userId)) {
        console.log(`[${userId}] Using existing, active connection.`);
        return activeSockets.get(userId);
    }

    // --- WARNING: EPHEMERAL FILESYSTEM ---
    // The 'auth_info' folder will be deleted when a free Render server sleeps.
    // This will log you out. For a permanent solution, you must use a database
    // to store the authentication state, not the local filesystem.
    const authDir = `auth_info_${userId}`;
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir);
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
    });

    // Listen for connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(`[${userId}] Connection opened successfully.`);
            userConnectionStatus.set(userId, 'connected');
            activeSockets.set(userId, sock);
        } else if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[${userId}] Connection closed. Reason: ${DisconnectReason[reason]}`);
            userConnectionStatus.set(userId, 'disconnected');
            activeSockets.delete(userId);

            // Reconnect on all disconnects except when logged out by the user
            if (reason !== DisconnectReason.loggedOut) {
                console.log(`[${userId}] Attempting to reconnect...`);
                setTimeout(() => initializeWhatsAppConnection(userId), 5000);
            }
        }
    });

    // Save credentials whenever they are updated
    sock.ev.on('creds.update', saveCreds);

    return sock;
}

// --- Get Active Socket ---
async function getActiveSocket(userId) {
    if (activeSockets.has(userId)) {
        return activeSockets.get(userId);
    }
    const authDir = `auth_info_${userId}`;
    if (fs.existsSync(authDir)) {
        return await initializeWhatsAppConnection(userId);
    }
    return null;
}

// --- API Endpoints ---

// Endpoint to request a pairing code
app.post('/request-pairing-code', async (req, res) => {
    const { phoneNumber, userId } = req.body;
    console.log(`[${userId}] Received pairing code request for ${phoneNumber}`);

    if (!phoneNumber || !userId) {
        return res.status(400).json({ error: 'Phone number and user ID are required.' });
    }

    try {
        const sock = await initializeWhatsAppConnection(userId);

        // --- IMPROVEMENT ---
        // Instead of a fixed wait, we now intelligently poll until the connection is ready.
        // This is much more reliable when the server is waking up from sleep.
        console.log(`[${userId}] Waiting for WhatsApp connection to open...`);
        let attempts = 0;
        while (!sock.ws?.isOpen && attempts < 20) { // Wait up to 10 seconds
            await new Promise(resolve => setTimeout(resolve, 500)); // Check every 0.5s
            attempts++;
        }

        if (!sock.ws?.isOpen) {
            console.error(`[${userId}] Connection failed to open in time.`);
            throw new Error('WhatsApp connection could not be established in time.');
        }
        console.log(`[${userId}] Connection is open. Requesting pairing code.`);

        const code = await sock.requestPairingCode(phoneNumber);
        const formattedCode = code.slice(0, 4) + '-' + code.slice(4, 8);
        console.log(`[${userId}] Pairing code generated: ${formattedCode}`);

        userConnectionStatus.set(userId, 'pending');
        res.status(200).json({ pairingCode: formattedCode });

    } catch (error) {
        console.error(`[${userId}] Error requesting pairing code:`, error.message);
        res.status(500).json({ error: 'Failed to request pairing code. Please try again.' });
    }
});


// Endpoint for your app to poll the binding/connection status
app.get('/check-status/:userId', (req, res) => {
    const { userId } = req.params;
    const status = userConnectionStatus.get(userId) || 'not_found';
    res.status(200).json({ status });
});

// Endpoint to send a WhatsApp message
app.post('/send-message', async (req, res) => {
    const { userId, phoneNumber, message } = req.body;

    if (!userId || !phoneNumber || !message) {
        return res.status(400).json({ error: 'userId, phoneNumber, and message are required.' });
    }

    try {
        const sock = await getActiveSocket(userId);

        if (!sock) {
            return res.status(400).json({ error: 'WhatsApp not connected for this user.' });
        }

        // Format number for WhatsApp JID
        let formattedNumber = phoneNumber.replace(/\D/g, '');
        if (formattedNumber.length === 10) {
            formattedNumber = '91' + formattedNumber; // Assuming Indian numbers
        }
        const jid = `${formattedNumber}@s.whatsapp.net`;

        await sock.sendMessage(jid, { text: message });
        console.log(`[${userId}] Message sent successfully to ${phoneNumber}`);
        res.status(200).json({ success: true, message: 'Message sent successfully' });

    } catch (error) {
        console.error(`[${userId}] Error sending message:`, error);
        res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
});


// Health check endpoint to verify the server is running
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', activeConnections: activeSockets.size });
});

// --- Start the Server ---
app.listen(port, () => {
    console.log(`WhatsApp backend server listening on port ${port}`);
});


