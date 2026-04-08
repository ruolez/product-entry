import { api } from "./api-client.js";
import { showToast, debounce, escapeHtml } from "./utils.js";

// ── State ──────────────────────────────────────────────
const state = {
    stores: [],
    selectedStoreIds: [],
    collections: {},
    locations: {},
    publications: {},
    productTypes: [],
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
        renderStoreSelector();
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
    bindSeoSync();
    bindActionButtons();
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
    const allSelected = state.selectedStoreIds.length === state.stores.length;
    const chips = state.stores.map(s => {
        const sel = state.selectedStoreIds.includes(s.id);
        return `<button class="store-chip ${sel ? "selected" : ""}" data-id="${s.id}">${escapeHtml(s.name)}</button>`;
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
            } else {
                const id = parseInt(chip.dataset.id);
                if (state.selectedStoreIds.includes(id)) {
                    state.selectedStoreIds = state.selectedStoreIds.filter(x => x !== id);
                } else {
                    state.selectedStoreIds.push(id);
                }
            }
            renderStoreSelector();
            onStoreSelectionChange();
        });
    });
}

async function onStoreSelectionChange() {
    const count = state.selectedStoreIds.length;
    document.getElementById("sp-store-count-label").textContent =
        count === 0 ? "No stores selected" : `${count} store${count > 1 ? "s" : ""} selected`;
    document.getElementById("sp-btn-save").disabled = count === 0;

    for (const sid of state.selectedStoreIds) {
        if (!state.collections[sid]) {
            try {
                const [cols, locs, pubs] = await Promise.all([
                    api.get(`/api/shopify/stores/${sid}/collections`),
                    api.get(`/api/shopify/stores/${sid}/locations`),
                    api.get(`/api/shopify/stores/${sid}/publications`),
                ]);
                state.collections[sid] = cols;
                state.locations[sid] = locs;
                state.publications[sid] = pubs;
            } catch (err) {
                showToast(`Failed to load data for store ${sid}: ${err.message}`, "error");
            }
        }
    }
    renderInventoryLocations();
    renderPublications();
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
                ["link", "image"],
                ["clean"],
            ],
        },
    });
    state.quill.on("text-change", () => {
        state.descriptionHtml = state.quill.root.innerHTML;
    });
}

// ── Media Upload ───────────────────────────────────────
function bindMediaUpload() {
    const zone = document.getElementById("sp-upload-zone");
    const fileInput = document.getElementById("sp-file-input");

    zone.addEventListener("click", () => fileInput.click());
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("drag-over");
        handleFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener("change", () => {
        handleFiles(fileInput.files);
        fileInput.value = "";
    });
}

function handleFiles(files) {
    for (const file of files) {
        if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) continue;
        const id = crypto.randomUUID();
        const reader = new FileReader();
        reader.onload = (e) => {
            state.uploadedImages.push({ id, file, preview: e.target.result, name: file.name });
            renderThumbnails();
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
        if (state.selectedStoreIds.length > 1) {
            html += `<div class="store-card-label" style="margin-top:var(--md-spacing-sm);">${escapeHtml(store?.name || "")}</div>`;
        }
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

    const firstStoreId = state.selectedStoreIds[0];
    const pubs = state.publications[firstStoreId] || [];
    if (!pubs.length) {
        container.innerHTML = '<p class="text-sm text-muted">No sales channels found</p>';
        return;
    }

    container.innerHTML = `
        <div class="store-card-label">Sales channels</div>
        ${pubs.map(pub => `
            <label class="form-checkbox" style="margin:4px 0;">
                <input type="checkbox" data-pub-id="${pub.id}" checked>
                ${escapeHtml(pub.name)}
            </label>
        `).join("")}
    `;
}

// ── Variants ───────────────────────────────────────────
function bindVariantEvents() {
    document.getElementById("sp-add-option").addEventListener("click", () => {
        if (state.options.length >= 3) {
            showToast("Maximum 3 options allowed", "warning");
            return;
        }
        state.options.push({ name: "", values: [] });
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

    container.innerHTML = state.options.map((opt, i) => `
        <div class="variant-option-card" data-index="${i}">
            <div class="option-header">
                <span class="material-icons-round" style="font-size:18px; color:var(--md-on-surface-variant); cursor:grab;">drag_indicator</span>
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
                <input type="text" class="option-value-input" placeholder="Add value..." data-option-index="${i}">
            </div>
        </div>
    `).join("");

    container.querySelectorAll('[data-field="name"]').forEach(input => {
        input.addEventListener("change", (e) => {
            state.options[parseInt(input.dataset.optionIndex)].name = input.value;
            generateVariants();
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

    state.variants = cartesian.map((combo, i) => ({
        optionValues: combo,
        title: combo.map(c => c.name).join(" / "),
        price: state.variants[i]?.price ?? price,
        compareAtPrice: state.variants[i]?.compareAtPrice ?? "",
        cost: state.variants[i]?.cost ?? cost,
        sku: state.variants[i]?.sku ?? (sku ? `${sku}-${i + 1}` : ""),
        barcode: state.variants[i]?.barcode ?? barcode,
    }));

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
                    <th>Price</th>
                    <th>Compare-at</th>
                    <th>Cost</th>
                    <th>SKU</th>
                    <th>Barcode</th>
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
            const field = input.dataset.field;
            state.variants[idx][field] = input.value;
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
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && input.value.trim()) {
            e.preventDefault();
            const tag = input.value.trim();
            if (!state.tags.includes(tag)) {
                state.tags.push(tag);
                renderTags();
            }
            input.value = "";
        } else if (e.key === "Backspace" && !input.value && state.tags.length) {
            state.tags.pop();
            renderTags();
        }
    });
}

function renderTags() {
    const container = document.getElementById("sp-tags-container");
    const input = container.querySelector(".tag-input");
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
        if (!seoTitle.value) {
            seoTitle.value = titleInput.value;
        }
        if (!seoHandle.value) {
            seoHandle.value = titleInput.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        }
        updateSeoPreview();
    }, 300));

    [seoTitle, seoDesc, seoHandle].forEach(el => {
        el.addEventListener("input", debounce(updateSeoPreview, 300));
    });
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
}

async function saveProduct() {
    const title = document.getElementById("sp-title").value.trim();
    if (!title) {
        showToast("Product title is required", "warning");
        document.getElementById("sp-error-title").textContent = "Title is required";
        document.getElementById("sp-title").focus();
        return;
    }
    document.getElementById("sp-error-title").textContent = "";

    if (!state.selectedStoreIds.length) {
        showToast("Select at least one store", "warning");
        return;
    }

    const saveBtn = document.getElementById("sp-btn-save");
    const origHtml = saveBtn.innerHTML;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span> Saving...';

    try {
        let imageIds = [];
        if (state.uploadedImages.length) {
            const formData = new FormData();
            state.uploadedImages.forEach((img, i) => {
                formData.append(`image_${i}`, img.file);
            });
            const uploadResp = await fetch("/api/shopify/upload-images", {
                method: "POST",
                body: formData,
            });
            const uploadData = await uploadResp.json();
            imageIds = (uploadData.images || []).map(i => i.id);
        }

        const productData = collectFormData();
        const result = await api.post("/api/shopify/products", {
            store_ids: state.selectedStoreIds,
            product_data: productData,
            image_ids: imageIds,
            image_mode: state.imageMode,
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

    saveBtn.disabled = false;
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
            inventoryItem: v.cost ? { cost: parseFloat(v.cost) } : undefined,
            sku: v.sku || undefined,
            barcode: v.barcode || undefined,
            taxable,
        }));
    } else {
        product.variants = [{
            price: parseFloat(price) || 0,
            compareAtPrice: compareAt ? parseFloat(compareAt) : undefined,
            inventoryItem: cost ? { cost: parseFloat(cost) } : undefined,
            sku: sku || undefined,
            barcode: barcode || undefined,
            taxable,
            optionValues: [{ optionName: "Title", name: "Default Title" }],
        }];
    }

    const locationQuantities = {};
    document.querySelectorAll("#sp-inventory-locations input[data-location]").forEach(input => {
        const qty = parseInt(input.value) || 0;
        if (qty > 0) {
            locationQuantities[input.dataset.location] = qty;
        }
    });

    const publicationIds = [];
    document.querySelectorAll("#sp-publications input[data-pub-id]:checked").forEach(input => {
        publicationIds.push(input.dataset.pubId);
    });

    return {
        product,
        inventory: { location_quantities: locationQuantities },
        publication_ids: publicationIds,
    };
}

function clearForm() {
    document.getElementById("sp-title").value = "";
    if (state.quill) state.quill.setText("");
    state.descriptionHtml = "";
    state.uploadedImages = [];
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
    document.getElementById("sp-country-origin").value = "";
    document.getElementById("sp-hs-code").value = "";
    document.getElementById("sp-status").value = "DRAFT";
    document.getElementById("sp-product-type").value = "";
    document.getElementById("sp-vendor").value = "";
    document.getElementById("sp-seo-title").value = "";
    document.getElementById("sp-seo-description").value = "";
    document.getElementById("sp-seo-handle").value = "";
    document.getElementById("sp-template").value = "";
    document.getElementById("sp-category").value = "";

    state.options = [];
    state.variants = [];
    state.metafields = [];
    state.tags = [];
    state.selectedCollections = [];

    renderVariantOptions();
    renderMetafields();
    renderTags();
    updateSeoPreview();
    renderInventoryLocations();

    document.getElementById("sp-error-title").textContent = "";
    showToast("Form cleared", "info");
}
