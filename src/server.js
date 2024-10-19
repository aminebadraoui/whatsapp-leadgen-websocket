const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const prisma = new PrismaClient();

const app = express();


let httpServer;
if (process.env.NODE_ENV === 'production') {
    const privateKey = fs.readFileSync('/etc/letsencrypt/live/leadchatapp.com/privkey.pem', 'utf8');
    const certificate = fs.readFileSync('/etc/letsencrypt/live/leadchatapp.com/cert.pem', 'utf8');
    const ca = fs.readFileSync('/etc/letsencrypt/live/leadchatapp.com/chain.pem', 'utf8');

    const credentials = { key: privateKey, cert: certificate, ca: ca };

    console.log(`privateKey ${privateKey}`)
    console.log(`certificate ${certificate}`)
    console.log(`ca ${ca}`)
    console.log(`credentials ${credentials}`)
    httpServer = https.createServer(credentials, app);
} else {
    httpServer = http.createServer(app);
}

const wss = new WebSocket.Server({ server: httpServer });

let client;
let isAuthenticated = false;

app.use(cors({
    origin: '*', // Replace with your frontend URL
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

// Initialize WhatsApp client

let clientReady = false;

async function initializeClient() {
    console.log('Starting new WhatsApp client initialization...');

    try {
        if (process.env.NODE_ENV === 'production') {
            client = new Client({
                authStrategy: new LocalAuth(),
                puppeteer: {
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox'],
                    executablePath: '/usr/bin/chromium'
                }
            });

        } else {
            client = new Client({
                authStrategy: new LocalAuth(),
                puppeteer: {
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox'],
                }
            });
        }

        console.log('Puppeteer browser launched successfully');



        client.on('qr', (qr) => {
            console.log('QR RECEIVED', qr);
            wss.clients.forEach((ws) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'qr', qr }));
                }
            });
        });

        client.on('ready', () => {
            console.log('WhatsApp client is ready!');
            clientReady = true;
            wss.clients.forEach((ws) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'whatsapp_ready' }));
                }
            });
        });

        client.on('authenticated', () => {
            console.log('WhatsApp client authenticated');
            isAuthenticated = true;
        });

        client.on('auth_failure', (msg) => {
            console.error('WhatsApp authentication failure:', msg);
            isAuthenticated = false;
        });

        client.on('disconnected', async (reason) => {
            console.log('WhatsApp client was disconnected', reason);
            clientReady = false;
            isAuthenticated = false;

            setTimeout(initializeClient, 5000);
        });

        console.log('Calling client.initialize()...');
        await client.initialize();
        console.log('WhatsApp client initialized');
    } catch (error) {
        console.error('Error initializing WhatsApp client:', error);

        setTimeout(initializeClient, 5000);
    }
}

async function getGroups() {
    if (!client || !client.pupPage) {
        throw new Error('Client not ready');
    }

    const chats = await client.getChats();
    const groups = chats
        .filter(chat => chat.isGroup)
        .map(group => ({ id: group.id._serialized, name: group.name }));

    return {
        groups: groups,
        totalGroups: groups.length
    };
}

async function getGroupMembers(groupId) {
    if (!client || !client.pupPage) {
        throw new Error('Client not ready');
    }

    const chat = await client.getChatById(groupId);
    if (!chat.isGroup) {
        throw new Error('Not a group chat');
    }

    const participants = await chat.participants;
    const members = await Promise.all(participants.map(async (participant) => {
        const contact = await client.getContactById(participant.id._serialized);
        return {
            id: contact.id._serialized,
            name: contact.name || contact.pushname || 'Unknown',
            phoneNumber: contact.number
        };
    }));

    return {
        members: members,
        totalMembers: members.length
    };
}


// REST API endpoints


app.get('/', async (req, res) => {
    res.json({ message: 'Welcome to the WhatsApp Lead Generation API' });
});

app.get('/api/buckets', async (req, res) => {
    console.log('Fetching buckets');
    try {
        const buckets = await prisma.bucket.findMany({
            include: { _count: { select: { contacts: true } } }
        });
        res.json(buckets.map(bucket => ({
            ...bucket,
            contacts: { length: bucket._count.contacts }
        })));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error fetching buckets' });
    }
});

app.post('/api/buckets', async (req, res) => {
    try {
        const { name } = req.body;
        const newBucket = await prisma.bucket.create({
            data: { name }
        });
        res.json(newBucket);
    } catch (error) {
        res.status(500).json({ error: 'Error creating bucket' });
    }
});

app.get('/api/buckets/:bucketId/contacts', async (req, res) => {
    try {
        const { bucketId } = req.params;
        const contacts = await prisma.contact.findMany({
            where: { bucketId },
        });
        res.json(contacts);
    } catch (error) {
        console.error('Error fetching bucket contacts:', error);
        res.status(500).json({ error: 'Error fetching bucket contacts' });
    }
});

app.post('/api/export', async (req, res) => {
    try {
        const { bucketId, contacts } = req.body;

        // Get existing contacts in the bucket
        const existingContacts = await prisma.contact.findMany({
            where: { bucketId },
            select: { whatsappId: true }
        });

        const existingWhatsappIds = new Set(existingContacts.map(c => c.whatsappId));

        // Filter out contacts that already exist in the bucket
        const newContacts = contacts.filter(contact => !existingWhatsappIds.has(contact.id));

        // Add new contacts to the bucket
        const createdContacts = await prisma.$transaction(
            newContacts.map(contact =>
                prisma.contact.upsert({
                    where: { whatsappId: contact.id },
                    update: {
                        name: contact.name,
                        phoneNumber: contact.phoneNumber,
                        groupId: contact.groupId,
                        groupName: contact.groupName,
                        bucketId: bucketId
                    },
                    create: {
                        whatsappId: contact.id,
                        name: contact.name,
                        phoneNumber: contact.phoneNumber,
                        groupId: contact.groupId,
                        groupName: contact.groupName,
                        bucketId: bucketId
                    }
                })
            )
        );

        res.json({
            message: 'Contacts exported successfully',
            addedContacts: createdContacts.length,
            skippedContacts: contacts.length - createdContacts.length
        });
    } catch (error) {
        console.error('Error exporting contacts:', error);
        res.status(500).json({ error: 'Error exporting contacts', details: error.message });
    }
});

// Get all message templates
app.get('/api/message-templates', async (req, res) => {
    try {
        const templates = await prisma.messageTemplate.findMany();
        console.log('Templates:', templates);
        res.json(templates);
    } catch (error) {
        console.error('Error fetching message templates:', error);
        res.status(500).json({ error: 'Error fetching message templates' });
    }
});

// Create a new message template
app.post('/api/message-templates', async (req, res) => {
    try {
        const { title, message } = req.body;
        const newTemplate = await prisma.messageTemplate.create({
            data: { title, message },
        });
        res.json(newTemplate);
    } catch (error) {
        console.error('Error creating message template:', error);
        res.status(500).json({ error: 'Error creating message template' });
    }
});

// Get a specific message template
app.get('/api/message-templates/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const template = await prisma.messageTemplate.findUnique({
            where: { id },
        });
        if (template) {
            res.json(template);
        } else {
            res.status(404).json({ error: 'Message template not found' });
        }
    } catch (error) {
        console.error('Error fetching message template:', error);
        res.status(500).json({ error: 'Error fetching message template' });
    }
});

// Update a message template
app.put('/api/message-templates/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { title, message } = req.body;
        const updatedTemplate = await prisma.messageTemplate.update({
            where: { id },
            data: { title, message },
        });
        res.json(updatedTemplate);
    } catch (error) {
        console.error('Error updating message template:', error);
        res.status(500).json({ error: 'Error updating message template' });
    }
});

// Delete a message template
app.delete('/api/message-templates/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.messageTemplate.delete({
            where: { id },
        });
        res.json({ message: 'Template deleted successfully' });
    } catch (error) {
        console.error('Error deleting message template:', error);
        res.status(500).json({ error: 'Error deleting message template' });
    }
});

// Send a message to a contact
app.post('/api/send-message', async (req, res) => {
    try {
        const { contactId, message } = req.body;

        if (!clientReady) {
            return res.status(503).json({ error: 'WhatsApp client is not ready' });
        }

        const contact = await prisma.contact.findUnique({
            where: { id: contactId }
        });

        if (!contact) {
            return res.status(404).json({ error: 'Contact not found' });
        }

        const chatId = contact.phoneNumber.includes('@c.us')
            ? contact.phoneNumber
            : `${contact.phoneNumber.replace(/[^\d]/g, '')}@c.us`;

        console.log('Sending message to:', chatId);
        console.log('Message content:', message);

        const sentMessage = await client.sendMessage(chatId, message);
        console.log('Message sent, response:', sentMessage);

        res.json({ success: true, message: 'Message sent successfully', messageId: sentMessage.id._serialized });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Error sending message', details: error.message });
    }
});

app.get('/api/client-status', (req, res) => {
    res.json({
        isReady: clientReady,
        isAuthenticated: isAuthenticated
    });
});

wss.on('headers', (headers, req) => {
    headers.push('Access-Control-Allow-Origin: *');
});

wss.on('connection', (ws) => {
    console.log('New WebSocket connection established');

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });

    ws.on('close', () => {
        console.log('WebSocket connection closed');
    });

    console.log('Current isAuthenticated status:', isAuthenticated);
    console.log('Current clientReady status:', clientReady);
    console.log('WhatsApp client status:', client ? 'Initialized' : 'Not initialized');

    if (isAuthenticated && clientReady) {
        console.log('Client already authenticated and ready, sending authenticated message');
        ws.send(JSON.stringify({ type: 'whatsapp_ready', authenticated: true }));
    } else {
        console.log('Client not authenticated or not ready, waiting for WhatsApp client initialization');
    }

    ws.on('message', async (message) => {
        console.log('Received message:', message);
        const data = JSON.parse(message);

        if (data.action === 'getGroups') {
            try {
                const groupsData = await getGroups();
                console.log('Sending groups data:', groupsData);
                ws.send(JSON.stringify({ action: 'groupsReceived', ...groupsData }));
            } catch (error) {
                console.error('Error getting groups:', error);
                ws.send(JSON.stringify({ action: 'error', message: 'Error retrieving groups' }));
            }
        }

        if (data.action === 'getGroupMembers') {
            try {
                const { groupId } = data;
                const membersData = await getGroupMembers(groupId);
                console.log('Sending group members data:', membersData);
                ws.send(JSON.stringify({ action: 'groupMembersReceived', ...membersData }));
            } catch (error) {
                console.error('Error getting group members:', error);
                ws.send(JSON.stringify({ action: 'error', message: 'Error retrieving group members' }));
            }
        }
    });
});


function startServer() {
    try {
        console.log('Initializing WhatsApp client...');
        initializeClient();

        const PORT = process.env.PORT || 5000;

        httpServer.listen(PORT, '0.0.0.0', () => {
            const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
            const wsProtocol = process.env.NODE_ENV === 'production' ? 'wss' : 'ws';
            const host = httpServer.address().address;
            const runningPort = httpServer.address().port;

            console.log(`HTTP server is running at ${protocol}://${host}:${runningPort}`);
            console.log(`WebSocket server is available at ${wsProtocol}://${host}:${runningPort}`);
        });

    } catch (err) {
        console.error('Error starting server:', err);
        process.exit(1);
    }
}

startServer();

