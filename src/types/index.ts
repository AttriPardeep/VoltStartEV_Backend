// Reuse your VoltStartEV frontend types for seamless integration

export interface User {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  walletBalance: number;
  isVerified: boolean;
  evDetails?: {
    model: string;
    batteryCapacity: number; // kWh
    vehicleNumber?: string;
  };
  savedChargers: string[]; // charger IDs
  paymentMethods: {
    id: string;
    last4: string;
    type: 'card' | 'upi' | 'wallet';
  }[];
  history: ChargingSession[];
}

export interface Charger {
  id: string; // Maps to SteVe's charge_box_id
  name: string;
  lat: number;
  lng: number;
  status: 'Available' | 'Occupied' | 'Offline' | 'Faulted';
  power: number; // kW
  type: 'Type 2' | 'CCS2' | 'CHAdeMO' | 'Type 1';
  ratePerUnit: number; // ₹ per kWh
  distance?: number; // km (calculated frontend-side)
  rating?: number;
  reviewCount?: number;
  operatingHours?: string;
  amenities?: string[];
}

export interface ChargingSession {
  id: string; // SteVe transaction_id
  chargerId: string;
  chargerName: string;
  date: string; // ISO timestamp
  duration: string; // "1h 23m"
  energyDelivered: number; // kWh
  cost: number; // ₹
  status: 'completed' | 'active' | 'failed';
}

export interface ChargingStats {
  soc: number; // State of Charge %
  power: number; // kW current
  voltage: number; // V
  current: number; // A
  energyDelivered: number; // kWh total
  remainingTime: number; // minutes estimate
  costSoFar: number; // ₹ accrued
  timestamp: string; // ISO
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
  };
}
