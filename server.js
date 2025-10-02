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
let familyFriendly = false;
const ipBanUntil = new Map(); // ip -> timestamp (ms)

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
        isAdmin: false,
        timestamp: Date.now(),
        system: true
    };
}

function getPublicUsers() {
    return Array.from(socketIdToUser.values()).map(u => ({ id: u.id, username: u.username, color: u.color, isAdmin: !!u.isAdmin }));
}

// Simple censor utility for family-friendly mode
const bannedWords = [
    'fuck','shit','bitch','asshole','cunt','dick','pussy','nigger','nigga','faggot','slut','whore','bastard','cock','jerk','retard'
];
const bannedPatterns = new RegExp(`\\b(${bannedWords.join('|')})\\b`, 'gi');
function censorTextIfNeeded(text) {
    if (!familyFriendly) return text;
    return String(text).replace(bannedPatterns, (m) => '*'.repeat(m.length));
}

// Connection gate for temporary IP bans
io.use((socket, next) => {
    const ip = getClientIp(socket);
    const until = ipBanUntil.get(ip) || 0;
    const now = Date.now();
    if (until > now) {
        const remainingMs = until - now;
        const err = new Error('banned');
        // @ts-ignore attach info
        err.data = { reason: 'temp_ban', remainingMs };
        return next(err);
    }
    return next();
});

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
        messages,
        users: getPublicUsers(),
        familyFriendly
    });

    // Notify others a user joined (system message)
    const joinMsg = systemMessage(`${user.username} joined the chat`);
    messages.push(joinMsg);
    io.emit('chat:new', joinMsg);
    io.emit('presence:join', { id: user.id, username: user.username, color: user.color, isAdmin: user.isAdmin });

    // Handle username updates
    socket.on('user:set_username', (newUsername) => {
        const u = socketIdToUser.get(socket.id);
        if (!u) return;
        let trimmed = String(newUsername || '').trim().slice(0, 24);
        trimmed = censorTextIfNeeded(trimmed);
        if (!trimmed) return;
        const old = u.username;
        u.username = trimmed;
        socket.emit('user:update_self', { username: u.username, color: u.color, isAdmin: u.isAdmin });
        const msg = systemMessage(`${old} is now known as ${u.username}`);
        messages.push(msg);
        io.emit('chat:new', msg);
        io.emit('presence:update', { id: u.id, username: u.username, color: u.color, isAdmin: u.isAdmin });
    });

    // Handle chat messages
    socket.on('chat:send', (text) => {
        const u = socketIdToUser.get(socket.id);
        if (!u) return;
        let content = String(text || '').slice(0, 2000);
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

        content = censorTextIfNeeded(content);
        const message = {
            id: generateMessageId(),
            text: content,
            username: u.username,
            color: u.color,
            userId: u.id,
            isAdmin: !!u.isAdmin,
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
        message.text = censorTextIfNeeded(content);
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
            io.emit('presence:leave', { id: u.id });
        }
    });

    // Admin endpoints
    socket.on('admin:set_family_friendly', (enabled) => {
        const u = socketIdToUser.get(socket.id);
        if (!u || !u.isAdmin) return;
        familyFriendly = !!enabled;
        io.emit('admin:family_friendly', { enabled: familyFriendly });
    });

    socket.on('admin:get_history', ({ limit }) => {
        const u = socketIdToUser.get(socket.id);
        if (!u || !u.isAdmin) return;
        const lim = Math.max(1, Math.min(Number(limit) || 200, 1000));
        const slice = messages.slice(-lim);
        socket.emit('admin:history', slice);
    });

    socket.on('admin:censor_message', ({ id }) => {
        const u = socketIdToUser.get(socket.id);
        if (!u || !u.isAdmin) return;
        const m = messages.find(x => x && x.id === id);
        if (!m || m.system) return;
        m.text = '[censored]';
        m.editedAt = Date.now();
        io.emit('chat:edited', { id: m.id, text: m.text, editedAt: m.editedAt });
    });

    socket.on('admin:kick', ({ userId, durationMs }) => {
        const u = socketIdToUser.get(socket.id);
        if (!u || !u.isAdmin) return;
        const target = socketIdToUser.get(userId);
        if (!target) return;
        const dur = Math.max(0, Math.min(Number(durationMs) || 0, 60_000));
        if (dur > 0) {
            const until = Date.now() + dur;
            ipBanUntil.set(target.ip, until);
        }
        const reason = dur > 0 ? `Kicked and temporarily banned for ${Math.round(dur/1000)}s` : 'Kicked by admin';
        const targetSocket = io.sockets.sockets.get(target.id);
        if (targetSocket) {
            targetSocket.emit('sys:kicked', { reason, durationMs: dur });
            targetSocket.disconnect(true);
        }
    });

    socket.on('admin:unban_ip', ({ ip }) => {
        const u = socketIdToUser.get(socket.id);
        if (!u || !u.isAdmin) return;
        if (typeof ip === 'string') ipBanUntil.delete(ip);
        socket.emit('admin:unban_ok', { ip });
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
