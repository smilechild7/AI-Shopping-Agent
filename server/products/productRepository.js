/**
 * 역할: SQLite의 쇼핑몰·상품·리뷰·가공 결과 저장과 조회를 담당하는 데이터 접근 계층이다.
 * 트랜잭션 저장, 검색 조건에 따른 SQL 조회와 DB 행의 상품 객체 변환을 제공한다.
 */

/**
 * DB의 JSON 문자열을 복원하고 값이 없거나 깨졌으면 필드에 맞는 기본값을 반환한다.
 */
function parseJson(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * 조회 개수를 양의 정수로 제한하며 최대 100개를 허용하고 잘못된 입력에는 기본값을 사용한다.
 */
function positiveLimit(value, fallback = 15) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 100) : fallback;
}

/**
 * 상품 DB 행의 컬럼명·JSON 필드를 애플리케이션 상품 객체로 복원하고, 행이 없으면 null을 반환한다.
 */
function hydrateProduct(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    source: {
      shopId: row.shop_id,
      shopName: row.shop_name,
      sourceProductId: row.source_product_id,
      productUrl: row.product_url,
    },
    name: row.name,
    brand: row.brand,
    category: row.category,
    price: row.price,
    originalPrice: row.original_price,
    imageUrl: row.image_url,
    colors: parseJson(row.colors_json, []),
    sizes: parseJson(row.sizes_json, []),
    sizeGuideText: row.size_guide_text,
    material: row.material,
    description: row.description,
    rating: row.rating,
    reviewCount: row.review_count,
    crawledAt: row.crawled_at,
  };
}

/**
 * 리뷰 DB 행을 공통 리뷰 객체로 바꾸고 프로필·이미지 목록의 JSON을 복원한다.
 */
function hydrateReview(row) {
  return {
    id: row.id,
    productId: row.product_id,
    rating: row.rating,
    text: row.text,
    optionText: row.option_text,
    reviewerProfile: parseJson(row.reviewer_profile_json, {
      heightCm: null,
      weightKg: null,
      usualSize: null,
      ageGroup: null,
    }),
    imageUrls: parseJson(row.image_urls_json, []),
    createdAt: row.created_at,
  };
}

/**
 * 단독 조회한 가공 결과 행을 태그·후기 요약·가공 메타데이터 객체로 복원한다.
 */
function hydrateEnrichment(row) {
  if (!row) {
    return null;
  }

  return {
    productId: row.product_id,
    summary: row.summary,
    styleTags: parseJson(row.style_tags_json, []),
    occasionTags: parseJson(row.occasion_tags_json, []),
    fitTags: parseJson(row.fit_tags_json, []),
    seasonTags: parseJson(row.season_tags_json, []),
    extraTags: parseJson(row.extra_tags_json, []),
    reviewSummary: parseJson(row.review_summary_json, null),
    model: row.model,
    promptVersion: row.prompt_version,
    enrichedAt: row.enriched_at,
  };
}

/**
 * 상품과 조인한 행의 가공 컬럼을 복원하고 연결된 가공 데이터가 없으면 null을 반환한다.
 */
function hydrateJoinedEnrichment(row) {
  if (!row.enrichment_product_id) {
    return null;
  }

  return {
    productId: row.enrichment_product_id,
    summary: row.enrichment_summary,
    styleTags: parseJson(row.enrichment_style_tags_json, []),
    occasionTags: parseJson(row.enrichment_occasion_tags_json, []),
    fitTags: parseJson(row.enrichment_fit_tags_json, []),
    seasonTags: parseJson(row.enrichment_season_tags_json, []),
    extraTags: parseJson(row.enrichment_extra_tags_json, []),
    reviewSummary: parseJson(row.enrichment_review_summary_json, null),
  };
}

/**
 * 쇼핑몰 ID와 원본 상품 ID를 결합해 저장소 전체에서 사용하는 상품 ID를 만든다.
 */
export function productIdForSource(shopId, sourceProductId) {
  return `${shopId}:${sourceProductId}`;
}

/**
 * 열린 SQLite 연결에 상품·리뷰·가공 결과 저장과 조회 메서드를 구성한다.
 * SQL의 준비·트랜잭션과 DB 행 변환을 한곳에 모아 검색·Agent·DB 생성 코드가 재사용하게 한다.
 */
export function createProductRepository(database) {
  const selectProductColumns = `
    SELECT
      products.*,
      shops.name AS shop_name
    FROM products
    JOIN shops ON shops.id = products.shop_id
  `;
  const selectSearchCandidateColumns = `
    SELECT
      products.*,
      shops.name AS shop_name,
      product_enrichments.product_id AS enrichment_product_id,
      product_enrichments.summary AS enrichment_summary,
      product_enrichments.style_tags_json AS enrichment_style_tags_json,
      product_enrichments.occasion_tags_json AS enrichment_occasion_tags_json,
      product_enrichments.fit_tags_json AS enrichment_fit_tags_json,
      product_enrichments.season_tags_json AS enrichment_season_tags_json,
      product_enrichments.extra_tags_json AS enrichment_extra_tags_json,
      product_enrichments.review_summary_json AS enrichment_review_summary_json
    FROM products
    JOIN shops ON shops.id = products.shop_id
    LEFT JOIN product_enrichments
      ON product_enrichments.product_id = products.id
  `;
  const upsertShop = database.prepare(`
    INSERT INTO shops (id, name, base_url)
    VALUES (@id, @name, @baseUrl)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      base_url = excluded.base_url
  `);
  const upsertProduct = database.prepare(`
    INSERT INTO products (
      id,
      shop_id,
      source_product_id,
      name,
      brand,
      category,
      price,
      original_price,
      image_url,
      product_url,
      colors_json,
      sizes_json,
      size_guide_text,
      material,
      description,
      rating,
      review_count,
      crawled_at
    ) VALUES (
      @id,
      @shopId,
      @sourceProductId,
      @name,
      @brand,
      @category,
      @price,
      @originalPrice,
      @imageUrl,
      @productUrl,
      @colorsJson,
      @sizesJson,
      @sizeGuideText,
      @material,
      @description,
      @rating,
      @reviewCount,
      @crawledAt
    )
    ON CONFLICT(shop_id, source_product_id) DO UPDATE SET
      id = excluded.id,
      name = excluded.name,
      brand = excluded.brand,
      category = excluded.category,
      price = excluded.price,
      original_price = excluded.original_price,
      image_url = excluded.image_url,
      product_url = excluded.product_url,
      colors_json = excluded.colors_json,
      sizes_json = excluded.sizes_json,
      size_guide_text = excluded.size_guide_text,
      material = excluded.material,
      description = excluded.description,
      rating = excluded.rating,
      review_count = excluded.review_count,
      crawled_at = excluded.crawled_at
  `);
  const deleteReviews = database.prepare(
    'DELETE FROM reviews WHERE product_id = ?',
  );
  const insertReview = database.prepare(`
    INSERT INTO reviews (
      product_id,
      rating,
      text,
      option_text,
      reviewer_profile_json,
      image_urls_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertEnrichment = database.prepare(`
    INSERT INTO product_enrichments (
      product_id,
      summary,
      style_tags_json,
      occasion_tags_json,
      fit_tags_json,
      season_tags_json,
      extra_tags_json,
      review_summary_json,
      model,
      prompt_version,
      enriched_at
    ) VALUES (
      @productId,
      @summary,
      @styleTagsJson,
      @occasionTagsJson,
      @fitTagsJson,
      @seasonTagsJson,
      @extraTagsJson,
      @reviewSummaryJson,
      @model,
      @promptVersion,
      @enrichedAt
    )
    ON CONFLICT(product_id) DO UPDATE SET
      summary = excluded.summary,
      style_tags_json = excluded.style_tags_json,
      occasion_tags_json = excluded.occasion_tags_json,
      fit_tags_json = excluded.fit_tags_json,
      season_tags_json = excluded.season_tags_json,
      extra_tags_json = excluded.extra_tags_json,
      review_summary_json = excluded.review_summary_json,
      model = excluded.model,
      prompt_version = excluded.prompt_version,
      enriched_at = excluded.enriched_at
  `);
  /**
   * 쇼핑몰·상품을 갱신 또는 추가하고 해당 상품의 리뷰를 최신 원본 스냅샷으로 교체하는 트랜잭션이다.
   */
  const saveProductsTransaction = database.transaction((products) => {
    for (const product of products) {
      const shopId = product.source.shopId;
      const sourceProductId = product.source.sourceProductId;
      const productId = productIdForSource(shopId, sourceProductId);
      const baseUrl = new URL(product.source.productUrl).origin;

      upsertShop.run({
        id: shopId,
        name: product.source.shopName,
        baseUrl,
      });
      upsertProduct.run({
        id: productId,
        shopId,
        sourceProductId,
        name: product.name,
        brand: product.brand,
        category: product.category,
        price: product.price,
        originalPrice: product.originalPrice,
        imageUrl: product.imageUrl,
        productUrl: product.source.productUrl,
        colorsJson: JSON.stringify(product.colors ?? []),
        sizesJson: JSON.stringify(product.sizes ?? []),
        sizeGuideText: product.sizeGuideText,
        material: product.material,
        description: product.description,
        rating: product.rating,
        reviewCount: product.reviewCount,
        crawledAt: product.crawledAt,
      });

      deleteReviews.run(productId);
      for (const review of product.reviews ?? []) {
        insertReview.run(
          productId,
          review.rating,
          review.text,
          review.optionText,
          JSON.stringify(review.reviewerProfile),
          JSON.stringify(review.imageUrls ?? []),
          review.createdAt,
        );
      }
    }
  });
  /**
   * 가공 결과의 태그·후기 요약을 JSON으로 직렬화해 상품별로 갱신 또는 추가하는 트랜잭션이다.
   */
  const saveEnrichmentsTransaction = database.transaction((enrichments) => {
    for (const enrichment of enrichments) {
      upsertEnrichment.run({
        productId: enrichment.productId,
        summary: enrichment.summary,
        styleTagsJson: JSON.stringify(enrichment.styleTags ?? []),
        occasionTagsJson: JSON.stringify(enrichment.occasionTags ?? []),
        fitTagsJson: JSON.stringify(enrichment.fitTags ?? []),
        seasonTagsJson: JSON.stringify(enrichment.seasonTags ?? []),
        extraTagsJson: JSON.stringify(enrichment.extraTags ?? []),
        reviewSummaryJson: JSON.stringify(enrichment.reviewSummary),
        model: enrichment.model,
        promptVersion: enrichment.promptVersion,
        enrichedAt: enrichment.enrichedAt,
      });
    }
  });

  return {
    /**
     * 상품 목록과 리뷰를 하나의 트랜잭션으로 저장하고 처리한 상품 수를 반환한다.
     */
    saveProducts(products) {
      saveProductsTransaction(products);
      return products.length;
    },

    /**
     * 상품 가공 결과들을 하나의 트랜잭션으로 저장하고 처리한 결과 수를 반환한다.
     */
    saveProductEnrichments(enrichments) {
      saveEnrichmentsTransaction(enrichments);
      return enrichments.length;
    },

    /**
     * 카테고리·가격·쇼핑몰 조건과 조회 상한을 적용해 가격·ID 순으로 정렬된 상품 객체 목록을 반환한다.
     */
    searchProducts({ category, minPrice, maxPrice, shopIds, limit } = {}) {
      const conditions = [];
      const parameters = {};

      if (category) {
        conditions.push('products.category = @category');
        parameters.category = category;
      }
      if (Number.isSafeInteger(minPrice)) {
        conditions.push('products.price >= @minPrice');
        parameters.minPrice = minPrice;
      }
      if (Number.isSafeInteger(maxPrice)) {
        conditions.push('products.price <= @maxPrice');
        parameters.maxPrice = maxPrice;
      }
      if (Array.isArray(shopIds) && shopIds.length > 0) {
        const placeholders = shopIds.map(/* 쇼핑몰 ID를 SQL에 직접 넣지 않고 바인딩할 수 있도록 위치별 매개변수 이름을 만든다. */ (_, index) => `@shopId${index}`);
        conditions.push(`products.shop_id IN (${placeholders.join(', ')})`);
        shopIds.forEach(/* 쇼핑몰마다 대응하는 SQL 매개변수에 실제 ID를 넣는다. */ (shopId, index) => {
          parameters[`shopId${index}`] = shopId;
        });
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      parameters.limit = positiveLimit(limit);

      return database
        .prepare(`
          ${selectProductColumns}
          ${where}
          ORDER BY products.price ASC, products.id ASC
          LIMIT @limit
        `)
        .all(parameters)
        .map(hydrateProduct);
    },

    /**
     * 카테고리·가격에 맞는 상품과 가공 결과를 조인해 조회하며, 선호 점수 계산 전이므로 개수 제한을 두지 않는다.
     */
    findSearchCandidates({ category, minPrice, maxPrice } = {}) {
      const conditions = [];
      const parameters = {};

      if (category) {
        conditions.push('products.category = @category');
        parameters.category = category;
      }
      if (Number.isSafeInteger(minPrice)) {
        conditions.push('products.price >= @minPrice');
        parameters.minPrice = minPrice;
      }
      if (Number.isSafeInteger(maxPrice)) {
        conditions.push('products.price <= @maxPrice');
        parameters.maxPrice = maxPrice;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      return database
        .prepare(`
          ${selectSearchCandidateColumns}
          ${where}
          ORDER BY products.price ASC, products.id ASC
        `)
        .all(parameters)
        .map(/* 조인된 DB 행을 실제 상품 정보와 가공 정보가 분리된 검색 후보 객체로 바꾼다. */ (row) => ({
          product: hydrateProduct(row),
          enrichment: hydrateJoinedEnrichment(row),
        }));
    },

    /**
     * 상품 ID 한 개로 쇼핑몰 정보가 포함된 상품을 조회하며, 없으면 null을 반환한다.
     */
    getProductById(id) {
      return hydrateProduct(
        database.prepare(`${selectProductColumns} WHERE products.id = ?`).get(id),
      );
    },

    /**
     * 여러 ID의 상품을 한 번에 조회한 뒤 요청한 ID 순서대로 반환하고 존재하지 않는 상품은 제외한다.
     */
    getProductsByIds(ids) {
      if (!Array.isArray(ids) || ids.length === 0) {
        return [];
      }

      const placeholders = ids.map(/* 상품 ID 값을 안전하게 바인딩할 SQL 위치 매개변수를 개수만큼 만든다. */ () => '?').join(', ');
      const productsById = new Map(
        database
          .prepare(
            `${selectProductColumns} WHERE products.id IN (${placeholders})`,
          )
          .all(...ids)
          .map(/* 조회한 상품을 ID와 객체의 쌍으로 바꿔 순서 복원에 사용할 Map을 구성한다. */ (row) => {
            const product = hydrateProduct(row);
            return [product.id, product];
          }),
      );

      return ids.map(/* 원래 요청 ID 순서대로 조회 결과를 찾아 추천 순서를 보존한다. */ (id) => productsById.get(id)).filter(Boolean);
    },

    /**
     * 한 상품에 연결된 리뷰를 작성일과 리뷰 ID의 최신 순서로 조회해 공통 리뷰 객체로 반환한다.
     */
    getReviewsByProductId(productId) {
      return database
        .prepare(`
          SELECT *
          FROM reviews
          WHERE product_id = ?
          ORDER BY created_at DESC, id DESC
        `)
        .all(productId)
        .map(hydrateReview);
    },

    /**
     * 한 상품의 가공 결과를 조회해 태그·후기 요약을 복원하고, 없으면 null을 반환한다.
     */
    getProductEnrichment(productId) {
      return hydrateEnrichment(
        database
          .prepare('SELECT * FROM product_enrichments WHERE product_id = ?')
          .get(productId),
      );
    },
  };
}
