// XpulseAI's config, read from EdgeLead's environment. (phase 31)
//
// This is the one file under xp/ that is not a copy: XpulseAI names its secrets
// SUPABASE_KEY / ENCRYPTION_KEY / ADMIN_API_KEY, EdgeLead names them
// SUPABASE_SERVICE_ROLE_KEY / APP_ENCRYPTION_KEY, and EdgeLead's admin is a
// Supabase session rather than an API key. Everything else keeps XpulseAI's
// defaults — the cron pair at 09:00 and 21:00 UTC, the lookbacks, the model —
// and every value can still be overridden with XP_* variables.
const isProd = process.env.NODE_ENV === 'production';
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

module.exports = {
  isProd,
  port: parseInt(process.env.PORT || '5000', 10),

  supabaseUrl: env('SUPABASE_URL', 'http://stub'),
  supabaseKey: env('SUPABASE_SERVICE_ROLE_KEY', env('SUPABASE_KEY', 'stub')),       // service_role, server-side only

  encryptionKey: env('XP_ENCRYPTION_KEY', env('APP_ENCRYPTION_KEY', 'development_fallback_secret_key_32bytes_min')),
  adminApiKey: env('XP_ADMIN_API_KEY', 'edgelead-has-its-own-admin-sessions'),
  clientSessionSecret: env('XP_SESSION_SECRET', env('APP_ENCRYPTION_KEY', 'dev_client_session_secret_change_me')),
  clientSessionTtlMs: 12 * 60 * 60 * 1000,
  clientRememberTtlMs: 30 * 24 * 60 * 60 * 1000,
  staffSessionTtlMs: 12 * 60 * 60 * 1000,
  staffRememberTtlMs: 14 * 24 * 60 * 60 * 1000,
  staffLinkTtlMs: 7 * 24 * 60 * 60 * 1000,

  // The timezone a client's dates resolve in when its record does not say.
  defaultClientTz: env('XP_DEFAULT_TZ', 'Asia/Dhaka'),

  meta: {
    appId: env('META_APP_ID', null),
    appSecret: env('META_APP_SECRET', null),
    redirectUri: process.env.META_REDIRECT_URI,
    systemUserToken: env('META_SYSTEM_USER_TOKEN', null),
    defaultApiVersion: env('XP_META_API_VERSION', 'v26.0'),
    scopes: [
      'pages_show_list', 'pages_read_engagement', 'pages_read_user_content',
      'read_insights', 'business_management',
      'instagram_basic', 'instagram_manage_insights', 'instagram_manage_comments',
      'ads_read'
    ]
  },

  gemini: {
    apiKey: env('GEMINI_API_KEY', null),
    model: env('XP_GEMINI_MODEL', env('GEMINI_MODEL', 'gemini-3.5-flash')),
    thinkingBudget: process.env.GEMINI_THINKING_BUDGET === undefined || process.env.GEMINI_THINKING_BUDGET === ''
      ? null : parseInt(process.env.GEMINI_THINKING_BUDGET, 10),
    thinkingLevel: process.env.GEMINI_THINKING_LEVEL || null
  },

  chatDailyLimit: (() => {
    const n = parseInt(process.env.CHAT_DAILY_LIMIT ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })(),

  reports: {
    monthlyEnabled: process.env.MONTHLY_REPORT_ENABLED !== 'false',
    monthlyDay: parseInt(process.env.MONTHLY_REPORT_DAY || '4', 10),
    monthlyHourUtc: parseInt(process.env.MONTHLY_REPORT_HOUR_UTC || '9', 10)
  },

  cron: {
    // EdgeLead's single-instance switch governs this too: SCHEDULER_ENABLED=false stops every timer.
    enabled: String(env('SCHEDULER_ENABLED', 'true')) !== 'false',
    schedule: env('XP_CRON_SCHEDULE', '0 9,21 * * *'),   // in tz — see XpulseAI's note: keep the pair >= 10 hours apart, the first after 07:00 UTC
    tz: env('XP_CRON_TZ', 'UTC'),
    alertWebhook: env('CRON_ALERT_WEBHOOK_URL', null)
  },

  sync: {
    lookbackDays: parseInt(process.env.SYNC_LOOKBACK_DAYS || '3', 10),
    postActiveWindowDays: parseInt(process.env.POST_ACTIVE_WINDOW_DAYS || '120', 10),
    postColdRefreshEvery: parseInt(process.env.POST_COLD_REFRESH_EVERY || '7', 10),
    accountBackfillDays: parseInt(process.env.ACCOUNT_BACKFILL_DAYS || '90', 10),
    demographicsEveryDays: parseInt(process.env.DEMOGRAPHICS_EVERY_DAYS || '7', 10),
    commentsEnabled: process.env.SYNC_COMMENTS !== 'false',
    anchorGraceHours: parseInt(process.env.ANCHOR_GRACE_HOURS || '4', 10),
    batchSize: 50,
    requestDelayMs: 120
  }
};
