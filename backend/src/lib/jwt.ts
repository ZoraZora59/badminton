import jwt from 'jsonwebtoken';
import type { AppConfig } from '../config';

export interface JwtPayload {
  userId: number;
}

export function signToken(cfg: AppConfig, payload: JwtPayload): string {
  return jwt.sign(payload, cfg.jwt.secret, {
    expiresIn: cfg.jwt.expiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(cfg: AppConfig, token: string): JwtPayload {
  const decoded = jwt.verify(token, cfg.jwt.secret) as JwtPayload & jwt.JwtPayload;
  return { userId: decoded.userId };
}
