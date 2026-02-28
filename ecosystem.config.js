module.exports = {
  apps: [
    {
      name: 'voltstartev-api',
      script: 'dist/server.js',
      instances: 2, // Scale for 20+ concurrent users
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      error_file: '/var/log/voltstartev/api-error.log',
      out_file: '/var/log/voltstartev/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_memory_restart: '500M',
      node_args: '--max-old-space-size=512',
      watch: false,
      ignore_watch: ['node_modules', 'logs'],
      merge_logs: true,
      rotate_interval: '1d',
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
