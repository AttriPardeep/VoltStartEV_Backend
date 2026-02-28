import jwt from 'jsonwebtoken';

export const generateToken = (payload: object, expiresIn = '7d'): string => {
  const secret = (process.env.JWT_SECRET || 'dev_secret_change_in_production') as jwt.Secret;
  return jwt.sign(payload, secret, { expiresIn } as jwt.SignOptions);
};

export const verifyToken = (token: string): any => {
  const secret = (process.env.JWT_SECRET || 'dev_secret_change_in_production') as jwt.Secret;
  return jwt.verify(token, secret);
};
