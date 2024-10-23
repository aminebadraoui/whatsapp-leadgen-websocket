const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const wss = new WebSocket.Server({
    server,
    verifyClient: () => true // This allows all connections
});

app.use(cors());
app.use(express.json());

let client;
let isAuthenticated = false;
let clientReady = false;

// Initialize WhatsApp client
let initializationInProgress = false;
async function initializeClient(userId) {
    console.log('Starting WhatsApp client initialization...');
    initializationInProgress = true;
    try {
        client = new Client({
            authStrategy: new LocalAuth({
                clientId: `client-${userId}`,
                dataPath: `/app/.wwebjs_auth/${userId}`
            }),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            },
            webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html', }
        });

        client.on('qr', (qr) => {
            console.log('QR RECEIVED', qr);
            wss.clients.forEach((ws) => {
                ws.send(JSON.stringify({ type: 'qr', qr }));
            });
        });

        client.on('ready', async () => {
            console.log('WhatsApp client is ready!');
            clientReady = true;
            isAuthenticated = true;
            wss.clients.forEach((ws) => {
                ws.send(JSON.stringify({ type: 'whatsapp_ready' }));
            });
        });

        client.on('disconnected', () => {
            console.log('WhatsApp client was disconnected');
            clientReady = false;
            isAuthenticated = false;
            setTimeout(() => initializeClient(userId), 5000);
        });

        await client.initialize();
        initializationInProgress = false;
    } catch (error) {
        console.error('Error initializing WhatsApp client:', error);
        if (error.message.includes('ENOTEMPTY: directory not empty')) {
            console.log('Attempting to clean up the session directory...');
            try {
                const rimraf = require('rimraf');
                await new Promise((resolve, reject) => {
                    rimraf('/app/.wwebjs_auth/session', (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                console.log('Session directory cleaned up. Retrying initialization...');
                setTimeout(() => initializeClient(userId), 1000);
            } catch (cleanupError) {
                console.error('Failed to clean up session directory:', cleanupError);
                setTimeout(() => initializeClient(userId), 5000);
            }
        } else {
            setTimeout(() => initializeClient(userId), 5000);
        }

        console.error('Error initializing WhatsApp client:', error);
        initializationInProgress = false;
        clientReady = false;
        isAuthenticated = false;
        // Notify clients about the error
        wss.clients.forEach((ws) => {
            ws.send(JSON.stringify({ type: 'whatsapp_not_ready', error: error.message }));
        });
    }
}

async function getGroups() {
    if (!client || !clientReady) {
        throw new Error('WhatsApp client is not ready');
    }
    try {
        console.log('Getting chats');

        const chats = await client.getChats();
        return chats.filter(chat => chat.isGroup).map(group => ({
            id: group.id._serialized,
            name: group.name
        }));
    } catch (error) {
        console.error('Error getting chats:', error);
        throw new Error('Failed to get chats: ' + error.message);
    }
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

    console.log("members", members);
    console.log("totalMembers", members.length);

    return {
        members: members,
        totalMembers: members.length
    };
}

wss.on('connection', (ws) => {
    console.log('New WebSocket connection established');

    if (isAuthenticated && clientReady) {
        ws.send(JSON.stringify({ type: 'whatsapp_ready', authenticated: true }));
    } else {
        ws.send(JSON.stringify({ type: 'whatsapp_not_ready', authenticated: false }));
        console.log('WhatsApp client is not ready');
    }

    ws.on('message', async (message) => {
        const data = JSON.parse(message);
        console.log('Received message:', data);

        try {
            if (data.action === 'checkClientStatus') {
                ws.send(JSON.stringify({ action: 'clientStatus', isReady: clientReady }));
            }

            if (data.action === 'initialize' && data.userId) {
                userId = data.userId;
                await initializeClient(userId);
            } else if (!userId) {
                ws.send(JSON.stringify({ action: 'error', message: 'User ID not provided' }));
                return;
            }

            if (!clientReady) {
                ws.send(JSON.stringify({ action: 'error', message: 'WhatsApp client is not ready' }));
                return;
            }

            if (data.action === 'getGroups') {
                const groups = await getGroups();
                ws.send(JSON.stringify({ action: 'groupsReceived', groups }));
            }

            else if (data.action === 'getGroupMembers') {
                const groupMembers = await getGroupMembers(data.groupId);
                ws.send(JSON.stringify({ action: 'groupMembersReceived', members: groupMembers.members, totalMembers: groupMembers.totalMembers }));
            }

            else if (data.action === 'sendMessage') {
                if (!clientReady) {
                    ws.send(JSON.stringify({
                        action: 'error',
                        contactId: data.contactId,
                        message: 'WhatsApp client is not ready'
                    }));
                    return;
                }

                const chatId = data.phoneNumber.includes('@c.us')
                    ? data.phoneNumber
                    : `${data.phoneNumber.replace(/[^\d]/g, '')}@c.us`;

                console.log('Sending message to:', chatId);
                console.log('Message content:', data.message);

                try {
                    const sentMessage = await client.sendMessage(chatId, data.message);
                    console.log('Message sent, response:', sentMessage);

                    ws.send(JSON.stringify({
                        action: 'messageSent',
                        contactId: data.contactId,
                        messageId: sentMessage.id._serialized
                    }));
                } catch (error) {
                    console.error('Error sending message:', error);
                    ws.send(JSON.stringify({
                        action: 'error',
                        contactId: data.contactId,
                        message: error.message
                    }));
                }
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
            ws.send(JSON.stringify({ action: 'error', message: error.message }));
        }
    });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`WebSocket server available at ws://0.0.0.0:${PORT}`);
});