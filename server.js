import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

// Импорт для оптимизации производительности
import cluster from 'cluster';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Оптимизация для сервера 1GB RAM + 1 CPU
const ENABLE_CLUSTER = process.env.ENABLE_CLUSTER === 'true';
const WORKER_PROCESSES = ENABLE_CLUSTER ? Math.min(os.cpus().length, 2) : 1;

if (cluster.isMaster && ENABLE_CLUSTER) {
  console.log(`Master process ${process.pid} is running`);
  
  // Создаем воркеры
  for (let i = 0; i < WORKER_PROCESSES; i++) {
    cluster.fork();
  }
  
  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });
} else {
  // Воркер процесс
  const app = express();
  
  // Оптимизированные заголовки для производительности
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Кэширование статики
    res.setHeader('Connection', 'keep-alive'); // Keep-alive соединения
    next();
  });
  
  const server = http.createServer(app);
  const VERBOSE_LOGS = process.env.VERBOSE_LOGS === '1' || process.env.VERBOSE_LOGS === 'true';
  
  // Оптимизированная конфигурация Socket.IO для сервера
  const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    // Оптимизации для производительности
    transports: ['websocket'], // Только WebSocket для экономии ресурсов
    allowEIO3: false, // Отключаем старые версии
    pingTimeout: 60000, // Увеличиваем таймаут пинга
    pingInterval: 25000, // Увеличиваем интервал пинга
    maxHttpBufferSize: 1e6, // 1MB буфер
    // Оптимизации памяти
    serveClient: false, // Не раздаем клиентские файлы
    allowUpgrades: false, // Отключаем апгрейды
    perMessageDeflate: {
      threshold: 1024, // Сжимаем сообщения больше 1KB
      concurrencyLimit: 10,
      memLevel: 7
    }
  });

  // Оптимизированные структуры данных для сервера
  const roomIdToSocketIds = new Map();
  const socketIdToUserName = new Map();
  const userActivity = new Map();
  
  // Кэш для часто используемых данных
  const cache = {
    peersList: new Map(), // roomId -> cached peers list
    lastUpdate: new Map()  // roomId -> timestamp
  };
  
  // Пулы для оптимизации памяти
  const messagePool = [];
  const activityPool = [];
  
  // Функции для работы с пулами объектов
  function getMessageFromPool() {
    return messagePool.pop() || {
      author: '',
      text: '',
      timestamp: null,
      socketId: ''
    };
  }
  
  function returnMessageToPool(message) {
    message.author = '';
    message.text = '';
    message.timestamp = null;
    message.socketId = '';
    messagePool.push(message);
  }
  
  function getActivityFromPool() {
    return activityPool.pop() || {
      lastActivity: 0,
      messageCount: 0,
      joinTime: 0,
      roomJoins: 0
    };
  }
  
  function returnActivityToPool(activity) {
    activity.lastActivity = 0;
    activity.messageCount = 0;
    activity.joinTime = 0;
    activity.roomJoins = 0;
    activityPool.push(activity);
  }
  // Настройки защиты от ботов
  const BOT_PROTECTION = {
    MAX_MESSAGES_PER_MINUTE: 10, // Максимум сообщений в минуту
    MAX_ROOMS_PER_HOUR: 5, // Максимум комнат в час
    MIN_TIME_BETWEEN_MESSAGES: 1000, // Минимальное время между сообщениями (мс)
    MAX_MESSAGE_LENGTH: 500, // Максимальная длина сообщения
    MAX_USERNAME_LENGTH: 20 // Максимальная длина имени пользователя
  };

  // Оптимизированные функции для защиты от ботов
  function initializeUserActivity(socketId) {
    const activity = getActivityFromPool();
    activity.lastActivity = Date.now();
    activity.messageCount = 0;
    activity.joinTime = Date.now();
    activity.roomJoins = 0;
    userActivity.set(socketId, activity);
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
    if (now - activity.joinTime > 60000) {
      activity.messageCount = 0;
      activity.joinTime = now;
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
    const timeSinceJoin = now - activity.joinTime;
    
    // Сбрасываем счетчик комнат каждый час
    if (timeSinceJoin > 3600000) {
      activity.roomJoins = 0;
      activity.joinTime = now;
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
      if (VERBOSE_LOGS) console.log(`Socket ${socket.id} joining room ${roomId}`);
      
      // Проверяем лимит комнат
      if (!checkRoomJoinRate(socket.id)) {
        if (VERBOSE_LOGS) console.log(`Socket ${socket.id} exceeded room join rate limit`);
        socket.emit('error', { message: 'Превышен лимит присоединений к комнатам' });
        return;
      }
      
      // Выходим из предыдущей комнаты если есть
      if (currentRoomId) {
        socket.leave(currentRoomId);
        const prevPeers = roomIdToSocketIds.get(currentRoomId);
        if (prevPeers) {
          prevPeers.delete(socket.id);
          socket.to(currentRoomId).emit('peer-left', { socketId: socket.id });
          if (prevPeers.size === 0) {
            roomIdToSocketIds.delete(currentRoomId);
            // Очищаем кэш для освободившейся комнаты
            cache.peersList.delete(currentRoomId);
            cache.lastUpdate.delete(currentRoomId);
          }
        }
      }

      if (!roomIdToSocketIds.has(roomId)) roomIdToSocketIds.set(roomId, new Set());
      const peers = roomIdToSocketIds.get(roomId);
      peers.add(socket.id);
      socket.join(roomId);
      currentRoomId = roomId;

      // Оптимизированная отправка списка пиров с кэшированием
      const existingPeers = [...peers].filter(id => id !== socket.id);
      
      // Кэшируем список пиров для этой комнаты
      cache.peersList.set(roomId, existingPeers);
      cache.lastUpdate.set(roomId, Date.now());
      
      if (VERBOSE_LOGS) console.log(`Sending peers list to ${socket.id}:`, existingPeers);
      socket.emit('peers-list', { peers: existingPeers });

      // Уведомляем всех существующих пиров о новом участнике
      if (VERBOSE_LOGS) console.log(`Notifying room ${roomId} about new peer: ${socket.id}`);
      socket.to(roomId).emit('peer-joined', { socketId: socket.id });
    });

    socket.on('leave', (roomId) => {
      if (VERBOSE_LOGS) console.log(`Socket ${socket.id} leaving room ${roomId}`);
      const peers = roomIdToSocketIds.get(roomId);
      if (peers) {
        peers.delete(socket.id);
        socket.to(roomId).emit('peer-left', { socketId: socket.id });
        if (peers.size === 0) roomIdToSocketIds.delete(roomId);
      }
      socket.leave(roomId);
      if (currentRoomId === roomId) currentRoomId = null;
    });

    socket.on('disconnect', () => {
      if (VERBOSE_LOGS) console.log(`Socket ${socket.id} disconnected`);
      if (currentRoomId) {
        const peers = roomIdToSocketIds.get(currentRoomId);
        if (peers) {
          peers.delete(socket.id);
          socket.to(currentRoomId).emit('peer-left', { socketId: socket.id });
          if (peers.size === 0) roomIdToSocketIds.delete(currentRoomId);
        }
      }
      // Очищаем имя пользователя при отключении
      socketIdToUserName.delete(socket.id);
    });

    // Оптимизированная обработка сигналов WebRTC
    socket.on('signal', ({ to, data }) => {
      if (to && data) {
        // Проверяем валидность сигнала на сервере
        if (data.sdp || data.candidate) {
          if (VERBOSE_LOGS) console.log(`Signal from ${socket.id} to ${to}:`, data.sdp?.type || 'candidate');
          io.to(to).emit('signal', { from: socket.id, data });
        } else {
          if (VERBOSE_LOGS) console.log(`Invalid signal from ${socket.id} to ${to}`);
        }
      }
    });

    socket.on('set-user-name', ({ userName }) => {
      if (VERBOSE_LOGS) console.log(`Socket ${socket.id} set name to: ${userName}`);
      
      // Проверяем валидность имени
      if (!validateUserName(userName)) {
        if (VERBOSE_LOGS) console.log(`Socket ${socket.id} provided invalid username: ${userName}`);
        socket.emit('error', { message: 'Недопустимое имя пользователя' });
        return;
      }
      
      socketIdToUserName.set(socket.id, userName);
      
      // Уведомляем всех в текущей комнате о новом имени
      if (currentRoomId) {
        socket.to(currentRoomId).emit('user-name-set', { 
          socketId: socket.id, 
          userName: userName 
        });
      }
    });

    socket.on('chat-message', ({ author, text, timestamp }) => {
      if (VERBOSE_LOGS) console.log(`Chat message from ${socket.id} (${author})`);
      
      // Проверяем валидность сообщения
      if (!validateMessage(text)) {
        if (VERBOSE_LOGS) console.log(`Socket ${socket.id} sent invalid message`);
        socket.emit('error', { message: 'Недопустимое сообщение' });
        return;
      }
      
      // Проверяем лимит сообщений
      if (!checkMessageRate(socket.id)) {
        if (VERBOSE_LOGS) console.log(`Socket ${socket.id} exceeded message rate limit`);
        socket.emit('error', { message: 'Превышен лимит сообщений' });
        return;
      }
      
      // Пересылаем сообщение всем в текущей комнате с оптимизацией
      if (currentRoomId) {
        // Получаем объект сообщения из пула для экономии памяти
        const message = getMessageFromPool();
        message.author = author;
        message.text = text;
        message.timestamp = timestamp;
        
        // Отправляем сообщение
        socket.to(currentRoomId).emit('chat-message', message);
        
        // Возвращаем объект в пул
        returnMessageToPool(message);
      }
    });
  });

  // Оптимизированная раздача статических файлов
  app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1h', // Кэширование статики на 1 час
    etag: true,
    lastModified: true,
    setHeaders: (res, path) => {
      // Специальные заголовки для разных типов файлов
      if (path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (path.endsWith('.js') || path.endsWith('.css')) {
        res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 часа
      }
    }
  }));

  // Очистка памяти каждые 5 минут
  setInterval(() => {
    const now = Date.now();
    // Очищаем старые записи активности
    for (const [socketId, activity] of userActivity.entries()) {
      if (now - activity.lastActivity > 300000) { // 5 минут
        returnActivityToPool(activity);
        userActivity.delete(socketId);
        socketIdToUserName.delete(socketId);
      }
    }
    
    // Очищаем старый кэш
    for (const [roomId, timestamp] of cache.lastUpdate.entries()) {
      if (now - timestamp > 300000) { // 5 минут
        cache.peersList.delete(roomId);
        cache.lastUpdate.delete(roomId);
      }
    }
    
    if (VERBOSE_LOGS) {
      console.log(`Memory cleanup: ${userActivity.size} active users, ${roomIdToSocketIds.size} rooms`);
    }
  }, 300000); // 5 минут

  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => {
    console.log(`Worker ${process.pid} listening on http://localhost:${PORT}`);
    console.log(`Optimized for 1GB RAM + 1 CPU server`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log(`Worker ${process.pid} received SIGTERM, shutting down gracefully`);
    server.close(() => {
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log(`Worker ${process.pid} received SIGINT, shutting down gracefully`);
    server.close(() => {
      process.exit(0);
    });
  });
}