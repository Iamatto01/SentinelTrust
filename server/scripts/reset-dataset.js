import 'dotenv/config';
import { createClient } from '@libsql/client';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';

function resolveDataFile(customPath, fallbackPath) {
  const value = String(customPath || '').trim();
  if (!value) return fallbackPath;
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function ensureParentDir(filePath) {
  const dirPath = dirname(filePath);
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function writeEmptyArray(filePath) {
  ensureParentDir(filePath);
  writeFileSync(filePath, '[]\n', 'utf-8');
}

function readArrayCount(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

async function ensureSchema(client) {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      party TEXT,
      category TEXT,
      verdict TEXT,
      event_date TEXT,
      source_type TEXT,
      record_type TEXT,
      verification_score INTEGER DEFAULT 0,
      ai_provider TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS agent_log (
      log_id TEXT PRIMARY KEY,
      entry_type TEXT,
      message TEXT,
      entry_timestamp TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

async function getTableCount(client, table) {
  const rs = await client.execute(`SELECT COUNT(*) AS count FROM ${table}`);
  const value = rs?.rows?.[0]?.count;
  const n = typeof value === 'bigint' ? Number(value) : Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

async function resetTurso() {
  const databaseUrl = String(process.env.TURSO_DATABASE_URL || '').trim();
  const authToken = String(process.env.TURSO_AUTH_TOKEN || '').trim();

  if (!databaseUrl || !authToken) {
    console.log('Turso credentials not configured. Skipping Turso reset.');
    return { skipped: true };
  }

  const client = createClient({
    url: databaseUrl,
    authToken,
  });

  await ensureSchema(client);

  await client.execute('DELETE FROM topics');
  await client.execute('DELETE FROM agent_log');
  await client.execute('DELETE FROM app_state');

  const topicsCount = await getTableCount(client, 'topics');
  const logsCount = await getTableCount(client, 'agent_log');
  const stateCount = await getTableCount(client, 'app_state');

  return {
    skipped: false,
    topicsCount,
    logsCount,
    stateCount,
  };
}

async function main() {
  const topicsPath = resolveDataFile(process.env.TOPICS_FILE_PATH, resolve(process.cwd(), 'server/data/topics.json'));
  const logPath = resolveDataFile(process.env.AGENT_LOG_FILE_PATH, resolve(process.cwd(), 'server/data/agent-log.json'));

  console.log('Resetting local dataset files...');
  writeEmptyArray(topicsPath);
  writeEmptyArray(logPath);

  const localTopics = readArrayCount(topicsPath);
  const localLogs = readArrayCount(logPath);

  console.log(`Local topics count: ${localTopics}`);
  console.log(`Local agent_log count: ${localLogs}`);

  console.log('Resetting Turso dataset...');
  const turso = await resetTurso();

  if (!turso.skipped) {
    console.log(`Turso topics count: ${turso.topicsCount}`);
    console.log(`Turso agent_log count: ${turso.logsCount}`);
    console.log(`Turso app_state count: ${turso.stateCount}`);
  }

  console.log('Dataset reset completed.');
}

main().catch((error) => {
  console.error(`Dataset reset failed: ${error.message}`);
  process.exit(1);
});
