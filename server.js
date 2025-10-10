import express from 'express';
import cors from 'cors';
import baileys, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import QRCode from 'qrcode';

const makeWASocket = baileys.default;

// --- Server Setup ---
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const activeSockets = new Map();
if (!fs.existsSync('./sessions')) fs.mkdirSync('./sessions');

// --- Main Connection Logic ---
async function initializeWhatsAppConnection(sessionCode) {
    if (activeSockets.has(sessionCode)) return { sock: activeSockets.get(sessionCode) };

    const { state, saveCreds } = await useMultiFileAuthState(`sessions/auth_info_${sessionCode}`);
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: true,
        browser: ["Chrome (Linux)", "AdminPanel", "1.0"],
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(`[${sessionCode}] Connection opened.`);
            activeSockets.set(sessionCode, sock);
        } else if (connection === 'close') {
            activeSockets.delete(sessionCode);
            if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
                fs.rmSync(`sessions/auth_info_${sessionCode}`, { recursive: true, force: true });
            }
        }
    });

    activeSockets.set(sessionCode, sock);
    return { sock };
}

// --- API Endpoints ---

// Endpoint for the USER PANEL to connect or get a QR code
app.post('/connect-user', async (req, res) => {
    const { sessionCode } = req.body;
    if (!sessionCode) return res.status(400).json({ error: 'Session code required.' });

    const sessionDir = `sessions/auth_info_${sessionCode}`;
    if (fs.existsSync(sessionDir)) {
        await initializeWhatsAppConnection(sessionCode);
        return res.status(200).json({ status: 'connected' });
    }

    const { sock } = await initializeWhatsAppConnection(sessionCode);
    const qrListener = async (update) => {
        const { qr } = update;
        if (qr) {
            try {
                const qrCodeUrl = await QRCode.toDataURL(qr);
                res.status(200).json({ status: 'qr_needed', qrCode: qrCodeUrl });
                sock.ev.off('connection.update', qrListener);
            } catch (e) { 
                console.error("Failed to generate QR code", e);
                // Clean up listener on error
                sock.ev.off('connection.update', qrListener);
            }
        }
    };
    sock.ev.on('connection.update', qrListener);
});

// Endpoint for the ADMIN PANEL to send a message on behalf of a user
app.post('/admin/send-message', async (req, res) => {
    const { sessionCode, phoneNumber, message } = req.body;
    const sock = activeSockets.get(sessionCode);

    if (!sock) {
        return res.status(400).json({ error: `Session '${sessionCode}' is not connected.` });
    }
    const jid = phoneNumber.replace(/\D/g, '') + '@s.whatsapp.net';
    try {
        await sock.sendMessage(jid, { text: message });
        res.status(200).json({ success: true, message: `Message sent from ${sessionCode}.` });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send message.' });
    }
});

// Endpoint for the ADMIN PANEL to see who is connected
app.get('/admin/get-connected-sessions', (req, res) => {
    const connectedSessions = Array.from(activeSockets.keys());
    res.status(200).json({ sessions: connectedSessions });
});

app.listen(port, () => console.log(`Multi-Panel WhatsApp Server listening on port ${port}`));
