import express from 'express';
import cors from 'cors';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import QRCode from 'qrcode';
import { GoogleGenerativeAI } from '@google/generative-ai';

// --- Server and AI Setup ---
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const genAI = new GoogleGenerativeAI("");
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-05-20" });

const activeSockets = new Map();

// --- CRITICAL NOTE ---
// This system requires a persistent filesystem to store session files.
// Use a service with a persistent disk (paid Render, Railway, etc.)
if (!fs.existsSync('./sessions')) fs.mkdirSync('./sessions');

// --- Main Connection Logic (Using the Correct Auth Function) ---
async function initializeWhatsAppConnection(sessionCode) {
    if (activeSockets.has(sessionCode)) return { sock: activeSockets.get(sessionCode) };

    const { state, saveCreds } = await useMultiFileAuthState(`sessions/auth_info_${sessionCode}`);
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: true,
        browser: ["Chrome (Linux)", "CampaignTool", "2.0"],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(`[${sessionCode}] Connection opened successfully.`);
            activeSockets.set(sessionCode, sock);
        } else if (connection === 'close') {
            activeSockets.delete(sessionCode);
            console.log(`[${sessionCode}] Connection closed.`);
            if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
                console.log(`[${sessionCode}] Logged out. Deleting session folder.`);
                fs.rmSync(`sessions/auth_info_${sessionCode}`, { recursive: true, force: true });
            }
        }
    });

    activeSockets.set(sessionCode, sock);
    return { sock };
}

// --- API Endpoints ---

app.post('/get-session-status', async (req, res) => {
    const { sessionCode } = req.body;
    if (!sessionCode) return res.status(400).json({ error: 'Session code required.' });

    const sessionDir = `sessions/auth_info_${sessionCode}`;
    if (fs.existsSync(sessionDir)) {
        await initializeWhatsAppConnection(sessionCode);
        return res.status(200).json({ status: 'connected' });
    }

    const { sock } = await initializeWhatsAppConnection(sessionCode);
    sock.ev.once('connection.update', async ({ qr }) => {
        if (qr) {
            try {
                const qrCodeUrl = await QRCode.toDataURL(qr);
                res.status(200).json({ status: 'qr_needed', qrCode: qrCodeUrl });
            } catch {
                res.status(500).json({ error: 'Failed to generate QR code.' });
            }
        }
    });
});

app.post('/generate-campaign-message', async (req, res) => {
    const { goal } = req.body;
    if (!goal) return res.status(400).json({ error: 'Goal is required.' });
    try {
        const systemPrompt = "You are a professional marketing copywriter. Based on the user's goal, write a short, engaging, and friendly WhatsApp message. Include the placeholder '{name}' to personalize the message. Provide only the message text as a single string.";
        const result = await model.generateContent({
            contents: [{ parts: [{ text: `Campaign Goal: ${goal}` }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] }
        });
        const message = result.response.text();
        res.status(200).json({ message });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate message.' });
    }
});

app.post('/start-campaign', (req, res) => {
    const { sessionCode, contacts, message } = req.body;
    const sock = activeSockets.get(sessionCode);

    if (!sock) return res.status(400).json({ error: 'Session not connected.' });
    if (!contacts || contacts.length === 0) return res.status(400).json({ error: 'Contacts list is empty.' });
    if (!message) return res.status(400).json({ error: 'Message is empty.' });

    res.status(200).json({ success: true, message: `Campaign started for ${contacts.length} contacts.` });

    let count = 0;
    const interval = setInterval(async () => {
        if (count >= contacts.length) {
            clearInterval(interval);
            console.log(`[${sessionCode}] Campaign finished.`);
            return;
        }

        const contact = contacts[count];
        const jid = contact.phone.replace(/\D/g, '') + '@s.whatsapp.net';
        const personalizedMessage = message.replace(/{name}/g, contact.name || '');

        try {
            await sock.sendMessage(jid, { text: personalizedMessage });
            console.log(`[${sessionCode}] Message sent to ${contact.name} (${contact.phone})`);
        } catch (error) {
            console.error(`[${sessionCode}] Failed to send to ${contact.name}: ${error.message}`);
        }
        
        count++;
    }, 8000);
});


app.listen(port, () => console.log(`WhatsApp Campaign Server listening on port ${port}`));
