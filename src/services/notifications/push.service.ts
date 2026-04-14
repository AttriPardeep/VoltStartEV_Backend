// src/services/notifications/push.service.ts
import logger from '../../config/logger.js';
import { appDbQuery } from '../../config/database.js';

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, any>;
  channelId?: string;
}

export async function sendPushToUser(
  userId: number,
  payload: PushPayload
): Promise<void> {
  try {
    const users = await appDbQuery<{ push_token: string; push_enabled: number }>(
      'SELECT push_token, push_enabled FROM users WHERE user_id = ? AND push_token IS NOT NULL',
      [userId]
    );

    const user = users[0];
    if (!user || !user.push_enabled || !user.push_token) return;

    const message = {
      to: user.push_token,
      sound: 'default',
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      channelId: payload.channelId || 'charging',
      priority: 'high',
    };

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify(message),
    });

    const result = await response.json() as { data?: { status?: string; message?: string } };

    if (result.data?.status === 'error') {
      logger.warn('Push notification failed', { userId, error: result.data.message });
    } else {
      logger.debug('Push notification sent', { userId, title: payload.title });
    }
  } catch (err: any) {
    logger.error('Push service error', { userId, error: err.message });
  }
}
