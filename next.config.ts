import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/chat": ["prompts/**"],
  },
};

export default nextConfig;
