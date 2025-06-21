const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const app = express();
app.use(cors());
app.use(express.json({limit: '10mb'}));

const sessions = {}; // In-memory session storage

// Function to create a client
function createClient(userId) {
    const client = new Client({
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
        authStrategy: new LocalAuth({ clientId: userId })
    });

    sessions[userId] = {
        client,
        ready: false,
        lastQR: null,
        initializing: true, // To know if init is happening
        timeout: null
    };
    sessions[userId].timeout = setTimeout(() => {
    if (!sessions[userId].ready) {
        console.warn(`[${userId}] Auto-destroying idle session (not logged in)`);
        client.destroy();
        delete sessions[userId];
    }
    }, 2 * 60 * 1000); // 2 minutes
    client.on('qr', (qr) => {
        console.log(`[${userId}] QR generated`);
        sessions[userId].lastQR = qr;
        sessions[userId].ready = false;
    });

    client.on('ready', () => {
        console.log(`[${userId}] Client ready`);
        sessions[userId].ready = true;
        sessions[userId].lastQR = null;
        sessions[userId].initializing = false;

        if (sessions[userId].timeout) {
        clearTimeout(sessions[userId].timeout);
        sessions[userId].timeout = null;
    }
    });

    client.on('authenticated', () => {
        console.log(`[${userId}] Authenticated`);
    });

    client.on('auth_failure', (msg) => {
        console.error(`[${userId}] Auth failure: ${msg}`);
        sessions[userId].ready = false;
    });

    client.on('disconnected', (reason) => {
        console.warn(`[${userId}] Disconnected: ${reason}`);
        
        sessions[userId].ready = false;
        sessions[userId].initializing = false;
        
        client.destroy();
    
        // Important: remove session auth files so it asks for new QR
        const authPath = path.join(__dirname, `.wwebjs_auth`, userId);
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
            console.log(`[${userId}] Old session files deleted after disconnect.`);
        }
    
        // Optional: Remove from memory also
        delete sessions[userId];
    
        // Now, automatically recreate a fresh client
        console.log(`[${userId}] Recreating client for fresh QR...`);
        createClient(userId);
    });

    client.initialize();
}

// Check if stored session exists (no QR needed)
function sessionExists(userId) {
    const authPath = path.join(__dirname, `.wwebjs_auth`, userId);
    return fs.existsSync(authPath);
}

// API to start session
app.post('/start-session', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).send({ error: 'UserId required' });

    if (!sessions[userId]) {
        console.log(`[${userId}] Creating client...`);
        createClient(userId);
    }

    // Give time for initialization
    setTimeout(() => {
        const session = sessions[userId];
        if (session.ready) {
            return res.send({ status: 'ready' });
        } else if (session.lastQR) {
            qrcode.toDataURL(session.lastQR, (err, url) => {
                if (err) {
                    console.error('Error creating QR:', err);
                    return res.status(500).send({ error: 'QR generation failed' });
                }
                return res.send({ status: 'qr', qr: url });
            });
        } else {
            return res.send({ status: 'pending' });
        }
    }, 2000); // wait 2 sec to allow ready if possible
});

// API to check login status
app.get('/check-login/:userId', (req, res) => {
    const { userId } = req.params;

    if (!sessions[userId]) {
        if (sessionExists(userId)) {
            console.log(`[${userId}] Session files exist. Creating client...`);
            createClient(userId);
            return res.json({ status: 'pending' });
        } else {
            return res.json({ status: 'not_started' });
        }
    }

    if (sessions[userId].ready) {
        return res.json({ status: 'ready' });
    } else {
        return res.json({ status: 'pending' });
    }
});

// API to send message
app.post('/send-message', async (req, res) => {
    const { userId, number, message } = req.body;

    if (!userId || !number || !message) {
        return res.status(400).send({ error: 'userId, number, and message are required' });
    }

    async function ensureClientReady() {
        // Check if session exists
        if (!sessions[userId]) {
            if (sessionExists(userId)) {
                console.log(`[${userId}] Session exists. Creating client...`);
                createClient(userId);  // Start the session if it doesn't exist
            } else {
                // If session doesn't exist, start the session immediately
                console.log(`[${userId}] No session found. Starting session...`);
                createClient(userId); // Create new client here
            }
        }

        const session = sessions[userId];

        if (session.ready) {
            return session.client;
        }

        console.log(`[${userId}] Waiting for client to be ready...`);

        return new Promise((resolve, reject) => {
            const interval = setInterval(() => {
                // Check if the session is ready, and avoid undefined access
                if (sessions[userId] && sessions[userId].ready) {
                    clearInterval(interval);
                    resolve(sessions[userId].client);
                }
            }, 1000);

            setTimeout(() => {
                clearInterval(interval);
                reject(new Error('Timeout: Client not ready after waiting.'));
            }, 15000); // 15 sec max wait
        });
    }

    try {
        const client = await ensureClientReady();

        if (!client) {
            throw new Error('Client not initialized properly');
        }

        // Ensure number is digits only
        const cleanNumber = number.replace(/\D/g, '');

        if (cleanNumber.length < 10) {
            return res.status(400).send({ error: 'Invalid phone number' });
        }

        const chatId = cleanNumber + '@c.us';

        console.log(`[${userId}] Sending message to ${chatId}...`);

        await client.sendMessage(chatId, message);
        res.send({ status: 'Message sent' });

    } catch (err) {
        console.error(err);
        res.status(500).send({ error: err.message });
    }
});

const { MessageMedia } = require('whatsapp-web.js');

app.post('/send-pdf-url', async (req, res) => {
    const { userId, number, message, pdfUrl } = req.body;

    if (!userId || !number || !message || !pdfUrl) {
        return res.status(400).send({ error: 'userId, number, message, and pdfUrl are required' });
    }

    async function ensureClientReady() {
        // Check if session exists
        if (!sessions[userId]) {
            if (sessionExists(userId)) {
                console.log(`[${userId}] Session exists. Creating client...`);
                createClient(userId);  // Start the session if it doesn't exist
            } else {
                // If session doesn't exist, start the session immediately
                console.log(`[${userId}] No session found. Starting session...`);
                createClient(userId); // Create new client here
            }
        }

        const session = sessions[userId];

        if (session.ready) {
            return session.client;
        }

        console.log(`[${userId}] Waiting for client to be ready...`);

        return new Promise((resolve, reject) => {
            const interval = setInterval(() => {
                // Check if the session is ready, and avoid undefined access
                if (sessions[userId] && sessions[userId].ready) {
                    clearInterval(interval);
                    resolve(sessions[userId].client);
                }
            }, 1000);

            setTimeout(() => {
                clearInterval(interval);
                reject(new Error('Timeout: Client not ready after waiting.'));
            }, 15000); // 15 sec max wait
        });
    }
    try {
        const client = await ensureClientReady();

        if (!client) {
            throw new Error('Client not initialized properly');
        }

        const cleanNumber = number.replace(/\D/g, '');

        if (cleanNumber.length < 10) {
            return res.status(400).send({ error: 'Invalid phone number' });
        }

        const chatId = cleanNumber + '@c.us';

        console.log(`[${userId}] Downloading PDF from URL...`);

        // Download the PDF
        const response = await axios.get(pdfUrl, { responseType: 'arraybuffer' });

        const pdfBase64 = Buffer.from(response.data, 'binary').toString('base64');

        const media = new MessageMedia('application/pdf', pdfBase64, 'document.pdf');

        // Send text message
        await client.sendMessage(chatId, message);

        // Send PDF document
        await client.sendMessage(chatId, media);

        res.send({ status: 'Message and PDF sent from URL' });

    } catch (err) {
        console.error(err);
        res.status(500).send({ error: err.message });
    }
});
app.post('/send-pdf-base64', async (req, res) => {
    const { userId, number, message, pdfBase64, filename } = req.body;

    if (!userId || !number || !message || !pdfBase64) {
        return res.status(400).send({ error: 'userId, number, message, and pdfBase64 are required' });
    }

    async function ensureClientReady() {
        if (!sessions[userId]) {
            if (sessionExists(userId)) {
                console.log(`[${userId}] Session exists. Creating client...`);
                createClient(userId);
            } else {
                console.log(`[${userId}] No session found. Starting session...`);
                createClient(userId);
            }
        }

        const session = sessions[userId];

        if (session.ready) {
            return session.client;
        }

        console.log(`[${userId}] Waiting for client to be ready...`);

        return new Promise((resolve, reject) => {
            const interval = setInterval(() => {
                if (sessions[userId] && sessions[userId].ready) {
                    clearInterval(interval);
                    resolve(sessions[userId].client);
                }
            }, 1000);

            setTimeout(() => {
                clearInterval(interval);
                reject(new Error('Timeout: Client not ready after waiting.'));
            }, 15000); // 15 seconds
        });
    }

    try {
        const client = await ensureClientReady();

        if (!client) {
            throw new Error('Client not initialized properly');
        }

        const cleanNumber = number.replace(/\D/g, '');

        if (cleanNumber.length < 10) {
            return res.status(400).send({ error: 'Invalid phone number' });
        }

        const chatId = cleanNumber + '@c.us';

        console.log(`[${userId}] Preparing PDF to send via base64...`);

        const media = new MessageMedia('application/pdf', pdfBase64, filename || 'document.pdf');

        // Send the PDF + message as caption
        await client.sendMessage(chatId, media, { caption: message });

        res.send({ status: 'Message and PDF (base64) sent' });

    } catch (err) {
        console.error(err);
        res.status(500).send({ error: err.message });
    }
});
app.post('/send-image-base64', async (req, res) => {
    const { userId, number, message, imageBase64, filename, mimeType } = req.body;

    if (!userId || !number || !message || !imageBase64 || !mimeType) {
        return res.status(400).send({ error: 'userId, number, message, imageBase64, and mimeType are required' });
    }

    async function ensureClientReady() {
        if (!sessions[userId]) {
            if (sessionExists(userId)) {
                console.log(`[${userId}] Session exists. Creating client...`);
                createClient(userId);
            } else {
                console.log(`[${userId}] No session found. Starting session...`);
                createClient(userId);
            }
        }

        const session = sessions[userId];

        if (session.ready) {
            return session.client;
        }

        return new Promise((resolve, reject) => {
            const interval = setInterval(() => {
                if (sessions[userId] && sessions[userId].ready) {
                    clearInterval(interval);
                    resolve(sessions[userId].client);
                }
            }, 1000);

            setTimeout(() => {
                clearInterval(interval);
                reject(new Error('Timeout: Client not ready after waiting.'));
            }, 15000);
        });
    }

    try {
        const client = await ensureClientReady();
        if (!client) throw new Error('Client not initialized properly');

        const cleanNumber = number.replace(/\D/g, '');
        if (cleanNumber.length < 10) {
            return res.status(400).send({ error: 'Invalid phone number' });
        }

        const chatId = cleanNumber + '@c.us';

        console.log(`[${userId}] Preparing image to send via base64...`);

        const media = new MessageMedia(mimeType, imageBase64, filename || 'image.jpg');

        await client.sendMessage(chatId, media, { caption: message });

        res.send({ status: 'Image (base64) and message sent' });

    } catch (err) {
        console.error(err);
        res.status(500).send({ error: err.message });
    }
});
// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
