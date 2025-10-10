//server.js
// This is the backend server that handles the REAL WhatsApp communication.
// You must run this on a server environment like Heroku, AWS, or your own computer.

// --- 1. Import necessary libraries ---
// You'll need to install these using npm: npm install express @whiskeysockets/baileys
import express from 'express';
import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import cors from 'cors';

// --- 2. Setup Express Server ---
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json()); // Middleware to parse JSON bodies
app.use(cors()); // Middleware to allow requests from your frontend

// A simple Map to store active WhatsApp socket connections for different users
const whatsappConnections = new Map();

// --- 3. The Core API Endpoint ---
app.post('/request-pairing-code', async (req, res) => {
    const { phoneNumber, userId } = req.body;

    if (!phoneNumber || !userId) {
        return res.status(400).json({ error: 'phoneNumber and userId are required.' });
    }

    // Prevents creating multiple sockets for the same user
    if (whatsappConnections.has(userId)) {
        console.log(`Socket for user ${userId} already exists.`);
        // You might want to handle this case differently, e.g., by closing the old socket
    }

    try {
        console.log(`[${userId}] Setting up WhatsApp socket...`);
        
        // --- Baileys Socket Setup ---
        // This manages authentication credentials to stay logged in
        const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${userId}`);
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false, // We are using pairing code, not QR
        });

        // Store the socket connection
        whatsappConnections.set(userId, sock);

        // Listen for connection updates
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                console.log(`[${userId}] Connection closed.`, lastDisconnect?.error);
                whatsappConnections.delete(userId); // Clean up on disconnect
            } else if (connection === 'open') {
                console.log(`[${userId}] Connection opened successfully.`);
            }
        });
        
        // Listen for credential updates and save them
        sock.ev.on('creds.update', saveCreds);

        // --- Request the Pairing Code ---
        // This is the key function that communicates with WhatsApp
        console.log(`[${userId}] Requesting pairing code for +91${phoneNumber}`);
        const code = await sock.requestPairingCode(phoneNumber);
        
        // The code is 8 characters. We format it with a dash for display.
        const formattedCode = `${code.slice(0, 4)}-${code.slice(4, 8)}`;
        console.log(`[${userId}] Pairing code received: ${formattedCode}`);
        
        // Send the real code back to the frontend
        res.status(200).json({ pairingCode: formattedCode });

    } catch (error) {
        console.error(`[${userId}] Error during pairing code request:`, error);
        res.status(500).json({ error: 'Failed to request pairing code.' });
    }
});

// --- 4. Start the server ---
app.listen(port, () => {
    console.log(`WhatsApp backend server listening on port ${port}`);
});

