const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

let client = null;
let isInitializing = false;
let isAuthenticated = false;

const SESSION_FILE_PATH = path.join(__dirname, 'whatsapp-session.json');

function saveSession() {
    if (client && client.pupPage) {
        const sessionData = client.pupPage.target()._session.toJSON();
        fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(sessionData));
    }
}

function sessionExists() {
    return fs.existsSync(SESSION_FILE_PATH);
}

async function initializeClient() {
    if (client || isInitializing) return;

    isInitializing = true;
    console.log('Initializing WhatsApp client...');

    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log('QR Code received, please scan');
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ qr }));
            }
        });
    });

    client.on('ready', () => {
        console.log('Client is ready!');
        isAuthenticated = true;
        isInitializing = false;
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ authenticated: true }));
            }
        });
    });

    client.on('authenticated', () => {
        console.log('Client authenticated');
        isAuthenticated = true;
        isInitializing = false;
    });

    client.on('auth_failure', (msg) => {
        console.error('Authentication failure:', msg);
        isAuthenticated = false;
        isInitializing = false;
    });

    try {
        console.log('Starting client initialization...');
        await client.initialize();
        console.log('Client initialization completed');
    } catch (error) {
        console.error('Failed to initialize client:', error);
        client = null;
        isInitializing = false;
        isAuthenticated = false;
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

wss.on('connection', (ws) => {
    console.log('New WebSocket connection established');

    if (isAuthenticated) {
        ws.send(JSON.stringify({ authenticated: true }));
    } else {
        initializeClient();
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

const port = process.env.PORT || 5000;
server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    if (sessionExists()) {
        console.log('Existing session found, attempting to restore...');
        initializeClient();
    }
});