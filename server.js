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
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// simple in-memory rooms map: roomId -> Set(socketId)
const roomIdToSocketIds = new Map();

io.on('connection', (socket) => {
  let currentRoomId = null;

  socket.on('join', (roomId) => {
    console.log(`Socket ${socket.id} joining room ${roomId}`);
    
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
    console.log(`Socket ${socket.id} disconnected`);
    if (currentRoomId) {
      const peers = roomIdToSocketIds.get(currentRoomId);
      if (peers) {
        peers.delete(socket.id);
        socket.to(currentRoomId).emit('peer-left', { socketId: socket.id });
        if (peers.size === 0) roomIdToSocketIds.delete(currentRoomId);
      }
    }
  });

  socket.on('signal', ({ to, data }) => {
    if (to) {
      console.log(`Signal from ${socket.id} to ${to}:`, data.type || 'candidate');
      io.to(to).emit('signal', { from: socket.id, data });
    }
  });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`webrtc-mvp listening on http://localhost:${PORT}`);
});


