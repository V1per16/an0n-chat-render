const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server);
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// ---------- Middleware ----------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// ---------- Database ----------
const DB_PATH = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      color TEXT NOT NULL,
      unique_id TEXT UNIQUE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // Add unique_id column if missing (safe to run multiple times)
  db.run(`ALTER TABLE users ADD COLUMN unique_id TEXT UNIQUE`, (err) => {
    if (err && !err.message.includes('duplicate column name')) console.error(err);
  });
});

// ---------- Helpers ----------
function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
function verifyPassword(pw, hash) { return bcrypt.compareSync(pw, hash); }

function generateUniqueId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '#';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// In-memory session store
const activeSessions = {};

// ---------- Routes ----------
app.get('/', (req, res) => res.sendFile(__dirname + '/public/login.html'));

// ---- Register ----
app.post('/api/register', (req, res) => {
  const { name, password, color } = req.body;
  if (!name || !password || !color) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const hashed = hashPassword(password);
  const uniqueId = generateUniqueId();

  db.run(
    'INSERT INTO users (name, password, color, unique_id) VALUES (?, ?, ?, ?)',
    [name, hashed, color, uniqueId],
    function (err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(400).json({ error: 'Username or ID taken' });
        }
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ success: true, userId: this.lastID, uniqueId });
    }
  );
});

// ---- Login ----
app.post('/api/login', (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) {
    return res.status(400).json({ error: 'Username & password required' });
  }

  db.get(
    'SELECT id, name, color, password, unique_id FROM users WHERE name = ?',
    [name],
    (err, user) => {
      if (err || !user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      if (!verifyPassword(password, user.password)) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
      activeSessions[token] = {
        user: {
          id: user.id,
          name: user.name,
          color: user.color,
          uniqueId: user.unique_id
        },
        expires
      };

      res.json({
        success: true,
        token,
        user: {
          id: user.id,
          name: user.name,
          color: user.color,
          uniqueId: user.unique_id
        }
      });
    }
  );
});

// ---- Update Profile ----
app.post('/api/update-profile', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  const token = auth.split(' ')[1];
  const session = activeSessions[token];
  if (!session || session.expires < Date.now()) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  const { name, color, password } = req.body;
  if (!name || !color) {
    return res.status(400).json({ error: 'Name and color required' });
  }

  let updates = ['name = ?', 'color = ?'];
  let values = [name, color];
  if (password) {
    updates.push('password = ?');
    values.push(hashPassword(password));
  }
  values.push(session.user.id);

  const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
  db.run(sql, values, function (err) {
    if (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(400).json({ error: 'Username taken' });
      }
      return res.status(500).json({ error: 'Database error' });
    }
    session.user.name = name;
    session.user.color = color;
    res.json({ success: true });
  });
});

// ---------- Socket.IO ----------
const onlineUsers = new Map(); // socket.id → user

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const sess = activeSessions[token];
  if (sess && sess.expires > Date.now()) {
    socket.user = sess.user;
    next();
  } else {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  console.log(`${socket.user.name} (#${socket.user.uniqueId}) connected`);

  // Online list
  onlineUsers.set(socket.id, socket.user);
  io.emit('online', Array.from(onlineUsers.values()));

  // Join message
  socket.broadcast.emit('user joined', socket.user);

  // Load history
  db.all(
    `SELECT m.id, m.text, m.timestamp, u.name, u.color, u.unique_id AS uniqueId
     FROM messages m
     JOIN users u ON m.user_id = u.id
     ORDER BY m.timestamp ASC
     LIMIT 200`,
    [],
    (err, rows) => {
      if (!err) {
        rows.forEach(r =>
          socket.emit('chat message', {
            id: r.id,
            user: { id: r.user_id, name: r.name, color: r.color, uniqueId: r.uniqueId },
            text: r.text,
            timestamp: r.timestamp
          })
        );
      }
    }
  );

  // === CHAT MESSAGE HANDLER ===
  socket.on('chat message', (text) => {
    const timestamp = Date.now();
    db.run(
      'INSERT INTO messages (user_id, text, timestamp) VALUES (?, ?, ?)',
      [socket.user.id, text, timestamp],
      function (err) {
        if (err) return console.error('MSG INSERT error:', err);

        const payload = {
          id: this.lastID,
          user: {
            id: socket.user.id,
            name: socket.user.name,
            color: socket.user.color,
            uniqueId: socket.user.uniqueId
          },
          text,
          timestamp
        };
        io.emit('chat message', payload);
      }
    );
  });

  // === Typing ===
  socket.on('typing', (isTyping) => {
    socket.broadcast.emit('typing', { userId: socket.user.id, isTyping });
  });

  // === Edit Message ===
  socket.on('edit message', ({ messageId, newText }) => {
    db.get('SELECT user_id FROM messages WHERE id = ?', [messageId], (err, msg) => {
      if (msg && msg.user_id === socket.user.id) {
        db.run('UPDATE messages SET text = ? WHERE id = ?', [newText, messageId]);
        io.emit('message edited', { messageId, newText });
      }
    });
  });

  // === Delete Message ===
  socket.on('delete message', (messageId) => {
    db.get('SELECT user_id FROM messages WHERE id = ?', [messageId], (err, msg) => {
      if (msg && msg.user_id === socket.user.id) {
        db.run('DELETE FROM messages WHERE id = ?', [messageId]);
        io.emit('message deleted', messageId);
      }
    });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('online', Array.from(onlineUsers.values()));
    socket.broadcast.emit('user left', socket.user);
  });
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chat server running on http://localhost:${PORT}`);
});