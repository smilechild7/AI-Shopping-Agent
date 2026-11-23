/**
 * 역할: data/raw와 data/enriched의 JSON을 읽어 마이그레이션을 적용한 SQLite DB를 새로 만든다.
 * 상품·리뷰·가공 결과를 저장하고 입력 수와 DB 레코드 수가 일치하는지 확인한다.
 */

import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../server/db/connection.js';
import { runMigrations } from '../server/db/migrationRunner.js';
import { createProductRepository } from '../server/products/productRepository.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * 원본 디렉터리의 JSON 파일을 이름순으로 읽어 상품 배열을 합치고, 배열이 아닌 파일은 거부한다.
 */
async function readRawProducts(rawDataDirectory) {
  const fileNames = (await readdir(rawDataDirectory))
    .filter(/* 원본 입력 중 JSON 확장자 파일만 DB 생성 대상으로 선택한다. */ (fileName) => fileName.endsWith('.json'))
    .sort(/* 원본 파일의 처리 순서를 이름순으로 고정해 반복 빌드의 입력 순서를 유지한다. */ (left, right) => left.localeCompare(right));
  const products = [];

  for (const fileName of fileNames) {
    const value = JSON.parse(
      await readFile(path.join(rawDataDirectory, fileName), 'utf8'),
    );

    if (!Array.isArray(value)) {
      throw new Error(`Expected an array in raw data file: ${fileName}`);
    }

    products.push(...value);
  }

  return products;
}

/**
 * 가공 JSON들을 이름순으로 합치고 중복 상품 ID를 거부하며, 디렉터리가 없으면 빈 목록을 반환한다.
 */
async function readEnrichments(enrichedDataDirectory) {
  let fileNames;
  try {
    fileNames = (await readdir(enrichedDataDirectory))
      .filter(/* 가공 입력 중 JSON 파일만 선택해 체크포인트 같은 임시 파일을 제외한다. */ (fileName) => fileName.endsWith('.json'))
      .sort(/* 가공 파일을 이름순으로 읽도록 정렬한다. */ (left, right) => left.localeCompare(right));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const enrichments = [];
  const productIds = new Set();
  for (const fileName of fileNames) {
    const value = JSON.parse(
      await readFile(path.join(enrichedDataDirectory, fileName), 'utf8'),
    );
    if (!Array.isArray(value)) {
      throw new Error(`Expected an array in enriched data file: ${fileName}`);
    }
    for (const enrichment of value) {
      if (productIds.has(enrichment.productId)) {
        throw new Error(`Duplicate enriched product ID: ${enrichment.productId}`);
      }
      productIds.add(enrichment.productId);
      enrichments.push(enrichment);
    }
  }

  return enrichments;
}

/**
 * 쇼핑몰·상품·리뷰·가공 결과 테이블의 행 수를 세어 입력과 대조할 집계를 만든다.
 */
function databaseCounts(database) {
  return {
    shops: database.prepare('SELECT COUNT(*) count FROM shops').get().count,
    products: database.prepare('SELECT COUNT(*) count FROM products').get().count,
    reviews: database.prepare('SELECT COUNT(*) count FROM reviews').get().count,
    enrichments: database
      .prepare('SELECT COUNT(*) count FROM product_enrichments')
      .get().count,
  };
}

/**
 * 원본·가공 JSON을 읽은 뒤 기존 DB 파일을 삭제하고 마이그레이션부터 새로 생성한다.
 * 모든 데이터를 저장해 행 수를 검증하고 DB 경로·적용 내역·개수를 반환하며, 실패해도 연결을 닫는다.
 */
export async function buildDatabase({
  databasePath = path.join(repositoryRoot, 'data/products.db'),
  rawDataDirectory = path.join(repositoryRoot, 'data/raw'),
  enrichedDataDirectory = path.join(repositoryRoot, 'data/enriched'),
  migrationsDirectory = path.join(repositoryRoot, 'db/migrations'),
} = {}) {
  const products = await readRawProducts(rawDataDirectory);
  const enrichments = await readEnrichments(enrichedDataDirectory);
  const expectedReviewCount = products.reduce(
    /**
     * 원본 상품마다 저장된 리뷰 개수를 더해 DB에 들어가야 할 총 리뷰 수를 계산한다.
     */
    (total, product) => total + (product.reviews?.length ?? 0),
    0,
  );

  await mkdir(path.dirname(databasePath), { recursive: true });
  await rm(databasePath, { force: true });

  const database = openDatabase(databasePath);

  try {
    const migrations = await runMigrations(database, migrationsDirectory);
    const productRepository = createProductRepository(database);
    productRepository.saveProducts(products);
    productRepository.saveProductEnrichments(enrichments);

    const counts = databaseCounts(database);

    if (
      counts.products !== products.length ||
      counts.reviews !== expectedReviewCount ||
      counts.enrichments !== enrichments.length
    ) {
      throw new Error(
        `Database count mismatch: expected products=${products.length} reviews=${expectedReviewCount} enrichments=${enrichments.length}, actual products=${counts.products} reviews=${counts.reviews} enrichments=${counts.enrichments}`,
      );
    }

    return { databasePath, migrations, counts };
  } finally {
    database.close();
  }
}

/**
 * 기본 경로로 DB를 생성하고 생성 위치·마이그레이션·저장 개수를 CLI 결과로 출력한다.
 */
async function main() {
  const result = await buildDatabase();

  console.log(
    JSON.stringify({
      event: 'db.build.complete',
      databasePath: path.relative(repositoryRoot, result.databasePath),
      migrations: result.migrations,
      counts: result.counts,
    }),
  );
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch(/* DB 생성 실패를 구조화 로그로 출력하고 프로세스의 실패 종료 코드를 설정한다. */ (error) => {
    console.error(
      JSON.stringify({
        event: 'db.build.failed',
        message: error.message,
      }),
    );
    process.exitCode = 1;
  });
}
