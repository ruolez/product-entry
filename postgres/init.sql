-- Item Entry System - PostgreSQL Settings Schema

-- Store connections (MS SQL servers)
CREATE TABLE stores (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    host            VARCHAR(255) NOT NULL,
    port            INTEGER NOT NULL DEFAULT 1433,
    database_name   VARCHAR(100) NOT NULL,
    username        VARCHAR(100) NOT NULL,
    password_enc    VARCHAR(500) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Price formulas per store: source_field -> target_field via operator + operand
CREATE TABLE price_formulas (
    id              SERIAL PRIMARY KEY,
    store_id        INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    target_field    VARCHAR(50) NOT NULL,
    source_field    VARCHAR(50) NOT NULL DEFAULT 'UnitCost',
    operator        VARCHAR(10) NOT NULL DEFAULT 'multiply',
    operand         NUMERIC(10,4) NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE(store_id, target_field)
);

-- Field visibility, requirement level, defaults
CREATE TABLE field_configs (
    id              SERIAL PRIMARY KEY,
    field_name      VARCHAR(50) NOT NULL UNIQUE,
    display_name    VARCHAR(100) NOT NULL,
    section         VARCHAR(50) NOT NULL,
    field_type      VARCHAR(30) NOT NULL,
    is_visible      BOOLEAN NOT NULL DEFAULT TRUE,
    is_required     BOOLEAN NOT NULL DEFAULT FALSE,
    is_per_store    BOOLEAN NOT NULL DEFAULT FALSE,
    default_value   TEXT,
    max_length      INTEGER,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    help_text       VARCHAR(255)
);

-- Per-store field default overrides
CREATE TABLE store_field_defaults (
    id              SERIAL PRIMARY KEY,
    store_id        INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    field_name      VARCHAR(50) NOT NULL,
    default_value   TEXT,
    UNIQUE(store_id, field_name)
);

-- Audit log for item insertions
CREATE TABLE insertion_log (
    id              SERIAL PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    product_upc     VARCHAR(20),
    product_sku     VARCHAR(20),
    product_desc    VARCHAR(50),
    stores_targeted TEXT[],
    stores_succeeded TEXT[],
    stores_failed   TEXT[],
    error_details   JSONB,
    form_data       JSONB
);

-- Seed field_configs with all Items_tbl fields

-- GENERAL section
INSERT INTO field_configs (field_name, display_name, section, field_type, is_visible, is_required, is_per_store, default_value, max_length, sort_order, help_text) VALUES
('ProductUPC',        'UPC',              'general',   'text',     TRUE, TRUE,  FALSE, NULL,  20,  10, 'Universal Product Code - must be unique across all stores'),
('ProductSKU',        'SKU',              'general',   'text',     TRUE, TRUE,  FALSE, NULL,  20,  20, 'Stock Keeping Unit - first 14 chars must be unique across all stores'),
('ProductDescription','Description',      'general',   'text',     TRUE, TRUE,  FALSE, NULL,  50,  30, 'Product name/description'),
('CateID',            'Main Category',    'general',   'select',   TRUE, TRUE,  TRUE,  NULL,  NULL, 40, 'Main category - may differ per store'),
('SubCateID',         'Sub Category',     'general',   'select',   TRUE, TRUE,  TRUE,  NULL,  NULL, 50, 'Sub category - may differ per store'),
('ProductType',       'Type',             'general',   'select',   TRUE, FALSE, FALSE, '1',   NULL, 60, '1=Standard'),
('ValuationMethod',   'Valuation',        'general',   'select',   TRUE, FALSE, FALSE, '1',   NULL, 70, '1=FIFO'),
('ItemTaxID',         'Tax',              'general',   'select',   TRUE, FALSE, FALSE, '0',   NULL, 80, 'Tax category'),
('BarcodeFormat',     'Barcode',          'general',   'select',   TRUE, FALSE, FALSE, '53',  NULL, 90, 'Barcode format type'),
('ExpDate',           'Exp. Date',        'general',   'date',     TRUE, FALSE, FALSE, NULL,  NULL, 100, 'Expiration date'),
('ProductMessage',    'Line Message',     'general',   'textarea', TRUE, FALSE, FALSE, NULL,  96,  110, 'Item-specific message'),
('Discontinued',      'Discontinued',     'general',   'checkbox', TRUE, FALSE, FALSE, '0',   NULL, 120, 'Product discontinued flag');

-- PRICING section
INSERT INTO field_configs (field_name, display_name, section, field_type, is_visible, is_required, is_per_store, default_value, max_length, sort_order, help_text) VALUES
('UnitCost',               'Unit Cost',                    'pricing', 'money',    TRUE, TRUE,  FALSE, NULL,   NULL, 10,  'Cost per unit - drives price calculations'),
('UnitPrice',              'Standard Price',               'pricing', 'money',    TRUE, TRUE,  FALSE, NULL,   NULL, 20,  'Standard selling price'),
('UnitPriceA',             'Cash & Carry Price',           'pricing', 'money',    TRUE, FALSE, FALSE, NULL,   NULL, 30,  'Cash & Carry price tier'),
('UnitPriceB',             'Delivery A Price',             'pricing', 'money',    TRUE, FALSE, FALSE, NULL,   NULL, 40,  'Delivery A price tier'),
('UnitPriceC',             'Delivery B Price',             'pricing', 'money',    TRUE, FALSE, FALSE, NULL,   NULL, 50,  'Delivery B price tier'),
('MSRPrice',               'MSRP',                        'pricing', 'money',    TRUE, FALSE, FALSE, '0.00', NULL, 60,  'Manufacturer suggested retail price'),
('LastCost',               'Last Cost',                    'pricing', 'money',    FALSE, FALSE, FALSE, NULL,  NULL, 70,  'Last cost paid - tracking field'),
('AvrCost',                'Avg. Cost',                    'pricing', 'money',    FALSE, FALSE, FALSE, NULL,  NULL, 80,  'Average cost - tracking field'),
('SPPromoted',             'Manufacturer Promotion',       'pricing', 'checkbox', TRUE, FALSE, FALSE, '0',   NULL, 90,  'NOT NULL in DB - defaults to 0'),
('PromotionID',            'Promotion',                    'pricing', 'select',   TRUE, FALSE, FALSE, '0',   NULL, 100, 'Preconfigured promotion'),
('SPPromotionDescription', 'Mfr Promotion Description',   'pricing', 'text',     TRUE, FALSE, FALSE, NULL,  50,  110, 'Manufacturer promotion description'),
('SPPromotionCode',        'Mfr Promotion Code',          'pricing', 'text',     TRUE, FALSE, FALSE, NULL,  20,  120, 'Manufacturer promotion code'),
('ManuProductID',          'Manufacturer Product ID',      'pricing', 'text',     TRUE, FALSE, FALSE, NULL,  20,  130, 'Manufacturer product identifier');

-- INVENTORY section
INSERT INTO field_configs (field_name, display_name, section, field_type, is_visible, is_required, is_per_store, default_value, max_length, sort_order, help_text) VALUES
('QuantOnHand',    'On Hand',           'inventory', 'number', TRUE,  FALSE, FALSE, '0',    NULL, 10, 'Current quantity in stock'),
('QuantOnOrder',   'On Order',          'inventory', 'number', TRUE,  FALSE, FALSE, NULL,   NULL, 20, 'Quantity on pending orders'),
('ReorderLevel',   'Reorder Point',     'inventory', 'number', TRUE,  FALSE, FALSE, '15',   NULL, 30, 'Minimum stock level before reorder'),
('ReorderQuant',   'Reorder Quantity',  'inventory', 'number', TRUE,  FALSE, FALSE, '0',    NULL, 40, 'Default reorder quantity'),
('ManuID',         'Manufacturer',      'inventory', 'select', TRUE,  FALSE, FALSE, '0',    NULL, 50, 'Manufacturer'),
('StLocationID',   'BIN Location',      'inventory', 'select', TRUE,  FALSE, FALSE, '0',    NULL, 60, 'Storage location'),
('CountInUnit',    'Base Unit Count',   'inventory', 'number', TRUE,  FALSE, FALSE, NULL,   NULL, 70, 'Units per base container'),
('ItemSize',       'Size',              'inventory', 'text',   TRUE,  FALSE, FALSE, NULL,   10,  80, 'Size descriptor (e.g. oz, ml)'),
('ItemWeight',     'Weight',            'inventory', 'text',   TRUE,  FALSE, FALSE, NULL,   10,  90, 'Weight descriptor'),
('UnitID',         'Base Unit',         'inventory', 'select', TRUE,  FALSE, FALSE, '14',   NULL, 100, 'Base unit of measure'),
('UnitID2',        'Unit 2',            'inventory', 'select', TRUE,  FALSE, FALSE, '0',    NULL, 110, 'Second unit of measure'),
('UnitQty2',       'Unit 2 Count',      'inventory', 'number', TRUE,  FALSE, FALSE, '0',    NULL, 120, 'Quantity per Unit 2'),
('UnitPrice2',     'Unit 2 Price',      'inventory', 'money',  TRUE,  FALSE, FALSE, '0.00', NULL, 130, 'Unit 2 standard price'),
('UnitPriceA2',    'Unit 2 C&C Price',  'inventory', 'money',  TRUE,  FALSE, FALSE, '0.00', NULL, 140, 'Unit 2 Cash & Carry price'),
('UnitPriceB2',    'Unit 2 Del A Price','inventory', 'money',  TRUE,  FALSE, FALSE, '0.00', NULL, 150, 'Unit 2 Delivery A price'),
('UnitPriceC2',    'Unit 2 Del B Price','inventory', 'money',  TRUE,  FALSE, FALSE, '0.00', NULL, 160, 'Unit 2 Delivery B price'),
('UnitID3',        'Unit 3',            'inventory', 'select', FALSE, FALSE, FALSE, '0',    NULL, 170, 'Third unit of measure'),
('UnitQty3',       'Unit 3 Count',      'inventory', 'number', FALSE, FALSE, FALSE, '0',    NULL, 180, 'Quantity per Unit 3'),
('UnitPrice3',     'Unit 3 Price',      'inventory', 'money',  FALSE, FALSE, FALSE, '0.00', NULL, 190, 'Unit 3 standard price'),
('UnitPriceA3',    'Unit 3 C&C Price',  'inventory', 'money',  FALSE, FALSE, FALSE, '0.00', NULL, 200, 'Unit 3 Cash & Carry price'),
('UnitPriceB3',    'Unit 3 Del A Price','inventory', 'money',  FALSE, FALSE, FALSE, '0.00', NULL, 210, 'Unit 3 Delivery A price'),
('UnitPriceC3',    'Unit 3 Del B Price','inventory', 'money',  FALSE, FALSE, FALSE, '0.00', NULL, 220, 'Unit 3 Delivery B price'),
('UnitID4',        'Unit 4',            'inventory', 'select', FALSE, FALSE, FALSE, '0',    NULL, 230, 'Fourth unit of measure'),
('UnitQty4',       'Unit 4 Count',      'inventory', 'number', FALSE, FALSE, FALSE, '0',    NULL, 240, 'Quantity per Unit 4'),
('UnitPrice4',     'Unit 4 Price',      'inventory', 'money',  FALSE, FALSE, FALSE, '0.00', NULL, 250, 'Unit 4 standard price'),
('UnitPriceA4',    'Unit 4 C&C Price',  'inventory', 'money',  FALSE, FALSE, FALSE, '0.00', NULL, 260, 'Unit 4 Cash & Carry price'),
('UnitPriceB4',    'Unit 4 Del A Price','inventory', 'money',  FALSE, FALSE, FALSE, '0.00', NULL, 270, 'Unit 4 Delivery A price'),
('UnitPriceC4',    'Unit 4 Del B Price','inventory', 'money',  FALSE, FALSE, FALSE, '0.00', NULL, 280, 'Unit 4 Delivery B price'),
('LastSold',       'Last Sold',         'inventory', 'date',   FALSE, FALSE, FALSE, NULL,   NULL, 290, 'Last sale date - tracking field'),
('LastReceived',   'Last Received',     'inventory', 'date',   FALSE, FALSE, FALSE, NULL,   NULL, 300, 'Last receipt date - tracking field'),
('LastCountDate',  'Last Physical Count','inventory','date',   FALSE, FALSE, FALSE, NULL,   NULL, 310, 'Last inventory count - tracking field');

-- EXTENDED section
INSERT INTO field_configs (field_name, display_name, section, field_type, is_visible, is_required, is_per_store, default_value, max_length, sort_order, help_text) VALUES
('ExtDescription', 'Extended Description', 'extended', 'textarea', TRUE,  FALSE, FALSE, NULL, NULL, 10, 'Extended product description'),
('Notes',          'Notes',                'extended', 'textarea', TRUE,  FALSE, FALSE, NULL, 500,  20, 'Additional notes');
