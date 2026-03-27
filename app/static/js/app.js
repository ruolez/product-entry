import { api } from "./api-client.js";
import { showToast, debounce, calculateMargin } from "./utils.js";

// ── State ──────────────────────────────────────────────
const state = {
    stores: [],
    selectedStoreIds: [],
    fieldConfigs: [],
    priceFormulas: {},           // { storeId: [ {target_field, operator, operand} ] }
    perStoreData: {},      // { storeId: { CateID, SubCateID, ManuID } }
    activeCategoryStoreId: null, // which store's categories are showing
    lookupCache: {},             // { "categories-1": [...], "subcategories-1-5": [...] }
};

// ── Init ───────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
    try {
        const [stores, fieldConfigs] = await Promise.all([
            api.get("/api/stores"),
            api.get("/api/field-configs"),
        ]);
        state.stores = stores;
        state.fieldConfigs = fieldConfigs;
        renderStoreSelector(stores);
        applyFieldDefaults(fieldConfigs);
        applyFieldVisibility(fieldConfigs);
    } catch (err) {
        showToast("Failed to initialize. Check Settings.", "error");
        renderStoreSelector([]);
    }

    bindValidation();
    bindPriceEngine();
    bindKeyboardNav();
    bindActionButtons();
});

// ── Store Selector ─────────────────────────────────────
function renderStoreSelector(stores) {
    const container = document.getElementById("store-selector");
    if (!stores.length) {
        container.innerHTML = `
            <span class="store-selector-label">
                <span class="material-icons-round" style="font-size:18px;vertical-align:middle;margin-right:4px;">store</span>
                Target Stores
            </span>
            <span class="text-muted">No stores configured. <a href="/settings">Go to Settings</a></span>
        `;
        return;
    }
    container.innerHTML = `
        <span class="store-selector-label">
            <span class="material-icons-round" style="font-size:18px;vertical-align:middle;margin-right:4px;">store</span>
            Target Stores
        </span>
        <button class="store-chip toggle-all-chip" id="toggle-all-stores" title="Select All / None">
            <span class="material-icons-round" style="font-size:16px;">select_all</span>
            All
        </button>
        ${stores.map(s => `
            <button class="store-chip" data-store-id="${s.id}" data-store-name="${s.name}">
                <span class="material-icons-round chip-check">check</span>
                ${s.name}
            </button>
        `).join("")}
    `;
    container.querySelectorAll(".store-chip[data-store-id]").forEach(chip => {
        chip.addEventListener("click", () => {
            chip.classList.toggle("selected");
            updateToggleAllState();
            onStoreSelectionChange();
        });
    });
    document.getElementById("toggle-all-stores").addEventListener("click", () => {
        const chips = container.querySelectorAll(".store-chip[data-store-id]");
        const allSelected = Array.from(chips).every(c => c.classList.contains("selected"));
        chips.forEach(c => c.classList.toggle("selected", !allSelected));
        updateToggleAllState();
        onStoreSelectionChange();
    });
}

function updateToggleAllState() {
    const btn = document.getElementById("toggle-all-stores");
    if (!btn) return;
    const chips = document.querySelectorAll(".store-chip[data-store-id]");
    const allSelected = Array.from(chips).every(c => c.classList.contains("selected"));
    btn.classList.toggle("selected", allSelected);
    btn.innerHTML = allSelected
        ? '<span class="material-icons-round" style="font-size:16px;">deselect</span> None'
        : '<span class="material-icons-round" style="font-size:16px;">select_all</span> All';
}

async function onStoreSelectionChange() {
    state.selectedStoreIds = Array.from(
        document.querySelectorAll(".store-chip.selected")
    ).map(c => parseInt(c.dataset.storeId));

    const count = state.selectedStoreIds.length;
    document.getElementById("store-count-label").textContent =
        count === 0 ? "No stores selected" : `${count} store${count > 1 ? "s" : ""} selected`;

    const saveBtns = [document.getElementById("btn-save"), document.getElementById("btn-save-new")];
    saveBtns.forEach(b => b.disabled = count === 0);

    renderCategoryTabs();

    if (count > 0) {
        loadPriceFormulas();
        loadLookupData(state.selectedStoreIds[0]);
    }
}

// ── Category Per-Store Tabs ────────────────────────────
function renderCategoryTabs() {
    const tabContainer = document.getElementById("category-store-tabs");
    if (state.selectedStoreIds.length === 0) {
        tabContainer.innerHTML = '<span class="text-muted text-sm">Select stores above</span>';
        return;
    }

    tabContainer.innerHTML = state.selectedStoreIds.map(sid => {
        const store = state.stores.find(s => s.id === sid);
        const data = state.perStoreData[sid];
        const assigned = data?.CateID && data?.SubCateID;
        const statusClass = assigned ? "assigned" : "missing";
        const statusIcon = assigned ? "check_circle" : "radio_button_unchecked";
        return `
            <button class="store-tab ${sid === state.activeCategoryStoreId ? "active" : ""}"
                    data-store-id="${sid}">
                ${store?.name || sid}
                <span class="material-icons-round tab-status ${statusClass}" style="font-size:14px;">${statusIcon}</span>
            </button>
        `;
    }).join("");

    tabContainer.querySelectorAll(".store-tab").forEach(tab => {
        tab.addEventListener("click", () => switchCategoryStore(parseInt(tab.dataset.storeId)));
    });

    if (!state.activeCategoryStoreId || !state.selectedStoreIds.includes(state.activeCategoryStoreId)) {
        switchCategoryStore(state.selectedStoreIds[0]);
    }
}

async function switchCategoryStore(storeId) {
    state.activeCategoryStoreId = storeId;
    document.querySelectorAll("#category-store-tabs .store-tab").forEach(t => {
        t.classList.toggle("active", parseInt(t.dataset.storeId) === storeId);
    });

    const catSelect = document.getElementById("field-CateID");
    const subSelect = document.getElementById("field-SubCateID");
    const manuSelect = document.getElementById("field-ManuID");

    // Load categories and manufacturers in parallel
    const [categories, manufacturers] = await Promise.all([
        getCachedLookup("categories", storeId),
        getCachedLookup("manufacturers", storeId),
    ]);

    catSelect.innerHTML = '<option value="">-- Select Category --</option>' +
        categories.map(c => `<option value="${c.CategoryID}">${c.CategoryName}</option>`).join("");

    manuSelect.innerHTML = '<option value="0">-- Select --</option>' +
        manufacturers.map(m => `<option value="${m.ManufacturerID}">${m.ManuName}</option>`).join("");

    // Restore saved values for this store
    const saved = state.perStoreData[storeId];
    if (saved?.CateID) {
        catSelect.value = saved.CateID;
        await loadSubcategories(storeId, saved.CateID);
        if (saved.SubCateID) subSelect.value = saved.SubCateID;
    } else {
        subSelect.innerHTML = '<option value="">-- Select Sub Category --</option>';
    }
    if (saved?.ManuID) {
        manuSelect.value = saved.ManuID;
    }
}

async function loadSubcategories(storeId, categoryId) {
    const subSelect = document.getElementById("field-SubCateID");
    const subs = await getCachedLookup("subcategories", storeId, categoryId);
    subSelect.innerHTML = '<option value="">-- Select Sub Category --</option>' +
        subs.map(s => `<option value="${s.SubCateID}">${s.SubCateName}</option>`).join("");
}

// Category change handlers
document.getElementById("field-CateID")?.addEventListener("change", async (e) => {
    const storeId = state.activeCategoryStoreId;
    if (!storeId) return;
    const catId = parseInt(e.target.value) || null;

    if (!state.perStoreData[storeId]) state.perStoreData[storeId] = {};
    state.perStoreData[storeId].CateID = catId;
    state.perStoreData[storeId].SubCateID = null;

    if (catId) {
        await loadSubcategories(storeId, catId);
    } else {
        document.getElementById("field-SubCateID").innerHTML =
            '<option value="">-- Select Sub Category --</option>';
    }
    renderCategoryTabs();
});

document.getElementById("field-SubCateID")?.addEventListener("change", (e) => {
    const storeId = state.activeCategoryStoreId;
    if (!storeId) return;
    if (!state.perStoreData[storeId]) state.perStoreData[storeId] = {};
    state.perStoreData[storeId].SubCateID = parseInt(e.target.value) || null;
    renderCategoryTabs();
});

document.getElementById("field-ManuID")?.addEventListener("change", (e) => {
    const storeId = state.activeCategoryStoreId;
    if (!storeId) return;
    if (!state.perStoreData[storeId]) state.perStoreData[storeId] = {};
    state.perStoreData[storeId].ManuID = parseInt(e.target.value) || null;
});

// Apply to All
document.getElementById("apply-cats-all")?.addEventListener("click", () => {
    const source = state.perStoreData[state.activeCategoryStoreId];
    if (!source?.CateID) {
        showToast("Select a category first", "warning");
        return;
    }
    state.selectedStoreIds.forEach(sid => {
        state.perStoreData[sid] = { ...source };
    });
    renderCategoryTabs();
    showToast("Categories applied to all stores", "success");
});

// ── Lookup Data Loading ────────────────────────────────
async function getCachedLookup(type, storeId, parentId) {
    const key = parentId ? `${type}-${storeId}-${parentId}` : `${type}-${storeId}`;
    if (state.lookupCache[key]) return state.lookupCache[key];

    let url;
    if (type === "categories") url = `/api/stores/${storeId}/categories`;
    else if (type === "subcategories") url = `/api/stores/${storeId}/subcategories?category_id=${parentId}`;
    else if (type === "taxes") url = `/api/stores/${storeId}/taxes`;
    else if (type === "units") url = `/api/stores/${storeId}/units`;
    else if (type === "manufacturers") url = `/api/stores/${storeId}/manufacturers`;
    else return [];

    try {
        const data = await api.get(url);
        state.lookupCache[key] = data;
        return data;
    } catch {
        return [];
    }
}

async function loadLookupData(storeId) {
    const [taxes, units] = await Promise.all([
        getCachedLookup("taxes", storeId),
        getCachedLookup("units", storeId),
    ]);

    populateSelect("field-ItemTaxID", taxes, "TaxID", "TaxName", "0", "None");
    populateSelect("field-UnitID", units, "UnitID", "UnitDesc", "14");
    populateSelect("field-UnitID2", units, "UnitID", "UnitDesc", "0", "-- None --");
    populateSelect("field-UnitID3", units, "UnitID", "UnitDesc", "0", "-- None --");
    populateSelect("field-UnitID4", units, "UnitID", "UnitDesc", "0", "-- None --");
}

function populateSelect(elementId, items, valueKey, labelKey, defaultVal, defaultLabel) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const currentVal = el.value;
    let html = defaultLabel ? `<option value="${defaultVal || ""}">${defaultLabel}</option>` : "";
    html += items.map(item => `<option value="${item[valueKey]}">${item[labelKey] || item[valueKey]}</option>`).join("");
    el.innerHTML = html;
    if (currentVal) el.value = currentVal;
}

// ── Price Formulas ─────────────────────────────────────
async function loadPriceFormulas() {
    if (state.selectedStoreIds.length === 0) return;
    try {
        const data = await api.get(`/api/price-formulas?store_ids=${state.selectedStoreIds.join(",")}`);
        state.priceFormulas = {};
        for (const [sid, formulas] of Object.entries(data)) {
            state.priceFormulas[sid] = formulas;
        }
    } catch { /* no formulas configured yet */ }
}

function bindPriceEngine() {
    // Any price field change triggers formula recalculation
    ["field-UnitCost", "field-UnitPrice", "field-UnitPriceC"].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("input", () => {
            // If user edits a field that is a formula target, mark as override
            if (el.classList.contains("auto-calculated")) {
                el.dataset.userOverride = "true";
                el.classList.remove("auto-calculated");
            }
            applyPriceFormulas();
            updateAllMargins();
        });
    });
}

function applyPriceFormulas() {
    const primaryStoreId = state.selectedStoreIds[0];
    const formulas = state.priceFormulas[primaryStoreId] || [];

    // Resolve formulas in order (allows chaining: Cost -> Price -> DeliveryB)
    for (const f of formulas) {
        const targetField = document.getElementById(`field-${f.target_field}`);
        if (!targetField || targetField.dataset.userOverride === "true") continue;

        // Get source value from the source field
        const sourceField = document.getElementById(`field-${f.source_field}`);
        const sourceVal = parseFloat(sourceField?.value) || 0;
        if (sourceVal <= 0 && f.operator !== "fixed") continue;

        let value;
        if (f.operator === "multiply") value = sourceVal * parseFloat(f.operand);
        else if (f.operator === "add") value = sourceVal + parseFloat(f.operand);
        else if (f.operator === "fixed") value = parseFloat(f.operand);
        else continue;

        targetField.value = value.toFixed(2);
        targetField.classList.add("auto-calculated");
    }
}

function updateAllMargins() {
    const cost = parseFloat(document.getElementById("field-UnitCost")?.value) || 0;
    ["UnitPrice", "UnitPriceC"].forEach(name => {
        const price = parseFloat(document.getElementById(`field-${name}`)?.value) || 0;
        const marginEl = document.getElementById(`margin-${name}`);
        if (marginEl) {
            if (price > 0 && cost > 0) {
                marginEl.textContent = `Margin: ${calculateMargin(price, cost).toFixed(1)}%`;
            } else {
                marginEl.textContent = "Margin: --";
            }
        }
    });
}

// ── Validation ─────────────────────────────────────────
function bindValidation() {
    const upcField = document.getElementById("field-ProductUPC");
    const skuField = document.getElementById("field-ProductSKU");

    if (upcField) {
        upcField.addEventListener("blur", debounce(() => validateUPCAsync(upcField.value), 300));
    }
    if (skuField) {
        skuField.addEventListener("blur", debounce(() => validateSKUAsync(skuField.value), 300));
    }
}

async function validateUPCAsync(upc) {
    if (!upc?.trim() || state.selectedStoreIds.length === 0) {
        setFieldStatus("ProductUPC", "hidden");
        return;
    }
    setFieldStatus("ProductUPC", "checking");
    try {
        const result = await api.post("/api/validate/upc", {
            upc: upc.trim(),
            store_ids: state.selectedStoreIds,
        });
        if (result.is_unique) {
            setFieldStatus("ProductUPC", "valid");
            setFieldError("ProductUPC", "");
        } else {
            setFieldStatus("ProductUPC", "invalid");
            const stores = result.found_in.map(f => f.store_name).join(", ");
            setFieldError("ProductUPC", `UPC exists in: ${stores}`);
        }
    } catch {
        setFieldStatus("ProductUPC", "hidden");
    }
}

async function validateSKUAsync(sku) {
    if (!sku?.trim() || state.selectedStoreIds.length === 0) {
        setFieldStatus("ProductSKU", "hidden");
        return;
    }
    setFieldStatus("ProductSKU", "checking");
    try {
        const result = await api.post("/api/validate/sku", {
            sku: sku.trim(),
            store_ids: state.selectedStoreIds,
        });
        if (result.is_unique) {
            setFieldStatus("ProductSKU", "valid");
            setFieldError("ProductSKU", "");
        } else {
            setFieldStatus("ProductSKU", "invalid");
            let msg = "";
            if (result.found_in?.length) msg += `SKU exists in: ${result.found_in.map(f => f.store_name).join(", ")}`;
            if (result.prefix_conflicts?.length) {
                if (msg) msg += ". ";
                msg += `Prefix conflict in: ${result.prefix_conflicts.map(f => f.store_name).join(", ")}`;
            }
            setFieldError("ProductSKU", msg);
        }
    } catch {
        setFieldStatus("ProductSKU", "hidden");
    }
}

function setFieldStatus(fieldName, status) {
    const icon = document.getElementById(`status-${fieldName}`);
    if (!icon) return;
    icon.className = "material-icons-round status-icon";
    if (status === "hidden") {
        icon.classList.add("hidden");
    } else if (status === "checking") {
        icon.classList.add("checking");
        icon.textContent = "sync";
    } else if (status === "valid") {
        icon.classList.add("valid");
        icon.textContent = "check_circle";
    } else if (status === "invalid") {
        icon.classList.add("invalid");
        icon.textContent = "error";
    }
}

function setFieldError(fieldName, message) {
    const el = document.getElementById(`error-${fieldName}`);
    if (el) el.textContent = message || "";
    const input = document.getElementById(`field-${fieldName}`);
    if (input) {
        input.classList.toggle("error", !!message);
        input.classList.toggle("success", !message && input.value?.trim());
    }
}

function validateRequired() {
    let firstError = null;
    const requiredCommon = ["ProductUPC", "ProductSKU", "ProductDescription", "UnitCost", "UnitPrice"];

    for (const name of requiredCommon) {
        const el = document.getElementById(`field-${name}`);
        if (!el || !el.value?.trim()) {
            setFieldError(name, `Required`);
            if (!firstError) firstError = el;
        } else {
            setFieldError(name, "");
        }
    }

    // Per-store categories
    for (const sid of state.selectedStoreIds) {
        const cats = state.perStoreData[sid];
        if (!cats?.CateID || !cats?.SubCateID) {
            const store = state.stores.find(s => s.id === sid);
            if (!firstError) {
                setFieldError("CateID", `Missing category for ${store?.name}`);
                firstError = document.getElementById("field-CateID");
            }
        }
    }

    if (firstError) {
        firstError.focus();
        firstError.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return !firstError;
}

// ── Collect Form Data ──────────────────────────────────
function collectFormData() {
    const getValue = (id) => {
        const el = document.getElementById(`field-${id}`);
        if (!el) return undefined;
        if (el.type === "checkbox") return el.checked ? 1 : 0;
        const val = el.value?.trim();
        return val === "" ? undefined : val;
    };

    const commonFields = {};
    const perStoreFieldNames = ["CateID", "SubCateID", "ManuID"];

    state.fieldConfigs.forEach(fc => {
        if (perStoreFieldNames.includes(fc.field_name) || !fc.is_visible) return;
        const val = getValue(fc.field_name);
        if (val !== undefined) commonFields[fc.field_name] = val;
    });

    // Always include SPPromoted
    if (commonFields.SPPromoted === undefined) commonFields.SPPromoted = 0;

    const perStoreFields = {};
    state.selectedStoreIds.forEach(sid => {
        const data = state.perStoreData[sid] || {};
        perStoreFields[sid] = {
            CateID: data.CateID,
            SubCateID: data.SubCateID,
            ManuID: data.ManuID || 0,
        };
    });

    return {
        store_ids: state.selectedStoreIds,
        common_fields: commonFields,
        per_store_fields: perStoreFields,
    };
}

// ── Save ───────────────────────────────────────────────
async function saveItem(andNew = false) {
    if (!validateRequired()) return;
    if (state.selectedStoreIds.length === 0) {
        showToast("Select at least one store", "warning");
        return;
    }

    const saveBtn = document.getElementById("btn-save");
    const saveNewBtn = document.getElementById("btn-save-new");
    saveBtn.disabled = true;
    saveNewBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span> Saving...';

    try {
        const data = collectFormData();
        const result = await api.post("/api/items", data);

        if (result.errors?.length) {
            result.errors.forEach(e => {
                setFieldError(e.field, e.error);
                showToast(e.error, "error");
            });
            return;
        }

        const succeeded = result.results.filter(r => r.success);
        const failed = result.results.filter(r => !r.success);

        if (failed.length === 0) {
            const ids = succeeded.map(r => `${r.store_name}: #${r.product_id}`).join(", ");
            showToast(`Saved to ${succeeded.length}/${result.results.length} stores. ${ids}`, "success", 8000);
            if (andNew) clearForm();
        } else if (succeeded.length > 0) {
            showToast(
                `Partial: ${succeeded.length} OK, ${failed.length} failed. ` +
                failed.map(r => `${r.store_name}: ${r.error}`).join("; "),
                "warning", 10000
            );
        } else {
            showToast(
                `All stores failed. ${failed.map(r => `${r.store_name}: ${r.error}`).join("; ")}`,
                "error", 10000
            );
        }
    } catch (err) {
        showToast(`Error: ${err.message}`, "error");
    } finally {
        saveBtn.disabled = state.selectedStoreIds.length === 0;
        saveNewBtn.disabled = state.selectedStoreIds.length === 0;
        saveBtn.innerHTML = '<span class="material-icons-round">save</span> Save to Stores <span class="shortcut-hint">Ctrl+S</span>';
    }
}

// ── Clear Form ─────────────────────────────────────────
function clearForm() {
    document.querySelectorAll("#form-sections .form-input, #form-sections .form-textarea").forEach(el => {
        if (el.type === "checkbox") {
            el.checked = false;
        } else {
            el.value = "";
            el.classList.remove("error", "success", "auto-calculated");
            delete el.dataset.userOverride;
        }
    });

    document.querySelectorAll("#form-sections .form-select").forEach(el => {
        el.selectedIndex = 0;
    });

    document.querySelectorAll(".field-error").forEach(el => el.textContent = "");
    document.querySelectorAll(".margin-display").forEach(el => el.textContent = "Margin: --");

    setFieldStatus("ProductUPC", "hidden");
    setFieldStatus("ProductSKU", "hidden");

    state.perStoreData = {};
    renderCategoryTabs();
    applyFieldDefaults(state.fieldConfigs);
    applyFieldVisibility(state.fieldConfigs);

    document.getElementById("field-ProductUPC")?.focus();
}

// ── Field Defaults ─────────────────────────────────────
function applyFieldDefaults(configs) {
    configs.forEach(fc => {
        if (fc.default_value == null || fc.is_per_store) return;
        const el = document.getElementById(`field-${fc.field_name}`);
        if (!el) return;
        if (el.type === "checkbox") {
            el.checked = fc.default_value === "1" || fc.default_value === "true";
        } else if (el.tagName === "SELECT") {
            el.value = fc.default_value;
        } else if (!el.value) {
            el.value = fc.default_value;
        }
    });
}

function applyFieldVisibility(configs) {
    // Step 1: Show/hide each field's direct container
    configs.forEach(fc => {
        const el = document.getElementById(`field-${fc.field_name}`);
        if (!el) return;

        const container = el.closest(".price-cell")
            || el.closest(".form-group")
            || el.closest("tr")
            || el.parentElement;
        if (!container) return;

        if (fc.is_visible) {
            container.classList.remove("hidden");
        } else {
            container.classList.add("hidden");
        }
    });

    // Step 2: Hide empty flex-rows (all children hidden)
    document.querySelectorAll("#form-sections .flex-row").forEach(row => {
        const hasVisible = Array.from(row.children).some(
            c => !c.classList.contains("hidden")
        );
        row.classList.toggle("hidden", !hasVisible);
    });

    // Step 3: In pricing-fields, hide individual cells by field name
    ["UnitCost", "UnitPrice", "UnitPriceA", "UnitPriceB", "UnitPriceC", "MSRPrice"].forEach(f => {
        const cell = document.getElementById(`cell-${f}`);
        if (!cell) return;
        const fc = configs.find(c => c.field_name === f);
        cell.classList.toggle("hidden", fc && !fc.is_visible);
    });

    // Step 6: Hide promotions subsection if all promo fields hidden
    const promoFields = ["PromotionID", "SPPromoted", "SPPromotionDescription", "SPPromotionCode", "ManuProductID"];
    const anyPromoVisible = promoFields.some(f => {
        const fc = configs.find(c => c.field_name === f);
        return fc && fc.is_visible;
    });
    const promoSection = document.getElementById("promotions-subsection");
    if (promoSection) promoSection.classList.toggle("hidden", !anyPromoVisible);

    // Step 7: Hide unit conversion table if all unit2/3/4 fields hidden
    const unitFields = ["UnitID2", "UnitQty2", "UnitPrice2", "UnitID3", "UnitQty3", "UnitPrice3", "UnitID4", "UnitQty4", "UnitPrice4"];
    const anyUnitVisible = unitFields.some(f => {
        const fc = configs.find(c => c.field_name === f);
        return fc && fc.is_visible;
    });
    const unitSection = document.getElementById("unit-table-section");
    if (unitSection) unitSection.classList.toggle("hidden", !anyUnitVisible);

    // Step 8: Hide entire sections if ALL their fields are hidden
    ["general", "pricing", "inventory", "extended"].forEach(sectionName => {
        const sectionEl = document.querySelector(`[data-section="${sectionName}"]`);
        if (!sectionEl) return;
        const sectionFields = configs.filter(c => c.section === sectionName);
        const anyVisible = sectionFields.some(c => c.is_visible);
        // For general section, categories are always shown (per-store), so don't hide
        if (sectionName === "general") return;
        sectionEl.classList.toggle("hidden", !anyVisible);
    });
}

// ── Action Buttons ─────────────────────────────────────
function bindActionButtons() {
    document.getElementById("btn-save")?.addEventListener("click", () => saveItem(false));
    document.getElementById("btn-save-new")?.addEventListener("click", () => saveItem(true));
    document.getElementById("btn-clear")?.addEventListener("click", () => {
        if (document.querySelector("#form-sections .form-input[value]")?.value) {
            if (confirm("Clear all form fields?")) clearForm();
        } else {
            clearForm();
        }
    });
}

// ── Keyboard Navigation ────────────────────────────────
function bindKeyboardNav() {
    document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            if (e.shiftKey) {
                saveItem(true);
            } else {
                saveItem(false);
            }
        }

        if (e.key === "Enter" && e.target.matches("input:not([type=checkbox])")) {
            e.preventDefault();
            const inputs = Array.from(
                document.querySelectorAll("#form-sections input:not([type=checkbox]):not([type=hidden]), #form-sections select, #form-sections textarea")
            ).filter(el => !el.disabled && el.offsetParent !== null);
            const idx = inputs.indexOf(e.target);
            if (idx >= 0 && idx < inputs.length - 1) {
                inputs[idx + 1].focus();
            }
        }
    });
}

// ── Section Toggle (global function for onclick) ───────
window.toggleSection = function (sectionId) {
    const section = document.getElementById(sectionId);
    if (section) section.classList.toggle("collapsed");
};

window.toggleSubsection = function (name) {
    const toggle = document.getElementById(`${name}-toggle`);
    const content = document.getElementById(`${name}-content`);
    if (toggle && content) {
        toggle.classList.toggle("collapsed");
        content.classList.toggle("collapsed");
    }
};
