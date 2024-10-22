const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');


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

class CustomStore {
    constructor(apiUrl, userId) {
        this.apiUrl = apiUrl;
        this.userId = userId;
    }

    async sessionExists({ session, userId }) {
        try {
            const response = await axios.get(`${this.apiUrl}/whatsapp-auth/${this.userId}/${session}`);
            return response.data.exists;
        } catch (error) {
            console.error('Error checking session existence:', error);
            return false;
        }
    }

    async save({ session }) {
        try {
            await axios.post(`${this.apiUrl}/whatsapp-auth/${this.userId}/${session}`, { data: fs.readFileSync(`${session}.zip`) });
        } catch (error) {
            console.error('Error saving session:', error);
        }
    }

    async extract({ session, path }) {
        try {
            const response = await axios.get(`${this.apiUrl}/whatsapp-auth/${this.userId}/${session}`, { responseType: 'arraybuffer' });
            fs.writeFileSync(path, response.data);
        } catch (error) {
            console.error('Error extracting session:', error);
        }
    }

    async delete({ session }) {
        try {
            await axios.delete(`${this.apiUrl}/whatsapp-auth/${this.userId}/${session}`);
        } catch (error) {
            console.error('Error deleting session:', error);
        }
    }

    async verifySession({ session }) {
        try {
            const response = await axios.post(`${this.apiUrl}/whatsapp-auth/verify`, { session, userId: this.userId });
            return response.data.isValid;
        } catch (error) {
            console.error('Error verifying session:', error);
            return false;
        }
    }
}

// Initialize WhatsApp client
async function initializeClient(userId) {
    console.log('Starting WhatsApp client initialization...');
    try {
        const store = new CustomStore(process.env.API_URL || 'http://localhost:5000/api', userId);

        client = new Client({
            authStrategy: new RemoteAuth({
                store: store,
                clientId: `leadchat-whatsapp-client-${userId}`,
                dataPath: `whatsapp-sessions/${userId}_leadchat-whatsapp-client.zip`,
                backupSyncIntervalMs: 300000, // 5 minutes
            }),
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

        client.on('ready', async () => {
            console.log('WhatsApp client is ready!');
            const isValid = await store.verifySession({ session: `leadchat-whatsapp-client-${userId}`, userId });
            if (isValid) {
                clientReady = true;
                isAuthenticated = true;
                wss.clients.forEach((ws) => {
                    ws.send(JSON.stringify({ type: 'whatsapp_ready' }));
                });
            } else {
                console.log('Invalid session for this user');
                await client.logout();
                setTimeout(() => initializeClient(userId), 5000);
            }
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
    } else {
        ws.send(JSON.stringify({ type: 'whatsapp_not_ready', authenticated: false }));
        console.log('WhatsApp client is not ready');
    }

    ws.on('message', async (message) => {
        const data = JSON.parse(message);
        console.log('Received message:', data);

        try {
            if (data.action === 'initialize' && data.userId) {
                userId = data.userId;
                await initializeClient(userId);
            } else if (!userId) {
                ws.send(JSON.stringify({ action: 'error', message: 'User ID not provided' }));
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