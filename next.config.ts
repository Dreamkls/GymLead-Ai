import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Allow images from Supabase Storage
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
    ],
  },

  // In Next.js 15, this moved out of experimental to the top level
  serverExternalPackages: ['@supabase/supabase-js'],
};

export default nextConfig;
