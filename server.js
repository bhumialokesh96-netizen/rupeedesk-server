import express from 'express';
import cors from 'cors';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';

// --- Basic Server Setup ---
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// This map will store the connection status for each user trying to bind.
const userConnectionStatus = new Map();
// This map will store active WhatsApp socket connections
const activeSockets = new Map();

// --- Main WhatsApp Connection Logic ---
async function initializeWhatsAppConnection(userId) {
    // Check if socket already exists and is connected
    if (activeSockets.has(userId)) {
        console.log(`${userId} Using existing connection.`);
        return activeSockets.get(userId);
    }

    // Ensure the auth directory exists
    const authDir = `auth_info_${userId}`;
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir);
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false, // We will use pairing code, not QR
    });

    // Listen for connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(`${userId} Connection opened successfully.`);
            userConnectionStatus.set(userId, 'connected');
            activeSockets.set(userId, sock);
        } else if (connection === 'close') {
            console.log(`${userId} Connection closed. Reason: ${DisconnectReason[lastDisconnect?.error?.output?.statusCode]}`);
            userConnectionStatus.set(userId, 'disconnected');
            activeSockets.delete(userId);

            // Auto-reconnect logic if needed
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log(`${userId} Attempting to reconnect...`);
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

    // Try to initialize if auth exists
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
    console.log(`${userId} Received pairing code request for ${phoneNumber}`);

    if (!phoneNumber || !userId) {
        return res.status(400).json({ error: 'Phone number and user ID are required.' });
    }

    try {
        const sock = await initializeWhatsAppConnection(userId);

        // IMPORTANT: Wait a moment for the socket to be ready before requesting the code
        await new Promise(resolve => setTimeout(resolve, 3000));

        const code = await sock.requestPairingCode(phoneNumber);
        const formattedCode = `${code.slice(0, 4)}-${code.slice(4, 8)}`;
        console.log(`${userId} Pairing code generated: ${formattedCode}`);

        userConnectionStatus.set(userId, 'pending');
        res.status(200).json({ pairingCode: formattedCode });

    } catch (error) {
        console.error(`${userId} Error requesting pairing code:`, error);
        res.status(500).json({ error: 'Failed to request pairing code. Please try again.' });
    }
});

// Endpoint for the app to check the binding status
app.get('/check-status/:userId', (req, res) => {
    const { userId } = req.params;
    const status = userConnectionStatus.get(userId) || 'not_found';
    console.log(`${userId} Status check requested. Current status: ${status}`);
    res.status(200).json({ status });
});

// Endpoint to send WhatsApp message
app.post('/send-message', async (req, res) => {
    const { userId, phoneNumber, message } = req.body;

    console.log(`${userId} Received message send request for ${phoneNumber}`);

    if (!userId || !phoneNumber || !message) {
        return res.status(400).json({ error: 'userId, phoneNumber, and message are required.' });
    }

    try {
        const sock = await getActiveSocket(userId);

        if (!sock) {
            return res.status(400).json({ error: 'WhatsApp not connected for this user.' });
        }

        // Format phone number for WhatsApp (add country code if needed)
        // Assuming Indian numbers, add 91 if not present
        let formattedNumber = phoneNumber.replace(/\D/g, '');
        if (formattedNumber.length === 10) {
            formattedNumber = '91' + formattedNumber;
        }

        const jid = `${formattedNumber}@s.whatsapp.net`;

        // Send message
        await sock.sendMessage(jid, { text: message });

        console.log(`${userId} Message sent successfully to ${phoneNumber}`);
        res.status(200).json({
            success: true,
            message: 'Message sent successfully',
            to: phoneNumber
        });

    } catch (error) {
        console.error(`${userId} Error sending message:`, error);
        res.status(500).json({
            error: 'Failed to send message',
            details: error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        activeConnections: activeSockets.size,
        timestamp: new Date().toISOString()
    });
});

// --- Start the Server ---
app.listen(port, () => {
    console.log(`WhatsApp backend server listening on port ${port}`);
});
