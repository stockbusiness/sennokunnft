/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // ワークスペースの共有パッケージは Next 側でトランスパイルする。
  transpilePackages: ['@sengoku/ui'],
  // セキュリティヘッダ（SECURITY_DESIGN.md §9）。
  // Claim URL がリファラ経由で外部へ漏れるのを防ぐため、Referrer-Policy が特に重要。
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
