import { api } from "./api-client.js";
import { showToast, debounce, escapeHtml } from "./utils.js";

// ── State ──────────────────────────────────────────────
const state = {
    stores: [],
    selectedStoreIds: [],
    collections: {},
    locations: {},
    publications: {},
    watermarkInfo: {},
    vendors: [],
    productTypes: [],
    existingTags: [],
    options: [],
    variants: [],
    uploadedImages: [],
    imageMode: "shared",
    perStoreImages: {},
    descriptionHtml: "",
    metafields: [],
    tags: [],
    selectedCollections: [],
    quill: null,
    initialized: false,
    templateMode: false,
    templateProduct: null,
    perStoreProductData: {},
    activeStoreId: null,
};

// ── Init ───────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    const shopifyTab = document.querySelector('.entry-mode-tab[data-mode="shopify"]');
    if (shopifyTab) {
        shopifyTab.addEventListener("click", initShopifyOnce);
    }
});

async function initShopifyOnce() {
    if (state.initialized) return;
    state.initialized = true;
    try {
        state.stores = await api.get("/api/shopify/stores");
        state.selectedStoreIds = state.stores.map(s => s.id);
        renderStoreSelector();
        if (state.selectedStoreIds.length) onStoreSelectionChange();
    } catch {
        state.stores = [];
        renderStoreSelector();
    }
    initQuillEditor();
    bindMediaUpload();
    bindImageModeToggle();
    bindVariantEvents();
    bindMetafieldEvents();
    bindTagInput();
    bindCollectionsSearch();
    bindSeoSync();
    bindActionButtons();
    initLookup();
}

// ── Store Selector ─────────────────────────────────────
function renderStoreSelector() {
    const container = document.getElementById("shopify-store-selector");
    if (!state.stores.length) {
        container.innerHTML = `
            <span class="store-selector-label">
                <span class="material-icons-round" style="font-size:18px;vertical-align:middle;margin-right:4px;">shopping_bag</span>
                Shopify Stores
            </span>
            <span class="text-muted">No Shopify stores configured. Add stores in Settings.</span>`;
        return;
    }
    const allSelected = state.selectedStoreIds.length === state.stores.length && state.stores.length > 0;
    const chips = state.stores.map(s => {
        const sel = state.selectedStoreIds.includes(s.id);
        const active = s.id === state.activeStoreId;
        const cls = active ? "selected active-tab" : sel ? "selected" : "";
        return `<button class="store-chip ${cls}" data-id="${s.id}">${escapeHtml(s.name)}</button>`;
    }).join("");

    container.innerHTML = `
        <span class="store-selector-label">
            <span class="material-icons-round" style="font-size:18px;vertical-align:middle;margin-right:4px;">shopping_bag</span>
            Shopify Stores
        </span>
        <button class="store-chip store-chip-all ${allSelected ? "selected" : ""}">All</button>
        ${chips}`;

    container.querySelectorAll(".store-chip").forEach(chip => {
        chip.addEventListener("click", () => {
            if (chip.classList.contains("store-chip-all")) {
                state.selectedStoreIds = allSelected ? [] : state.stores.map(s => s.id);
                renderStoreSelector();
                onStoreSelectionChange();
            } else {
                const id = parseInt(chip.dataset.id);
                const wasSelected = state.selectedStoreIds.includes(id);
                if (wasSelected) {
                    // If clicking the active store, deselect it
                    if (id === state.activeStoreId) {
                        state.selectedStoreIds = state.selectedStoreIds.filter(x => x !== id);
                        delete state.perStoreProductData[id];
                        state.activeStoreId = state.selectedStoreIds[0] || null;
                        if (state.activeStoreId && state.perStoreProductData[state.activeStoreId]) {
                            restoreFormState(state.perStoreProductData[state.activeStoreId]);
                        }
                        renderStoreSelector();
                        onStoreSelectionChange();
                    } else {
                        // Click a selected (but not active) store → switch to it
                        switchStore(id);
                    }
                } else {
                    // Select and switch to it
                    state.selectedStoreIds.push(id);
                    // Initialize with current form state
                    state.perStoreProductData[id] = captureFormState();
                    switchStore(id);
                    onStoreSelectionChange();
                }
            }
        });
    });
}

async function onStoreSelectionChange() {
    const count = state.selectedStoreIds.length;
    document.getElementById("sp-btn-save").disabled = count === 0;

    // Set active store if none or if current active was deselected
    if (!state.activeStoreId || !state.selectedStoreIds.includes(state.activeStoreId)) {
        state.activeStoreId = state.selectedStoreIds[0] || null;
    }

    // Initialize per-store data for new stores
    for (const sid of state.selectedStoreIds) {
        if (!state.perStoreProductData[sid]) {
            state.perStoreProductData[sid] = captureFormState();
            console.log(`[Shopify] Initialized store ${sid} with:`, state.perStoreProductData[sid].title);
        }
    }
    // Remove data for deselected stores
    for (const sid of Object.keys(state.perStoreProductData)) {
        if (!state.selectedStoreIds.includes(parseInt(sid))) {
            delete state.perStoreProductData[sid];
        }
    }

    // Re-render store selector to show active tab
    renderStoreSelector();
    updateStoreLabel();

    for (const sid of state.selectedStoreIds) {
        if (state._loaded?.[sid]) continue;
        const store = state.stores.find(s => s.id === sid);
        const name = store?.name || sid;

        try {
            const resp = await fetch(`/api/shopify/stores/${sid}/store-data`);
            const storeData = await resp.json();

            if (storeData.error) throw new Error(storeData.error);

            state.collections[sid] = storeData.collections || [];
            state.locations[sid] = storeData.locations || [];
            state.publications[sid] = storeData.publications || [];

            const wmInfo = await fetch(`/api/shopify/stores/${sid}/watermark-info`)
                .then(r => r.json()).catch(() => ({}));
            state.watermarkInfo[sid] = wmInfo || {};

            for (const v of (storeData.vendors || [])) {
                if (!state.vendors.includes(v)) state.vendors.push(v);
            }
            for (const t of (storeData.productTypes || [])) {
                if (!state.productTypes.includes(t)) state.productTypes.push(t);
            }
            for (const t of (storeData.tags || [])) {
                if (!state.existingTags.includes(t)) state.existingTags.push(t);
            }

            if (storeData.errors && Object.keys(storeData.errors).length) {
                const failedFields = Object.keys(storeData.errors).join(", ");
                showToast(`${name}: Failed to load ${failedFields}. Check API token scopes.`, "warning", 8000);
            }

            if (!state._loaded) state._loaded = {};
            state._loaded[sid] = true;
        } catch (err) {
            showToast(`Failed to load ${name}: ${err.message}`, "error");
        }
    }

    renderInventoryLocations();
    renderPublications();
    renderPerStoreMediaUI();
    renderWatermarkPreviews();
    rebindAutocompletes();
}

function switchStore(newStoreId) {
    if (state.activeStoreId === newStoreId) return;

    // Save current form to current store's data
    if (state.activeStoreId) {
        const saved = captureFormState();
        state.perStoreProductData[state.activeStoreId] = saved;
        console.log(`[Shopify] Saved store ${state.activeStoreId}:`, saved.title, saved.price);
    }

    state.activeStoreId = newStoreId;

    // Restore new store's form data
    const snap = state.perStoreProductData[newStoreId];
    if (snap) {
        console.log(`[Shopify] Restoring store ${newStoreId}:`, snap.title, snap.price);
        restoreFormState(snap);
    } else {
        console.log(`[Shopify] No data for store ${newStoreId}`);
    }

    renderStoreSelector();
    updateStoreLabel();
}

function updateStoreLabel() {
    const count = state.selectedStoreIds.length;
    const activeStore = state.stores.find(s => s.id === state.activeStoreId);
    const activeLabel = activeStore ? ` — editing: ${activeStore.name}` : "";
    document.getElementById("sp-store-count-label").textContent =
        count === 0 ? "No stores selected" : `${count} store${count > 1 ? "s" : ""} selected${activeLabel}`;
}

function captureFormState() {
    return {
        title: document.getElementById("sp-title").value,
        descriptionHtml: state.descriptionHtml || "",
        vendor: document.getElementById("sp-vendor").value,
        productType: document.getElementById("sp-product-type").value,
        status: document.getElementById("sp-status").value,
        price: document.getElementById("sp-price").value,
        compareAtPrice: document.getElementById("sp-compare-at-price").value,
        cost: document.getElementById("sp-cost").value,
        sku: document.getElementById("sp-sku").value,
        barcode: document.getElementById("sp-barcode").value,
        chargeTax: document.getElementById("sp-charge-tax").checked,
        trackInventory: document.getElementById("sp-track-inventory").checked,
        continueSelling: document.getElementById("sp-continue-selling").checked,
        physicalProduct: document.getElementById("sp-physical-product").checked,
        weight: document.getElementById("sp-weight").value,
        weightUnit: document.getElementById("sp-weight-unit").value,
        countryOrigin: document.getElementById("sp-country-origin").value,
        hsCode: document.getElementById("sp-hs-code").value,
        seoTitle: document.getElementById("sp-seo-title").value,
        seoDescription: document.getElementById("sp-seo-description").value,
        seoHandle: document.getElementById("sp-seo-handle").value,
        seoHandleEdited: document.getElementById("sp-seo-handle")._userEdited || false,
        seoTitleEdited: document.getElementById("sp-seo-title")._userEdited || false,
        template: document.getElementById("sp-template").value,
        tags: [...state.tags],
        metafields: state.metafields.map(mf => ({ ...mf })),
        options: state.options.map(o => ({ ...o, values: [...o.values] })),
        variants: state.variants.map(v => ({ ...v })),
        selectedCollections: state.selectedCollections.map(c => ({ ...c })),
    };
}

function restoreFormState(snap) {
    console.log("[Shopify] restoreFormState called with:", JSON.stringify({title: snap.title, price: snap.price, vendor: snap.vendor}));
    document.getElementById("sp-title").value = snap.title || "";
    if (state.quill) {
        state.quill.root.innerHTML = snap.descriptionHtml || "";
        state.descriptionHtml = snap.descriptionHtml || "";
    }
    document.getElementById("sp-vendor").value = snap.vendor || "";
    document.getElementById("sp-product-type").value = snap.productType || "";
    document.getElementById("sp-status").value = snap.status || "DRAFT";
    document.getElementById("sp-price").value = snap.price || "";
    document.getElementById("sp-compare-at-price").value = snap.compareAtPrice || "";
    document.getElementById("sp-cost").value = snap.cost || "";
    document.getElementById("sp-sku").value = snap.sku || "";
    document.getElementById("sp-barcode").value = snap.barcode || "";
    document.getElementById("sp-charge-tax").checked = snap.chargeTax !== false;
    document.getElementById("sp-track-inventory").checked = snap.trackInventory !== false;
    document.getElementById("sp-continue-selling").checked = !!snap.continueSelling;
    document.getElementById("sp-physical-product").checked = snap.physicalProduct !== false;
    document.getElementById("sp-weight").value = snap.weight || "";
    document.getElementById("sp-weight-unit").value = snap.weightUnit || "lb";
    document.getElementById("sp-country-origin").value = snap.countryOrigin || "";
    document.getElementById("sp-hs-code").value = snap.hsCode || "";
    document.getElementById("sp-seo-title").value = snap.seoTitle || "";
    document.getElementById("sp-seo-title")._userEdited = !!snap.seoTitleEdited;
    document.getElementById("sp-seo-description").value = snap.seoDescription || "";
    document.getElementById("sp-seo-handle").value = snap.seoHandle || "";
    document.getElementById("sp-seo-handle")._userEdited = !!snap.seoHandleEdited;
    document.getElementById("sp-template").value = snap.template || "";

    state.tags = Array.isArray(snap.tags) ? [...snap.tags] : [];
    state.metafields = Array.isArray(snap.metafields) ? snap.metafields.map(mf => ({ ...mf })) : [];
    state.options = Array.isArray(snap.options) ? snap.options.map(o => ({ ...o, values: [...(o.values || [])] })) : [];
    state.variants = Array.isArray(snap.variants) ? snap.variants.map(v => ({ ...v })) : [];
    state.selectedCollections = Array.isArray(snap.selectedCollections) ? snap.selectedCollections.map(c => ({ ...c })) : [];

    renderTags();
    renderMetafields();
    renderVariantOptions();
    renderCollectionChips();
    updateSeoPreview();

    document.getElementById("sp-error-title").textContent = "";
}

function buildProductDataFromSnapshot(snap, storeId) {
    const product = {
        title: snap.title || "",
        descriptionHtml: snap.descriptionHtml || "",
        vendor: snap.vendor || "",
        productType: snap.productType || "",
        tags: snap.tags || [],
        status: snap.status || "DRAFT",
        handle: snap.seoHandle || undefined,
        templateSuffix: snap.template || undefined,
    };

    const seoTitle = snap.seoTitle || "";
    const seoDesc = snap.seoDescription || "";
    if (seoTitle || seoDesc) {
        product.seo = { title: seoTitle || undefined, description: seoDesc || undefined };
    }

    const mfs = (snap.metafields || []).filter(mf => mf.key && mf.value);
    if (mfs.length) {
        product.metafields = mfs.map(mf => ({
            namespace: mf.namespace || "custom",
            key: mf.key,
            type: mf.type,
            value: mf.value,
        }));
    }

    if (snap.selectedCollections && snap.selectedCollections.length) {
        product.collectionsToJoin = snap.selectedCollections.map(c => c.id);
    }

    const trackInventory = snap.trackInventory !== false;
    const taxable = snap.chargeTax !== false;
    const inventoryPolicy = snap.continueSelling ? "CONTINUE" : "DENY";

    if (snap.options && snap.options.length && snap.variants && snap.variants.length) {
        product.productOptions = snap.options
            .filter(o => o.name && o.values.length)
            .map(o => ({ name: o.name, values: o.values.map(v => ({ name: v })) }));
        product.variants = snap.variants.map(v => ({
            optionValues: v.optionValues,
            price: parseFloat(v.price) || 0,
            compareAtPrice: v.compareAtPrice ? parseFloat(v.compareAtPrice) : undefined,
            inventoryItem: { tracked: trackInventory, cost: v.cost ? parseFloat(v.cost) : undefined },
            inventoryPolicy,
            sku: v.sku || undefined,
            barcode: v.barcode || undefined,
            taxable,
        }));
    } else {
        product.productOptions = [{ name: "Title", values: [{ name: "Default Title" }] }];
        product.variants = [{
            price: parseFloat(snap.price) || 0,
            compareAtPrice: snap.compareAtPrice ? parseFloat(snap.compareAtPrice) : undefined,
            inventoryItem: { tracked: trackInventory, cost: snap.cost ? parseFloat(snap.cost) : undefined },
            inventoryPolicy,
            sku: snap.sku || undefined,
            barcode: snap.barcode || undefined,
            taxable,
            optionValues: [{ optionName: "Title", name: "Default Title" }],
        }];
    }

    const result = { product };

    // Inventory for this store
    const sid = String(storeId);
    const locationQuantities = {};
    document.querySelectorAll(`#sp-inventory-locations input[data-store="${sid}"]`).forEach(input => {
        const qty = parseInt(input.value) || 0;
        if (qty > 0) locationQuantities[input.dataset.location] = qty;
    });
    if (Object.keys(locationQuantities).length) {
        result.inventory = { location_quantities: locationQuantities };
    }

    // Publications for this store
    const pubIds = [];
    document.querySelectorAll(`#sp-publications input[data-store-id="${sid}"]`).forEach(input => {
        if (input.checked) pubIds.push(input.dataset.pubId);
    });
    if (pubIds.length) result.publication_ids = pubIds;

    // Shipping
    if (snap.physicalProduct) {
        const weight = parseFloat(snap.weight);
        if (weight > 0) {
            result.shipping = { weight, weightUnit: (snap.weightUnit || "lb").toUpperCase() };
        }
        if (snap.countryOrigin) {
            result.shipping = result.shipping || {};
            result.shipping.countryOfOrigin = snap.countryOrigin;
        }
        if (snap.hsCode) {
            result.shipping = result.shipping || {};
            result.shipping.hsCode = snap.hsCode;
        }
    }

    return result;
}

function rebindAutocompletes() {
    console.log(`[Shopify] Rebinding autocompletes. vendors=${state.vendors.length}, types=${state.productTypes.length}, tags=${state.existingTags.length}`);
    bindAutocomplete("sp-product-type", "sp-product-type-dropdown", () => state.productTypes, null);
    bindAutocomplete("sp-vendor", "sp-vendor-dropdown", () => state.vendors, null);
}

// ── Quill Editor ───────────────────────────────────────
function initQuillEditor() {
    if (typeof Quill === "undefined") return;
    state.quill = new Quill("#sp-description-editor", {
        theme: "snow",
        placeholder: "Product description...",
        modules: {
            toolbar: [
                [{ header: [1, 2, 3, false] }],
                ["bold", "italic", "underline"],
                [{ list: "ordered" }, { list: "bullet" }],
                [{ align: [] }],
                ["link", "image"],
                ["clean"],
            ],
        },
    });
    state.quill.on("text-change", () => {
        state.descriptionHtml = state.quill.root.innerHTML;
    });
}

// ── Media Upload (Shared) ──────────────────────────────
function bindMediaUpload() {
    const zone = document.getElementById("sp-upload-zone");
    const fileInput = document.getElementById("sp-file-input");

    zone.addEventListener("click", (e) => {
        if (e.target === fileInput) return;
        fileInput.click();
    });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("drag-over");
        handleFiles(e.dataTransfer.files, "shared");
    });
    fileInput.addEventListener("change", () => {
        handleFiles(fileInput.files, "shared");
        fileInput.value = "";
    });
}

function handleFiles(files, target) {
    for (const file of files) {
        if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) continue;
        const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        const reader = new FileReader();
        reader.onload = (e) => {
            const entry = { id, file, preview: e.target.result, name: file.name };
            if (target === "shared") {
                state.uploadedImages.push(entry);
                renderThumbnails();
                renderWatermarkPreviews();
            } else {
                const storeId = parseInt(target);
                if (!state.perStoreImages[storeId]) state.perStoreImages[storeId] = [];
                state.perStoreImages[storeId].push(entry);
                renderPerStoreMediaUI();
            }
        };
        reader.readAsDataURL(file);
    }
}

function renderThumbnails() {
    const container = document.getElementById("sp-thumbnails");
    container.innerHTML = state.uploadedImages.map((img, i) => `
        <div class="media-thumb ${i === 0 ? "primary" : ""}" data-id="${img.id}">
            <img src="${img.preview}" alt="${escapeHtml(img.name)}">
            <button class="thumb-remove material-icons-round" data-id="${img.id}">close</button>
        </div>
    `).join("");

    container.querySelectorAll(".thumb-remove").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            state.uploadedImages = state.uploadedImages.filter(img => img.id !== btn.dataset.id);
            renderThumbnails();
            renderWatermarkPreviews();
        });
    });
}

function bindImageModeToggle() {
    document.querySelectorAll(".image-mode-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".image-mode-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            state.imageMode = btn.dataset.mode;
            document.getElementById("sp-media-shared").classList.toggle("hidden", state.imageMode !== "shared");
            document.getElementById("sp-media-perstore").classList.toggle("hidden", state.imageMode !== "per_store");
            if (state.imageMode === "per_store") renderPerStoreMediaUI();
        });
    });
}

// ── Per-Store Media ────────────────────────────────────
function renderPerStoreMediaUI() {
    if (state.imageMode !== "per_store") return;
    const tabsContainer = document.getElementById("sp-media-store-tabs");
    const areasContainer = document.getElementById("sp-perstore-upload-areas");

    if (!state.selectedStoreIds.length) {
        tabsContainer.innerHTML = '<span class="text-sm text-muted">Select stores above</span>';
        areasContainer.innerHTML = "";
        return;
    }

    const activeStoreId = state.selectedStoreIds[0];
    tabsContainer.innerHTML = state.selectedStoreIds.map(sid => {
        const store = state.stores.find(s => s.id === sid);
        const count = (state.perStoreImages[sid] || []).length;
        return `<button class="store-tab ${sid === activeStoreId ? "active" : ""}" data-store-id="${sid}">
            ${escapeHtml(store?.name || "")} ${count ? `(${count})` : ""}
        </button>`;
    }).join("");

    tabsContainer.querySelectorAll(".store-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            tabsContainer.querySelectorAll(".store-tab").forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            renderPerStoreUploadArea(parseInt(tab.dataset.storeId));
        });
    });

    renderPerStoreUploadArea(activeStoreId);
}

function renderPerStoreUploadArea(storeId) {
    const container = document.getElementById("sp-perstore-upload-areas");
    const images = state.perStoreImages[storeId] || [];

    container.innerHTML = `
        <div class="media-upload-zone" id="sp-perstore-zone-${storeId}" style="margin-top:var(--md-spacing-sm);">
            <span class="material-icons-round" style="font-size:28px; margin-bottom:4px; display:block;">cloud_upload</span>
            <span class="upload-label">Upload images for this store</span>
            <input type="file" id="sp-perstore-file-${storeId}" multiple accept="image/*" style="display:none;">
        </div>
        <div class="media-thumbnails" style="margin-top:var(--md-spacing-sm);">
            ${images.map((img, i) => `
                <div class="media-thumb ${i === 0 ? "primary" : ""}" data-id="${img.id}">
                    <img src="${img.preview}" alt="${escapeHtml(img.name)}">
                    <button class="thumb-remove material-icons-round" data-id="${img.id}" data-store="${storeId}">close</button>
                </div>
            `).join("")}
        </div>
    `;

    const zone = document.getElementById(`sp-perstore-zone-${storeId}`);
    const fileInput = document.getElementById(`sp-perstore-file-${storeId}`);

    zone.addEventListener("click", (e) => {
        if (e.target === fileInput) return;
        fileInput.click();
    });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("drag-over");
        handleFiles(e.dataTransfer.files, String(storeId));
    });
    fileInput.addEventListener("change", () => {
        handleFiles(fileInput.files, String(storeId));
        fileInput.value = "";
    });

    container.querySelectorAll(".thumb-remove").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const sid = parseInt(btn.dataset.store);
            state.perStoreImages[sid] = (state.perStoreImages[sid] || []).filter(img => img.id !== btn.dataset.id);
            renderPerStoreMediaUI();
        });
    });
}

// ── Watermark Preview (Canvas) ─────────────────────────
function renderWatermarkPreviews() {
    const container = document.getElementById("sp-watermark-previews");
    if (!state.uploadedImages.length || !state.selectedStoreIds.length) {
        container.innerHTML = "";
        return;
    }

    const firstImage = state.uploadedImages[0];
    const hasAnyWatermark = state.selectedStoreIds.some(sid => state.watermarkInfo[sid]?.has_watermark);
    if (!hasAnyWatermark) {
        container.innerHTML = "";
        return;
    }

    container.innerHTML = state.selectedStoreIds.map(sid => {
        const store = state.stores.find(s => s.id === sid);
        const wm = state.watermarkInfo[sid];
        return `<div class="watermark-card" data-store="${sid}">
            <canvas id="wm-canvas-${sid}" width="120" height="120"></canvas>
            <div class="store-label">${escapeHtml(store?.name || "")}</div>
            <div class="text-sm" style="color:var(--md-on-surface-variant);">${wm?.has_watermark ? "Watermark applied" : "No watermark"}</div>
        </div>`;
    }).join("");

    for (const sid of state.selectedStoreIds) {
        const canvas = document.getElementById(`wm-canvas-${sid}`);
        if (!canvas) continue;
        const ctx = canvas.getContext("2d");
        const wm = state.watermarkInfo[sid];

        const img = new Image();
        img.onload = () => {
            const scale = Math.min(120 / img.width, 120 / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            canvas.width = 120;
            canvas.height = 120;
            ctx.fillStyle = "#f8f9fa";
            ctx.fillRect(0, 0, 120, 120);
            ctx.drawImage(img, (120 - w) / 2, (120 - h) / 2, w, h);

            if (wm?.has_watermark && wm.watermark_base64) {
                const wmImg = new Image();
                wmImg.onload = () => {
                    const wmW = Math.max(w * 0.25, 20);
                    const wmRatio = wmW / wmImg.width;
                    const wmH = wmImg.height * wmRatio;
                    const opacity = wm.opacity || 0.30;
                    const pos = wm.position || "bottom-right";

                    let x, y;
                    const ox = (120 - w) / 2;
                    const oy = (120 - h) / 2;
                    if (pos === "bottom-right") { x = ox + w - wmW - 4; y = oy + h - wmH - 4; }
                    else if (pos === "bottom-left") { x = ox + 4; y = oy + h - wmH - 4; }
                    else if (pos === "top-right") { x = ox + w - wmW - 4; y = oy + 4; }
                    else if (pos === "top-left") { x = ox + 4; y = oy + 4; }
                    else { x = (120 - wmW) / 2; y = (120 - wmH) / 2; }

                    ctx.globalAlpha = opacity;
                    ctx.drawImage(wmImg, x, y, wmW, wmH);
                    ctx.globalAlpha = 1;
                };
                wmImg.src = `data:image/png;base64,${wm.watermark_base64}`;
            }
        };
        img.src = firstImage.preview;
    }
}

// ── Generic Autocomplete ───────────────────────────────
const _acBound = {};

function bindAutocomplete(inputId, dropdownId, getItems, onSelect) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);
    if (!input || !dropdown) return;

    // Remove old listeners if rebinding
    if (_acBound[inputId]) {
        const old = _acBound[inputId];
        input.removeEventListener("input", old.onInput);
        input.removeEventListener("keydown", old.onKeydown);
        input.removeEventListener("blur", old.onBlur);
        input.removeEventListener("focus", old.onFocus);
    }

    let activeIndex = -1;

    function render(query) {
        const items = getItems();
        const q = query.toLowerCase();
        const filtered = q
            ? items.filter(item => item.toLowerCase().includes(q)).slice(0, 10)
            : [];

        if (!filtered.length) {
            dropdown.classList.add("hidden");
            if (q && items.length === 0) {
                dropdown.innerHTML = '<div class="autocomplete-item" style="color:var(--md-on-surface-variant);cursor:default;"><span class="ac-subcat">No data loaded — select a store first</span></div>';
                dropdown.classList.remove("hidden");
            }
            activeIndex = -1;
            return;
        }

        dropdown.innerHTML = filtered.map((item, i) => `
            <div class="autocomplete-item ${i === activeIndex ? "active" : ""}" data-index="${i}" data-value="${escapeHtml(item)}">
                <span class="ac-subcat">${highlightMatch(item, query)}</span>
            </div>
        `).join("");
        dropdown.classList.remove("hidden");

        dropdown.querySelectorAll(".autocomplete-item[data-value]").forEach(el => {
            el.addEventListener("mousedown", (e) => {
                e.preventDefault();
                input.value = el.dataset.value;
                dropdown.classList.add("hidden");
                if (onSelect) onSelect(el.dataset.value);
            });
        });
    }

    const onInput = debounce(() => {
        activeIndex = -1;
        render(input.value.trim());
    }, 150);

    const onKeydown = (e) => {
        const items = dropdown.querySelectorAll(".autocomplete-item[data-value]");
        if (!items.length) return;

        if (e.key === "ArrowDown") {
            e.preventDefault();
            activeIndex = Math.min(activeIndex + 1, items.length - 1);
            updateActive(items, activeIndex);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            activeIndex = Math.max(activeIndex - 1, 0);
            updateActive(items, activeIndex);
        } else if (e.key === "Enter" && activeIndex >= 0) {
            e.preventDefault();
            input.value = items[activeIndex].dataset.value;
            dropdown.classList.add("hidden");
            activeIndex = -1;
            if (onSelect) onSelect(input.value);
        } else if (e.key === "Escape") {
            dropdown.classList.add("hidden");
            activeIndex = -1;
        }
    };

    const onBlur = () => {
        setTimeout(() => { dropdown.classList.add("hidden"); activeIndex = -1; }, 200);
    };

    const onFocus = () => {
        if (input.value.trim()) render(input.value.trim());
    };

    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeydown);
    input.addEventListener("blur", onBlur);
    input.addEventListener("focus", onFocus);

    _acBound[inputId] = { onInput, onKeydown, onBlur, onFocus };
}

function highlightMatch(text, query) {
    if (!query) return escapeHtml(text);
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    const before = text.slice(0, idx);
    const match = text.slice(idx, idx + query.length);
    const after = text.slice(idx + query.length);
    return `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`;
}

function updateActive(items, index) {
    items.forEach((el, i) => el.classList.toggle("active", i === index));
    if (items[index]) items[index].scrollIntoView({ block: "nearest" });
}

// ── Collections Search/Select ──────────────────────────
function bindCollectionsSearch() {
    const input = document.getElementById("sp-collections-search");
    const dropdown = document.getElementById("sp-collections-dropdown");
    if (!input || !dropdown) return;

    let activeIndex = -1;

    function getAllCollections() {
        const all = [];
        for (const sid of state.selectedStoreIds) {
            for (const col of (state.collections[sid] || [])) {
                if (!all.find(c => c.id === col.id)) all.push(col);
            }
        }
        return all;
    }

    function render(query) {
        const q = query.toLowerCase();
        const filtered = getAllCollections()
            .filter(c => c.title.toLowerCase().includes(q))
            .filter(c => !state.selectedCollections.find(sc => sc.id === c.id))
            .slice(0, 10);

        if (!filtered.length) {
            dropdown.classList.add("hidden");
            activeIndex = -1;
            return;
        }

        dropdown.innerHTML = filtered.map((c, i) => `
            <div class="autocomplete-item ${i === activeIndex ? "active" : ""}" data-index="${i}" data-id="${c.id}" data-title="${escapeHtml(c.title)}">
                <span class="ac-subcat">${highlightMatch(c.title, query)}</span>
            </div>
        `).join("");
        dropdown.classList.remove("hidden");

        dropdown.querySelectorAll(".autocomplete-item").forEach(item => {
            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                state.selectedCollections.push({ id: item.dataset.id, title: item.dataset.title });
                input.value = "";
                dropdown.classList.add("hidden");
                activeIndex = -1;
                renderCollectionChips();
            });
        });
    }

    input.addEventListener("input", debounce(() => {
        activeIndex = -1;
        const q = input.value.trim();
        if (!q) { dropdown.classList.add("hidden"); return; }
        render(q);
    }, 150));

    input.addEventListener("keydown", (e) => {
        const items = dropdown.querySelectorAll(".autocomplete-item");

        if (e.key === "ArrowDown" && items.length) {
            e.preventDefault();
            activeIndex = Math.min(activeIndex + 1, items.length - 1);
            updateActive(items, activeIndex);
        } else if (e.key === "ArrowUp" && items.length) {
            e.preventDefault();
            activeIndex = Math.max(activeIndex - 1, 0);
            updateActive(items, activeIndex);
        } else if (e.key === "Enter" && activeIndex >= 0 && items[activeIndex]) {
            e.preventDefault();
            state.selectedCollections.push({
                id: items[activeIndex].dataset.id,
                title: items[activeIndex].dataset.title,
            });
            input.value = "";
            dropdown.classList.add("hidden");
            activeIndex = -1;
            renderCollectionChips();
        } else if (e.key === "Backspace" && !input.value && state.selectedCollections.length) {
            state.selectedCollections.pop();
            renderCollectionChips();
        } else if (e.key === "Escape") {
            dropdown.classList.add("hidden");
            activeIndex = -1;
        }
    });

    input.addEventListener("blur", () => {
        setTimeout(() => { dropdown.classList.add("hidden"); activeIndex = -1; }, 150);
    });

    input.addEventListener("focus", () => {
        if (input.value.trim()) render(input.value.trim());
    });
}

function renderCollectionChips() {
    const container = document.getElementById("sp-collections-input");
    const chips = state.selectedCollections.map((col, i) => `
        <span class="tag-chip">
            ${escapeHtml(col.title)}
            <span class="remove-tag material-icons-round" data-col-index="${i}">close</span>
        </span>
    `).join("");
    container.innerHTML = chips + '<input type="text" class="tag-input" id="sp-collections-search" placeholder="Search collections...">';
    bindCollectionsSearch();

    container.querySelectorAll(".remove-tag").forEach(btn => {
        btn.addEventListener("click", () => {
            state.selectedCollections.splice(parseInt(btn.dataset.colIndex), 1);
            renderCollectionChips();
        });
    });
}

// ── Inventory Locations ────────────────────────────────
function renderInventoryLocations() {
    const container = document.getElementById("sp-inventory-locations");
    if (!state.selectedStoreIds.length) {
        container.innerHTML = '<p class="text-muted text-sm">Select a store to load locations</p>';
        return;
    }

    let html = "";
    for (const sid of state.selectedStoreIds) {
        const store = state.stores.find(s => s.id === sid);
        const locs = state.locations[sid] || [];
        html += `<div class="store-card-label" style="margin-top:var(--md-spacing-sm);">${escapeHtml(store?.name || "")}</div>`;
        if (!locs.length) {
            html += '<p class="text-sm text-muted">No locations found</p>';
            continue;
        }
        html += locs.map(loc => `
            <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--md-outline-variant);">
                <span class="text-sm">${escapeHtml(loc.name)}</span>
                <input type="number" class="form-input" data-store="${sid}" data-location="${loc.id}" value="0" min="0"
                       style="width:80px; padding:4px 8px; font-size:0.8125rem; text-align:right;">
            </div>
        `).join("");
    }
    container.innerHTML = html;
}

// ── Publications ───────────────────────────────────────
function renderPublications() {
    const container = document.getElementById("sp-publications");
    if (!state.selectedStoreIds.length) {
        container.innerHTML = '<p class="text-sm text-muted">Select a store to load sales channels</p>';
        return;
    }

    let html = "";
    for (const sid of state.selectedStoreIds) {
        const store = state.stores.find(s => s.id === sid);
        const pubs = state.publications[sid] || [];
        if (!pubs.length) continue;

        if (state.selectedStoreIds.length > 1) {
            html += `<div class="store-card-label" style="margin-top:var(--md-spacing-sm);">${escapeHtml(store?.name || "")}</div>`;
        } else {
            html += '<div class="store-card-label">Sales channels</div>';
        }
        html += pubs.map(pub => `
            <label class="form-checkbox" style="margin:4px 0;">
                <input type="checkbox" data-store-id="${sid}" data-pub-id="${pub.id}" checked>
                ${escapeHtml(pub.name)}
            </label>
        `).join("");
    }

    container.innerHTML = html || '<p class="text-sm text-muted">No sales channels found</p>';
}

// ── Variants ───────────────────────────────────────────
function bindVariantEvents() {
    document.getElementById("sp-add-option").addEventListener("click", () => {
        if (state.options.length >= 3) {
            showToast("Maximum 3 options allowed", "warning");
            return;
        }
        state.options.push({ name: "", values: [], done: false });
        renderVariantOptions();
    });
}

function renderVariantOptions() {
    const container = document.getElementById("sp-variant-options");
    const addBtn = document.getElementById("sp-add-option");

    if (!state.options.length) {
        container.innerHTML = "";
        addBtn.classList.remove("hidden");
        addBtn.innerHTML = '<span class="material-icons-round" style="font-size:16px;">add</span> Add options like size or color';
        document.getElementById("sp-variant-table-container").classList.add("hidden");
        return;
    }

    addBtn.innerHTML = '<span class="material-icons-round" style="font-size:16px;">add</span> Add another option';
    addBtn.classList.toggle("hidden", state.options.length >= 3);

    const validCount = state.options.filter(o => o.name && o.values.length).length;
    const totalVariants = state.variants.length;

    container.innerHTML = state.options.map((opt, i) => {
        if (opt.done) {
            return `<div class="variant-option-card" data-index="${i}" style="cursor:pointer;">
                <div style="display:flex; align-items:center; justify-content:space-between;">
                    <div>
                        <strong style="font-size:0.875rem;">${escapeHtml(opt.name || "Option " + (i + 1))}</strong>
                        <span class="text-sm text-muted" style="margin-left:8px;">${opt.values.length} value${opt.values.length !== 1 ? "s" : ""}: ${opt.values.map(v => escapeHtml(v)).join(", ")}</span>
                    </div>
                    <div class="flex gap-xs">
                        <button class="btn btn-icon btn-secondary" data-edit-option="${i}" style="padding:4px;" title="Edit">
                            <span class="material-icons-round" style="font-size:16px;">edit</span>
                        </button>
                        <button class="btn btn-icon btn-danger" data-remove-option="${i}" style="padding:4px;" title="Delete">
                            <span class="material-icons-round" style="font-size:16px;">delete</span>
                        </button>
                    </div>
                </div>
            </div>`;
        }
        return `<div class="variant-option-card" data-index="${i}">
            <div class="option-header">
                <span class="material-icons-round" style="font-size:18px; color:var(--md-on-surface-variant);">drag_indicator</span>
                <div class="form-group" style="flex:1; margin:0;">
                    <label>Option name</label>
                    <input type="text" class="form-input" value="${escapeHtml(opt.name)}" placeholder="e.g. Size, Color"
                           data-option-index="${i}" data-field="name" style="padding:6px 10px; font-size:0.8125rem;">
                </div>
                <button class="btn btn-icon btn-danger" data-remove-option="${i}" style="padding:4px;" title="Delete option">
                    <span class="material-icons-round" style="font-size:16px;">delete</span>
                </button>
            </div>
            <label>Option values</label>
            <div class="option-values-container" data-option-index="${i}">
                ${opt.values.map((v, vi) => `
                    <span class="option-value-chip">
                        ${escapeHtml(v)}
                        <span class="remove-value material-icons-round" data-option="${i}" data-value-index="${vi}">close</span>
                    </span>
                `).join("")}
                <input type="text" class="option-value-input" placeholder="Add value and press Enter..." data-option-index="${i}">
            </div>
            <div style="display:flex; justify-content:flex-end; margin-top:var(--md-spacing-sm);">
                <button class="btn btn-primary" data-done-option="${i}" style="padding:6px 16px; font-size:0.8125rem;"
                        ${!opt.name || !opt.values.length ? "disabled" : ""}>Done</button>
            </div>
        </div>`;
    }).join("");

    if (totalVariants > 0) {
        const summary = document.createElement("div");
        summary.className = "text-sm text-muted";
        summary.style.marginTop = "var(--md-spacing-xs)";
        summary.textContent = `${totalVariants} variant${totalVariants !== 1 ? "s" : ""} will be created`;
        container.appendChild(summary);
    }

    container.querySelectorAll('[data-field="name"]').forEach(input => {
        input.addEventListener("input", () => {
            const idx = parseInt(input.dataset.optionIndex);
            state.options[idx].name = input.value;
            const doneBtn = container.querySelector(`[data-done-option="${idx}"]`);
            if (doneBtn) doneBtn.disabled = !input.value || !state.options[idx].values.length;
        });
    });

    container.querySelectorAll(".option-value-input").forEach(input => {
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && input.value.trim()) {
                e.preventDefault();
                const idx = parseInt(input.dataset.optionIndex);
                state.options[idx].values.push(input.value.trim());
                input.value = "";
                renderVariantOptions();
                generateVariants();
                const newInput = container.querySelector(`.option-value-input[data-option-index="${idx}"]`);
                if (newInput) newInput.focus();
            }
        });
    });

    container.querySelectorAll(".remove-value").forEach(btn => {
        btn.addEventListener("click", () => {
            const oi = parseInt(btn.dataset.option);
            const vi = parseInt(btn.dataset.valueIndex);
            state.options[oi].values.splice(vi, 1);
            renderVariantOptions();
            generateVariants();
        });
    });

    container.querySelectorAll("[data-remove-option]").forEach(btn => {
        btn.addEventListener("click", () => {
            state.options.splice(parseInt(btn.dataset.removeOption), 1);
            renderVariantOptions();
            generateVariants();
        });
    });

    container.querySelectorAll("[data-done-option]").forEach(btn => {
        btn.addEventListener("click", () => {
            const idx = parseInt(btn.dataset.doneOption);
            if (state.options[idx].name && state.options[idx].values.length) {
                state.options[idx].done = true;
                renderVariantOptions();
                generateVariants();
            }
        });
    });

    container.querySelectorAll("[data-edit-option]").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            state.options[parseInt(btn.dataset.editOption)].done = false;
            renderVariantOptions();
        });
    });
}

function generateVariants() {
    const validOptions = state.options.filter(o => o.name && o.values.length > 0);
    if (!validOptions.length) {
        state.variants = [];
        document.getElementById("sp-variant-table-container").classList.add("hidden");
        return;
    }

    const cartesian = validOptions.reduce((acc, opt) =>
        acc.flatMap(combo => opt.values.map(v => [...combo, { optionName: opt.name, name: v }]))
    , [[]]);

    const price = document.getElementById("sp-price").value || "0";
    const cost = document.getElementById("sp-cost").value || "0";
    const sku = document.getElementById("sp-sku").value || "";
    const barcode = document.getElementById("sp-barcode").value || "";

    const oldVariants = new Map(state.variants.map(v => [v.title, v]));
    state.variants = cartesian.map((combo) => {
        const title = combo.map(c => c.name).join(" / ");
        const existing = oldVariants.get(title);
        return {
            optionValues: combo,
            title,
            price: existing?.price ?? price,
            compareAtPrice: existing?.compareAtPrice ?? "",
            cost: existing?.cost ?? cost,
            sku: existing?.sku ?? "",
            barcode: existing?.barcode ?? barcode,
        };
    });

    renderVariantTable();
}

function renderVariantTable() {
    const container = document.getElementById("sp-variant-table-container");
    if (!state.variants.length) {
        container.classList.add("hidden");
        return;
    }
    container.classList.remove("hidden");

    container.innerHTML = `
        <table class="variant-table">
            <thead>
                <tr>
                    <th>Variant</th>
                    <th style="width:90px;">Price</th>
                    <th style="width:90px;">Compare-at</th>
                    <th style="width:90px;">Cost</th>
                    <th style="width:100px;">SKU</th>
                    <th style="width:100px;">Barcode</th>
                </tr>
            </thead>
            <tbody>
                ${state.variants.map((v, i) => `
                    <tr data-variant="${i}">
                        <td style="font-weight:500;">${escapeHtml(v.title)}</td>
                        <td><input type="number" step="0.01" value="${v.price}" data-field="price" data-index="${i}"></td>
                        <td><input type="number" step="0.01" value="${v.compareAtPrice}" data-field="compareAtPrice" data-index="${i}"></td>
                        <td><input type="number" step="0.01" value="${v.cost}" data-field="cost" data-index="${i}"></td>
                        <td><input type="text" value="${escapeHtml(v.sku)}" data-field="sku" data-index="${i}"></td>
                        <td><input type="text" value="${escapeHtml(v.barcode)}" data-field="barcode" data-index="${i}"></td>
                    </tr>
                `).join("")}
            </tbody>
        </table>
    `;

    container.querySelectorAll("input").forEach(input => {
        input.addEventListener("change", () => {
            const idx = parseInt(input.dataset.index);
            state.variants[idx][input.dataset.field] = input.value;
        });
    });
}

// ── Metafields ─────────────────────────────────────────
function bindMetafieldEvents() {
    document.getElementById("sp-add-metafield").addEventListener("click", () => {
        state.metafields.push({ namespace: "custom", key: "", type: "single_line_text_field", value: "" });
        renderMetafields();
    });
}

function renderMetafields() {
    const container = document.getElementById("sp-metafields-list");
    container.innerHTML = state.metafields.map((mf, i) => `
        <div class="metafield-row" data-index="${i}">
            <input type="text" class="form-input" value="${escapeHtml(mf.namespace)}" data-field="namespace" placeholder="Namespace">
            <input type="text" class="form-input" value="${escapeHtml(mf.key)}" data-field="key" placeholder="Key">
            <select class="form-select" data-field="type">
                ${["single_line_text_field","multi_line_text_field","number_integer","number_decimal","date","boolean","url","color","json"]
                    .map(t => `<option value="${t}" ${t === mf.type ? "selected" : ""}>${t.replace(/_/g, " ")}</option>`).join("")}
            </select>
            <input type="text" class="form-input" value="${escapeHtml(mf.value)}" data-field="value" placeholder="Value">
            <button class="btn btn-icon btn-danger" data-remove-mf="${i}" style="padding:4px;">
                <span class="material-icons-round" style="font-size:16px;">close</span>
            </button>
        </div>
    `).join("");

    container.querySelectorAll(".metafield-row input, .metafield-row select").forEach(el => {
        el.addEventListener("change", () => {
            const row = el.closest(".metafield-row");
            const idx = parseInt(row.dataset.index);
            state.metafields[idx][el.dataset.field] = el.value;
        });
    });

    container.querySelectorAll("[data-remove-mf]").forEach(btn => {
        btn.addEventListener("click", () => {
            state.metafields.splice(parseInt(btn.dataset.removeMf), 1);
            renderMetafields();
        });
    });
}

// ── Tags ───────────────────────────────────────────────
function bindTagInput() {
    const input = document.getElementById("sp-tags-input");
    const dropdown = document.getElementById("sp-tags-dropdown");
    if (!input) return;

    let activeIndex = -1;

    function addTag(tag) {
        if (tag && !state.tags.includes(tag)) {
            state.tags.push(tag);
            renderTags();
        }
    }

    function renderSuggestions(query) {
        if (!dropdown) return;
        const q = query.toLowerCase();
        const suggestions = state.existingTags
            .filter(t => t.toLowerCase().includes(q))
            .filter(t => !state.tags.includes(t))
            .slice(0, 8);

        if (!suggestions.length) {
            dropdown.classList.add("hidden");
            activeIndex = -1;
            return;
        }

        dropdown.innerHTML = suggestions.map((t, i) => `
            <div class="autocomplete-item ${i === activeIndex ? "active" : ""}" data-index="${i}" data-value="${escapeHtml(t)}">
                <span class="ac-subcat">${highlightMatch(t, query)}</span>
            </div>
        `).join("");
        dropdown.classList.remove("hidden");

        dropdown.querySelectorAll(".autocomplete-item").forEach(el => {
            el.addEventListener("mousedown", (e) => {
                e.preventDefault();
                addTag(el.dataset.value);
                input.value = "";
                dropdown.classList.add("hidden");
                activeIndex = -1;
            });
        });
    }

    input.addEventListener("input", debounce(() => {
        activeIndex = -1;
        const q = input.value.trim();
        if (!q) { if (dropdown) dropdown.classList.add("hidden"); return; }
        renderSuggestions(q);
    }, 150));

    input.addEventListener("keydown", (e) => {
        if (dropdown) {
            const items = dropdown.querySelectorAll(".autocomplete-item");
            if (e.key === "ArrowDown" && items.length) {
                e.preventDefault();
                activeIndex = Math.min(activeIndex + 1, items.length - 1);
                updateActive(items, activeIndex);
                return;
            } else if (e.key === "ArrowUp" && items.length) {
                e.preventDefault();
                activeIndex = Math.max(activeIndex - 1, 0);
                updateActive(items, activeIndex);
                return;
            } else if (e.key === "Enter" && activeIndex >= 0 && items[activeIndex]) {
                e.preventDefault();
                addTag(items[activeIndex].dataset.value);
                input.value = "";
                dropdown.classList.add("hidden");
                activeIndex = -1;
                return;
            }
        }

        if ((e.key === "Enter" || e.key === ",") && input.value.trim()) {
            e.preventDefault();
            const tag = input.value.trim().replace(/,$/,"");
            addTag(tag);
            input.value = "";
            if (dropdown) dropdown.classList.add("hidden");
            activeIndex = -1;
        } else if (e.key === "Backspace" && !input.value && state.tags.length) {
            state.tags.pop();
            renderTags();
        } else if (e.key === "Escape" && dropdown) {
            dropdown.classList.add("hidden");
            activeIndex = -1;
        }
    });

    input.addEventListener("blur", () => {
        setTimeout(() => { if (dropdown) { dropdown.classList.add("hidden"); activeIndex = -1; } }, 150);
    });

    input.addEventListener("focus", () => {
        if (input.value.trim()) renderSuggestions(input.value.trim());
    });
}

function renderTags() {
    const container = document.getElementById("sp-tags-container");
    const chips = state.tags.map((tag, i) => `
        <span class="tag-chip">
            ${escapeHtml(tag)}
            <span class="remove-tag material-icons-round" data-tag-index="${i}">close</span>
        </span>
    `).join("");
    container.innerHTML = chips + '<input type="text" class="tag-input" id="sp-tags-input" placeholder="Add tags...">';
    bindTagInput();

    container.querySelectorAll(".remove-tag").forEach(btn => {
        btn.addEventListener("click", () => {
            state.tags.splice(parseInt(btn.dataset.tagIndex), 1);
            renderTags();
        });
    });
}

// ── SEO Sync ───────────────────────────────────────────
function bindSeoSync() {
    const titleInput = document.getElementById("sp-title");
    const seoTitle = document.getElementById("sp-seo-title");
    const seoHandle = document.getElementById("sp-seo-handle");
    const seoDesc = document.getElementById("sp-seo-description");

    titleInput.addEventListener("input", debounce(() => {
        if (!seoTitle._userEdited) {
            seoTitle.value = titleInput.value;
        }
        if (!seoHandle._userEdited) {
            seoHandle.value = titleInput.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        }
        updateSeoPreview();
    }, 300));

    seoTitle.addEventListener("input", () => { seoTitle._userEdited = true; updateSeoPreview(); });
    seoHandle.addEventListener("input", () => { seoHandle._userEdited = true; updateSeoPreview(); });
    seoDesc.addEventListener("input", debounce(updateSeoPreview, 300));
}

function updateSeoPreview() {
    const title = document.getElementById("sp-seo-title").value || document.getElementById("sp-title").value || "Page title";
    const handle = document.getElementById("sp-seo-handle").value || "";
    const desc = document.getElementById("sp-seo-description").value || "Add a description to see a preview";

    document.getElementById("sp-seo-preview-title").textContent = title;
    document.getElementById("sp-seo-preview-url").textContent = `https://store.myshopify.com/products/${handle}`;
    document.getElementById("sp-seo-preview-desc").textContent = desc;
}

// ── Action Buttons ─────────────────────────────────────
function bindActionButtons() {
    document.getElementById("sp-btn-save").addEventListener("click", saveProduct);
    document.getElementById("sp-btn-clear").addEventListener("click", clearForm);
    document.getElementById("sp-btn-test-data").addEventListener("click", fillTestData);
}

function validateForm() {
    let valid = true;
    const title = document.getElementById("sp-title").value.trim();
    const titleError = document.getElementById("sp-error-title");

    if (!title) {
        titleError.textContent = "Title is required";
        document.getElementById("sp-title").focus();
        valid = false;
    } else {
        titleError.textContent = "";
    }

    if (!state.selectedStoreIds.length) {
        showToast("Select at least one store", "warning");
        valid = false;
    }

    const handle = document.getElementById("sp-seo-handle").value.trim();
    if (handle && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle)) {
        showToast("URL handle must be lowercase letters, numbers, and hyphens", "warning");
        valid = false;
    }

    return valid;
}

async function saveProduct() {
    if (!validateForm()) return;

    const saveBtn = document.getElementById("sp-btn-save");
    const origHtml = saveBtn.innerHTML;
    saveBtn.disabled = true;

    try {
        let imageIds = [];
        let perStoreImageIds = {};

        if (state.imageMode === "shared" && state.uploadedImages.length) {
            saveBtn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span> Uploading images...';
            const formData = new FormData();
            state.uploadedImages.forEach((img, i) => formData.append(`image_${i}`, img.file));
            const uploadResp = await fetch("/api/shopify/upload-images", { method: "POST", body: formData });
            const uploadData = await uploadResp.json();
            imageIds = (uploadData.images || []).map(i => i.id);
        } else if (state.imageMode === "per_store") {
            saveBtn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span> Uploading images...';
            for (const sid of state.selectedStoreIds) {
                const storeImages = state.perStoreImages[sid] || [];
                if (!storeImages.length) continue;
                const formData = new FormData();
                storeImages.forEach((img, i) => formData.append(`image_${i}`, img.file));
                const uploadResp = await fetch("/api/shopify/upload-images", { method: "POST", body: formData });
                const uploadData = await uploadResp.json();
                perStoreImageIds[sid] = (uploadData.images || []).map(i => i.id);
            }
        }

        saveBtn.innerHTML = `<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span> Saving to ${state.selectedStoreIds.length} store${state.selectedStoreIds.length > 1 ? "s" : ""}...`;

        // Capture current active store's form
        if (state.activeStoreId) {
            state.perStoreProductData[state.activeStoreId] = captureFormState();
        }

        // Build per-store product data
        const perStoreProductData = {};
        for (const sid of state.selectedStoreIds) {
            const snap = state.perStoreProductData[sid];
            if (snap) {
                perStoreProductData[sid] = buildProductDataFromSnapshot(snap, sid);
            }
        }

        const result = await api.post("/api/shopify/products", {
            store_ids: state.selectedStoreIds,
            per_store_product_data: perStoreProductData,
            image_ids: imageIds,
            image_mode: state.imageMode,
            per_store_image_ids: perStoreImageIds,
        });

        if (result.stores_succeeded?.length) {
            showToast(`Product created on: ${result.stores_succeeded.join(", ")}`, "success", 8000);
        }
        if (result.stores_failed?.length) {
            for (const name of result.stores_failed) {
                showToast(`Failed on ${name}: ${result.error_details?.[name] || "Unknown error"}`, "error", 10000);
            }
        }
    } catch (err) {
        showToast(`Save failed: ${err.message}`, "error");
    }

    saveBtn.disabled = state.selectedStoreIds.length === 0;
    saveBtn.innerHTML = origHtml;
}

function collectFormData() {
    const product = {
        title: document.getElementById("sp-title").value.trim(),
        descriptionHtml: state.descriptionHtml || "",
        vendor: document.getElementById("sp-vendor").value.trim(),
        productType: document.getElementById("sp-product-type").value.trim(),
        tags: [...state.tags],
        status: document.getElementById("sp-status").value,
        handle: document.getElementById("sp-seo-handle").value.trim() || undefined,
        templateSuffix: document.getElementById("sp-template").value || undefined,
    };

    const seoTitle = document.getElementById("sp-seo-title").value.trim();
    const seoDesc = document.getElementById("sp-seo-description").value.trim();
    if (seoTitle || seoDesc) {
        product.seo = { title: seoTitle || undefined, description: seoDesc || undefined };
    }

    if (state.metafields.length) {
        product.metafields = state.metafields
            .filter(mf => mf.key && mf.value)
            .map(mf => ({
                namespace: mf.namespace || "custom",
                key: mf.key,
                type: mf.type,
                value: mf.value,
            }));
    }

    if (state.selectedCollections.length) {
        product.collectionsToJoin = state.selectedCollections.map(c => c.id);
    }

    const price = document.getElementById("sp-price").value;
    const compareAt = document.getElementById("sp-compare-at-price").value;
    const cost = document.getElementById("sp-cost").value;
    const sku = document.getElementById("sp-sku").value.trim();
    const barcode = document.getElementById("sp-barcode").value.trim();
    const taxable = document.getElementById("sp-charge-tax").checked;
    const trackInventory = document.getElementById("sp-track-inventory").checked;
    const continueSelling = document.getElementById("sp-continue-selling").checked;
    const inventoryPolicy = continueSelling ? "CONTINUE" : "DENY";

    if (state.options.length && state.variants.length) {
        product.productOptions = state.options
            .filter(o => o.name && o.values.length)
            .map(o => ({
                name: o.name,
                values: o.values.map(v => ({ name: v })),
            }));
        product.variants = state.variants.map(v => ({
            optionValues: v.optionValues,
            price: parseFloat(v.price) || 0,
            compareAtPrice: v.compareAtPrice ? parseFloat(v.compareAtPrice) : undefined,
            inventoryItem: {
                tracked: trackInventory,
                cost: v.cost ? parseFloat(v.cost) : undefined,
            },
            inventoryPolicy,
            sku: v.sku || undefined,
            barcode: v.barcode || undefined,
            taxable,
        }));
    } else {
        product.productOptions = [{ name: "Title", values: [{ name: "Default Title" }] }];
        product.variants = [{
            price: parseFloat(price) || 0,
            compareAtPrice: compareAt ? parseFloat(compareAt) : undefined,
            inventoryItem: {
                tracked: trackInventory,
                cost: cost ? parseFloat(cost) : undefined,
            },
            inventoryPolicy,
            sku: sku || undefined,
            barcode: barcode || undefined,
            taxable,
            optionValues: [{ optionName: "Title", name: "Default Title" }],
        }];
    }

    const perStoreInventory = {};
    document.querySelectorAll("#sp-inventory-locations input[data-location]").forEach(input => {
        const qty = parseInt(input.value) || 0;
        if (qty > 0) {
            const sid = input.dataset.store;
            if (!perStoreInventory[sid]) perStoreInventory[sid] = {};
            perStoreInventory[sid][input.dataset.location] = qty;
        }
    });

    const perStorePublications = {};
    document.querySelectorAll("#sp-publications input[data-pub-id]").forEach(input => {
        const sid = input.dataset.storeId;
        if (!perStorePublications[sid]) perStorePublications[sid] = [];
        if (input.checked) {
            perStorePublications[sid].push(input.dataset.pubId);
        }
    });

    const result = {
        product,
        inventory: { per_store: perStoreInventory },
        per_store_publications: perStorePublications,
    };

    const isPhysical = document.getElementById("sp-physical-product").checked;
    if (isPhysical) {
        const weight = parseFloat(document.getElementById("sp-weight").value);
        const weightUnit = document.getElementById("sp-weight-unit").value.toUpperCase();
        const countryOfOrigin = document.getElementById("sp-country-origin").value.trim();
        const hsCode = document.getElementById("sp-hs-code").value.trim();

        if (weight > 0) {
            result.shipping = { weight, weightUnit };
        }
        if (countryOfOrigin) {
            result.shipping = result.shipping || {};
            result.shipping.countryOfOrigin = countryOfOrigin;
        }
        if (hsCode) {
            result.shipping = result.shipping || {};
            result.shipping.hsCode = hsCode;
        }
    }

    return result;
}

function clearForm() {
    document.getElementById("sp-title").value = "";
    if (state.quill) state.quill.setText("");
    state.descriptionHtml = "";
    state.uploadedImages = [];
    state.perStoreImages = {};
    renderThumbnails();
    document.getElementById("sp-price").value = "";
    document.getElementById("sp-compare-at-price").value = "";
    document.getElementById("sp-cost").value = "";
    document.getElementById("sp-sku").value = "";
    document.getElementById("sp-barcode").value = "";
    document.getElementById("sp-charge-tax").checked = true;
    document.getElementById("sp-track-inventory").checked = true;
    document.getElementById("sp-continue-selling").checked = false;
    document.getElementById("sp-physical-product").checked = true;
    document.getElementById("sp-weight").value = "";
    document.getElementById("sp-weight-unit").value = "lb";
    document.getElementById("sp-country-origin").value = "";
    document.getElementById("sp-hs-code").value = "";
    document.getElementById("sp-status").value = "DRAFT";
    document.getElementById("sp-product-type").value = "";
    document.getElementById("sp-vendor").value = "";
    document.getElementById("sp-seo-title").value = "";
    document.getElementById("sp-seo-title")._userEdited = false;
    document.getElementById("sp-seo-description").value = "";
    document.getElementById("sp-seo-handle").value = "";
    document.getElementById("sp-seo-handle")._userEdited = false;
    document.getElementById("sp-template").value = "";

    state.options = [];
    state.variants = [];
    state.metafields = [];
    state.tags = [];
    state.selectedCollections = [];

    renderVariantOptions();
    renderMetafields();
    renderTags();
    renderCollectionChips();
    updateSeoPreview();
    renderInventoryLocations();
    renderPerStoreMediaUI();

    document.getElementById("sp-error-title").textContent = "";
    document.getElementById("sp-watermark-previews").innerHTML = "";

    // Clear per-store data and re-init from blank form
    state.perStoreProductData = {};
    for (const sid of state.selectedStoreIds) {
        state.perStoreProductData[sid] = captureFormState();
    }

    showToast("Form cleared", "info");
}

function fillTestData() {
    const id = Math.floor(Math.random() * 9000) + 1000;
    const sku = `TEST-${id}`;

    // Basic fields
    document.getElementById("sp-title").value = `Test Product #${id}`;
    document.getElementById("sp-vendor").value = "Test Vendor Co";
    document.getElementById("sp-product-type").value = "Test Category";
    document.getElementById("sp-status").value = "DRAFT";

    // Pricing
    document.getElementById("sp-price").value = "29.99";
    document.getElementById("sp-compare-at-price").value = "39.99";
    document.getElementById("sp-cost").value = "12.50";

    // Inventory
    document.getElementById("sp-sku").value = sku;
    document.getElementById("sp-barcode").value = `0${id}${id}${id}`.slice(0, 12);
    document.getElementById("sp-track-inventory").checked = true;
    document.getElementById("sp-continue-selling").checked = false;
    document.getElementById("sp-charge-tax").checked = true;

    // Shipping
    document.getElementById("sp-physical-product").checked = true;
    document.getElementById("sp-weight").value = "0.75";
    document.getElementById("sp-weight-unit").value = "lb";
    document.getElementById("sp-country-origin").value = "United States";
    document.getElementById("sp-hs-code").value = "6109.10";

    // Description (Quill)
    const descHtml = `<h2>Test Product #${id}</h2><p>This is an <strong>automatically generated</strong> test product for system testing.</p><ul><li>Feature one: Premium quality</li><li>Feature two: Fast shipping</li><li>Feature three: 30-day returns</li></ul><p>Available in multiple sizes and colors.</p>`;
    if (state.quill) {
        state.quill.root.innerHTML = descHtml;
        state.descriptionHtml = descHtml;
    }

    // SEO
    document.getElementById("sp-seo-title").value = `Test Product #${id} | Shop`;
    document.getElementById("sp-seo-title")._userEdited = true;
    document.getElementById("sp-seo-description").value = `Shop our Test Product #${id}. Premium quality, available in multiple sizes and colors. Free shipping on orders over $50.`;
    document.getElementById("sp-seo-handle").value = `test-product-${id}`;
    document.getElementById("sp-seo-handle")._userEdited = true;
    updateSeoPreview();

    // Tags
    state.tags = ["test", "sample", "new-arrival", `batch-${id}`];
    renderTags();

    // Metafields
    state.metafields = [
        { namespace: "custom", key: "material", type: "single_line_text_field", value: "Cotton Blend" },
        { namespace: "custom", key: "care_instructions", type: "multi_line_text_field", value: "Machine wash cold\nTumble dry low" },
        { namespace: "custom", key: "weight_oz", type: "number_decimal", value: "12.0" },
    ];
    renderMetafields();

    // Expand collapsed sections so user can see everything
    ["sp-section-inventory", "sp-section-shipping", "sp-section-metafields", "sp-section-seo"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove("collapsed");
    });

    // Variants: Size + Color options
    state.options = [
        { name: "Size", values: ["Small", "Medium", "Large"], done: true },
        { name: "Color", values: ["Red", "Blue"], done: true },
    ];
    renderVariantOptions();
    generateVariants();

    // Override variant SKUs/barcodes with unique values
    state.variants.forEach((v, i) => {
        v.sku = `${sku}-${i + 1}`;
        v.barcode = `0${id}${id}${String(i + 1).padStart(3, "0")}`.slice(0, 12);
        v.price = (29.99 + i * 2).toFixed(2);
        v.cost = (12.50 + i).toFixed(2);
    });
    renderVariantTable();

    document.getElementById("sp-error-title").textContent = "";
    showToast(`Test data filled — Product #${id}`, "success");
}

// ── Product Lookup ────────────────────────────────────
function initLookup() {
    // Barcode search (button-based)
    const barcodeBtn = document.getElementById("sp-lookup-btn");
    const barcodeInput = document.getElementById("sp-lookup-barcode");
    if (barcodeBtn) barcodeBtn.addEventListener("click", lookupByBarcode);
    if (barcodeInput) {
        barcodeInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); lookupByBarcode(); }
        });
    }

    // Title search (autocomplete)
    const titleInput = document.getElementById("sp-lookup-title");
    const dropdown = document.getElementById("sp-lookup-dropdown");
    let activeIndex = -1;

    if (titleInput && dropdown) {
        titleInput.addEventListener("input", debounce(async () => {
            const query = titleInput.value.trim();
            if (query.length < 2) { dropdown.classList.add("hidden"); return; }

            try {
                const results = await api.get(`/api/shopify/products/search?q=${encodeURIComponent(query)}`);
                if (!results.length) {
                    dropdown.innerHTML = '<div class="autocomplete-item" style="color:var(--md-on-surface-variant);pointer-events:none;">No products found</div>';
                    dropdown.classList.remove("hidden");
                    return;
                }

                activeIndex = -1;
                dropdown.innerHTML = results.map((p, i) => `
                    <div class="autocomplete-item" data-index="${i}" data-store-id="${p.store_id}" data-product-id="${p.product_id}">
                        <span class="ac-subcat">${spHighlightMatch(escapeHtml(p.title), query)}</span>
                        <span class="ac-cat">
                            ${p.barcode ? escapeHtml(p.barcode) + " &bull; " : ""}${p.vendor ? escapeHtml(p.vendor) + " &bull; " : ""}$${parseFloat(p.price || 0).toFixed(2)}
                            <span style="float:right;opacity:0.7;">${escapeHtml(p.store_name)}</span>
                        </span>
                    </div>
                `).join("");
                dropdown.classList.remove("hidden");

                dropdown.querySelectorAll(".autocomplete-item[data-product-id]").forEach(item => {
                    item.addEventListener("click", () => {
                        selectLookupProduct(parseInt(item.dataset.storeId), item.dataset.productId);
                    });
                });
            } catch {
                dropdown.classList.add("hidden");
            }
        }, 300));

        titleInput.addEventListener("keydown", (e) => {
            const items = dropdown.querySelectorAll(".autocomplete-item[data-product-id]");
            if (!items.length || dropdown.classList.contains("hidden")) return;

            if (e.key === "ArrowDown") {
                e.preventDefault();
                activeIndex = Math.min(activeIndex + 1, items.length - 1);
                spUpdateActiveItem(items, activeIndex);
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                activeIndex = Math.max(activeIndex - 1, 0);
                spUpdateActiveItem(items, activeIndex);
            } else if (e.key === "Enter") {
                e.preventDefault();
                if (activeIndex >= 0 && items[activeIndex]) {
                    selectLookupProduct(
                        parseInt(items[activeIndex].dataset.storeId),
                        items[activeIndex].dataset.productId,
                    );
                }
            } else if (e.key === "Escape") {
                dropdown.classList.add("hidden");
            }
        });

        document.addEventListener("click", (e) => {
            if (!e.target.closest("#sp-lookup-title") && !e.target.closest("#sp-lookup-dropdown")) {
                dropdown.classList.add("hidden");
            }
        });
    }

    // Clear template
    document.getElementById("sp-clear-template")?.addEventListener("click", clearLookupTemplate);
}

function spHighlightMatch(text, query) {
    if (!query) return text;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return text.slice(0, idx) + "<mark>" + text.slice(idx, idx + query.length) + "</mark>" + text.slice(idx + query.length);
}

function spUpdateActiveItem(items, index) {
    items.forEach((item, i) => item.classList.toggle("active", i === index));
    if (items[index]) items[index].scrollIntoView({ block: "nearest" });
}

async function selectLookupProduct(storeId, productId) {
    document.getElementById("sp-lookup-dropdown").classList.add("hidden");
    document.getElementById("sp-lookup-title").value = "";

    try {
        const product = await api.get(`/api/shopify/products/detail/${storeId}/${encodeURIComponent(productId)}`);
        applyLookupData(product, null);
    } catch (err) {
        showToast(`Failed to load product details: ${err.message}`, "error");
    }
}

async function lookupByBarcode() {
    const input = document.getElementById("sp-lookup-barcode");
    const btn = document.getElementById("sp-lookup-btn");
    const barcode = input.value.trim();

    if (!barcode) {
        showToast("Enter a barcode to search", "warning");
        input.focus();
        return;
    }

    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px;"></span>';

    try {
        const result = await api.post("/api/shopify/products/lookup", { barcode });

        if (!result.found) {
            showToast("No product found with this barcode", "warning");
            return;
        }

        applyLookupData(result.product, `Found in: ${result.found_in_stores.join(", ")}`, result.per_store_products);
    } catch (err) {
        showToast(`Lookup failed: ${err.message}`, "error");
    } finally {
        btn.disabled = false;
        btn.innerHTML = origHtml;
    }
}

function applyLookupData(p, extraInfo, perStoreProducts) {
    state.templateMode = true;
    state.templateProduct = p;

    // Show template banner
    const banner = document.getElementById("sp-template-banner");
    let bannerText = `Template: ${p.title}`;
    if (extraInfo) bannerText += ` — ${extraInfo}`;
    document.getElementById("sp-template-banner-text").textContent = bannerText;
    banner.classList.remove("hidden");

    // Clear search inputs
    document.getElementById("sp-lookup-barcode").value = "";
    document.getElementById("sp-lookup-title").value = "";

    // Build per-store snapshots from per-store product data
    state.perStoreProductData = {};
    for (const sid of state.selectedStoreIds) {
        const storeProduct = perStoreProducts?.[String(sid)] || p;
        const snap = productToSnapshot(storeProduct);
        state.perStoreProductData[sid] = snap;
    }

    // Load active store's data into the form
    const activeSnap = state.perStoreProductData[state.activeStoreId];
    if (activeSnap) {
        restoreFormState(activeSnap);
    }

    document.getElementById("sp-error-title").textContent = "";
    showToast("Product loaded as template", "success");

    setTimeout(() => document.getElementById("sp-title")?.focus(), 100);
}

function productToSnapshot(p) {
    return {
        title: p.title || "",
        descriptionHtml: p.descriptionHtml || "",
        vendor: p.vendor || "",
        productType: p.productType || "",
        status: p.status || "DRAFT",
        price: p.price || "",
        compareAtPrice: p.compareAtPrice || "",
        cost: p.cost || "",
        sku: "",
        barcode: "",
        chargeTax: p.taxable !== false,
        trackInventory: true,
        continueSelling: false,
        physicalProduct: !!p.weight,
        weight: p.weight || "",
        weightUnit: p.weightUnit || "lb",
        countryOrigin: "",
        hsCode: "",
        seoTitle: p.seo?.title || "",
        seoDescription: p.seo?.description || "",
        seoHandle: "",
        seoHandleEdited: false,
        seoTitleEdited: false,
        template: p.templateSuffix || "",
        tags: Array.isArray(p.tags) ? [...p.tags] : [],
        metafields: Array.isArray(p.metafields) ? p.metafields.map(mf => ({ ...mf })) : [],
        options: [],
        variants: [],
        selectedCollections: [],
    };
}

function clearLookupTemplate() {
    state.templateMode = false;
    state.templateProduct = null;
    document.getElementById("sp-template-banner").classList.add("hidden");
    clearForm();
}
