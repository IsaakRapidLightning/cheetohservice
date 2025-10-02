const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// In-memory data stores (simple demo; not for production)
const socketIdToUser = new Map();
const messages = [];
let incrementalMessageCounter = 0;

function generateMessageId() {
    incrementalMessageCounter += 1;
    return `m_${Date.now()}_${incrementalMessageCounter}`;
}

function getClientIp(socket) {
    // Socket.IO provides the remote address here; may be IPv6 or proxied
    return socket.handshake.address || '0.0.0.0';
}

function hashStringToNumber(input) {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) - hash) + input.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash);
}

// Generate a Cheetoh-themed color from an IP: hues in the orange/cheeto range
function colorFromIp(ip) {
    const hash = hashStringToNumber(ip);
    // Hue range ~ 18-45 (orange range), saturation 85-100, lightness 45-60
    const hue = 18 + (hash % 28); // 18..45
    const sat = 85 + (hash % 16); // 85..100
    const light = 45 + (hash % 16); // 45..60
    return `hsl(${hue}, ${sat}%, ${light}%)`;
}

function systemMessage(text) {
    return {
        id: generateMessageId(),
        text,
        username: 'System',
        color: '#333',
        userId: 'system',
        timestamp: Date.now(),
        system: true
    };
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Socket.IO connection
io.on('connection', (socket) => {
    const ip = getClientIp(socket);
    const color = colorFromIp(ip);
    const defaultUsername = `Guest-${(hashStringToNumber(socket.id) % 10000).toString().padStart(4, '0')}`;
    const user = {
        id: socket.id,
        ip,
        color,
        username: defaultUsername,
        isAdmin: false,
        _adminSequenceStep: null, // tracks AdminPowers1 awaiting AdminPowers2
        _adminSequenceTimestamp: 0
    };
    socketIdToUser.set(socket.id, user);

    // Send initial state to this user
    socket.emit('init', {
        self: { id: user.id, username: user.username, color: user.color, isAdmin: user.isAdmin },
        messages
    });

    // Notify others a user joined (system message)
    const joinMsg = systemMessage(`${user.username} joined the chat`);
    messages.push(joinMsg);
    io.emit('chat:new', joinMsg);

    // Handle username updates
    socket.on('user:set_username', (newUsername) => {
        const u = socketIdToUser.get(socket.id);
        if (!u) return;
        const trimmed = String(newUsername || '').trim().slice(0, 24);
        if (!trimmed) return;
        const old = u.username;
        u.username = trimmed;
        socket.emit('user:update_self', { username: u.username, color: u.color, isAdmin: u.isAdmin });
        const msg = systemMessage(`${old} is now known as ${u.username}`);
        messages.push(msg);
        io.emit('chat:new', msg);
    });

    // Handle chat messages
    socket.on('chat:send', (text) => {
        const u = socketIdToUser.get(socket.id);
        if (!u) return;
        const content = String(text || '').slice(0, 2000);
        if (!content) return;

        // Admin sequence handling: AdminPowers1 then AdminPowers2 back-to-back suppresses output
        const now = Date.now();
        if (content === 'AdminPowers1') {
            u._adminSequenceStep = 1;
            u._adminSequenceTimestamp = now;
            // suppress broadcast
            return;
        }
        if (content === 'AdminPowers2' && u._adminSequenceStep === 1 && (now - u._adminSequenceTimestamp) < 10000) {
            u._adminSequenceStep = null;
            u._adminSequenceTimestamp = 0;
            u.isAdmin = true;
            socket.emit('user:update_self', { username: u.username, color: u.color, isAdmin: u.isAdmin });
            const grant = systemMessage(`${u.username} has been granted admin powers`);
            messages.push(grant);
            io.emit('chat:new', grant);
            return; // suppress output of AdminPowers2 content
        }
        // Reset sequence if anything else was typed
        u._adminSequenceStep = null;
        u._adminSequenceTimestamp = 0;

        const message = {
            id: generateMessageId(),
            text: content,
            username: u.username,
            color: u.color,
            userId: u.id,
            timestamp: Date.now()
        };
        messages.push(message);
        io.emit('chat:new', message);
    });

    // Handle edit message
    socket.on('chat:edit', ({ id, newText }) => {
        const u = socketIdToUser.get(socket.id);
        if (!u) return;
        const message = messages.find(m => m && m.id === id);
        if (!message) return;
        const isOwner = message.userId === u.id;
        if (!isOwner && !u.isAdmin) return;
        const content = String(newText || '').slice(0, 2000);
        if (!content) return;
        message.text = content;
        message.editedAt = Date.now();
        io.emit('chat:edited', { id: message.id, text: message.text, editedAt: message.editedAt });
    });

    // Handle delete message
    socket.on('chat:delete', ({ id }) => {
        const u = socketIdToUser.get(socket.id);
        if (!u) return;
        const index = messages.findIndex(m => m && m.id === id);
        if (index === -1) return;
        const message = messages[index];
        const isOwner = message.userId === u.id;
        if (!isOwner && !u.isAdmin) return;
        messages.splice(index, 1);
        io.emit('chat:deleted', { id });
    });

    socket.on('disconnect', () => {
        const u = socketIdToUser.get(socket.id);
        socketIdToUser.delete(socket.id);
        if (u) {
            const leaveMsg = systemMessage(`${u.username} left the chat`);
            messages.push(leaveMsg);
            io.emit('chat:new', leaveMsg);
        }
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
