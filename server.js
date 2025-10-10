import express from 'express';
import cors from 'cors';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';

// --- Basic Server Setup ---
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// This map will store the connection status for each user trying to bind.
const userConnectionStatus = new Map();

// --- Main WhatsApp Connection Logic ---
async function initializeWhatsAppConnection(userId) {
    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${userId}`);
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false, // We will use pairing code, not QR
    });

    // Listen for connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(`[${userId}] Connection opened successfully.`);
            userConnectionStatus.set(userId, 'connected'); // Set status to connected
        } else if (connection === 'close') {
            console.log(`[${userId}] Connection closed. Reason: ${DisconnectReason[lastDisconnect?.error?.output?.statusCode]}`);
            userConnectionStatus.set(userId, 'disconnected'); // Set status to disconnected
        }
    });

    // Save credentials whenever they are updated
    sock.ev.on('creds.update', saveCreds);
    
    return sock;
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
        
        // IMPORTANT: Wait a moment for the socket to be ready before requesting the code
        await new Promise(resolve => setTimeout(resolve, 3000));

        const code = await sock.requestPairingCode(phoneNumber);
        const formattedCode = `${code.slice(0, 4)}-${code.slice(4, 8)}`;
        console.log(`[${userId}] Pairing code generated: ${formattedCode}`);
        
        userConnectionStatus.set(userId, 'pending'); // Set initial status
        res.status(200).json({ pairingCode: formattedCode });

    } catch (error) {
        console.error(`[${userId}] Error requesting pairing code:`, error);
        res.status(500).json({ error: 'Failed to request pairing code. Please try again.' });
    }
});

// NEW Endpoint for the app to check the binding status
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


