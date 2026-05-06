# Use Node.js 18 Alpine as base image for smaller footprint
FROM node:18-alpine

# Install SQLite dependencies and build tools
RUN apk add --no-cache python3 make g++ sqlite

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies including PM2 globally
RUN npm install && npm install -g pm2

# Install PM2 logrotate module
RUN pm2 install pm2-logrotate && \
    pm2 set pm2-logrotate:max_size 10M && \
    pm2 set pm2-logrotate:retain 7 && \
    pm2 set pm2-logrotate:compress true

# Copy application source code
COPY . .

# Create required directories
RUN mkdir -p data logs data/prod

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=./data/prod/todo.db

# Expose the port the app runs on
EXPOSE 3000

# Start PM2 with ecosystem config and keep Docker container running
CMD ["pm2-runtime", "start", "ecosystem.config.js", "--env", "production"]
