const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); // Update the path to your service account key

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://rupeedesk-135aa.firebaseio.com' // Replace with your database URL
});

const db = admin.database();
const auth = admin.auth();

module.exports = { db, auth };





