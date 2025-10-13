const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const { state, saveState } = useMultiFileAuthState('./auth_info');
const QRCode = require('qrcode');
const { db, auth } = require('./firebaseConfig'); // Import Firebase configuration

const userCompensations = {};

async function connectToWhatsApp() {
  const socket = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    pairingCode: '77777777' // Set your custom pairing code here
  });

  socket.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, pairingCode } = update;
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error as Error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('opened connection');
    } else if (pairingCode) {
      console.log('Pairing Code:', pairingCode);
      // Display the pairing code to the user
    }
  });

  socket.ev.on('messages.upsert', async (m) => {
    console.log(JSON.stringify(m, null, 2));
    // Handle incoming messages here
  });

  socket.ev.on('creds.update', saveState);
}

async function sendBulkMessages(contacts, message) {
  for (const contact of contacts) {
    await socket.sendMessage(contact, { text: message });
    // Compensate the user 0.63 per message
    compensateUser(contact, 0.63);
  }
}

function compensateUser(contact, amount) {
  if (!userCompensations[contact]) {
    userCompensations[contact] = 0;
  }
  userCompensations[contact] += amount;
  console.log(`Compensated ${contact} ${amount}. Total: ${userCompensations[contact]}`);

  // Optionally, save the compensation to Firebase
  db.ref(`compensations/${contact}`).set(userCompensations[contact]);
}

connectToWhatsApp();

// Example usage
const contacts = ['contact1@example.com', 'contact2@example.com', 'contact3@example.com'];
const message = 'Hello, this is a bulk message!';

sendBulkMessages(contacts, message);
