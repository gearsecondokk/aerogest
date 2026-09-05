// Configuration pm2 (fichier .cjs car le projet est en ESM)
module.exports = {
  apps: [
    {
      name: "video-bot",
      script: "dist/index.js",
      cwd: "/opt/video-bot",
      env: { NODE_ENV: "production" },
      watch: false,
      max_memory_restart: "512M",
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: "30s",
    },
  ],
};
