// === Auth ===
const onlineUsers = new Map(); // socket.id → user object
const token = localStorage.getItem('chatToken');
const user = JSON.parse(localStorage.getItem('chatUser') || 'null');
if (!token || !user) location.href = '/login.html';

const socket = io({ auth: { token } });

// === Elements ===
const messagesContainer = document.getElementById('messages');
const onlineCount = document.getElementById('onlineCount');
const typingIndicator = document.getElementById('typingIndicator');
const contextMenu = document.getElementById('contextMenu');
let currentMessageId = null;

// === Typing Indicator ===
const typingUsers = new Map(); // userId → { name, timer }

document.getElementById('input').addEventListener('input', () => {
  socket.emit('typing', true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit('typing', false), 1000);
});

socket.on('typing', ({ userId, isTyping }) => {
  const user = onlineUsers.get(userId); // from online list
  const name = user?.name || 'Someone';

  if (isTyping) {
    // Start or update
    if (typingUsers.has(userId)) {
      clearTimeout(typingUsers.get(userId).timer);
    }
    typingUsers.set(userId, {
      name,
      timer: setTimeout(() => {
        typingUsers.delete(userId);
        updateTypingIndicator();
      }, 1500)
    });
  } else {
    // Stop
    if (typingUsers.has(userId)) {
      clearTimeout(typingUsers.get(userId).timer);
      typingUsers.delete(userId);
    }
  }

  updateTypingIndicator();
});

function updateTypingIndicator() {
  const indicator = document.getElementById('typingIndicator');
  const names = Array.from(typingUsers.values()).map(u => u.name);

  if (names.length === 0) {
    indicator.style.display = 'none';
    indicator.textContent = '';
    return;
  }

  let text = '';
  if (names.length === 1) {
    text = `${names[0]} is typing...`;
  } else if (names.length === 2) {
    text = `${names[0]} and ${names[1]} are typing...`;
  } else {
    text = `${names[0]}, ${names[1]} and ${names.length - 2} others are typing...`;
  }

  indicator.textContent = text;
  indicator.style.display = 'block';
}

// === Online Users ===
socket.on('online', (users) => {
  onlineUsers.clear();
  users.forEach(u => onlineUsers.set(u.id, u));
  document.getElementById('onlineCount').textContent = `${users.length} online`;
});

// === Context Menu ===
let selectedMessage = null;

function showContextMenu(e, messageId, isOwn) {
  e.preventDefault();
  selectedMessage = { id: messageId, isOwn };
  contextMenu.style.display = 'block';
  contextMenu.style.left = `${e.pageX}px`;
  contextMenu.style.top = `${e.pageY}px`;
}

function hideContextMenu() {
  contextMenu.style.display = 'none';
  selectedMessage = null;
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.message')) hideContextMenu();
});

function editMessage() {
  if (!selectedMessage?.isOwn) return;
  const msgEl = document.querySelector(`[data-id="${selectedMessage.id}"] .content`);
  const oldText = msgEl.textContent;
  const input = prompt('Edit message:', oldText);
  if (input && input !== oldText) {
    socket.emit('edit message', { messageId: selectedMessage.id, newText: input });
  }
  hideContextMenu();
}

function deleteMessage() {
  if (!selectedMessage?.isOwn) return;
  if (confirm('Delete this message?')) {
    socket.emit('delete message', selectedMessage.id);
  }
  hideContextMenu();
}

// === Add Message ===
function addMessage({ user: msgUser, text, timestamp, messageId, system }) {
  const div = document.createElement('div');
  div.className = 'message';
  div.dataset.id = messageId;
  div.dataset.userId = msgUser.id;

  if (system) {
    div.className += ' system';
    div.textContent = text;
  } else {
    const isOwn = msgUser.id === user.id;
    div.className += isOwn ? ' own' : ' other';

    const sender = document.createElement('div');
    sender.className = 'sender';
    sender.textContent = isOwn ? 'You' : msgUser.name;
    if (!isOwn) sender.style.color = msgUser.color;

    const content = document.createElement('div');
    content.className = 'content';
    content.textContent = text;

    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    div.append(sender, content, time);

    // Right-click menu
    if (isOwn) {
      div.addEventListener('contextmenu', (e) => showContextMenu(e, messageId, true));
    }
  }

  messagesContainer.appendChild(div);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// === Socket Events ===
socket.on('chat message', (data) => {
  addMessage({ ...data, messageId: data.id });
});

socket.on('user joined', (u) => addMessage({ system: true, text: `${u.name} joined` }));
socket.on('user left', (u) => addMessage({ system: true, text: `${u.name} left` }));

socket.on('message edited', ({ messageId, newText }) => {
  const msg = document.querySelector(`[data-id="${messageId}"] .content`);
  if (msg) msg.textContent = newText;
});

socket.on('message deleted', (messageId) => {
  const msg = document.querySelector(`[data-id="${messageId}"]`);
  if (msg) msg.remove();
});

// === Send Message ===
document.getElementById('form').onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (text) {
    socket.emit('chat message', text);
    input.value = '';
  }
};