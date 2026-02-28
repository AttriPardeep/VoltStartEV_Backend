import jwt from 'jsonwebtoken';
export const generateToken = (payload: object, expiresIn = '7d'): string => {
  return jwt.sign(payload, process.env.JWT_SECRET || 'dev_secret', { expiresIn });
};
export const verifyToken = (token: string): any => {
  return jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
};
