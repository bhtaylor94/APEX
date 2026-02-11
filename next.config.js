/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    KALSHI_API_KEY: process.env.KALSHI_API_KEY,
    KALSHI_ENV: process.env.KALSHI_ENV || "demo",
  },
};

module.exports = nextConfig;
