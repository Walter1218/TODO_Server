module.exports = {
  apps: [
    {
      name: 'todo-server',
      script: 'src/server.js',
      watch: false,
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development'
      }
    },
    {
      name: 'hermes-default',
      script: 'start.js',
      args: '--config config.hermes-default.json',
      autorestart: true,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'development'
      }
    },
    {
      name: 'hermes-ops',
      script: 'start.js',
      args: '--config config.hermes-ops.json',
      autorestart: true,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'development'
      }
    },
    {
      name: 'hermes-coder',
      script: 'start.js',
      args: '--config config.hermes-coder.json',
      autorestart: true,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'development'
      }
    }
  ]
};
