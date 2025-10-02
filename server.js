import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const allowedOrigin = process.env.NODE_ENV === 'production'
  ? (process.env.CORS_ORIGIN || 'https://yourdomain.com')
  : '*';
const io = new Server(server, {
  cors: { origin: allowedOrigin, methods: ['GET', 'POST'] }
});

// simple in-memory rooms map: roomId -> Set(socketId)
const roomIdToSocketIds = new Map();
// Map для хранения имен пользователей: socketId -> userName
const socketIdToUserName = new Map();
// Map для отслеживания активности пользователей: socketId -> { lastActivity, messageCount, lastMessageReset, roomJoins, lastRoomJoinReset }
const userActivity = new Map();
// Настройки защиты от ботов
const BOT_PROTECTION = {
  MAX_MESSAGES_PER_MINUTE: 10, // Максимум сообщений в минуту
  MAX_ROOMS_PER_HOUR: 5, // Максимум комнат в час
  MIN_TIME_BETWEEN_MESSAGES: 1000, // Минимальное время между сообщениями (мс)
  MAX_MESSAGE_LENGTH: 500, // Максимальная длина сообщения
  MAX_USERNAME_LENGTH: 20 // Максимальная длина имени пользователя
};

// Функции для защиты от ботов

function initializeUserActivity(socketId) {
  const now = Date.now();
  userActivity.set(socketId, {
    lastActivity: now,
    messageCount: 0,
    lastMessageReset: now,
    roomJoins: 0,
    lastRoomJoinReset: now
  });
}

function updateUserActivity(socketId) {
  const activity = userActivity.get(socketId);
  if (activity) {
    activity.lastActivity = Date.now();
  }
}


function checkMessageRate(socketId) {
  const activity = userActivity.get(socketId);
  if (!activity) return true;
  const now = Date.now();
  const timeSinceLastMessage = now - activity.lastActivity;
  // Проверяем минимальное время между сообщениями
  if (timeSinceLastMessage < BOT_PROTECTION.MIN_TIME_BETWEEN_MESSAGES) {
    return false;
  }
  // Сбрасываем счетчик сообщений каждую минуту
  if (now - activity.lastMessageReset > 60000) {
    activity.messageCount = 0;
    activity.lastMessageReset = now;
  }
  // Проверяем лимит сообщений в минуту
  if (activity.messageCount >= BOT_PROTECTION.MAX_MESSAGES_PER_MINUTE) {
    return false;
  }
  activity.messageCount++;
  return true;
}


function checkRoomJoinRate(socketId) {
  const activity = userActivity.get(socketId);
  if (!activity) return true;
  const now = Date.now();
  const timeSinceLastRoomJoin = now - activity.lastRoomJoinReset;
  // Сбрасываем счетчик комнат каждый час
  if (timeSinceLastRoomJoin > 3600000) {
    activity.roomJoins = 0;
    activity.lastRoomJoinReset = now;
  }
  // Проверяем лимит комнат в час
  if (activity.roomJoins >= BOT_PROTECTION.MAX_ROOMS_PER_HOUR) {
    return false;
  }
  activity.roomJoins++;
  return true;
}

function validateMessage(text) {
  if (!text || typeof text !== 'string') return false;
  if (text.length > BOT_PROTECTION.MAX_MESSAGE_LENGTH) return false;
  if (text.trim().length === 0) return false;
  
  // Проверяем на спам-паттерны
  const spamPatterns = [
    /(.)\1{10,}/, // Повторяющиеся символы
    /https?:\/\/[^\s]+/gi, // Ссылки
    /[A-Z]{10,}/, // Много заглавных букв подряд
    /[0-9]{10,}/ // Много цифр подряд
  ];
  
  for (const pattern of spamPatterns) {
    if (pattern.test(text)) return false;
  }
  
  return true;
}

function validateUserName(userName) {
  if (!userName || typeof userName !== 'string') return false;
  if (userName.length > BOT_PROTECTION.MAX_USERNAME_LENGTH) return false;
  if (userName.trim().length < 2) return false;
  
  // Проверяем на нежелательные символы
  const invalidChars = /[<>\"'&]/;
  if (invalidChars.test(userName)) return false;
  
  return true;
}

io.on('connection', (socket) => {
  let currentRoomId = null;
  
  // Инициализируем активность пользователя
  initializeUserActivity(socket.id);

  socket.on('join', (roomId) => {
    console.log(`Socket ${socket.id} joining room ${roomId}`);
    // Проверяем валидность roomId
    if (!roomId || typeof roomId !== 'string' || roomId.length < 3 || roomId.length > 32 || /[^a-zA-Z0-9_-]/.test(roomId)) {
      socket.emit('error', { type: 'room', message: 'Недопустимый идентификатор комнаты' });
      return;
    }
    // Проверяем лимит комнат
    if (!checkRoomJoinRate(socket.id)) {
      console.log(`Socket ${socket.id} exceeded room join rate limit`);
        socket.emit('error', { type: 'room', message: 'Превышен лимит присоединений к комнатам' });
      return;
    }
    // Выходим из предыдущей комнаты если есть
    if (currentRoomId) {
      socket.leave(currentRoomId);
      const prevPeers = roomIdToSocketIds.get(currentRoomId);
      if (prevPeers) {
        prevPeers.delete(socket.id);
        socket.to(currentRoomId).emit('peer-left', { socketId: socket.id });
        if (prevPeers.size === 0) roomIdToSocketIds.delete(currentRoomId);
      }
    }
    if (!roomIdToSocketIds.has(roomId)) roomIdToSocketIds.set(roomId, new Set());
    const peers = roomIdToSocketIds.get(roomId);
    peers.add(socket.id);
    socket.join(roomId);
    currentRoomId = roomId;
    // Отправляем новому пиру список всех существующих пиров
    const existingPeers = [...peers].filter(id => id !== socket.id);
    console.log(`Sending peers list to ${socket.id}:`, existingPeers);
    socket.emit('peers-list', { peers: existingPeers });
    // Уведомляем всех существующих пиров о новом участнике
    console.log(`Notifying room ${roomId} about new peer: ${socket.id}`);
    socket.to(roomId).emit('peer-joined', { socketId: socket.id });
  });

  socket.on('leave', (roomId) => {
    console.log(`Socket ${socket.id} leaving room ${roomId}`);
    // Проверяем валидность roomId
    if (!roomId || typeof roomId !== 'string' || roomId.length < 3 || roomId.length > 32 || /[^a-zA-Z0-9_-]/.test(roomId)) {
      socket.emit('error', { type: 'room', message: 'Недопустимый идентификатор комнаты' });
      return;
    }
    const peers = roomIdToSocketIds.get(roomId);
    if (peers) {
      peers.delete(socket.id);
      socket.to(roomId).emit('peer-left', { socketId: socket.id });
      if (peers.size === 0) roomIdToSocketIds.delete(roomId);
    }
    socket.leave(roomId);
    if (currentRoomId === roomId) currentRoomId = null;
    // Очищаем активность пользователя
    userActivity.delete(socket.id);
  });

  socket.on('disconnect', () => {
    console.log(`Socket ${socket.id} disconnected`);
    if (currentRoomId) {
      const peers = roomIdToSocketIds.get(currentRoomId);
      if (peers) {
        peers.delete(socket.id);
        socket.to(currentRoomId).emit('peer-left', { socketId: socket.id });
        if (peers.size === 0) roomIdToSocketIds.delete(currentRoomId);
      }
    }
    // Очищаем имя пользователя и активность при отключении
    socketIdToUserName.delete(socket.id);
    userActivity.delete(socket.id);
  });

  socket.on('signal', ({ to, data }) => {
    if (to) {
      // Проверяем, что оба сокета в одной комнате
      let targetRoom = null;
      for (const [roomId, peers] of roomIdToSocketIds.entries()) {
        if (peers.has(socket.id) && peers.has(to)) {
          targetRoom = roomId;
          break;
        }
      }
      if (!targetRoom) {
        console.log(`Signal from ${socket.id} to ${to} rejected: not in same room`);
        socket.emit('error', { type: 'signal', message: 'Пользователь не найден в вашей комнате' });
        return;
      }
      console.log(`Signal from ${socket.id} to ${to}:`, data.type || 'candidate');
      io.to(to).emit('signal', { from: socket.id, data });
    }
  });

  socket.on('set-user-name', ({ userName }) => {
    console.log(`Socket ${socket.id} set name to: ${userName}`);
    // Проверяем валидность имени
    if (!validateUserName(userName)) {
      console.log(`Socket ${socket.id} provided invalid username: ${userName}`);
      socket.emit('error', { type: 'username', message: 'Недопустимое имя пользователя' });
      return;
    }
    // Проверяем уникальность имени в комнате
    if (currentRoomId) {
      const peers = roomIdToSocketIds.get(currentRoomId);
      for (const peerId of peers) {
        if (peerId !== socket.id && socketIdToUserName.get(peerId) === userName) {
          socket.emit('error', { type: 'username', message: 'Имя пользователя уже занято в комнате' });
          return;
        }
      }
    }
    socketIdToUserName.set(socket.id, userName);
    // Уведомляем всех в текущей комнате о новом имени
    if (currentRoomId) {
      socket.to(currentRoomId).emit('user-name-set', {
        socketId: socket.id,
        userName: userName
      });
      // Отправляем подтверждение самому пользователю
      socket.emit('user-name-set', {
        socketId: socket.id,
        userName: userName
      });
    }
  });

  socket.on('chat-message', ({ text, timestamp }) => {
    const author = socketIdToUserName.get(socket.id) || 'Гость';
    console.log(`Chat message from ${socket.id} (${author}): ${text}`);
    // Проверяем валидность сообщения
    if (!validateMessage(text)) {
      console.log(`Socket ${socket.id} sent invalid message: ${text}`);
        socket.emit('error', { type: 'chat', message: 'Недопустимое сообщение' });
      return;
    }
    // Проверяем лимит сообщений
    if (!checkMessageRate(socket.id)) {
      console.log(`Socket ${socket.id} exceeded message rate limit`);
        socket.emit('error', { type: 'chat', message: 'Превышен лимит сообщений' });
      return;
    }
    // Пересылаем сообщение всем в текущей комнате
    if (currentRoomId) {
      socket.to(currentRoomId).emit('chat-message', {
        author,
        text,
        timestamp
      });
    }
  });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`webrtc-mvp listening on http://localhost:${PORT}`);
});