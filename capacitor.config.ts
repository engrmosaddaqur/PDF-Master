import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.engrmosaddaqur.pdfmaster',
  appName: 'PDF MASTER',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
