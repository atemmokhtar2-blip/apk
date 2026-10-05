// index.js
// ============================================================
// WhatsApp Blast Worker — Real Implementation
// ============================================================

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));

const PORT = process.env.WORKER_PORT || 3001;
const WORKER_SECRET = process.env.WORKER_SECRET || 'change_me_in_env';

// ─── Global State ───
let client = null;
let isReady = false;
let currentQR = null;
let currentSessionName = null;

// ─── Sessions Store ───
const sessions = new Map();

// ─── Auth Middleware ───
function requireSecret(req, res, next) {
    const secret = req.headers['x-worker-secret'];
    if (secret !== WORKER_SECRET) {
        return res.status(403).json({ error: 'forbidden' });
    }
    next();
}

// ══════════════════════════════════════════════════════════
// Initialize WhatsApp Client
// ══════════════════════════════════════════════════════════
async function initClient(sessionName = 'default') {
    if (client && isReady) {
        console.log('[+] Client already ready');
        return true;
    }

    currentSessionName = sessionName;

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: sessionName,
            dataPath: './.wwebjs_auth'
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ]
        }
    });

    // ─── QR Code Event ───
    client.on('qr', (qr) => {
        console.log('[QR] New QR generated');
        currentQR = qr;
        qrcode.generate(qr, { small: true });

        // Notify admin server
        notifyAdminServer('qr_ready', { qr: qr });
    });

    // ─── Ready Event ───
    client.on('ready', () => {
        console.log('[+] WhatsApp client is READY');
        isReady = true;
        currentQR = null;
        notifyAdminServer('ready', {
            session: sessionName,
            number: client.info?.wid?.user || 'unknown'
        });
    });

    // ─── Auth Failure ───
    client.on('auth_failure', (msg) => {
        console.error('[!] Auth failure:', msg);
        isReady = false;
        notifyAdminServer('auth_failure', { error: msg });
    });

    // ─── Disconnected ───
    client.on('disconnected', (reason) => {
        console.log('[!] Disconnected:', reason);
        isReady = false;
        notifyAdminServer('disconnected', { reason: reason });
    });

    // ─── Incoming Message ───
    client.on('message', async (msg) => {
        console.log(`[MSG] From ${msg.from}: ${msg.body}`);
    });

    try {
        console.log('[*] Initializing client...');
        await client.initialize();
        return true;
    } catch (e) {
        console.error('[!] Init error:', e);
        return false;
    }
}

// ══════════════════════════════════════════════════════════
// Admin Server Notification
// ══════════════════════════════════════════════════════════
async function notifyAdminServer(event, data) {
    const adminUrl = process.env.ADMIN_SERVER_URL;
    if (!adminUrl) return;

    try {
        await fetch(`${adminUrl}/admin/wb/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Worker-Secret': WORKER_SECRET
            },
            body: JSON.stringify({ event, data, timestamp: Date.now() })
        });
    } catch (e) {
        console.error('[!] Notify admin error:', e.message);
    }
}

// ══════════════════════════════════════════════════════════
// API Routes
// ══════════════════════════════════════════════════════════

// ─── Health ───
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        ready: isReady,
        session: currentSessionName,
        has_qr: !!currentQR
    });
});

// ─── Get QR ───
app.get('/qr', requireSecret, (req, res) => {
    if (isReady) {
        return res.json({ ready: true, message: 'Already authenticated' });
    }
    if (!currentQR) {
        return res.json({ ready: false, message: 'No QR yet. Call /init first.' });
    }
    res.json({ ready: false, qr: currentQR });
});

// ─── Init Session ───
app.post('/init', requireSecret, async (req, res) => {
    const { session_name } = req.body;
    const success = await initClient(session_name || 'default');
    res.json({ ok: success });
});

// ─── Get Contacts ───
app.get('/contacts', requireSecret, async (req, res) => {
    if (!isReady || !client) {
        return res.status(400).json({ error: 'client_not_ready' });
    }

    try {
        const contacts = await client.getContacts();
        const filtered = contacts
            .filter(c => c.isUser && c.id && c.id.user)
            .map(c => ({
                id: c.id._serialized,
                number: c.number,
                name: c.name || c.pushname || 'Unknown',
                shortName: c.shortName || '',
                isBusiness: c.isBusiness || false
            }));

        res.json({ contacts: filtered, count: filtered.length });
    } catch (e) {
        console.error('[!] Get contacts error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ─── Send Message ───
app.post('/send', requireSecret, async (req, res) => {
    if (!isReady || !client) {
        return res.status(400).json({ error: 'client_not_ready' });
    }

    const { to, message } = req.body;
    if (!to || !message) {
        return res.status(400).json({ error: 'missing_to_or_message' });
    }

    try {
        const result = await client.sendMessage(to, message);
        res.json({ ok: true, id: result.id._serialized });
    } catch (e) {
        console.error('[!] Send error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ─── Send File ───
app.post('/send_file', requireSecret, async (req, res) => {
    if (!isReady || !client) {
        return res.status(400).json({ error: 'client_not_ready' });
    }

    const { to, file_url, filename, caption } = req.body;

    try {
        const { MessageMedia } = require('whatsapp-web.js');
        const media = await MessageMedia.fromUrl(file_url, { unsafeMime: true });

        if (filename) {
            media.filename = filename;
        }

        const result = await client.sendMessage(to, media, { caption: caption || '' });
        res.json({ ok: true, id: result.id._serialized });
    } catch (e) {
        console.error('[!] Send file error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ─── Bulk Blast ───
app.post('/blast', requireSecret, async (req, res) => {
    if (!isReady || !client) {
        return res.status(400).json({ error: 'client_not_ready' });
    }

    const {
        contacts,
        message,
        file_url,
        filename,
        caption,
        delay_min = 3000,
        delay_max = 8000,
        session_id
    } = req.body;

    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
        return res.status(400).json({ error: 'no_contacts' });
    }

    // Create blast record
    const blastId = session_id || `blast_${Date.now()}`;
    sessions.set(blastId, {
        id: blastId,
        total: contacts.length,
        sent: 0,
        failed: 0,
        status: 'running',
        started: Date.now(),
        log: []
    });

    // Start async blast
    (async () => {
        const blast = sessions.get(blastId);
        const { MessageMedia } = require('whatsapp-web.js');

        let media = null;
        if (file_url) {
            try {
                media = await MessageMedia.fromUrl(file_url, { unsafeMime: true });
                if (filename) media.filename = filename;
            } catch (e) {
                blast.log.push({ t: Date.now(), msg: `Media load failed: ${e.message}` });
            }
        }

        for (let i = 0; i < contacts.length; i++) {
            const c = contacts[i];
            const chatId = c.id || c;

            try {
                if (media) {
                    await client.sendMessage(chatId, media, { caption: caption || message || '' });
                } else {
                    await client.sendMessage(chatId, message || '');
                }

                blast.sent++;
                blast.log.push({
                    t: Date.now(),
                    msg: `✅ Sent to ${chatId}`,
                    i: i + 1
                });

            } catch (e) {
                blast.failed++;
                blast.log.push({
                    t: Date.now(),
                    msg: `❌ Failed ${chatId}: ${e.message}`,
                    i: i + 1
                });
            }

            // Random delay to avoid detection
            const delay = Math.floor(Math.random() * (delay_max - delay_min) + delay_min);
            await new Promise(r => setTimeout(r, delay));

            // Trim log
            if (blast.log.length > 500) {
                blast.log = blast.log.slice(-500);
            }
        }

        blast.status = 'completed';
        blast.completed = Date.now();
        console.log(`[+] Blast ${blastId} completed: ${blast.sent} sent, ${blast.failed} failed`);

        // Notify admin
        notifyAdminServer('blast_completed', {
            blast_id: blastId,
            sent: blast.sent,
            failed: blast.failed,
            total: blast.total
        });
    })();

    res.json({ ok: true, blast_id: blastId, total: contacts.length });
});

// ─── Blast Status ───
app.get('/blast/:id', requireSecret, (req, res) => {
    const blast = sessions.get(req.params.id);
    if (!blast) {
        return res.status(404).json({ error: 'not_found' });
    }
    res.json(blast);
});

// ─── Stop Blast ───
app.post('/blast/:id/stop', requireSecret, (req, res) => {
    const blast = sessions.get(req.params.id);
    if (!blast) {
        return res.status(404).json({ error: 'not_found' });
    }
    blast.status = 'stopped';
    res.json({ ok: true });
});

// ─── Logout ───
app.post('/logout', requireSecret, async (req, res) => {
    try {
        if (client) {
            await client.logout();
            await client.destroy();
            client = null;
            isReady = false;
            currentQR = null;
        }
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════
// Start Server
// ══════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[+] WhatsApp Worker running on port ${PORT}`);
    console.log(`[+] Secret: ${WORKER_SECRET.slice(0, 8)}...`);
});
