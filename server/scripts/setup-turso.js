import 'dotenv/config';
import { createClient } from '@libsql/client';
import { existsSync, readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { createHash } from 'crypto';

function resolveDataFile(customPath, fallbackPath) {
  const value = String(customPath || '').trim();
  if (!value) return fallbackPath;
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function readJson(filePath, fallback = []) {
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Ignore malformed files and use fallback.
  }
  return [...fallback];
}

function buildLogId(entry = {}) {
  const key = `${entry.timestamp || ''}|${entry.type || ''}|${entry.message || ''}`;
  return createHash('sha1').update(key).digest('hex');
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

  await client.execute('CREATE INDEX IF NOT EXISTS idx_topics_event_date ON topics(event_date)');
  await client.execute('CREATE INDEX IF NOT EXISTS idx_topics_party ON topics(party)');
  await client.execute('CREATE INDEX IF NOT EXISTS idx_topics_verdict ON topics(verdict)');
  await client.execute('CREATE INDEX IF NOT EXISTS idx_topics_category ON topics(category)');

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

  await client.execute('CREATE INDEX IF NOT EXISTS idx_agent_log_timestamp ON agent_log(entry_timestamp)');

  await client.execute(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

async function importTopics(client, topics) {
  let upserted = 0;

  for (const topic of topics) {
    const now = new Date().toISOString();
    const id = String(topic?.id || '').trim();
    if (!id) continue;

    await client.execute({
      sql: `
        INSERT INTO topics (
          id, title, party, category, verdict, event_date, source_type, record_type,
          verification_score, ai_provider, payload, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title,
          party=excluded.party,
          category=excluded.category,
          verdict=excluded.verdict,
          event_date=excluded.event_date,
          source_type=excluded.source_type,
          record_type=excluded.record_type,
          verification_score=excluded.verification_score,
          ai_provider=excluded.ai_provider,
          payload=excluded.payload,
          updated_at=excluded.updated_at
      `,
      args: [
        id,
        topic?.title || '',
        topic?.party || '',
        topic?.category || '',
        topic?.verdict || '',
        topic?.date || null,
        topic?.sourceType || '',
        topic?.recordType || '',
        Number(topic?.verification?.score || 0),
        topic?.aiProvider || '',
        JSON.stringify(topic),
        topic?.createdAt || now,
        now,
      ],
    });

    upserted += 1;
  }

  return upserted;
}

async function importLogs(client, logs) {
  let upserted = 0;

  for (const entry of logs) {
    const logId = buildLogId(entry);
    const createdAt = entry?.timestamp || new Date().toISOString();

    await client.execute({
      sql: `
        INSERT INTO agent_log (log_id, entry_type, message, entry_timestamp, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(log_id) DO UPDATE SET
          entry_type=excluded.entry_type,
          message=excluded.message,
          entry_timestamp=excluded.entry_timestamp,
          payload=excluded.payload,
          created_at=excluded.created_at
      `,
      args: [
        logId,
        entry?.type || '',
        entry?.message || '',
        entry?.timestamp || '',
        JSON.stringify(entry),
        createdAt,
      ],
    });

    upserted += 1;
  }

  return upserted;
}

async function getTableCount(client, table) {
  const rs = await client.execute(`SELECT COUNT(*) AS count FROM ${table}`);
  const value = rs?.rows?.[0]?.count;
  const n = typeof value === 'bigint' ? Number(value) : Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const databaseUrl = String(process.env.TURSO_DATABASE_URL || '').trim();
  const authToken = String(process.env.TURSO_AUTH_TOKEN || '').trim();

  if (!databaseUrl) {
    throw new Error('Missing TURSO_DATABASE_URL');
  }
  if (!authToken) {
    throw new Error('Missing TURSO_AUTH_TOKEN');
  }

  const client = createClient({
    url: databaseUrl,
    authToken,
  });

  const topicsPath = resolveDataFile(process.env.TOPICS_FILE_PATH, resolve(process.cwd(), 'server/data/topics.json'));
  const logPath = resolveDataFile(process.env.AGENT_LOG_FILE_PATH, resolve(process.cwd(), 'server/data/agent-log.json'));

  const schemaOnly = process.argv.includes('--schema-only');

  console.log('Connecting to Turso...');
  await ensureSchema(client);
  console.log('Schema ready.');

  if (!schemaOnly) {
    const topics = readJson(topicsPath, []);
    const logs = readJson(logPath, []);

    console.log(`Importing ${topics.length} topics from ${topicsPath}...`);
    const topicsUpserted = await importTopics(client, topics);

    console.log(`Importing ${logs.length} log entries from ${logPath}...`);
    const logsUpserted = await importLogs(client, logs);

    await client.execute({
      sql: `
        INSERT INTO app_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
      `,
      args: [
        'last_import_report',
        JSON.stringify({
          importedAt: new Date().toISOString(),
          topicsUpserted,
          logsUpserted,
          topicsPath,
          logPath,
        }),
        new Date().toISOString(),
      ],
    });

    console.log(`Imported topics: ${topicsUpserted}`);
    console.log(`Imported logs: ${logsUpserted}`);
  }

  const topicCount = await getTableCount(client, 'topics');
  const logCount = await getTableCount(client, 'agent_log');

  console.log(`Turso topics count: ${topicCount}`);
  console.log(`Turso agent_log count: ${logCount}`);
  console.log('Turso setup completed.');
}

main().catch((error) => {
  console.error(`Turso setup failed: ${error.message}`);
  process.exit(1);
});
