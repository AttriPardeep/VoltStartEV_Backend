# ⚡ VoltStartEV Backend

Production-ready TypeScript backend for the VoltStartEV EV charging application, integrating with SteVe OCPP server.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/Node-20.x-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)

## 🎯 Features

- 🔐 OTP-based authentication with JWT
- 🔌 SteVe OCPP Server MySQL integration (read-only queries)
- ⚡ Real-time charging session monitoring via WebSocket
- 💳 Wallet management with Razorpay integration (India)
- 🗺️ Charger discovery with geospatial filtering
- 📊 Comprehensive logging with Winston
- 🛡️ Security: Helmet, rate limiting, input validation (Zod)
- 🚀 Ubuntu-native deployment (no Docker required)

## 🏗️ Architecture


## Flow 
VoltStartEV Frontend (React/TS)
          │
          ▼ HTTPS/REST + JWT
VoltStartEV Backend (Node.js/Express/TS)
          │
          ├──► SteVe MySQL Database (read: chargers, transactions)
          ├──► App MySQL Tables (write: app_users, payments)
          └──► WebSocket Server (real-time stats)
                    │
                    ▼ OCPP 1.6
              SteVe OCPP Server
                    │
                    ▼ WebSocket
              EV Chargers / SAP Simulator
