import { db } from './db.js';

const insert = db.prepare('INSERT INTO logs (ts, level, message) VALUES (?, ?, ?)');

function write(level, message) {
  const line = String(message);
  insert.run(Date.now(), level, line);
  const stamp = new Date().toLocaleTimeString('fr-FR');
  console.log(`[${stamp}] ${level.toUpperCase().padEnd(5)} ${line}`);
}

export const log = {
  info: (m) => write('info', m),
  warn: (m) => write('warn', m),
  error: (m) => write('error', m),
};

/** Garde les 500 dernieres lignes pour que la base ne gonfle pas indefiniment. */
export function trimLogs() {
  db.exec('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 500)');
}
