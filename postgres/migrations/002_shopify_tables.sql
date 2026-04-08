-- Shopify store connections
CREATE TABLE IF NOT EXISTS shopify_stores (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(100) NOT NULL,
    store_url           VARCHAR(255) NOT NULL,
    access_token_enc    VARCHAR(500) NOT NULL,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    watermark_image     BYTEA,
    watermark_position  VARCHAR(20) DEFAULT 'bottom-right',
    watermark_opacity   NUMERIC(3,2) DEFAULT 0.30,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Shopify product insertion audit log
CREATE TABLE IF NOT EXISTS shopify_insertion_log (
    id                  SERIAL PRIMARY KEY,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    product_title       VARCHAR(255),
    stores_targeted     TEXT[],
    stores_succeeded    TEXT[],
    stores_failed       TEXT[],
    error_details       JSONB,
    form_data           JSONB,
    shopify_product_ids JSONB
);
