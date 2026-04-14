// src/services/assistant/assistant.service.ts
import Anthropic from '@anthropic-ai/sdk';
import logger from '../../config/logger.js';
import { appDbQuery } from '../../config/database.js';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── Context Builder ──────────────────────────────────
async function buildUserContext(userId: number): Promise<string> {
  // Get user + primary vehicle
  const users = await appDbQuery<any>(`
    SELECT u.username, u.email,
           v.brand, v.model, v.variant, v.battery_kwh, v.target_soc
    FROM users u
    LEFT JOIN user_vehicles v ON v.user_id = u.user_id AND v.is_primary = 1
    WHERE u.user_id = ?
    LIMIT 1
  `, [userId]);

  // Get active session if any
  const sessions = await appDbQuery<any>(`
    SELECT charge_box_id, connector_id, start_time,
           end_meter_value, start_meter_value, status
    FROM charging_sessions
    WHERE app_user_id = ? AND status = 'active'
    LIMIT 1
  `, [userId]);

  // Get this month's stats
  const stats = await appDbQuery<any>(`
    SELECT COUNT(*) as sessions,
           COALESCE(SUM(energy_kwh), 0) as total_kwh,
           COALESCE(SUM(total_cost), 0) as total_cost
    FROM charging_sessions
    WHERE app_user_id = ?
      AND status = 'completed'
      AND MONTH(start_time) = MONTH(NOW())
      AND YEAR(start_time) = YEAR(NOW())
  `, [userId]);

  const user = users[0];
  const session = sessions[0];
  const stat = stats[0];

  const vehicle = user?.brand
    ? `${user.brand} ${user.model}${user.variant ? ' ' + user.variant : ''} (${user.battery_kwh} kWh, target ${user.target_soc}%)`
    : 'Not set';

  const activeSession = session
    ? `Active on ${session.charge_box_id} connector ${session.connector_id} since ${session.start_time}`
    : 'No active session';

  const monthlyStats = `${stat.sessions} sessions, ${parseFloat(stat.total_kwh).toFixed(1)} kWh, ₹${parseFloat(stat.total_cost).toFixed(0)} this month`;

  return `User: ${user?.username || 'Unknown'}
Primary Vehicle: ${vehicle}
Active Session: ${activeSession}
This Month: ${monthlyStats}`;
}

// ─── Action Parser ────────────────────────────────────
// Claude returns structured actions in addition to text
function parseAction(text: string): { action: any; cleanText: string } {
  const actionMatch = text.match(/\[ACTION:(.*?)\]/s);
  if (!actionMatch) return { action: null, cleanText: text.trim() };

  try {
    const action = JSON.parse(actionMatch[1]);
    const cleanText = text.replace(/\[ACTION:.*?\]/s, '').trim();
    return { action, cleanText };
  } catch {
    return { action: null, cleanText: text.trim() };
  }
}

// ─── Main Query Function ──────────────────────────────
export async function queryAssistant(
  userId: number,
  message: string,
  nearbyChargers?: any[],
  userLocation?: { latitude: number; longitude: number }
): Promise<{ response: string; action: any }> {

  const userContext = await buildUserContext(userId);

  const chargersContext = nearbyChargers?.length
    ? nearbyChargers.slice(0, 8).map(c =>
        `${c.chargeBoxId}: ${c.status}, ${c.availableConnectors}/${c.totalConnectors} available, ` +
        `${c.city}, ${c.distance != null ? c.distance.toFixed(1) + 'km' : 'distance unknown'}, ` +
        `${c.maxPower ? (c.maxPower / 1000).toFixed(0) + 'kW' : 'power unknown'}`
      ).join('\n')
    : 'No charger data provided';

  const locationContext = userLocation
    ? `${userLocation.latitude.toFixed(4)}, ${userLocation.longitude.toFixed(4)}`
    : 'Unknown';

  const systemPrompt = `You are Volt, a smart EV charging assistant for VoltStartEV app in India.
Be concise, helpful, and friendly. Answer in 1-3 sentences max.
All costs are in Indian Rupees (₹). Distances in km.

USER CONTEXT:
${userContext}

USER LOCATION: ${locationContext}

NEARBY CHARGERS:
${chargersContext}

CAPABILITIES — when user asks to DO something, include an action tag:
- Find/navigate to charger: [ACTION:{"type":"navigate","chargeBoxId":"CS-XX"}]
- Filter by availability: [ACTION:{"type":"filter","availability":"available"}]
- Filter by power: [ACTION:{"type":"filter","minPower":50}]
- Show session tab: [ACTION:{"type":"navigate_tab","tab":"Session"}]
- Show history tab: [ACTION:{"type":"navigate_tab","tab":"History"}]
- Start charging (only if user explicitly asks AND no active session):
  [ACTION:{"type":"start_charging","chargeBoxId":"CS-XX","connectorId":1}]
- Stop charging (only if user explicitly asks AND active session exists):
  [ACTION:{"type":"stop_charging"}]

RULES:
- Never start/stop charging unless user explicitly requests it
- For "find nearest" queries, pick the closest Available charger
- If asked about cost/sessions, use the monthly stats provided
- If user asks something unrelated to EV charging, politely redirect
- Don't make up charger data — only use what's provided above`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
    });

    const rawText = response.content[0].type === 'text'
      ? response.content[0].text : '';

    const { action, cleanText } = parseAction(rawText);

    logger.debug('Assistant query', { userId, message, action });

    return { response: cleanText, action };

  } catch (err: any) {
    logger.error('Assistant API error', { error: err.message });
    throw new Error('Assistant temporarily unavailable');
  }
}
