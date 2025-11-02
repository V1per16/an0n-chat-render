const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: "*" } });
const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// --- PostgreSQL Pool ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// --- Middleware ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// --- Helpers ---
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

const activeSessions = {};
const onlineUsers = new Map();

// --- Init DB ---
pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR UNIQUE NOT NULL,
    password VARCHAR NOT NULL,
    color VARCHAR NOT NULL,
    unique_id VARCHAR UNIQUE
  );
  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    timestamp BIGINT NOT NULL
  );
`).catch(console.error);

// --- Routes ---
app.get('/', (req, res) => res.sendFile(__dirname + '/public/login.html'));

// Register
app.post('/api/register', async (req, res) => {
  const { name, password, color } = req.body;
  if (!name || !password || !color) return res.status(400).json({ error: 'All fields required' });

  const hashed = hashPassword(password);
  const uniqueId = generateUniqueId();

  try {
    const result = await pool.query(
      'INSERT INTO users (name, password, color, unique_id) VALUES ($1, $2, $3, $4) RETURNING id, unique_id',
      [name, hashed, color, uniqueId]
    );
    res.json({ success: true, userId: result.rows[0].id, uniqueId: result.rows[0].unique_id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Username taken' });
    res.status(500).json({ error: 'Database error' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Required' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE name = $1', [name]);
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
    activeSessions[token] = {
      user: { id: user.id, name: user.name, color: user.color, uniqueId: user.unique_id },
      expires
    };

    res.json({
      success: true,
      token,
      user: { id: user.id, name: user.name, color: user.color, uniqueId: user.unique_id }
    });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ---- Update Profile (FIXED) ----
app.post('/api/update-profile', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const session = activeSessions[token];
  if (!session || session.expires < Date.now()) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  const { name, color, password } = req.body;
  if (!name || !color) {
    return res.status(400).json({ error: 'Name and color required' });
  }

  // Dynamic query for optional password
  let query = 'UPDATE users SET name = $1, color = $2 WHERE id = $3';
  let params = [name, color, session.user.id];

  if (password) {
    query = 'UPDATE users SET name = $1, color = $2, password = $3 WHERE id = $4';
    params = [name, color, hashPassword(password), session.user.id];
  }

  try {
    const result = await pool.query(query, params);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    session.user.name = name;
    session.user.color = color;
    res.json({ success: true });
  } catch (err) {
    console.error('UPDATE PROFILE error:', err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Username already taken' });
    }
    res.status(500).json({ error: 'Database error' });
  }
});

// --- Socket.IO ---
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const sess = activeSessions[token];
  if (sess && sess.expires > Date.now()) {
    socket.user = sess.user;
    next();
  } else next(new Error('Unauthorized'));
});

io.on('connection', (socket) => {
  onlineUsers.set(socket.id, socket.user);
  io.emit('online', Array.from(onlineUsers.values()));

  // Join message
  socket.broadcast.emit('user joined', socket.user);

  // Load history
  pool.query(`
    SELECT m.id, m.text, m.timestamp, u.name, u.color, u.unique_id AS "uniqueId", u.id AS user_id
    FROM messages m JOIN users u ON m.user_id = u.id
    ORDER BY m.timestamp ASC LIMIT 200
  `).then(({ rows }) => {
    rows.forEach(r => socket.emit('chat message', {
      id: r.id,
      user: { id: r.user_id, name: r.name, color: r.color, uniqueId: r.uniqueId },
      text: r.text,
      timestamp: r.timestamp
    }));
  });

  // Chat message
  socket.on('chat message', async (text) => {
    const ts = Date.now();
    const result = await pool.query(
      'INSERT INTO messages (user_id, text, timestamp) VALUES ($1, $2, $3) RETURNING id',
      [socket.user.id, text, ts]
    );
    const payload = {
      id: result.rows[0].id,
      user: { ...socket.user },
      text,
      timestamp: ts
    };
    io.emit('chat message', payload);
  });

  // Typing
  socket.on('typing', (isTyping) => {
    socket.broadcast.emit('typing', { userId: socket.user.id, isTyping });
  });

  // Edit/Delete
  socket.on('edit message', async ({ messageId, newText }) => {
    const res = await pool.query('SELECT user_id FROM messages WHERE id = $1', [messageId]);
    if (res.rows[0]?.user_id === socket.user.id) {
      await pool.query('UPDATE messages SET text = $1 WHERE id = $2', [newText, messageId]);
      io.emit('message edited', { messageId, newText });
    }
  });

  socket.on('delete message', async (messageId) => {
    const res = await pool.query('SELECT user_id FROM messages WHERE id = $1', [messageId]);
    if (res.rows[0]?.user_id === socket.user.id) {
      await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);
      io.emit('message deleted', messageId);
    }
  });

  // Leave message
  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('online', Array.from(onlineUsers.values()));
    socket.broadcast.emit('user left', socket.user);
  });
});

// Keep DB warm
setInterval(() => pool.query('SELECT 1').catch(() => {}), 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
