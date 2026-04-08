import { api } from "/static/js/api-client.js";
import { showToast, debounce, formatCurrency, escapeHtml } from "/static/js/utils.js";

const FIELD_SECTIONS = {
    general: [
        "ProductUPC", "ProductSKU", "ProductDescription", "CateID", "SubCateID",
        "ProductType", "ValuationMethod", "ItemTaxID", "BarcodeFormat",
        "ExpDate", "ProductMessage", "Discontinued",
    ],
    pricing: [
        "UnitCost", "UnitPrice", "UnitPriceA", "UnitPriceB", "UnitPriceC",
        "MSRPrice", "LastCost", "AvrCost", "SPPromoted", "PromotionID",
        "SPPromotionDescription", "SPPromotionCode", "ManuProductID",
    ],
    inventory: [
        "QuantOnHand", "QuantOnOrder", "ReorderLevel", "ReorderQuant",
        "ManuID", "StLocationID", "CountInUnit", "ItemSize", "ItemWeight",
        "UnitID", "UnitID2", "UnitQty2", "UnitPrice2", "UnitPriceA2",
        "UnitPriceB2", "UnitPriceC2", "UnitID3", "UnitQty3", "UnitPrice3",
        "UnitPriceA3", "UnitPriceB3", "UnitPriceC3", "UnitID4", "UnitQty4",
        "UnitPrice4", "UnitPriceA4", "UnitPriceB4", "UnitPriceC4",
    ],
    extended: [
        "ExtDescription", "Notes",
    ],
};

const MONEY_FIELDS = new Set([
    "UnitCost", "UnitPrice", "UnitPriceA", "UnitPriceB", "UnitPriceC",
    "MSRPrice", "LastCost", "AvrCost",
    "UnitPrice2", "UnitPriceA2", "UnitPriceB2", "UnitPriceC2",
    "UnitPrice3", "UnitPriceA3", "UnitPriceB3", "UnitPriceC3",
    "UnitPrice4", "UnitPriceA4", "UnitPriceB4", "UnitPriceC4",
]);

const SECTION_LABELS = {
    general: "General",
    pricing: "Pricing",
    inventory: "Inventory",
    extended: "Extended",
};

const STATUS_ICONS = {
    success: "check_circle",
    partial: "warning",
    failed: "cancel",
};

const state = {
    entries: [],
    total: 0,
    page: 1,
    perPage: 25,
    totalPages: 0,
    timezone: "America/Chicago",
    stores: [],
    stats: { total: 0, success: 0, partial: 0, failed: 0 },
    filters: { search: "", type: "", status: "", store: "", dateFrom: "", dateTo: "" },
    selectedIds: new Set(),
    fieldConfigs: {},
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
    await Promise.all([loadTimezone(), loadStores(), loadFieldConfigs()]);
    await Promise.all([loadStats(), loadEntries()]);
    bindEvents();
}

async function loadTimezone() {
    try {
        const settings = await api.get("/api/settings/app-settings");
        state.timezone = settings.timezone || "America/Chicago";
    } catch { /* default */ }
}

async function loadStores() {
    try {
        state.stores = await api.get("/api/history/stores");
        const sel = document.getElementById("filter-store");
        state.stores.forEach(name => {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            sel.appendChild(opt);
        });
    } catch { /* empty */ }
}

async function loadFieldConfigs() {
    try {
        const configs = await api.get("/api/settings/field-configs");
        configs.forEach(c => { state.fieldConfigs[c.field_name] = c; });
    } catch { /* empty */ }
}

async function loadStats() {
    try {
        const params = buildFilterParams();
        delete params.status;
        const qs = new URLSearchParams(params).toString();
        state.stats = await api.get(`/api/history/stats?${qs}`);
        renderStats();
    } catch { /* empty */ }
}

async function loadEntries() {
    try {
        const params = buildFilterParams();
        params.page = state.page;
        params.per_page = state.perPage;
        const qs = new URLSearchParams(params).toString();
        const result = await api.get(`/api/history/entries?${qs}`);
        state.entries = result.items;
        state.total = result.total;
        state.page = result.page;
        state.totalPages = result.total_pages;
        state.selectedIds.clear();
        renderList();
        renderPagination();
        updateDeleteBtn();
    } catch (err) {
        showToast(`Failed to load history: ${err.message}`, "error");
    }
}

function buildFilterParams() {
    const p = {};
    if (state.filters.search) p.search = state.filters.search;
    if (state.filters.type) p.type = state.filters.type;
    if (state.filters.status) p.status = state.filters.status;
    if (state.filters.store) p.store = state.filters.store;
    if (state.filters.dateFrom) {
        p.date_from = toTimezoneISO(state.filters.dateFrom, "start");
    }
    if (state.filters.dateTo) {
        p.date_to = toTimezoneISO(state.filters.dateTo, "end");
    }
    return p;
}

function toTimezoneISO(dateStr, edge) {
    const d = new Date(dateStr + "T00:00:00");
    const opts = { timeZone: state.timezone, year: "numeric", month: "2-digit", day: "2-digit" };
    const formatted = new Intl.DateTimeFormat("en-CA", opts).format(d);
    if (edge === "end") return formatted + "T23:59:59";
    return formatted + "T00:00:00";
}

function formatDateTime(isoString) {
    if (!isoString) return "---";
    return new Intl.DateTimeFormat("en-US", {
        timeZone: state.timezone,
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
    }).format(new Date(isoString));
}

// ── Rendering ──

function renderStats() {
    document.getElementById("stat-total").textContent = state.stats.total;
    document.getElementById("stat-success").textContent = state.stats.success;
    document.getElementById("stat-partial").textContent = state.stats.partial;
    document.getElementById("stat-failed").textContent = state.stats.failed;

    document.querySelectorAll(".stat-badge").forEach(el => {
        const filter = el.dataset.filter;
        el.classList.toggle("active", filter === state.filters.status);
    });
}

function renderList() {
    const container = document.getElementById("history-rows");

    if (!state.entries.length) {
        container.innerHTML = `
            <div class="history-empty">
                <span class="material-icons-round">inventory_2</span>
                <p>No entries found. Products you create will appear here.</p>
            </div>`;
        return;
    }

    container.innerHTML = state.entries.map(e => {
        const key = `${e.entry_type}:${e.id}`;
        const checked = state.selectedIds.has(key) ? "checked" : "";
        const identifiers = e.entry_type === "mssql"
            ? `UPC: ${escapeHtml(e.product_upc || "---")} | SKU: ${escapeHtml(e.product_sku || "---")}`
            : "---";
        return `
            <div class="history-row" data-type="${e.entry_type}" data-id="${e.id}">
                <div class="row-checkbox" data-key="${key}">
                    <input type="checkbox" ${checked} data-key="${key}">
                </div>
                <span class="type-badge ${e.entry_type}">${e.entry_type === "mssql" ? "Back Office" : "Shopify"}</span>
                <span class="entry-name" title="${escapeHtml(e.product_name || "")}">${escapeHtml(e.product_name || "(untitled)")}</span>
                <span class="entry-identifiers">${identifiers}</span>
                <span class="entry-date">${formatDateTime(e.created_at)}</span>
                <span class="status-badge ${e.status}">
                    <span class="material-icons-round">${STATUS_ICONS[e.status]}</span>
                    ${e.status}
                </span>
                <span class="store-count">${e.store_count} store${e.store_count !== 1 ? "s" : ""}</span>
            </div>`;
    }).join("");
}

function renderPagination() {
    const container = document.getElementById("history-pagination");
    if (state.total === 0) { container.innerHTML = ""; return; }

    const start = (state.page - 1) * state.perPage + 1;
    const end = Math.min(state.page * state.perPage, state.total);

    let pageButtons = "";
    const maxVisible = 5;
    let startPage = Math.max(1, state.page - Math.floor(maxVisible / 2));
    let endPage = Math.min(state.totalPages, startPage + maxVisible - 1);
    if (endPage - startPage < maxVisible - 1) {
        startPage = Math.max(1, endPage - maxVisible + 1);
    }

    if (startPage > 1) {
        pageButtons += `<button class="page-btn" data-page="1">1</button>`;
        if (startPage > 2) pageButtons += `<span style="padding:0 4px;color:var(--md-on-surface-variant);">...</span>`;
    }
    for (let i = startPage; i <= endPage; i++) {
        pageButtons += `<button class="page-btn ${i === state.page ? "active" : ""}" data-page="${i}">${i}</button>`;
    }
    if (endPage < state.totalPages) {
        if (endPage < state.totalPages - 1) pageButtons += `<span style="padding:0 4px;color:var(--md-on-surface-variant);">...</span>`;
        pageButtons += `<button class="page-btn" data-page="${state.totalPages}">${state.totalPages}</button>`;
    }

    container.innerHTML = `
        <span class="pagination-info">Showing ${start}-${end} of ${state.total}</span>
        <div class="pagination-controls">
            <button class="page-btn" data-page="${state.page - 1}" ${state.page <= 1 ? "disabled" : ""}>
                <span class="material-icons-round">chevron_left</span>
            </button>
            ${pageButtons}
            <button class="page-btn" data-page="${state.page + 1}" ${state.page >= state.totalPages ? "disabled" : ""}>
                <span class="material-icons-round">chevron_right</span>
            </button>
        </div>
        <div class="per-page-select">
            <span>Per page:</span>
            <select id="per-page">
                ${[10, 25, 50, 100].map(n =>
                    `<option value="${n}" ${n === state.perPage ? "selected" : ""}>${n}</option>`
                ).join("")}
            </select>
        </div>`;
}

function updateDeleteBtn() {
    document.getElementById("btn-delete-selected").disabled = state.selectedIds.size === 0;
}

// ── Events ──

function bindEvents() {
    // Search
    const searchInput = document.getElementById("history-search");
    const debouncedSearch = debounce(() => {
        state.filters.search = searchInput.value.trim();
        state.page = 1;
        loadStats();
        loadEntries();
    }, 300);
    searchInput.addEventListener("input", debouncedSearch);

    // Filters
    document.getElementById("filter-type").addEventListener("change", e => {
        state.filters.type = e.target.value;
        state.page = 1;
        loadStats();
        loadEntries();
    });
    document.getElementById("filter-status").addEventListener("change", e => {
        state.filters.status = e.target.value;
        syncStatBadges();
        state.page = 1;
        loadStats();
        loadEntries();
    });
    document.getElementById("filter-store").addEventListener("change", e => {
        state.filters.store = e.target.value;
        state.page = 1;
        loadStats();
        loadEntries();
    });
    document.getElementById("filter-date-from").addEventListener("change", e => {
        state.filters.dateFrom = e.target.value;
        state.page = 1;
        loadStats();
        loadEntries();
    });
    document.getElementById("filter-date-to").addEventListener("change", e => {
        state.filters.dateTo = e.target.value;
        state.page = 1;
        loadStats();
        loadEntries();
    });

    // Stats badges click
    document.querySelectorAll(".stat-badge").forEach(el => {
        el.addEventListener("click", () => {
            const filter = el.dataset.filter;
            state.filters.status = state.filters.status === filter ? "" : filter;
            document.getElementById("filter-status").value = state.filters.status;
            syncStatBadges();
            state.page = 1;
            loadEntries();
        });
    });

    // Row clicks + checkbox
    document.getElementById("history-rows").addEventListener("click", e => {
        const checkbox = e.target.closest(".row-checkbox input[type='checkbox']");
        if (checkbox) {
            e.stopPropagation();
            const key = checkbox.dataset.key;
            if (checkbox.checked) state.selectedIds.add(key);
            else state.selectedIds.delete(key);
            updateDeleteBtn();
            updateSelectAll();
            return;
        }

        const cbContainer = e.target.closest(".row-checkbox");
        if (cbContainer) return;

        const row = e.target.closest(".history-row");
        if (row) openDrawer(row.dataset.type, parseInt(row.dataset.id));
    });

    // Select all
    document.getElementById("select-all").addEventListener("change", e => {
        const checked = e.target.checked;
        state.entries.forEach(en => {
            const key = `${en.entry_type}:${en.id}`;
            if (checked) state.selectedIds.add(key);
            else state.selectedIds.delete(key);
        });
        renderList();
        updateDeleteBtn();
    });

    // Pagination
    document.getElementById("history-pagination").addEventListener("click", e => {
        const btn = e.target.closest(".page-btn");
        if (btn && !btn.disabled) {
            state.page = parseInt(btn.dataset.page);
            loadEntries();
        }
    });
    document.getElementById("history-pagination").addEventListener("change", e => {
        if (e.target.id === "per-page") {
            state.perPage = parseInt(e.target.value);
            state.page = 1;
            loadEntries();
        }
    });

    // Drawer close
    document.getElementById("btn-close-drawer").addEventListener("click", closeDrawer);
    document.getElementById("drawer-overlay").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", e => {
        if (e.key === "Escape") closeDrawer();
    });

    // Delete actions
    document.getElementById("btn-delete-selected").addEventListener("click", deleteSelected);
    document.getElementById("btn-delete-failed").addEventListener("click", deleteAllFailed);

    // Export
    document.getElementById("btn-export").addEventListener("click", exportCSV);
}

function syncStatBadges() {
    document.querySelectorAll(".stat-badge").forEach(el => {
        el.classList.toggle("active", el.dataset.filter === state.filters.status);
    });
}

function updateSelectAll() {
    const all = state.entries.every(e => state.selectedIds.has(`${e.entry_type}:${e.id}`));
    document.getElementById("select-all").checked = all && state.entries.length > 0;
}

// ── Drawer ──

async function openDrawer(entryType, entryId) {
    const drawer = document.getElementById("detail-drawer");
    const overlay = document.getElementById("drawer-overlay");
    const body = document.getElementById("drawer-body");

    body.innerHTML = `<div style="text-align:center;padding:var(--md-spacing-2xl);color:var(--md-on-surface-variant);">Loading...</div>`;
    drawer.classList.add("active");
    overlay.classList.add("active");

    try {
        const entry = await api.get(`/api/history/entries/${entryType}/${entryId}`);
        renderDrawer(entry);
    } catch (err) {
        body.innerHTML = `<div style="text-align:center;padding:var(--md-spacing-2xl);color:var(--md-error);">Failed to load entry details.</div>`;
    }
}

function closeDrawer() {
    document.getElementById("detail-drawer").classList.remove("active");
    document.getElementById("drawer-overlay").classList.remove("active");
}

function renderDrawer(entry) {
    const body = document.getElementById("drawer-body");
    const isShopify = entry.entry_type === "shopify";

    let html = "";

    // Summary
    html += `
        <div class="drawer-summary">
            <div class="drawer-summary-info">
                <div class="entry-title">
                    <span class="type-badge ${entry.entry_type}" style="font-size:0.6rem;margin-right:8px;">
                        ${isShopify ? "Shopify" : "Back Office"}
                    </span>
                    ${escapeHtml(entry.product_name || "(untitled)")}
                </div>
                <div class="entry-meta">
                    ${formatDateTime(entry.created_at)}
                    &nbsp;&middot;&nbsp;
                    <span class="status-badge ${entry.status}" style="font-size:0.6rem;">
                        <span class="material-icons-round">${STATUS_ICONS[entry.status]}</span>
                        ${entry.status}
                    </span>
                </div>
            </div>
        </div>`;

    // Store results
    html += `<div class="drawer-section">
        <div class="drawer-section-title">Store Results</div>`;
    const allStores = entry.stores_targeted || [];
    const succeeded = new Set(entry.stores_succeeded || []);
    const failed = new Set(entry.stores_failed || []);
    const errors = entry.error_details || {};

    allStores.forEach(store => {
        const isOk = succeeded.has(store);
        const isFail = failed.has(store);
        const icon = isOk ? "check_circle" : isFail ? "cancel" : "help_outline";
        const cls = isOk ? "success" : isFail ? "failed" : "";
        html += `<div class="store-result-item">
            <span class="material-icons-round ${cls}">${icon}</span>
            <span>${escapeHtml(store)}</span>
        </div>`;
        if (isFail && errors[store]) {
            html += `<div class="store-result-error">${escapeHtml(String(errors[store]))}</div>`;
        }
    });
    html += `</div>`;

    // Shopify Product IDs
    if (isShopify && entry.shopify_product_ids) {
        html += `<div class="drawer-section">
            <div class="drawer-section-title">Shopify Product IDs</div>
            <dl class="detail-kv">`;
        for (const [store, pid] of Object.entries(entry.shopify_product_ids)) {
            html += `<dt>${escapeHtml(store)}</dt><dd>${escapeHtml(String(pid))}</dd>`;
        }
        html += `</dl></div>`;
    }

    // Form data
    if (entry.form_data) {
        if (isShopify) {
            html += renderShopifyFormData(entry.form_data);
        } else {
            html += renderMssqlFormData(entry.form_data);
        }
    }

    body.innerHTML = html;
    bindDrawerCollapseEvents();
}

function renderMssqlFormData(formData) {
    const common = formData.common_fields || formData;
    const perStore = formData.per_store_fields || {};
    const storeIds = formData.store_ids || [];
    let html = "";

    // Build store ID → name map from stores_targeted + store_ids order
    const storeIdToName = {};
    if (formData._store_names) {
        Object.assign(storeIdToName, formData._store_names);
    }

    // Collect all per-store field names (to show them in the per-store section, not in common)
    const perStoreFieldNames = new Set();
    for (const fields of Object.values(perStore)) {
        for (const [k, v] of Object.entries(fields)) {
            if (v !== undefined && v !== null && v !== "") perStoreFieldNames.add(k);
        }
    }

    // Render common fields by section
    for (const [sectionKey, fields] of Object.entries(FIELD_SECTIONS)) {
        const label = SECTION_LABELS[sectionKey];
        const collapsed = sectionKey === "extended";
        const pairs = [];

        fields.forEach(field => {
            const val = common[field];
            if (val !== undefined && val !== null && val !== "") {
                const cfg = state.fieldConfigs[field];
                const displayName = cfg ? cfg.display_name : field;
                const displayVal = MONEY_FIELDS.has(field) ? formatCurrency(val) : String(val);
                pairs.push([displayName, displayVal]);
            }
        });

        if (!pairs.length) continue;

        html += `<div class="drawer-section">
            <div class="drawer-section-title collapsible${collapsed ? " collapsed" : ""}" data-section="${sectionKey}">
                ${label}
                <span class="material-icons-round">expand_more</span>
            </div>
            <div class="drawer-section-content${collapsed ? " collapsed" : ""}">
                <dl class="detail-kv">`;
        pairs.forEach(([k, v]) => {
            html += `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`;
        });
        html += `</dl></div></div>`;
    }

    // Any common fields not captured in sections (catch-all)
    const allSectionFields = new Set(Object.values(FIELD_SECTIONS).flat());
    const extraPairs = [];
    for (const [k, v] of Object.entries(common)) {
        if (!allSectionFields.has(k) && v !== undefined && v !== null && v !== "" && k !== "mode") {
            const cfg = state.fieldConfigs[k];
            const displayName = cfg ? cfg.display_name : k;
            const displayVal = MONEY_FIELDS.has(k) ? formatCurrency(v) : String(v);
            extraPairs.push([displayName, displayVal]);
        }
    }
    if (extraPairs.length) {
        html += `<div class="drawer-section">
            <div class="drawer-section-title collapsible" data-section="other">
                Other Fields
                <span class="material-icons-round">expand_more</span>
            </div>
            <div class="drawer-section-content">
                <dl class="detail-kv">`;
        extraPairs.forEach(([k, v]) => {
            html += `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`;
        });
        html += `</dl></div></div>`;
    }

    // Per-store fields — show each store's fields with store name
    if (Object.keys(perStore).length) {
        html += `<div class="drawer-section">
            <div class="drawer-section-title collapsible" data-section="per-store">
                Per-Store Fields
                <span class="material-icons-round">expand_more</span>
            </div>
            <div class="drawer-section-content">`;

        for (const [storeId, fields] of Object.entries(perStore)) {
            const nonEmpty = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== "");
            if (!nonEmpty.length) continue;
            const storeName = storeIdToName[storeId] || `Store ${storeId}`;
            html += `<div style="margin-bottom:var(--md-spacing-md);padding-bottom:var(--md-spacing-sm);border-bottom:1px solid var(--md-outline-variant);">
                <strong style="font-size:0.8125rem;color:var(--md-primary);">${escapeHtml(storeName)}</strong>
                <dl class="detail-kv" style="margin-top:4px;">`;
            nonEmpty.forEach(([k, v]) => {
                const cfg = state.fieldConfigs[k];
                const displayName = cfg ? cfg.display_name : k;
                const displayVal = MONEY_FIELDS.has(k) ? formatCurrency(v) : String(v);
                html += `<dt>${escapeHtml(displayName)}</dt><dd>${escapeHtml(displayVal)}</dd>`;
            });
            html += `</dl></div>`;
        }
        html += `</div></div>`;
    }

    return html;
}

function renderShopifyFormData(formData) {
    const product = formData.product || formData;
    let html = "";

    // Main product fields
    const mainFields = [
        ["Title", product.title],
        ["Handle", product.handle],
        ["Vendor", product.vendor],
        ["Product Type", product.productType],
        ["Status", product.status],
        ["Tags", Array.isArray(product.tags) ? product.tags.join(", ") : product.tags],
    ].filter(([, v]) => v);

    if (mainFields.length) {
        html += `<div class="drawer-section">
            <div class="drawer-section-title collapsible" data-section="shopify-general">
                Product Info
                <span class="material-icons-round">expand_more</span>
            </div>
            <div class="drawer-section-content">
                <dl class="detail-kv">`;
        mainFields.forEach(([k, v]) => {
            html += `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`;
        });
        html += `</dl></div></div>`;
    }

    // Description
    if (product.descriptionHtml) {
        html += `<div class="drawer-section">
            <div class="drawer-section-title collapsible collapsed" data-section="shopify-desc">
                Description
                <span class="material-icons-round">expand_more</span>
            </div>
            <div class="drawer-section-content collapsed">
                <div style="font-size:0.8125rem;line-height:1.5;padding:var(--md-spacing-xs) 0;">
                    ${product.descriptionHtml}
                </div>
            </div>
        </div>`;
    }

    // SEO
    if (product.seo) {
        const seoFields = [
            ["SEO Title", product.seo.title],
            ["Meta Description", product.seo.description],
        ].filter(([, v]) => v);
        if (seoFields.length) {
            html += `<div class="drawer-section">
                <div class="drawer-section-title collapsible collapsed" data-section="shopify-seo">
                    SEO
                    <span class="material-icons-round">expand_more</span>
                </div>
                <div class="drawer-section-content collapsed">
                    <dl class="detail-kv">`;
            seoFields.forEach(([k, v]) => {
                html += `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`;
            });
            html += `</dl></div></div>`;
        }
    }

    // Variants
    if (product.variants && product.variants.length) {
        html += `<div class="drawer-section">
            <div class="drawer-section-title collapsible collapsed" data-section="shopify-variants">
                Variants (${product.variants.length})
                <span class="material-icons-round">expand_more</span>
            </div>
            <div class="drawer-section-content collapsed">`;
        product.variants.forEach((v, i) => {
            html += `<div style="margin-bottom:var(--md-spacing-sm);padding:var(--md-spacing-xs) 0;${i > 0 ? "border-top:1px solid var(--md-outline-variant);" : ""}">
                <dl class="detail-kv">`;
            if (v.title) html += `<dt>Title</dt><dd>${escapeHtml(v.title)}</dd>`;
            if (v.sku) html += `<dt>SKU</dt><dd>${escapeHtml(v.sku)}</dd>`;
            if (v.price) html += `<dt>Price</dt><dd>${formatCurrency(v.price)}</dd>`;
            if (v.barcode) html += `<dt>Barcode</dt><dd>${escapeHtml(v.barcode)}</dd>`;
            html += `</dl></div>`;
        });
        html += `</div></div>`;
    }

    return html;
}

function bindDrawerCollapseEvents() {
    document.querySelectorAll(".drawer-section-title.collapsible").forEach(title => {
        title.addEventListener("click", () => {
            title.classList.toggle("collapsed");
            const content = title.nextElementSibling;
            if (content) content.classList.toggle("collapsed");
        });
    });
}

// ── Delete actions ──

async function deleteSelected() {
    const count = state.selectedIds.size;
    if (!count) return;

    const confirmed = await showConfirm(
        "Delete Selected",
        `Are you sure you want to delete ${count} selected entry${count > 1 ? "ies" : "y"}? This cannot be undone.`
    );
    if (!confirmed) return;

    const entries = [...state.selectedIds].map(key => {
        const [type, id] = key.split(":");
        return { type, id: parseInt(id) };
    });

    try {
        const result = await api.delete("/api/history/entries", { entries });
        showToast(`${result.count} entries deleted`, "success");
        state.selectedIds.clear();
        await Promise.all([loadStats(), loadEntries()]);
    } catch (err) {
        showToast(`Delete failed: ${err.message}`, "error");
    }
}

async function deleteAllFailed() {
    if (state.stats.failed === 0) {
        showToast("No failed entries to delete", "info");
        return;
    }

    const confirmed = await showConfirm(
        "Clear Failed Entries",
        `Are you sure you want to delete all ${state.stats.failed} failed entries? This cannot be undone.`
    );
    if (!confirmed) return;

    try {
        const result = await api.delete("/api/history/entries/failed");
        showToast(`${result.count} failed entries deleted`, "success");
        await Promise.all([loadStats(), loadEntries()]);
    } catch (err) {
        showToast(`Delete failed: ${err.message}`, "error");
    }
}

function showConfirm(title, message) {
    return new Promise(resolve => {
        const container = document.getElementById("confirm-container");
        container.innerHTML = `
            <div class="confirm-overlay" id="confirm-overlay">
                <div class="confirm-modal">
                    <h3>${escapeHtml(title)}</h3>
                    <p>${escapeHtml(message)}</p>
                    <div class="confirm-modal-actions">
                        <button class="btn btn-secondary" id="confirm-cancel">Cancel</button>
                        <button class="btn btn-danger" id="confirm-ok">Delete</button>
                    </div>
                </div>
            </div>`;
        document.getElementById("confirm-cancel").addEventListener("click", () => {
            container.innerHTML = "";
            resolve(false);
        });
        document.getElementById("confirm-ok").addEventListener("click", () => {
            container.innerHTML = "";
            resolve(true);
        });
        document.getElementById("confirm-overlay").addEventListener("click", e => {
            if (e.target === e.currentTarget) {
                container.innerHTML = "";
                resolve(false);
            }
        });
    });
}

// ── Export ──

function exportCSV() {
    const params = buildFilterParams();
    const qs = new URLSearchParams(params).toString();
    window.location.href = `/api/history/export?${qs}`;
}
