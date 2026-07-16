CREATE TABLE IF NOT EXISTS programs (
  program_id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  beneficiary TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  daily_limit_seconds INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vouchers (
  program_id TEXT NOT NULL,
  day_index INTEGER NOT NULL,
  usage_seconds INTEGER NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  signature TEXT NOT NULL,
  valid_until INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  PRIMARY KEY (program_id, day_index),
  FOREIGN KEY (program_id) REFERENCES programs(program_id)
);
