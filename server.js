import express from 'express';
import cors from 'cors';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import { parsePhoneNumberFromString } from 'libphonenumber-js';


// --- Basic Server Setup ---
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// This map will store the connection status for each user trying to bind.
const userConnections = new Map();

// --- Main WhatsApp Connection Logic ---
async function initializeWhatsAppConnection(userId) {
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
    
    userConnections.set(userId, { sock, status: 'pending' });

    // Listen for connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        const userData = userConnections.get(userId);

        if (connection === 'open') {
            console.log(`[${userId}] Connection opened successfully.`);
            if(userData) userData.status = 'connected';
        } else if (connection === 'close') {
            console.log(`[${userId}] Connection closed. Reason: ${DisconnectReason[lastDisconnect?.error?.output?.statusCode]}`);
            if(userData) userData.status = 'disconnected';
            // Optional: Reconnect logic can be added here
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
        
        res.status(200).json({ pairingCode: formattedCode });

    } catch (error) {
        console.error(`[${userId}] Error requesting pairing code:`, error);
        res.status(500).json({ error: 'Failed to request pairing code. Please try again.' });
    }
});

// Endpoint for the app to check the binding status
app.get('/check-status/:userId', (req, res) => {
    const { userId } = req.params;
    const userData = userConnections.get(userId);
    const status = userData ? userData.status : 'not_found';
    console.log(`[${userId}] Status check requested. Current status: ${status}`);
    res.status(200).json({ status });
});

// Endpoint to send a message
app.post('/send-message', async (req, res) => {
    const { userId, recipient, message } = req.body;

    if (!userId || !recipient || !message) {
        return res.status(400).json({ error: 'User ID, recipient, and message are required.' });
    }

    const userData = userConnections.get(userId);
    if (!userData || userData.status !== 'connected') {
        return res.status(400).json({ error: 'User is not connected.' });
    }

    try {
        const phoneNumber = parsePhoneNumberFromString(recipient, 'IN'); // Assuming Indian numbers, change as needed
        if (!phoneNumber || !phoneNumber.isValid()) {
            return res.status(400).json({ error: 'Invalid recipient phone number.' });
        }
        
        const jid = `${phoneNumber.countryCallingCode}${phoneNumber.nationalNumber}@s.whatsapp.net`;
        
        await userData.sock.sendMessage(jid, { text: message });
        console.log(`[${userId}] Message sent to ${recipient}`);
        res.status(200).json({ success: true, message: 'Message sent successfully.' });

    } catch (error) {
        console.error(`[${userId}] Error sending message:`, error);
        res.status(500).json({ error: 'Failed to send message.' });
    }
});


// --- Start the Server ---
app.listen(port, () => {
    console.log(`WhatsApp backend server listening on port ${port}`);
});

