/**
 * 역할: 로컬 상품 DB에 아직 적용하지 않은 SQL 마이그레이션을 실행하고 적용한 파일 목록을 출력하는 CLI다.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../server/db/connection.js';
import { runMigrations } from '../server/db/migrationRunner.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const databasePath = path.join(repositoryRoot, 'data/products.db');
const migrationsDirectory = path.join(repositoryRoot, 'db/migrations');
const database = openDatabase(databasePath);

try {
  const migrations = await runMigrations(database, migrationsDirectory);
  console.log(
    JSON.stringify({
      event: 'db.migrate.complete',
      applied: migrations,
    }),
  );
} finally {
  database.close();
}
