const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATABASE_DIR || './data');
const DB_FILE = path.join(DATA_DIR, 'database.sqlite');
const JSON_DB_FILE = path.join(DATA_DIR, 'db.json');

let dbInstance = null;
let useJsonFallback = false;

let jsonDbState = {
  schemas: [],
  calls: [],
  attempt_logs: []
};

function ensureDataDirectory() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

const jsonDb = {
  read: () => {
    try {
      if (fs.existsSync(JSON_DB_FILE)) {
        const raw = fs.readFileSync(JSON_DB_FILE, 'utf8');
        jsonDbState = JSON.parse(raw);
      } else {
        jsonDb.write();
      }
    } catch (err) {
      console.warn('[TypeCast DB] Error reading JSON DB, using in-memory state:', err.message);
    }
  },
  write: () => {
    try {
      fs.writeFileSync(JSON_DB_FILE, JSON.stringify(jsonDbState, null, 2), 'utf8');
    } catch (err) {
      console.error('[TypeCast DB] Error writing JSON DB:', err.message);
    }
  }
};

function initSqlite() {
  const sqlite3 = require('sqlite3').verbose();
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_FILE, (err) => {
      if (err) return reject(err);
      resolve(db);
    });
  });
}

function runSchemaDDL(db) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      
      db.run(`
        CREATE TABLE IF NOT EXISTS schemas (
          id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          description TEXT,
          definition TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => { if (err) return reject(err); });

      db.run(`
        CREATE TABLE IF NOT EXISTS calls (
          id TEXT PRIMARY KEY,
          schema_id TEXT,
          prompt TEXT NOT NULL,
          strategy TEXT NOT NULL,
          model TEXT NOT NULL,
          attempts INTEGER DEFAULT 1,
          success INTEGER NOT NULL, -- 0 for false, 1 for true
          final_output TEXT,
          latency_ms INTEGER,
          token_usage TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(schema_id) REFERENCES schemas(id)
        )
      `, (err) => { if (err) return reject(err); });

      db.run(`
        CREATE TABLE IF NOT EXISTS attempt_logs (
          id TEXT PRIMARY KEY,
          call_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          prompt_used TEXT NOT NULL,
          response_received TEXT,
          error_message TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(call_id) REFERENCES calls(id)
        )
      `, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

function seedDatabase(repo) {
  const defaultSchemas = [
    {
      id: 'default-user-profile',
      name: 'User Profile',
      description: 'Standard validated schema for extracting user profile information from free-form text.',
      definition: JSON.stringify({
        type: 'object',
        properties: {
          name: { type: 'string', constraints: { min: 2, max: 50 } },
          email: { type: 'string', constraints: { format: 'email' } },
          age: { type: 'number', constraints: { min: 18, max: 100 } },
          skills: { type: 'array', items: { type: 'string' } },
          status: { type: 'enum', values: ['active', 'inactive', 'pending'] }
        }
      })
    },
    {
      id: 'default-sentiment-analysis',
      name: 'Sentiment Analyzer',
      description: 'Extract sentiments, confidence scores, and list key topics of a feedback review.',
      definition: JSON.stringify({
        type: 'object',
        properties: {
          sentiment: { type: 'enum', values: ['positive', 'negative', 'neutral'] },
          confidence: { type: 'number', constraints: { min: 0, max: 1 } },
          keyIssues: { type: 'array', items: { type: 'string' } },
          escalationRequired: { type: 'enum', values: ['yes', 'no'] }
        }
      })
    }
  ];

  for (const schema of defaultSchemas) {
    repo.schemas.getByName(schema.name).then((exists) => {
      if (!exists) {
        repo.schemas.insert(schema).catch(err => {
          
        });
      }
    });
  }
}

async function initializeDatabase() {
  ensureDataDirectory();
  console.log('[TypeCast DB] Initializing storage layer...');

  try {
    
    require('sqlite3');

    const db = await initSqlite();
    dbInstance = db;
    await runSchemaDDL(db);
    console.log('[TypeCast DB] SQLite database connected and tables initialized.');
  } catch (err) {
    console.warn('[TypeCast DB] SQLite failed to initialize (binary compilation issue). Falling back to pure JSON database store! Error:', err.message);
    useJsonFallback = true;
    jsonDb.read();
    console.log('[TypeCast DB] JSON Flat-file database initialized at:', JSON_DB_FILE);
  }

  const repo = createRepository();
  seedDatabase(repo);
  return repo;
}

function dbQuery(method, sql, params = []) {
  return new Promise((resolve, reject) => {
    dbInstance[method](sql, params, function (err, result) {
      if (err) return reject(err);
      if (method === 'run') {
        resolve({ lastID: this.lastID, changes: this.changes });
      } else {
        resolve(result);
      }
    });
  });
}

function createRepository() {
  return {
    schemas: {
      getAll: async () => {
        if (useJsonFallback) {
          jsonDb.read();
          return jsonDbState.schemas;
        } else {
          return dbQuery('all', 'SELECT * FROM schemas ORDER BY created_at DESC');
        }
      },
      getById: async (id) => {
        if (useJsonFallback) {
          jsonDb.read();
          return jsonDbState.schemas.find(s => s.id === id) || null;
        } else {
          return dbQuery('get', 'SELECT * FROM schemas WHERE id = ?', [id]);
        }
      },
      getByName: async (name) => {
        if (useJsonFallback) {
          jsonDb.read();
          return jsonDbState.schemas.find(s => s.name.toLowerCase() === name.toLowerCase()) || null;
        } else {
          return dbQuery('get', 'SELECT * FROM schemas WHERE name = ?', [name]);
        }
      },
      insert: async ({ id, name, description, definition }) => {
        const schemaId = id || `schema_${Date.now()}`;
        if (useJsonFallback) {
          jsonDb.read();
          if (jsonDbState.schemas.some(s => s.name.toLowerCase() === name.toLowerCase())) {
            throw new Error(`Schema with name '${name}' already exists.`);
          }
          const row = { id: schemaId, name, description, definition, created_at: new Date().toISOString() };
          jsonDbState.schemas.push(row);
          jsonDb.write();
          return { id: schemaId };
        } else {
          await dbQuery('run', 'INSERT INTO schemas (id, name, description, definition) VALUES (?, ?, ?, ?)', [
            schemaId, name, description, definition
          ]);
          return { id: schemaId };
        }
      },
      delete: async (id) => {
        if (useJsonFallback) {
          jsonDb.read();
          jsonDbState.schemas = jsonDbState.schemas.filter(s => s.id !== id);
          jsonDb.write();
          return { success: true };
        } else {
          await dbQuery('run', 'DELETE FROM schemas WHERE id = ?', [id]);
          return { success: true };
        }
      }
    },
    calls: {
      insert: async ({ id, schema_id, prompt, strategy, model, attempts, success, final_output, latency_ms, token_usage }) => {
        const callId = id || `call_${Date.now()}`;
        const serializedOutput = typeof final_output === 'object' ? JSON.stringify(final_output) : final_output;
        const serializedTokens = typeof token_usage === 'object' ? JSON.stringify(token_usage) : token_usage;

        if (useJsonFallback) {
          jsonDb.read();
          const row = {
            id: callId,
            schema_id,
            prompt,
            strategy,
            model,
            attempts: parseInt(attempts) || 1,
            success: success ? 1 : 0,
            final_output: serializedOutput,
            latency_ms: parseInt(latency_ms) || 0,
            token_usage: serializedTokens,
            created_at: new Date().toISOString()
          };
          jsonDbState.calls.push(row);
          jsonDb.write();
          return { id: callId };
        } else {
          await dbQuery('run', `
            INSERT INTO calls (id, schema_id, prompt, strategy, model, attempts, success, final_output, latency_ms, token_usage)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [callId, schema_id, prompt, strategy, model, attempts, success ? 1 : 0, serializedOutput, latency_ms, serializedTokens]);
          return { id: callId };
        }
      },
      getAll: async () => {
        if (useJsonFallback) {
          jsonDb.read();
          
          return jsonDbState.calls.map(c => {
            const schema = jsonDbState.schemas.find(s => s.id === c.schema_id);
            return {
              ...c,
              schema_name: schema ? schema.name : 'Unknown Schema'
            };
          }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        } else {
          return dbQuery('all', `
            SELECT c.*, s.name as schema_name 
            FROM calls c 
            LEFT JOIN schemas s ON c.schema_id = s.id 
            ORDER BY c.created_at DESC
          `);
        }
      },
      getById: async (id) => {
        if (useJsonFallback) {
          jsonDb.read();
          const call = jsonDbState.calls.find(c => c.id === id);
          if (!call) return null;
          const schema = jsonDbState.schemas.find(s => s.id === call.schema_id);
          const logs = jsonDbState.attempt_logs.filter(l => l.call_id === id).sort((a, b) => a.attempt_number - b.attempt_number);
          return {
            ...call,
            schema_name: schema ? schema.name : 'Unknown Schema',
            logs
          };
        } else {
          const call = await dbQuery('get', 'SELECT c.*, s.name as schema_name FROM calls c LEFT JOIN schemas s ON c.schema_id = s.id WHERE c.id = ?', [id]);
          if (!call) return null;
          const logs = await dbQuery('all', 'SELECT * FROM attempt_logs WHERE call_id = ? ORDER BY attempt_number ASC', [id]);
          return { ...call, logs };
        }
      },
      getFailures: async () => {
        if (useJsonFallback) {
          jsonDb.read();
          
          const failures = jsonDbState.calls.filter(c => c.success === 0);
          const logs = jsonDbState.attempt_logs;
          
          const groups = {};
          failures.forEach(c => {
            const schema = jsonDbState.schemas.find(s => s.id === c.schema_id);
            const sName = schema ? schema.name : 'Unknown';
            const key = `${c.schema_id}:${c.prompt}`;

            const callLogs = logs.filter(l => l.call_id === c.id).sort((a,b) => b.attempt_number - a.attempt_number);
            const lastError = callLogs[0] ? callLogs[0].error_message : 'Unknown validation error';

            if (!groups[key]) {
              groups[key] = {
                schema_id: c.schema_id,
                schema_name: sName,
                prompt: c.prompt,
                model: c.model,
                failure_count: 0,
                common_errors: {}
              };
            }
            groups[key].failure_count++;
            groups[key].common_errors[lastError] = (groups[key].common_errors[lastError] || 0) + 1;
          });

          return Object.values(groups).map(g => {
            
            let mostCommon = 'Unknown error';
            let maxCount = 0;
            for (const [err, count] of Object.entries(g.common_errors)) {
              if (count > maxCount) {
                maxCount = count;
                mostCommon = err;
              }
            }
            return {
              schema_id: g.schema_id,
              schema_name: g.schema_name,
              prompt: g.prompt,
              model: g.model,
              failure_count: g.failure_count,
              most_common_error: mostCommon
            };
          }).sort((a, b) => b.failure_count - a.failure_count);
        } else {
          
          return dbQuery('all', `
            SELECT 
              c.schema_id, 
              s.name as schema_name, 
              c.prompt, 
              c.model, 
              COUNT(*) as failure_count,
              (
                SELECT error_message 
                FROM attempt_logs al 
                WHERE al.call_id IN (SELECT id FROM calls WHERE schema_id = c.schema_id AND prompt = c.prompt AND success = 0)
                GROUP BY error_message
                ORDER BY COUNT(*) DESC
                LIMIT 1
              ) as most_common_error
            FROM calls c
            LEFT JOIN schemas s ON c.schema_id = s.id
            WHERE c.success = 0
            GROUP BY c.schema_id, c.prompt, c.model, s.name
            ORDER BY failure_count DESC
          `);
        }
      },
      getMetrics: async () => {
        if (useJsonFallback) {
          jsonDb.read();
          const allCalls = jsonDbState.calls;
          const total = allCalls.length;
          
          if (total === 0) {
            return {
              total_calls: 0,
              success_rate: 0,
              avg_latency: 0,
              strategy_metrics: []
            };
          }

          const successful = allCalls.filter(c => c.success === 1).length;
          const successRate = (successful / total) * 100;
          const totalLatency = allCalls.reduce((acc, c) => acc + (c.latency_ms || 0), 0);
          const avgLatency = totalLatency / total;

          const strategyGroups = {};
          allCalls.forEach(c => {
            const strat = c.strategy;
            if (!strategyGroups[strat]) {
              strategyGroups[strat] = { total: 0, firstAttemptPass: 0, successful: 0 };
            }
            strategyGroups[strat].total++;
            if (c.success === 1) strategyGroups[strat].successful++;
            if (c.attempts === 1 && c.success === 1) strategyGroups[strat].firstAttemptPass++;
          });

          const strategy_metrics = Object.entries(strategyGroups).map(([strat, metrics]) => {
            return {
              strategy: strat,
              total_calls: metrics.total,
              first_attempt_pass_rate: (metrics.firstAttemptPass / metrics.total) * 100,
              success_rate: (metrics.successful / metrics.total) * 100
            };
          });

          return {
            total_calls: total,
            success_rate: successRate,
            avg_latency: avgLatency,
            strategy_metrics
          };
        } else {
          
          const totals = await dbQuery('get', `
            SELECT 
              COUNT(*) as total_calls,
              SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_calls,
              AVG(latency_ms) as avg_latency
            FROM calls
          `);

          const strategyData = await dbQuery('all', `
            SELECT 
              strategy,
              COUNT(*) as total_calls,
              SUM(CASE WHEN attempts = 1 AND success = 1 THEN 1 ELSE 0 END) as first_attempt_successes,
              SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as total_successes
            FROM calls
            GROUP BY strategy
          `);

          const totalCalls = totals.total_calls || 0;
          const successRate = totalCalls > 0 ? (totals.successful_calls / totalCalls) * 100 : 0;

          const strategy_metrics = strategyData.map(row => ({
            strategy: row.strategy,
            total_calls: row.total_calls,
            first_attempt_pass_rate: row.total_calls > 0 ? (row.first_attempt_successes / row.total_calls) * 100 : 0,
            success_rate: row.total_calls > 0 ? (row.total_successes / row.total_calls) * 100 : 0
          }));

          return {
            total_calls: totalCalls,
            success_rate: successRate,
            avg_latency: totals.avg_latency || 0,
            strategy_metrics
          };
        }
      }
    },
    attemptLogs: {
      insert: async ({ call_id, attempt_number, prompt_used, response_received, error_message }) => {
        const id = `log_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        if (useJsonFallback) {
          jsonDb.read();
          const row = {
            id,
            call_id,
            attempt_number: parseInt(attempt_number),
            prompt_used,
            response_received,
            error_message,
            created_at: new Date().toISOString()
          };
          jsonDbState.attempt_logs.push(row);
          jsonDb.write();
          return { id };
        } else {
          await dbQuery('run', `
            INSERT INTO attempt_logs (id, call_id, attempt_number, prompt_used, response_received, error_message)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [id, call_id, attempt_number, prompt_used, response_received, error_message]);
          return { id };
        }
      }
    }
  };
}

module.exports = {
  initializeDatabase
};
