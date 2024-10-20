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
async function initializeClient() {
    console.log('Starting WhatsApp client initialization...');
    try {
        client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            }
        });

        client.on('qr', (qr) => {
            console.log('QR RECEIVED', qr);
            wss.clients.forEach((ws) => {
                ws.send(JSON.stringify({ type: 'qr', qr }));
            });
        });

        client.on('ready', () => {
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
            setTimeout(initializeClient, 5000);
        });

        await client.initialize();
    } catch (error) {
        console.error('Error initializing WhatsApp client:', error);
        setTimeout(initializeClient, 5000);
    }
}

async function getGroups() {
    if (!client || !clientReady) {
        throw new Error('WhatsApp client is not ready');
    }
    const chats = await client.getChats();
    return chats.filter(chat => chat.isGroup).map(group => ({
        id: group.id._serialized,
        name: group.name
    }));
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
    }

    ws.on('message', async (message) => {
        const data = JSON.parse(message);
        console.log('Received message:', data);

        try {
            if (data.action === 'getGroups') {
                const groups = await getGroups();
                ws.send(JSON.stringify({ action: 'groupsReceived', groups }));
            } else if (data.action === 'getGroupMembers') {
                const groupMembers = await getGroupMembers(data.groupId);
                ws.send(JSON.stringify({ action: 'groupMembersReceived', members: groupMembers.members, totalMembers: groupMembers.totalMembers }));
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
    initializeClient();
});