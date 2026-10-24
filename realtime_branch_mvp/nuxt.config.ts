// Nuxt 4 app + Nitro server (single process, local-only MVP).
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: false },
  ssr: false,
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      title: 'Realtime 分岐応対 MVP',
      htmlAttrs: { lang: 'ja' },
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },
  nitro: {
    experimental: { websocket: true },
  },
  devServer: { host: '127.0.0.1', port: 8000 },
  typescript: { strict: true },
})
