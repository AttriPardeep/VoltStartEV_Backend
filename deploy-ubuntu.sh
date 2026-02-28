#!/bin/bash
# VoltStartEV Backend - Ubuntu Native Deployment Script
# Usage: curl -sSL https://raw.githubusercontent.com/AttriPardeep/voltstartev-backend/main/deploy-ubuntu.sh | bash

set -e

echo "🚀 Starting VoltStartEV Backend Deployment on Ubuntu..."

# Configuration
APP_NAME="voltstartev-backend"
APP_DIR="/opt/$APP_NAME"
USER="voltstart"
LOG_DIR="/var/log/voltstartev"
NODE_VERSION="20.x"

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
  echo "❌ Please run as root or with sudo"
  exit 1
fi

# 1. Create application user
echo "👤 Creating user: $USER"
if ! id "$USER" &>/dev/null; then
  useradd -r -m -d "$APP_DIR" -s /bin/bash "$USER"
fi

# 2. Install Node.js 20 LTS
echo "📦 Installing Node.js $NODE_VERSION"
if ! command -v node &> /dev/null || ! node -v | grep -q "v20"; then
  curl -fsSL https://deb.nodesource.com/setup_$NODE_VERSION | bash -
  apt-get install -y nodejs build-essential
fi

# 3. Install PM2 globally
echo "⚙️ Installing PM2 process manager"
npm install -g pm2

# 4. Setup app directory
echo "📁 Setting up application directory: $APP_DIR"
mkdir -p "$APP_DIR" "$LOG_DIR"
chown -R "$USER:$USER" "$APP_DIR" "$LOG_DIR"
chmod 755 "$APP_DIR" "$LOG_DIR"

# 5. Clone or update repository
echo "📥 Fetching latest code..."
cd "$APP_DIR"
if [ -d ".git" ]; then
  sudo -u "$USER" git pull origin main
else
  sudo -u "$USER" git clone https://github.com/AttriPardeep/voltstartev-backend.git .
fi

# 6. Install dependencies
echo "📦 Installing Node.js dependencies..."
sudo -u "$USER" npm ci --production --ignore-scripts

# 7. Build TypeScript
echo "🔨 Building TypeScript..."
sudo -u "$USER" npm run build

# 8. Setup environment file
if [ ! -f "$APP_DIR/.env" ]; then
  echo "⚠️ Creating .env from .env.example"
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chown "$USER:$USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "🔐 Please edit $APP_DIR/.env with your credentials before starting!"
fi

# 9. Setup log rotation
echo "🔄 Configuring log rotation..."
cat > /etc/logrotate.d/voltstartev << EOF
$LOG_DIR/*.log {
  daily
  missingok
  rotate 14
  compress
  delaycompress
  notifempty
  create 644 $USER $USER
  sharedscripts
  postrotate
    /usr/bin/pm2 reload $APP_NAME --silent > /dev/null 2>&1 || true
  endscript
}
EOF

# 10. Setup systemd service for PM2 (optional but recommended)
echo "🔧 Setting up systemd service for PM2..."
pm2 startup systemd -u "$USER" --hp "/home/$USER" 2>/dev/null || true

# 11. Start/restart application
echo "🚀 Starting VoltStartEV Backend..."
sudo -u "$USER" pm2 start ecosystem.config.js --env production
sudo -u "$USER" pm2 save

# 12. Setup nginx reverse proxy (optional)
if command -v nginx &> /dev/null; then
  echo "🌐 Configuring nginx reverse proxy..."
  cat > /etc/nginx/sites-available/voltstartev << 'NGINX'
upstream voltstartev_backend {
    server 127.0.0.1:3000;
}

server {
    listen 80;
    server_name api.voltstartev.com; # Change to your domain

    location / {
        proxy_pass http://voltstartev_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 90s;
    }

    # Health check endpoint for load balancers
    location /health {
        proxy_pass http://voltstartev_backend/health;
        access_log off;
    }
}
NGINX
  
  ln -sf /etc/nginx/sites-available/voltstartev /etc/nginx/sites-enabled/
  nginx -t && systemctl reload nginx
  echo "✅ Nginx configured for api.voltstartev.com"
fi

# 13. Firewall configuration
echo "🔥 Configuring firewall..."
if command -v ufw &> /dev/null; then
  ufw allow 3000/tcp comment "VoltStartEV Backend API" 2>/dev/null || true
  ufw allow 80/tcp comment "HTTP" 2>/dev/null || true
  ufw allow 443/tcp comment "HTTPS" 2>/dev/null || true
fi

# Final status
echo ""
echo "✅ Deployment complete!"
echo ""
echo "📊 Check status: pm2 status"
echo "📋 View logs: pm2 logs $APP_NAME"
echo "🔄 Restart: pm2 restart $APP_NAME"
echo "🔐 Edit config: nano $APP_DIR/.env"
echo ""
echo "🌐 API Endpoint: http://136.113.7.146:3000"
echo "🔍 Health Check: http://136.113.7.146:3000/health"
echo ""
echo "⚠️ Remember to:"
echo "  1. Update .env with your SteVe MySQL credentials"
echo "  2. Set a strong JWT_SECRET (min 32 chars)"
echo "  3. Configure CORS_ORIGIN to your frontend domain"
echo "  4. Setup SSL with Let's Encrypt for production"
echo ""
