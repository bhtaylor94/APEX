/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    KALSHI_API_KEY: process.env.KALSHI_API_KEY || process.env.NEXT_PUBLIC_KALSHI_API_KEY_ID,
    KALSHI_ENV: process.env.KALSHI_ENV || process.env.NEXT_PUBLIC_KALSHI_ENV || "demo",
  },
};

module.exports = nextConfig;
