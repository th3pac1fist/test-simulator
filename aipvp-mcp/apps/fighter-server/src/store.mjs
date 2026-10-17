// Fighter Lab server store: Node's built-in SQLite. The server is the source of truth for accounts,
// fighters, progress, the Cycles ledger, battles, the arena and token withdrawals and deposits.
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (address TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, address TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS progress (address TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fighters (id TEXT PRIMARY KEY, address TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS fighters_by_owner ON fighters(address);
-- every Cycles movement, append-only (the wallet in progress is the same data in economy.js's shape)
CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, at INTEGER NOT NULL,
  amount INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT);
CREATE INDEX IF NOT EXISTS ledger_by_owner ON ledger(address);
-- server-run battles, with the seed and the fighters as they were, so anyone can replay and check them
CREATE TABLE IF NOT EXISTS battles (id TEXT PRIMARY KEY, address TEXT NOT NULL, kind TEXT NOT NULL, fighter_id TEXT NOT NULL,
  opponent TEXT NOT NULL, seed INTEGER NOT NULL, result TEXT NOT NULL, json TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS arena (address TEXT NOT NULL, fighter_id TEXT NOT NULL, json TEXT NOT NULL, published_at INTEGER NOT NULL,
  PRIMARY KEY (address, fighter_id));
CREATE TABLE IF NOT EXISTS withdrawals (nonce TEXT PRIMARY KEY, address TEXT NOT NULL, cycles INTEGER NOT NULL, amount TEXT NOT NULL,
  deadline INTEGER NOT NULL, signature TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deposits (tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, address TEXT NOT NULL, amount TEXT NOT NULL,
  cycles INTEGER NOT NULL, credited_at INTEGER NOT NULL, PRIMARY KEY (tx_hash, log_index));
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function openStore(file = ":memory:") {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);
  const st = {
    db,
    /** Run fn inside one transaction; any throw rolls everything back. */
    tx(fn) {
      db.exec("BEGIN IMMEDIATE");
      try { const out = fn(); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    account: (address) => q("SELECT * FROM accounts WHERE address = ?").get(address),
    addAccount: (address, now) => q("INSERT OR IGNORE INTO accounts (address, created_at) VALUES (?, ?)").run(address, now),
    addSession: (token, address, expires) => q("INSERT INTO sessions (token, address, expires) VALUES (?, ?, ?)").run(token, address, expires),
    session: (token, now) => q("SELECT * FROM sessions WHERE token = ? AND expires > ?").get(token, now),
    dropSession: (token) => q("DELETE FROM sessions WHERE token = ?").run(token),
    addNonce: (nonce, expires) => q("INSERT INTO nonces (nonce, expires) VALUES (?, ?)").run(nonce, expires),
    /** Use a sign-in nonce exactly once. */
    takeNonce(nonce, now) {
      const r = q("UPDATE nonces SET used = 1 WHERE nonce = ? AND used = 0 AND expires > ?").run(nonce, now);
      return r.changes === 1;
    },
    progress(address) { const r = q("SELECT json FROM progress WHERE address = ?").get(address); return r ? JSON.parse(r.json) : null; },
    setProgress: (address, p) => q("INSERT INTO progress (address, json) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET json = excluded.json").run(address, JSON.stringify(p)),
    fighters: (address) => q("SELECT json FROM fighters WHERE address = ? ORDER BY updated_at").all(address).map((r) => JSON.parse(r.json)),
    fighter(address, id) { const r = q("SELECT json FROM fighters WHERE address = ? AND id = ?").get(address, id); return r ? JSON.parse(r.json) : null; },
    putFighter: (address, f, now) => q("INSERT INTO fighters (id, address, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at WHERE fighters.address = excluded.address")
      .run(f.id, address, JSON.stringify(f), now),
    dropFighter: (address, id) => q("DELETE FROM fighters WHERE address = ? AND id = ?").run(address, id),
    addLedger: (address, e) => q("INSERT INTO ledger (address, at, amount, reason, ref) VALUES (?, ?, ?, ?, ?)").run(address, e.at, e.amount, e.reason, e.ref ?? null),
    ledgerSum(address) { return Number(q("SELECT COALESCE(SUM(amount), 0) AS s FROM ledger WHERE address = ?").get(address).s); },
    addBattle: (b) => q("INSERT INTO battles (id, address, kind, fighter_id, opponent, seed, result, json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(b.id, b.address, b.kind, b.fighterId, b.opponent, b.seed, b.result, JSON.stringify(b.record), b.at),
    battle(id) { const r = q("SELECT * FROM battles WHERE id = ?").get(id); return r ? { ...r, record: JSON.parse(r.json) } : null; },
    arenaResults: () => q("SELECT json FROM battles WHERE kind = 'arena' ORDER BY at").all().map((r) => JSON.parse(r.json).result),
    publish: (address, f, now) => q("INSERT INTO arena (address, fighter_id, json, published_at) VALUES (?, ?, ?, ?) ON CONFLICT(address, fighter_id) DO UPDATE SET json = excluded.json, published_at = excluded.published_at")
      .run(address, f.id, JSON.stringify(f), now),
    unpublish: (address, id) => q("DELETE FROM arena WHERE address = ? AND fighter_id = ?").run(address, id),
    arena: () => q("SELECT address, json FROM arena ORDER BY published_at").all().map((r) => ({ owner: r.address, fighter: JSON.parse(r.json) })),
    arenaEntry(address, id) { const r = q("SELECT json FROM arena WHERE address = ? AND fighter_id = ?").get(address, id); return r ? JSON.parse(r.json) : null; },
    addWithdrawal: (w) => q("INSERT INTO withdrawals (nonce, address, cycles, amount, deadline, signature, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'issued', ?)")
      .run(w.nonce, w.address, w.cycles, w.amount, w.deadline, w.signature, w.createdAt),
    withdrawals: (address) => q("SELECT * FROM withdrawals WHERE address = ? ORDER BY created_at DESC").all(address),
    withdrawal: (nonce) => q("SELECT * FROM withdrawals WHERE nonce = ?").get(nonce),
    openWithdrawals: () => q("SELECT * FROM withdrawals WHERE status = 'issued'").all(),
    setWithdrawal: (nonce, status) => q("UPDATE withdrawals SET status = ? WHERE nonce = ? AND status = 'issued'").run(status, nonce),
    withdrawnSince(address, since) { return Number(q("SELECT COALESCE(SUM(cycles), 0) AS s FROM withdrawals WHERE address = ? AND created_at >= ? AND status != 'refunded'").get(address, since).s); },
    addDeposit(d) {
      const r = q("INSERT OR IGNORE INTO deposits (tx_hash, log_index, address, amount, cycles, credited_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(d.txHash, d.logIndex, d.address, d.amount, d.cycles, d.at);
      return r.changes === 1;   // false: this event was already credited
    },
    get(key) { const r = q("SELECT value FROM kv WHERE key = ?").get(key); return r ? r.value : null; },
    set: (key, value) => q("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value)),
  };
  return st;
}
