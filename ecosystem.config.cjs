// Configuration pm2 (fichier .cjs car le projet est en ESM)
module.exports = {
  apps: [
    {
      name: "video-bot",
      script: "dist/index.js",
      // node systeme = v20, or le projet exige >=22 : seul ce bot tourne sur le
      // node 22 installe a part. rgbot et fnacbot restent en 20, intouches.
      interpreter: "/opt/node22/bin/node",
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
