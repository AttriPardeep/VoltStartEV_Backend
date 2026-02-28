export interface User {
  id: string; name: string; email?: string; phone?: string; walletBalance: number; isVerified: boolean;
  evDetails?: { model: string; batteryCapacity: number; vehicleNumber?: string };
  savedChargers: string[]; paymentMethods: { id: string; last4: string; type: 'card'|'upi'|'wallet' }[]; history: ChargingSession[];
}
export interface Charger {
  id: string; name: string; lat: number; lng: number;
  status: 'Available'|'Occupied'|'Offline'|'Faulted'; power: number;
  type: 'Type 2'|'CCS2'|'CHAdeMO'|'Type 1'; ratePerUnit: number;
  distance?: number; rating?: number; reviewCount?: number; operatingHours?: string; amenities?: string[];
}
export interface ChargingSession {
  id: string; chargerId: string; chargerName: string; date: string; duration: string;
  energyDelivered: number; cost: number; status: 'completed'|'active'|'failed';
}
export interface ChargingStats {
  soc: number; power: number; voltage: number; current: number;
  energyDelivered: number; remainingTime: number; costSoFar: number; timestamp: string;
}
export interface ApiResponse<T = any> {
  success: boolean; data?: T; error?: { code: string; message: string; details?: any };
  meta?: { page?: number; limit?: number; total?: number };
}
