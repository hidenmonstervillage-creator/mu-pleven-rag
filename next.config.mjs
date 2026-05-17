/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
    // Prevent Next.js from bundling pdf-parse — let Node.js require() it natively
    serverComponentsExternalPackages: ['pdf-parse', 'pdfjs-dist', 'officeparser', 'unpdf'],
  },
};

export default nextConfig;
