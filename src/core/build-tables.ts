/**
 * The journey record's tables for what happens to the boards after an order is placed (src/core/boards.ts reads and
 * writes them). They are journey tables (src/core/journey.ts JOURNEY_TABLES): people enter them through the API, the
 * agents cannot write them, and they are copied into the repository with every release, like the orders.
 *
 *   order_tracking  the shipment of an order: carrier and tracking number, as the person recorded them (order.update)
 *   boards          each board by its serial: the order it came in, when it was received, its status, notes, photos
 *                   (run artifacts or files, as evidence paths files.url opens)
 *   board_checks    the incoming inspection's result per board and check: pass, fail, or marked (a hand-placed part
 *                   left off on purpose), with the reference a fault is at and a photo
 *
 * Only the schema is here (store.ts only), so journey.ts can register it without a cycle.
 */
import { ensureProjectSchema } from './store.js'

const newer = (table: string, key: string, cols: readonly string[]): string =>
  `INSERT INTO ${table} (${key}, ${cols.join(', ')}) SELECT ${key}, ${cols.join(', ')} FROM theirs.${table} WHERE true
  ON CONFLICT(${key}) DO UPDATE SET ${cols.map((c) => `${c}=excluded.${c}`).join(', ')} WHERE excluded.updated > ${table}.updated;`

const TRACKING_COLS = ['carrier', 'tracking', 'by', 'at', 'updated'] as const
const BOARD_COLS = ['order_id', 'revision', 'received_at', 'status', 'notes', 'photos', 'by', 'created', 'updated'] as const
const CHECK_COLS = ['serial', 'check_id', 'kind', 'result', 'ref', 'note', 'photo', 'by', 'at', 'updated'] as const

ensureProjectSchema({ table: 'order_tracking', sql: `
CREATE TABLE IF NOT EXISTS order_tracking (
  order_id TEXT PRIMARY KEY,      -- orders.id
  carrier TEXT NOT NULL,          -- dhl | fedex | ups | other
  tracking TEXT NOT NULL,         -- the carrier's tracking number
  by TEXT NOT NULL, at REAL NOT NULL, updated REAL NOT NULL
);`, merge: newer('order_tracking', 'order_id', TRACKING_COLS) })

ensureProjectSchema({ table: 'boards', sql: `
CREATE TABLE IF NOT EXISTS boards (
  serial TEXT PRIMARY KEY,        -- the label on the board (SN-001)
  order_id TEXT,                  -- orders.id it came in
  revision TEXT NOT NULL,
  received_at REAL,
  status TEXT NOT NULL CHECK (status IN ('received', 'inspected', 'failed', 'brought_up', 'scrapped')),
  notes TEXT,
  photos TEXT NOT NULL DEFAULT '[]',   -- JSON list of evidence paths (runs/<id>/<name>, or a file in the repository)
  by TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL
);`, merge: newer('boards', 'serial', BOARD_COLS) })

ensureProjectSchema({ table: 'board_checks', sql: `
CREATE TABLE IF NOT EXISTS board_checks (
  id TEXT PRIMARY KEY,
  serial TEXT NOT NULL,
  check_id TEXT NOT NULL,         -- what was checked: count, visual-top, bridges, U3-rotation, hand-J2, …
  kind TEXT NOT NULL CHECK (kind IN ('count', 'visual', 'fault', 'hand', 'label')),
  result TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'marked')),
  ref TEXT,                       -- the reference designator a fault is at (U3, C12)
  note TEXT,
  photo TEXT,                     -- an evidence path
  by TEXT NOT NULL, at REAL NOT NULL, updated REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS board_checks_serial ON board_checks(serial, at);`, merge: newer('board_checks', 'id', CHECK_COLS) })

export const BUILD_TABLES = ['order_tracking', 'boards', 'board_checks'] as const
