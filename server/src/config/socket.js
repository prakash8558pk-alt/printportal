import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
let io;
export const initSocket = server => {
 io = new Server(server, { cors: { origin: (process.env.CLIENT_ORIGIN || '').split(',') } });
 io.use(async (socket, next) => {
  try {
   const claims = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
   const user = await User.findById(claims.userId);
   if (!user || !user.isActive || user.tokenVersion !== claims.tokenVersion || user.role !== claims.role) throw new Error('Unauthorized');
   socket.data.organizationId = user.organization;
   socket.data.expiresAt = claims.exp * 1000;
   next();
  } catch { next(new Error('Unauthorized')); }
 });
 io.on('connection', socket => {
  socket.join(socket.data.organizationId);
  const timer = setTimeout(() => socket.disconnect(true), Math.max(0,socket.data.expiresAt-Date.now()));
  socket.on('disconnect', () => clearTimeout(timer));
 });
};
export const getIO = () => io;
