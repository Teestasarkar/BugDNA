import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle with only the node_modules actually
  // reached at runtime. Takes the production image from ~1.2GB to ~180MB, which
  // matters on a single EC2 instance.
  output: "standalone",

  reactStrictMode: true,

  // The API owns its own error contract and versioning; the frontend calls it
  // directly rather than proxying, so a failure is attributable to one service.
  // In production Nginx routes /api to the backend (see infra/nginx).
  poweredByHeader: false,

  eslint: {
    // Lint runs as its own CI step. Letting it fail the build as well means one
    // style violation blocks a deploy.
    ignoreDuringBuilds: true,
  },

  typescript: {
    // Type errors DO fail the build. Unlike lint, a type error is a real defect.
    ignoreBuildErrors: false,
  },

  images: {
    remotePatterns: [
      // GitHub avatars are the only remote images the app renders.
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
      { protocol: "https", hostname: "github.com" },
    ],
  },

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
