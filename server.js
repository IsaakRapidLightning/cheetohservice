const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// In-memory data stores (simple demo; not for production)
const socketIdToUser = new Map();
const messages = [];
let incrementalMessageCounter = 0;
let familyFriendly = false;
const ipBanUntil = new Map(); // ip -> timestamp (ms)
const adminRequests = new Map(); // userId -> { username, timestamp, reason }
let cheetohPartyActive = false;
const userProfiles = new Map(); // userId -> { profilePicture, bio, etc }

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
    return Array.from(socketIdToUser.values()).map(u => ({ 
        id: u.id, 
        username: u.username, 
        color: u.color, 
        isAdmin: !!u.isAdmin,
        profilePicture: userProfiles.get(u.id)?.profilePicture || null
    }));
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

// Command handlers
const commands = {
    '/help': (user, args) => {
        const helpText = `Available commands:
/help - Show this help
/picture - Display a cheetoh picture
/cheetohparty - Start a cheetoh party (admin only)
/requestadmin - Request admin privileges
/grant <username> - Grant admin to user (admin only)
/camera - Enable camera stream (admin only)
/slash - Show slash command autocomplete`;
        return { type: 'help', text: helpText };
    },
    '/slash': (user, args) => {
        const slashCommands = ['/help', '/picture', '/cheetohparty', '/requestadmin', '/grant', '/camera', '/slash'];
        return { type: 'slash', commands: slashCommands };
    },
    '/picture': (user, args) => {
        return { type: 'picture', url: '/cheetoh.png' };
    },
    '/cheetohparty': (user, args) => {
        if (!user.isAdmin) return { type: 'error', text: 'Admin privileges required' };
        cheetohPartyActive = true;
        setTimeout(() => { cheetohPartyActive = false; }, 10000); // 10 second party
        return { type: 'cheetohparty', duration: 10000 };
    },
    '/requestadmin': (user, args) => {
        const reason = args.join(' ') || 'No reason provided';
        adminRequests.set(user.id, { username: user.username, timestamp: Date.now(), reason });
        return { type: 'requestadmin', text: 'Admin request sent' };
    },
    '/grant': (user, args) => {
        if (!user.isAdmin) return { type: 'error', text: 'Admin privileges required' };
        const targetUsername = args.join(' ').trim();
        if (!targetUsername) return { type: 'error', text: 'Usage: /grant <username>' };
        
        // Find user by username
        const targetUser = Array.from(socketIdToUser.values()).find(u => u.username.toLowerCase() === targetUsername.toLowerCase());
        if (!targetUser) return { type: 'error', text: 'User not found' };
        
        targetUser.isAdmin = true;
        adminRequests.delete(targetUser.id);
        const targetSocket = io.sockets.sockets.get(targetUser.id);
        if (targetSocket) {
            targetSocket.emit('user:update_self', { username: targetUser.username, color: targetUser.color, isAdmin: targetUser.isAdmin });
        }
        const msg = systemMessage(`${targetUser.username} has been granted admin privileges`);
        messages.push(msg);
        io.emit('chat:new', msg);
        return { type: 'success', text: `Granted admin to ${targetUser.username}` };
    },
    '/camera': (user, args) => {
        if (!user.isAdmin) return { type: 'error', text: 'Admin privileges required' };
        return { type: 'camera', action: 'enable', userId: user.id, username: user.username };
    }
};

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

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ 
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp|mp3|wav|ogg|m4a|aac/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype) || file.mimetype.startsWith('audio/') || file.mimetype.startsWith('image/');
        if (mimetype && extname) cb(null, true);
        else cb(new Error('Only images and audio files allowed'));
    }
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
        self: { 
            id: user.id, 
            username: user.username, 
            color: user.color, 
            isAdmin: user.isAdmin,
            profilePicture: userProfiles.get(user.id)?.profilePicture || null
        },
        messages,
        users: getPublicUsers(),
        familyFriendly
    });

    // Notify others a user joined (system message)
    const joinMsg = systemMessage(`${user.username} joined the chat`);
    messages.push(joinMsg);
    io.emit('chat:new', joinMsg);
    io.emit('presence:join', { 
        id: user.id, 
        username: user.username, 
        color: user.color, 
        isAdmin: user.isAdmin,
        profilePicture: userProfiles.get(user.id)?.profilePicture || null
    });

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
        io.emit('presence:update', { 
            id: u.id, 
            username: u.username, 
            color: u.color, 
            isAdmin: u.isAdmin,
            profilePicture: userProfiles.get(u.id)?.profilePicture || null
        });
    });

    // Handle chat messages
    socket.on('chat:send', (text) => {
        const u = socketIdToUser.get(socket.id);
        if (!u) return;
        let content = String(text || '').slice(0, 2000);
        if (!content) return;

        // Check for commands
        if (content.startsWith('/')) {
            const [cmd, ...args] = content.split(' ');
            const handler = commands[cmd];
            if (handler) {
                const result = handler(u, args);
                if (result.type === 'help' || result.type === 'slash') {
                    socket.emit('command:result', result);
                } else if (result.type === 'picture') {
                    const message = {
                        id: generateMessageId(),
                        text: `${u.username} shared a cheetoh picture!`,
                        username: u.username,
                        color: u.color,
                        userId: u.id,
                        isAdmin: !!u.isAdmin,
                        timestamp: Date.now(),
                        type: 'picture',
                        pictureUrl: result.url
                    };
                    messages.push(message);
                    io.emit('chat:new', message);
                } else if (result.type === 'cheetohparty') {
                    io.emit('command:cheetohparty', { duration: result.duration });
                } else if (result.type === 'requestadmin') {
                    socket.emit('command:result', result);
                    // Notify all admins
                    socketIdToUser.forEach((adminUser, adminSocketId) => {
                        if (adminUser.isAdmin) {
                            const adminSocket = io.sockets.sockets.get(adminSocketId);
                            if (adminSocket) {
                                adminSocket.emit('admin:request', { userId: u.id, username: u.username, reason: adminRequests.get(u.id)?.reason });
                            }
                        }
                    });
                } else if (result.type === 'success' || result.type === 'error') {
                    socket.emit('command:result', result);
                } else if (result.type === 'camera') {
                    io.emit('command:camera', { 
                        userId: result.userId, 
                        username: result.username, 
                        action: result.action 
                    });
                }
                return;
            }
        }

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
            profilePicture: userProfiles.get(u.id)?.profilePicture || null,
            timestamp: Date.now()
        };
        console.log('Message created with profilePicture:', message.profilePicture);
        messages.push(message);
        io.emit('chat:new', message);
    });

    // Handle file uploads
    socket.on('chat:send_file', (fileData) => {
        const u = socketIdToUser.get(socket.id);
        if (!u) return;
        
        const message = {
            id: generateMessageId(),
            text: `${u.username} shared a ${fileData.type}`,
            username: u.username,
            color: u.color,
            userId: u.id,
            isAdmin: !!u.isAdmin,
            profilePicture: userProfiles.get(u.id)?.profilePicture || null,
            timestamp: Date.now(),
            type: 'file',
            fileUrl: fileData.url,
            fileType: fileData.type
        };
        messages.push(message);
        io.emit('chat:file_uploaded', {
            username: u.username,
            color: u.color,
            userId: u.id,
            isAdmin: !!u.isAdmin,
            url: fileData.url,
            type: fileData.type
        });
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

    // New admin powers
    socket.on('admin:grant_admin', ({ userId }) => {
        const u = socketIdToUser.get(socket.id);
        if (!u || !u.isAdmin) return;
        const target = socketIdToUser.get(userId);
        if (!target) return;
        target.isAdmin = true;
        adminRequests.delete(userId);
        const targetSocket = io.sockets.sockets.get(target.id);
        if (targetSocket) {
            targetSocket.emit('user:update_self', { username: target.username, color: target.color, isAdmin: target.isAdmin });
        }
        const msg = systemMessage(`${target.username} has been granted admin privileges`);
        messages.push(msg);
        io.emit('chat:new', msg);
    });

    socket.on('admin:deny_admin', ({ userId }) => {
        const u = socketIdToUser.get(socket.id);
        if (!u || !u.isAdmin) return;
        adminRequests.delete(userId);
        socket.emit('admin:deny_ok', { userId });
    });

    socket.on('admin:clear_chat', () => {
        const u = socketIdToUser.get(socket.id);
        if (!u || !u.isAdmin) return;
        messages.length = 0;
        io.emit('admin:chat_cleared');
    });

    socket.on('admin:announce', ({ text }) => {
        const u = socketIdToUser.get(socket.id);
        if (!u || !u.isAdmin) return;
        const announcement = systemMessage(`ANNOUNCEMENT: ${text}`);
        messages.push(announcement);
        io.emit('chat:new', announcement);
    });

    socket.on('admin:get_requests', () => {
        const u = socketIdToUser.get(socket.id);
        if (!u || !u.isAdmin) return;
        const requests = Array.from(adminRequests.entries()).map(([userId, data]) => ({ userId, ...data }));
        socket.emit('admin:requests', requests);
    });

    socket.on('admin:kick_all', () => {
        const u = socketIdToUser.get(socket.id);
        if (!u || !u.isAdmin) return;
        socketIdToUser.forEach((user, socketId) => {
            if (socketId !== socket.id) { // Don't kick self
                const userSocket = io.sockets.sockets.get(socketId);
                if (userSocket) {
                    userSocket.emit('sys:kicked', { reason: 'Kicked by admin (kick all)' });
                    userSocket.disconnect(true);
                }
            }
        });
    });

    // Profile picture handlers
    socket.on('profile:set_picture', ({ url }) => {
        const u = socketIdToUser.get(socket.id);
        if (!u) return;
        
        if (!userProfiles.has(u.id)) {
            userProfiles.set(u.id, {});
        }
        userProfiles.get(u.id).profilePicture = url;
        
        socket.emit('user:update_self', { 
            username: u.username, 
            color: u.color, 
            isAdmin: u.isAdmin,
            profilePicture: url
        });
        
        io.emit('presence:update', { 
            id: u.id, 
            username: u.username, 
            color: u.color, 
            isAdmin: u.isAdmin,
            profilePicture: url
        });
    });
});

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
    console.log('Upload request received:', req.file);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const fileUrl = `/uploads/${req.file.filename}`;
    const fileType = req.file.mimetype.startsWith('audio/') ? 'audio' : 'image';
    
    console.log('Upload successful:', { fileUrl, fileType, filename: req.file.originalname });
    res.json({ 
        success: true, 
        url: fileUrl, 
        type: fileType,
        filename: req.file.originalname,
        size: req.file.size
    });
});

// Profile picture upload endpoint
app.post('/upload-profile', upload.single('profile'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const fileUrl = `/uploads/${req.file.filename}`;
    
    res.json({ 
        success: true, 
        url: fileUrl,
        filename: req.file.originalname,
        size: req.file.size
    });
});

// File cleanup endpoint (admin only)
app.post('/cleanup-files', (req, res) => {
    // This would need authentication in production
    const uploadDir = path.join(__dirname, 'public', 'uploads');
    if (fs.existsSync(uploadDir)) {
        const files = fs.readdirSync(uploadDir);
        let deletedCount = 0;
        files.forEach(file => {
            const filePath = path.join(uploadDir, file);
            const stats = fs.statSync(filePath);
            // Delete files older than 7 days
            if (Date.now() - stats.mtime.getTime() > 7 * 24 * 60 * 60 * 1000) {
                fs.unlinkSync(filePath);
                deletedCount++;
            }
        });
        res.json({ success: true, deletedCount });
    } else {
        res.json({ success: true, deletedCount: 0 });
    }
});

// JSON error handler for uploads and other endpoints
app.use((err, req, res, next) => {
    if (!err) return next();
    const status = err.status || 400;
    // Prefer JSON for XHR/fetch
    res.status(status).json({ success: false, error: err.message || 'Upload error' });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
