export const config = {
  port: Number(process.env.PORT || 8080),
  nodeEnv: process.env.NODE_ENV || 'production',
  databaseUrl: (process.env.DATABASE_URL || '').trim(),
  managerSecret: (process.env.MANAGER_SECRET || '').trim(),
  sessionSecret: (process.env.SESSION_SECRET || '').trim(),
  // Empty string means the read-only team view is open to anyone with the link,
  // which is how the prototype's share link behaved.
  teamAccessCode: (process.env.TEAM_ACCESS_CODE || '').trim(),
  timezone: (process.env.APP_TIMEZONE || 'Asia/Jerusalem').trim(),
  sessionMaxAgeSeconds: Number(process.env.SESSION_MAX_AGE_SECONDS || 60 * 60 * 24 * 30),
};

export const isTeamGated = () => config.teamAccessCode.length > 0;

/**
 * Fails fast at boot rather than on the first request. Never prints values.
 */
export function assertRequiredConfig(names = ['databaseUrl', 'managerSecret', 'sessionSecret']) {
  const envNames = {
    databaseUrl: 'DATABASE_URL',
    managerSecret: 'MANAGER_SECRET',
    sessionSecret: 'SESSION_SECRET',
  };
  const missing = names.filter((key) => !config[key]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing
        .map((k) => envNames[k] || k)
        .join(', ')}. See .env.example.`
    );
  }
}
