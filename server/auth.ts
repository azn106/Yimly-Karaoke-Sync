import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import express from 'express';

const scryptAsync = promisify(crypto.scrypt);
const USERS_FILE = path.join(process.cwd(), 'yimly_users.json');

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: 'ADMIN' | 'USER';
  createdAt: number;
}

export interface Session {
  id: string;
  userId: string;
  username: string;
  role: 'ADMIN' | 'USER';
  createdAt: number;
  expiresAt: number;
}

// In-memory session store & IP rate limiter
const activeSessions = new Map<string, Session>();
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 Hours

// ----------------------------------------------------
// USER STORAGE (yimly_users.json)
// ----------------------------------------------------
export function loadUsers(): UserRecord[] {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf-8');
      return JSON.parse(data) as UserRecord[];
    }
  } catch (err) {
    console.error('Error reading yimly_users.json:', err);
  }
  return [];
}

export function saveUsers(users: UserRecord[]): void {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving yimly_users.json:', err);
  }
}

export function hasUsers(): boolean {
  return loadUsers().length > 0;
}

export function findUserByUsername(username: string): UserRecord | null {
  const users = loadUsers();
  const normalized = username.trim().toLowerCase();
  return users.find(u => u.username.toLowerCase() === normalized) || null;
}

export function findUserById(id: string): UserRecord | null {
  const users = loadUsers();
  return users.find(u => u.id === id) || null;
}

// ----------------------------------------------------
// SCRYPT PASSWORD HASHING
// ----------------------------------------------------
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    const parts = storedHash.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = parts[1];
    const keyHex = parts[2];
    const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
    const keyBuffer = Buffer.from(keyHex, 'hex');
    if (keyBuffer.length !== derivedKey.length) return false;
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
  } catch {
    return false;
  }
}

// ----------------------------------------------------
// SESSIONS MANAGEMENT
// ----------------------------------------------------
export function createSession(user: UserRecord): Session {
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session: Session = {
    id,
    userId: user.id,
    username: user.username,
    role: user.role,
    createdAt: now,
    expiresAt: now + SESSION_DURATION_MS,
  };
  activeSessions.set(id, session);
  return session;
}

export function getSession(sessionId?: string): Session | null {
  if (!sessionId) return null;
  const session = activeSessions.get(sessionId);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    activeSessions.delete(sessionId);
    return null;
  }
  return session;
}

export function destroySession(sessionId?: string): void {
  if (sessionId) {
    activeSessions.delete(sessionId);
  }
}

export function clearAllSessions(): void {
  activeSessions.clear();
}

// ----------------------------------------------------
// RATE LIMITING & COOKIE PARSING
// ----------------------------------------------------
export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 10) {
    return false;
  }
  entry.count++;
  return true;
}

export function parseCookies(cookieHeader?: string): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;

  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      const name = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      list[name] = decodeURIComponent(val);
    }
  });

  return list;
}

export function extractSessionToken(req: express.Request): string | null {
  // 1. Check Cookies
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.session_token) {
    return cookies.session_token;
  }

  // 2. Check Authorization Header: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }

  // 3. Check Query parameter ?session_token=...
  if (req.query && typeof req.query.session_token === 'string') {
    return req.query.session_token;
  }

  return null;
}

export function authenticateRequest(req: express.Request): Session | null {
  const token = extractSessionToken(req);
  return getSession(token || undefined);
}

// ----------------------------------------------------
// AUTHORIZATION MIDDLEWARES
// ----------------------------------------------------
export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const session = authenticateRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized: Authentication required' });
  }
  (req as any).user = session;
  next();
}

export function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const session = authenticateRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized: Authentication required' });
  }
  if (session.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Forbidden: Admin privilege required' });
  }
  (req as any).user = session;
  next();
}
