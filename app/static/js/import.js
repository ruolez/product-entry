import { api } from "./api-client.js";
import { showToast, escapeHtml } from "./utils.js";

const STEPS = [
    { num: 1, label: "Upload" },
    { num: 2, label: "Mapping" },
    { num: 3, label: "Stores & Prices" },
    { num: 4, label: "Validate" },
    { num: 5, label: "Import" },
];

const PRICE_FIELDS = [
    { field: "UnitCost", label: "Unit Cost" },
    { field: "UnitPrice", label: "Standard Price" },
    { field: "UnitPriceA", label: "Cash & Carry" },
    { field: "UnitPriceB", label: "Delivery A" },
    { field: "UnitPriceC", label: "Delivery B" },
    { field: "MSRPrice", label: "MSRP" },
];

const REQUIRED_MAPPINGS = ["ProductUPC", "ProductDescription"];

// Step 2: only universal fields shared across all stores
const MAPPING_FIELDS = [
    { field: "ProductUPC", label: "UPC", required: true },
    { field: "ProductSKU", label: "SKU", required: false },
    { field: "ProductDescription", label: "Description", required: true },
];

// Step 3: per-store fields (category + prices) mapped inside each store panel
const STORE_MAPPING_FIELDS = [
    { field: "CateName", label: "Category", required: false },
    { field: "SubCateName", label: "Subcategory", required: false },
    { field: "UnitCost", label: "Unit Cost", required: false },
    { field: "UnitPrice", label: "Standard Price", required: false },
    { field: "UnitPriceA", label: "Cash & Carry", required: false },
    { field: "UnitPriceB", label: "Delivery A", required: false },
    { field: "UnitPriceC", label: "Delivery B", required: false },
    { field: "MSRPrice", label: "MSRP", required: false },
];

let state = {
    currentStep: 1,
    uploadId: null,
    sheets: [],
    activeSheet: null,
    headers: [],
    previewRows: [],
    totalRows: 0,
    columnMapping: {},
    stores: [],
    selectedStoreIds: [],
    categoryMatches: {},
    categoryAssignments: {},
    priceMode: {},
    priceMapping: {},
    validationResults: null,
    skipRows: new Set(),
    importResult: null,
    priceFormulas: {},
};

let modalEl = null;

export function initImport(stores, selectedStoreIds, priceFormulas) {
    state.stores = stores || [];
    state.selectedStoreIds = selectedStoreIds || [];
    state.priceFormulas = priceFormulas || {};
}

export function openImportModal() {
    if (modalEl) return;
    resetState();
    createModal();
    renderStep(1);
}

function resetState() {
    state.currentStep = 1;
    state.uploadId = null;
    state.sheets = [];
    state.activeSheet = null;
    state.headers = [];
    state.previewRows = [];
    state.totalRows = 0;
    state.columnMapping = {};
    state.categoryMatches = {};
    state.categoryAssignments = {};
    state.priceMode = {};
    state.priceMapping = {};
    state.validationResults = null;
    state.skipRows = new Set();
    state.importResult = null;

    for (const store of state.stores) {
        state.priceMode[String(store.id)] = "formula";
    }
}

function closeModal() {
    if (modalEl) {
        modalEl.remove();
        modalEl = null;
    }
}

function createModal() {
    modalEl = document.createElement("div");
    modalEl.className = "import-overlay";
    modalEl.innerHTML = `
        <div class="import-wizard">
            <div class="import-header">
                <h2><span class="material-icons-round">upload_file</span> Import from Excel</h2>
                <button class="import-close-btn" id="import-close">
                    <span class="material-icons-round">close</span>
                </button>
            </div>
            <div class="import-steps" id="import-steps"></div>
            <div class="import-content" id="import-content"></div>
            <div class="import-footer" id="import-footer"></div>
        </div>
    `;
    document.body.appendChild(modalEl);

    modalEl.querySelector("#import-close").addEventListener("click", closeModal);
    modalEl.addEventListener("click", (e) => {
        if (e.target === modalEl) closeModal();
    });
}

function renderStepIndicators() {
    const container = modalEl.querySelector("#import-steps");
    const parts = [];
    for (let i = 0; i < STEPS.length; i++) {
        const step = STEPS[i];
        let cls = "";
        if (step.num < state.currentStep) cls = "completed";
        else if (step.num === state.currentStep) cls = "active";
        parts.push(`<div class="import-step-indicator ${cls}">
            <span class="step-number">${cls === "completed" ? '<span class="material-icons-round" style="font-size:16px">check</span>' : step.num}</span>
            <span class="step-label">${step.label}</span>
        </div>`);
        if (i < STEPS.length - 1) {
            parts.push(`<div class="step-connector ${step.num < state.currentStep ? "done" : ""}"></div>`);
        }
    }
    container.innerHTML = parts.join("");
}

function renderStep(step) {
    state.currentStep = step;
    renderStepIndicators();

    const content = modalEl.querySelector("#import-content");
    const footer = modalEl.querySelector("#import-footer");

    switch (step) {
        case 1: renderUploadStep(content, footer); break;
        case 2: renderMappingStep(content, footer); break;
        case 3: renderStoreStep(content, footer); break;
        case 4: renderValidationStep(content, footer); break;
        case 5: renderExecuteStep(content, footer); break;
    }
}

// ── Step 1: Upload ────────────────────────────────────────

function renderUploadStep(content, footer) {
    content.innerHTML = `
        <div class="import-upload-zone" id="import-drop-zone">
            <span class="material-icons-round">upload_file</span>
            <p>Drag & drop an Excel file here</p>
            <p class="upload-hint">Accepts .xlsx files only</p>
            <input type="file" accept=".xlsx" hidden id="import-file-input">
        </div>
        <div id="import-file-result"></div>
    `;
    footer.innerHTML = `
        <div class="import-footer-left"></div>
        <div class="import-footer-right">
            <button class="btn btn-primary" id="import-next" disabled>Next</button>
        </div>
    `;

    const zone = content.querySelector("#import-drop-zone");
    const input = content.querySelector("#import-file-input");

    zone.addEventListener("click", () => input.click());
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dragover"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("dragover");
        const file = e.dataTransfer.files[0];
        if (file) handleFileUpload(file);
    });
    input.addEventListener("change", () => {
        if (input.files[0]) handleFileUpload(input.files[0]);
    });

    footer.querySelector("#import-next").addEventListener("click", () => renderStep(2));

    if (state.uploadId) {
        showFileResult(content);
        footer.querySelector("#import-next").disabled = false;
    }
}

async function handleFileUpload(file) {
    if (!file.name.endsWith(".xlsx")) {
        showToast("Only .xlsx files are accepted", "error");
        return;
    }

    const content = modalEl.querySelector("#import-content");
    const resultDiv = content.querySelector("#import-file-result");
    resultDiv.innerHTML = `<div class="import-loading"><div class="spinner"></div><p>Parsing file...</p></div>`;

    try {
        const formData = new FormData();
        formData.append("file", file);
        const data = await api.upload("/api/import/upload", formData);

        state.uploadId = data.upload_id;
        state.sheets = data.sheets || [];
        state.activeSheet = data.active_sheet;
        state.headers = data.headers || [];
        state.previewRows = data.preview_rows || [];
        state.totalRows = data.total_rows || 0;
        state.columnMapping = data.auto_mapping || {};

        showFileResult(content);
        modalEl.querySelector("#import-next").disabled = false;
    } catch (err) {
        resultDiv.innerHTML = "";
        showToast(err.message || "Failed to parse file", "error");
    }
}

function showFileResult(content) {
    const resultDiv = content.querySelector("#import-file-result");
    let sheetsHtml = "";
    if (state.sheets.length > 1) {
        const opts = state.sheets.map(s =>
            `<option value="${escapeHtml(s)}" ${s === state.activeSheet ? "selected" : ""}>${escapeHtml(s)}</option>`
        ).join("");
        sheetsHtml = `
            <div class="import-sheet-selector">
                <label>Sheet:</label>
                <select id="import-sheet-select">${opts}</select>
            </div>
        `;
    }

    resultDiv.innerHTML = `
        <div class="import-file-info">
            <span class="material-icons-round">description</span>
            <div class="file-details">
                <div class="file-name">${state.activeSheet || "Sheet 1"}</div>
                <div class="file-stats">${state.totalRows} data rows, ${state.headers.length} columns</div>
            </div>
        </div>
        ${sheetsHtml}
    `;

    if (state.sheets.length > 1) {
        resultDiv.querySelector("#import-sheet-select").addEventListener("change", async (e) => {
            const sheet = e.target.value;
            try {
                const data = await api.post("/api/import/select-sheet", {
                    upload_id: state.uploadId,
                    sheet_name: sheet,
                });
                state.activeSheet = data.active_sheet;
                state.headers = data.headers || [];
                state.previewRows = data.preview_rows || [];
                state.totalRows = data.total_rows || 0;
                state.columnMapping = data.auto_mapping || {};
                showFileResult(content);
            } catch (err) {
                showToast(err.message || "Failed to load sheet", "error");
            }
        });
    }
}

// ── Step 2: Column Mapping ────────────────────────────────

function renderMappingStep(content, footer) {
    const mappingRows = MAPPING_FIELDS.map(f => {
        const isReq = f.required;
        const currentIdx = state.columnMapping[f.field];
        const isMapped = currentIdx !== undefined && currentIdx !== null && currentIdx !== "";
        const opts = [`<option value="">-- Not mapped --</option>`];
        state.headers.forEach((h, i) => {
            const sel = currentIdx === i ? "selected" : "";
            opts.push(`<option value="${i}" ${sel}>${escapeHtml(h)} (Col ${i + 1})</option>`);
        });
        const reqClass = isReq ? "required" : "";
        const mapClass = isMapped ? "mapped" : (isReq ? "unmapped" : "");
        return `
            <div class="import-mapping-row ${reqClass} ${mapClass}" data-field="${f.field}">
                <span class="mapping-field-name">${f.label}${isReq ? ' <span class="required-star">*</span>' : ""}</span>
                <span class="material-icons-round mapping-arrow">arrow_forward</span>
                <select class="mapping-select" data-field="${f.field}">${opts.join("")}</select>
            </div>
        `;
    }).join("");

    const mappedIndices = new Set(Object.values(state.columnMapping).filter(v => v !== undefined && v !== null));

    const previewHtml = buildPreviewTable(mappedIndices);

    content.innerHTML = `
        <div class="import-mapping-section">
            <h3>Map Excel Columns to Fields</h3>
            <p class="text-sm text-muted" style="margin-bottom: var(--md-spacing-md);">
                Fields marked with <span style="color:var(--md-error)">*</span> are required. Auto-detected mappings are shown below.
            </p>
            <div class="import-mapping-grid">${mappingRows}</div>
        </div>
        <div style="margin-top: var(--md-spacing-lg);">
            <h3>Preview (first 5 rows)</h3>
            <div style="overflow-x:auto;">${previewHtml}</div>
        </div>
    `;

    footer.innerHTML = `
        <div class="import-footer-left">
            <button class="btn btn-secondary" id="import-back">Back</button>
        </div>
        <div class="import-footer-right">
            <button class="btn btn-primary" id="import-next" ${canProceedStep2() ? "" : "disabled"}>Next</button>
        </div>
    `;

    content.querySelectorAll(".mapping-select").forEach(sel => {
        sel.addEventListener("change", (e) => {
            const field = e.target.dataset.field;
            const val = e.target.value;
            if (val === "") {
                delete state.columnMapping[field];
            } else {
                state.columnMapping[field] = parseInt(val);
            }
            renderMappingStep(content, footer);
        });
    });

    footer.querySelector("#import-back").addEventListener("click", () => renderStep(1));
    footer.querySelector("#import-next").addEventListener("click", () => renderStep(3));
}

function canProceedStep2() {
    return REQUIRED_MAPPINGS.every(f => state.columnMapping[f] !== undefined && state.columnMapping[f] !== null);
}

function buildPreviewTable(mappedIndices) {
    if (!state.previewRows.length) return "<p class='text-muted'>No preview data</p>";
    let html = `<table class="import-preview-table"><thead><tr><th>#</th>`;
    state.headers.forEach((h, i) => {
        const cls = mappedIndices.has(i) ? "mapped" : "";
        html += `<th class="${cls}">${escapeHtml(h)}</th>`;
    });
    html += `</tr></thead><tbody>`;
    state.previewRows.forEach((row, ri) => {
        html += `<tr><td>${ri + 1}</td>`;
        row.forEach((cell, ci) => {
            const cls = mappedIndices.has(ci) ? "mapped" : "";
            html += `<td class="${cls}">${escapeHtml(String(cell))}</td>`;
        });
        html += `</tr>`;
    });
    html += `</tbody></table>`;
    return html;
}

// ── Step 3: Store Selection & Price/Category Config ───────

async function renderStoreStep(content, footer) {
    footer.innerHTML = `
        <div class="import-footer-left">
            <button class="btn btn-secondary" id="import-back">Back</button>
        </div>
        <div class="import-footer-right">
            <button class="btn btn-primary" id="import-next" disabled>Next</button>
        </div>
    `;
    footer.querySelector("#import-back").addEventListener("click", () => renderStep(2));

    renderStoreStepContent(content, footer);
}

function initCategoryAssignments() {
    for (const [sid, matchData] of Object.entries(state.categoryMatches)) {
        if (!state.categoryAssignments[sid]) {
            state.categoryAssignments[sid] = {};
        }
        const subs = matchData.subcategories || {};
        for (const [text, info] of Object.entries(subs)) {
            if (info.matched && !state.categoryAssignments[sid][text]) {
                state.categoryAssignments[sid][text] = {
                    SubCateID: info.SubCateID,
                    CateID: info.CateID,
                };
            }
        }
    }
}

async function fetchCategoryMatches() {
    const hasCatMapping = state.columnMapping.SubCateName !== undefined;
    if (!hasCatMapping || !state.selectedStoreIds.length) {
        state.categoryMatches = {};
        return;
    }
    try {
        const data = await api.post("/api/import/match-categories", {
            upload_id: state.uploadId,
            store_ids: state.selectedStoreIds,
            column_mapping: state.columnMapping,
            sheet_name: state.activeSheet,
        });
        state.categoryMatches = data;
        initCategoryAssignments();
    } catch (err) {
        showToast(err.message || "Failed to match categories", "error");
    }
}

function renderStoreStepContent(content, footer) {
    const storeChips = state.stores
        .filter(s => s.is_active)
        .map(s => {
            const sel = state.selectedStoreIds.includes(s.id) ? "selected" : "";
            return `<div class="store-chip ${sel}" data-id="${s.id}">
                <span class="material-icons-round chip-check">check</span>
                ${escapeHtml(s.name)}
            </div>`;
        }).join("");

    const panels = state.selectedStoreIds.map(sid => renderStorePanel(sid)).join("");

    content.innerHTML = `
        <div class="import-subsection">
            <div class="import-subsection-label">
                <span class="material-icons-round" style="font-size:18px">store</span> Select Stores
            </div>
            <div class="store-selector" style="margin-bottom:0">${storeChips}</div>
        </div>
        <p class="text-sm text-muted" style="margin-top:var(--md-spacing-sm);">
            Unmapped fields will use defaults from Settings. Price formulas apply when "Use price formulas" is selected.
        </p>
        <div style="margin-top: var(--md-spacing-md); display: flex; align-items: center; gap: var(--md-spacing-sm);">
            <button class="copy-all-btn" id="import-copy-store">Copy first store's settings to all</button>
        </div>
        <div class="import-store-panels" style="margin-top: var(--md-spacing-md);">${panels}</div>
    `;

    footer.querySelector("#import-next").disabled = !canProceedStep3();
    footer.querySelector("#import-next").addEventListener("click", () => renderStep(4));

    content.querySelectorAll(".store-chip[data-id]").forEach(chip => {
        chip.addEventListener("click", () => {
            const id = parseInt(chip.dataset.id);
            if (state.selectedStoreIds.includes(id)) {
                state.selectedStoreIds = state.selectedStoreIds.filter(x => x !== id);
            } else {
                state.selectedStoreIds.push(id);
            }
            renderStoreStepContent(content, footer);
        });
    });

    content.querySelectorAll('input[name^="price-mode-"]').forEach(radio => {
        radio.addEventListener("change", (e) => {
            const sid = e.target.name.replace("price-mode-", "");
            state.priceMode[sid] = e.target.value;
            renderStoreStepContent(content, footer);
        });
    });

    content.querySelectorAll(".price-mapping-select").forEach(sel => {
        sel.addEventListener("change", (e) => {
            const sid = e.target.dataset.store;
            const field = e.target.dataset.field;
            if (!state.priceMapping[sid]) state.priceMapping[sid] = {};
            if (e.target.value === "") {
                delete state.priceMapping[sid][field];
            } else {
                state.priceMapping[sid][field] = e.target.value;
            }
        });
    });

    // Per-store category/subcategory column mapping selects
    content.querySelectorAll(".store-col-mapping-select").forEach(sel => {
        sel.addEventListener("change", async (e) => {
            const field = e.target.dataset.field;
            const val = e.target.value;
            if (val === "") {
                delete state.columnMapping[field];
            } else {
                state.columnMapping[field] = parseInt(val);
            }
            // Re-fetch category matches with updated mapping
            state.categoryMatches = {};
            state.categoryAssignments = {};
            await fetchCategoryMatches();
            renderStoreStepContent(content, footer);
        });
    });

    content.querySelectorAll(".category-manual-select").forEach(sel => {
        sel.addEventListener("change", (e) => {
            const sid = e.target.dataset.store;
            const subText = e.target.dataset.subtext;
            const val = e.target.value;
            if (!state.categoryAssignments[sid]) state.categoryAssignments[sid] = {};
            if (val) {
                const parts = val.split("|");
                state.categoryAssignments[sid][subText] = {
                    SubCateID: parseInt(parts[0]),
                    CateID: parseInt(parts[1]),
                };
            } else {
                delete state.categoryAssignments[sid][subText];
            }
            footer.querySelector("#import-next").disabled = !canProceedStep3();
        });
    });

    content.querySelector("#import-copy-store")?.addEventListener("click", () => {
        if (!state.selectedStoreIds.length) return;
        const firstSid = String(state.selectedStoreIds[0]);
        const firstMode = state.priceMode[firstSid] || "formula";
        const firstMapping = state.priceMapping[firstSid] || {};
        for (const sid of state.selectedStoreIds) {
            const s = String(sid);
            state.priceMode[s] = firstMode;
            state.priceMapping[s] = { ...firstMapping };
        }
        renderStoreStepContent(content, footer);
        showToast("Settings copied to all stores", "info");
    });
}

function buildColumnSelect(field, label) {
    const currentIdx = state.columnMapping[field];
    const opts = [`<option value="">-- Not mapped (use default) --</option>`];
    state.headers.forEach((h, i) => {
        const sel = currentIdx === i ? "selected" : "";
        opts.push(`<option value="${i}" ${sel}>${escapeHtml(h)} (Col ${i + 1})</option>`);
    });
    return `
        <div class="price-mapping-item">
            <label>${label}</label>
            <select class="store-col-mapping-select" data-field="${field}">${opts.join("")}</select>
        </div>
    `;
}

function renderStorePanel(storeId) {
    const sid = String(storeId);
    const store = state.stores.find(s => s.id === storeId);
    const name = store ? store.name : `Store ${storeId}`;

    const mode = state.priceMode[sid] || "formula";
    const hasFormulas = state.priceFormulas[sid] && state.priceFormulas[sid].length > 0;

    // Category/Subcategory column mapping (shared columns but shown per-store for context)
    const catSubHtml = `
        <div class="price-mapping-grid">
            ${buildColumnSelect("CateName", "Category")}
            ${buildColumnSelect("SubCateName", "Subcategory")}
        </div>
    `;

    // Category match results
    let categoryMatchHtml = "";
    const matchData = state.categoryMatches[sid];
    if (matchData && matchData.subcategories && Object.keys(matchData.subcategories).length) {
        const subs = matchData.subcategories;
        const allSubs = matchData.all_subcategories || [];
        const items = Object.entries(subs).map(([text, info]) => {
            const assignment = (state.categoryAssignments[sid] || {})[text];
            const isAssigned = assignment && assignment.SubCateID;
            if (info.matched) {
                return `
                    <div class="category-match-item matched">
                        <span class="material-icons-round match-icon">check_circle</span>
                        <span class="match-text">${escapeHtml(text)}</span>
                        <span class="match-mapped">${escapeHtml(info.CategoryName || "")} > ${escapeHtml(info.SubCateName || "")}</span>
                    </div>
                `;
            } else {
                const opts = [`<option value="">-- Select subcategory --</option>`];
                allSubs.forEach(s => {
                    const val = `${s.SubCateID}|${s.CategoryID}`;
                    const sel = isAssigned && assignment.SubCateID === s.SubCateID ? "selected" : "";
                    opts.push(`<option value="${val}" ${sel}>${escapeHtml(s.CategoryName)} > ${escapeHtml(s.SubCateName)}</option>`);
                });
                return `
                    <div class="category-match-item unmatched">
                        <span class="material-icons-round match-icon">${isAssigned ? "check_circle" : "error"}</span>
                        <span class="match-text">${escapeHtml(text)}</span>
                        <select class="category-manual-select" data-store="${sid}" data-subtext="${escapeHtml(text)}">${opts.join("")}</select>
                    </div>
                `;
            }
        }).join("");
        categoryMatchHtml = `<div class="category-match-list" style="margin-top:var(--md-spacing-sm)">${items}</div>`;
    } else if (state.columnMapping.SubCateName !== undefined) {
        categoryMatchHtml = `<p class="text-sm text-muted" style="margin-top:var(--md-spacing-sm)">No subcategory values found in file.</p>`;
    }

    // Price mapping
    let priceMappingHtml = "";
    if (mode === "excel") {
        const items = PRICE_FIELDS.map(pf => {
            const currentMap = (state.priceMapping[sid] || {})[pf.field] || "";
            const opts = [`<option value="">-- Not mapped (use default) --</option>`];
            state.headers.forEach((h, i) => {
                const sel = currentMap === String(i) ? "selected" : "";
                opts.push(`<option value="${i}" ${sel}>${escapeHtml(h)} (Col ${i + 1})</option>`);
            });
            return `
                <div class="price-mapping-item">
                    <label>${pf.label}</label>
                    <select class="price-mapping-select" data-store="${sid}" data-field="${pf.field}">${opts.join("")}</select>
                </div>
            `;
        }).join("");
        priceMappingHtml = `<div class="price-mapping-grid">${items}</div>`;
    } else {
        priceMappingHtml = `<p class="text-sm text-muted">Prices will be calculated from formulas in Settings${hasFormulas ? "" : " (no formulas configured — defaults apply)"}.</p>`;
    }

    return `
        <div class="import-store-panel" data-store="${sid}">
            <div class="import-store-panel-header">
                <h4>
                    <span class="material-icons-round" style="font-size:18px">store</span>
                    ${escapeHtml(name)}
                </h4>
            </div>
            <div class="import-store-panel-body">
                <div class="import-subsection">
                    <div class="import-subsection-label">
                        <span class="material-icons-round" style="font-size:16px">category</span> Category / Subcategory
                    </div>
                    ${catSubHtml}
                    ${categoryMatchHtml}
                </div>
                <div class="import-subsection">
                    <div class="import-subsection-label">
                        <span class="material-icons-round" style="font-size:16px">attach_money</span> Pricing
                    </div>
                    <div class="price-mode-toggle">
                        <label class="${mode === "excel" ? "price-mode-active" : ""}">
                            <input type="radio" name="price-mode-${sid}" value="excel" ${mode === "excel" ? "checked" : ""}>
                            Excel columns
                        </label>
                        <label class="${mode === "formula" ? "price-mode-active" : ""}">
                            <input type="radio" name="price-mode-${sid}" value="formula" ${mode === "formula" ? "checked" : ""}>
                            Price formulas
                        </label>
                    </div>
                    ${priceMappingHtml}
                </div>
            </div>
        </div>
    `;
}

function canProceedStep3() {
    if (!state.selectedStoreIds.length) return false;
    // Check all unmatched categories have manual assignments
    for (const sid of state.selectedStoreIds) {
        const s = String(sid);
        const matchData = state.categoryMatches[s];
        if (!matchData) continue;
        const subs = matchData.subcategories || {};
        for (const [text, info] of Object.entries(subs)) {
            if (!info.matched) {
                const assignment = (state.categoryAssignments[s] || {})[text];
                if (!assignment || !assignment.SubCateID) return false;
            }
        }
    }
    return true;
}

// ── Step 4: Validation ────────────────────────────────────

async function renderValidationStep(content, footer) {
    content.innerHTML = `<div class="import-loading"><div class="spinner"></div><p>Validating all rows...</p></div>`;
    footer.innerHTML = `
        <div class="import-footer-left">
            <button class="btn btn-secondary" id="import-back">Back</button>
        </div>
        <div class="import-footer-right">
            <button class="btn btn-primary" id="import-next" disabled>Import</button>
        </div>
    `;
    footer.querySelector("#import-back").addEventListener("click", () => renderStep(3));

    try {
        const mergedAssignments = buildMergedAssignments();
        const data = await api.post("/api/import/validate", {
            upload_id: state.uploadId,
            store_ids: state.selectedStoreIds,
            column_mapping: state.columnMapping,
            category_assignments: mergedAssignments,
            sheet_name: state.activeSheet,
        });
        state.validationResults = data;
        state.skipRows = new Set();
        // Auto-skip duplicates
        for (const row of data.rows) {
            if (row.status === "duplicate") {
                state.skipRows.add(row.row_index);
            }
        }
        renderValidationReport(content, footer);
    } catch (err) {
        content.innerHTML = `<p class="text-error">Validation failed: ${escapeHtml(err.message)}</p>`;
        showToast(err.message || "Validation failed", "error");
    }
}

function buildMergedAssignments() {
    const merged = {};
    for (const sid of state.selectedStoreIds) {
        const s = String(sid);
        merged[s] = {};
        const matchData = state.categoryMatches[s];
        if (!matchData) continue;
        const subs = matchData.subcategories || {};
        for (const [text, info] of Object.entries(subs)) {
            if (info.matched) {
                merged[s][text] = { SubCateID: info.SubCateID, CateID: info.CateID };
            }
        }
        const manual = state.categoryAssignments[s] || {};
        for (const [text, data] of Object.entries(manual)) {
            if (data.SubCateID) {
                merged[s][text] = data;
            }
        }
    }
    return merged;
}

function renderValidationReport(content, footer) {
    const data = state.validationResults;
    const validCount = data.rows.filter(r => r.status === "valid").length;
    const dupCount = data.rows.filter(r => r.status === "duplicate").length;
    const errCount = data.rows.filter(r => r.status === "error").length;
    const importableCount = data.rows.filter(r => r.status === "valid" && !state.skipRows.has(r.row_index)).length;

    const summaryHtml = `
        <div class="import-validation-summary">
            <div class="validation-stat total">
                <span class="material-icons-round">list</span>
                ${data.total_rows} Total
            </div>
            <div class="validation-stat valid">
                <span class="material-icons-round">check_circle</span>
                ${validCount} Valid
            </div>
            <div class="validation-stat duplicate">
                <span class="material-icons-round">content_copy</span>
                ${dupCount} Duplicate
            </div>
            <div class="validation-stat error">
                <span class="material-icons-round">error</span>
                ${errCount} Errors
            </div>
        </div>
    `;

    const rowsHtml = data.rows.map(row => {
        const isSkipped = state.skipRows.has(row.row_index);
        const errorsText = (row.errors || []).map(e => `${e.field}: ${e.error}`).join("; ");
        return `
            <tr class="status-${row.status} ${isSkipped ? "skipped" : ""}">
                <td>
                    <input type="checkbox" class="skip-check" data-row="${row.row_index}"
                        ${isSkipped ? "" : "checked"} ${row.status === "error" ? "disabled" : ""}>
                </td>
                <td>${row.row_index + 1}</td>
                <td>${escapeHtml(row.upc || "")}</td>
                <td>${escapeHtml(row.sku || "")}</td>
                <td>${escapeHtml(row.description || "")}</td>
                <td><span class="row-status-badge ${row.status}">${row.status}</span></td>
                <td class="row-errors">${errorsText ? escapeHtml(errorsText) : ""}</td>
            </tr>
        `;
    }).join("");

    content.innerHTML = `
        ${summaryHtml}
        <p class="text-sm text-muted" style="margin-bottom: var(--md-spacing-sm);">
            Uncheck rows to skip them. Duplicates are auto-skipped. Error rows cannot be imported.
        </p>
        <div class="import-validation-scroll">
            <table class="import-validation-table">
                <thead>
                    <tr>
                        <th style="width:40px"></th>
                        <th>Row</th>
                        <th>UPC</th>
                        <th>SKU</th>
                        <th>Description</th>
                        <th>Status</th>
                        <th>Issues</th>
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>
    `;

    const nextBtn = footer.querySelector("#import-next");
    nextBtn.disabled = importableCount === 0;
    nextBtn.textContent = `Import ${importableCount} Items`;
    nextBtn.addEventListener("click", () => renderStep(5));

    content.querySelectorAll(".skip-check").forEach(cb => {
        cb.addEventListener("change", (e) => {
            const rowIdx = parseInt(e.target.dataset.row);
            if (e.target.checked) {
                state.skipRows.delete(rowIdx);
            } else {
                state.skipRows.add(rowIdx);
            }
            const newImportable = data.rows.filter(r => r.status === "valid" && !state.skipRows.has(r.row_index)).length;
            nextBtn.disabled = newImportable === 0;
            nextBtn.textContent = `Import ${newImportable} Items`;
        });
    });
}

// ── Step 5: Execute & Results ─────────────────────────────

async function renderExecuteStep(content, footer) {
    footer.innerHTML = `
        <div class="import-footer-left"></div>
        <div class="import-footer-right">
            <button class="btn btn-secondary" id="import-done" style="display:none">Close</button>
        </div>
    `;
    footer.querySelector("#import-done")?.addEventListener("click", closeModal);

    content.innerHTML = `
        <div class="import-progress">
            <div class="import-progress-bar"><div class="import-progress-fill" id="import-progress-fill" style="width:0%"></div></div>
            <div class="import-progress-text" id="import-progress-text">Starting import...</div>
        </div>
        <div id="import-results-area"></div>
    `;

    try {
        const mergedAssignments = buildMergedAssignments();

        // Build price mapping: convert col indices to field keys the backend can use
        const priceMappingForBackend = {};
        for (const [sid, mapping] of Object.entries(state.priceMapping)) {
            priceMappingForBackend[sid] = {};
            for (const [field, colIdx] of Object.entries(mapping)) {
                // The backend will look up the value from the row using the mapped field name
                // We need to tell it which column maps to which price field
                priceMappingForBackend[sid][field] = colIdx;
            }
        }

        const data = await api.post("/api/import/execute", {
            upload_id: state.uploadId,
            store_ids: state.selectedStoreIds,
            column_mapping: state.columnMapping,
            category_assignments: mergedAssignments,
            price_mode: state.priceMode,
            price_mapping: priceMappingForBackend,
            skip_rows: Array.from(state.skipRows),
            sheet_name: state.activeSheet,
        });

        state.importResult = data;
        renderFinalSummary(content, footer, data);
    } catch (err) {
        content.innerHTML = `<p class="text-error">Import failed: ${escapeHtml(err.message)}</p>`;
        showToast(err.message || "Import failed", "error");
        footer.querySelector("#import-done").style.display = "";
    }
}

function renderFinalSummary(content, footer, data) {
    const progressFill = content.querySelector("#import-progress-fill");
    const progressText = content.querySelector("#import-progress-text");
    if (progressFill) progressFill.style.width = "100%";
    if (progressText) progressText.textContent = "Import complete!";

    const resultsArea = content.querySelector("#import-results-area");

    const detailRows = data.results
        .filter(r => r.status !== "skipped")
        .map(r => {
            const icon = r.status === "success"
                ? '<span class="material-icons-round" style="color:var(--md-success);font-size:18px">check_circle</span>'
                : '<span class="material-icons-round" style="color:var(--md-error);font-size:18px">error</span>';
            const errText = r.errors ? r.errors.map(e => `${e.field}: ${e.error}`).join("; ") : "";
            const storeResults = (r.results || []).map(sr => {
                const sIcon = sr.success ? "check" : "close";
                const sColor = sr.success ? "var(--md-success)" : "var(--md-error)";
                return `<span style="color:${sColor};font-size:0.75rem;display:inline-flex;align-items:center;gap:2px;margin-right:8px">
                    <span class="material-icons-round" style="font-size:14px">${sIcon}</span>${escapeHtml(sr.store_name)}
                </span>`;
            }).join("");
            return `
            <tr>
                <td>${icon}</td>
                <td>${r.row_index + 1}</td>
                <td>${escapeHtml(r.upc || "")}</td>
                <td>${escapeHtml(r.description || "")}</td>
                <td>${storeResults}${errText ? `<div class="row-errors">${escapeHtml(errText)}</div>` : ""}</td>
            </tr>
        `;
    }).join("");

    resultsArea.innerHTML = `
        <div class="import-results-summary">
            <div class="result-stat-card total">
                <div class="stat-number">${data.total}</div>
                <div class="stat-label">Total Rows</div>
            </div>
            <div class="result-stat-card succeeded">
                <div class="stat-number">${data.succeeded}</div>
                <div class="stat-label">Succeeded</div>
            </div>
            <div class="result-stat-card failed">
                <div class="stat-number">${data.failed}</div>
                <div class="stat-label">Failed</div>
            </div>
            <div class="result-stat-card skipped">
                <div class="stat-number">${data.skipped}</div>
                <div class="stat-label">Skipped</div>
            </div>
        </div>
        <div class="import-results-detail">
            <table class="import-validation-table">
                <thead>
                    <tr>
                        <th style="width:40px"></th>
                        <th>Row</th>
                        <th>UPC</th>
                        <th>Description</th>
                        <th>Result</th>
                    </tr>
                </thead>
                <tbody>${detailRows}</tbody>
            </table>
        </div>
    `;

    footer.querySelector("#import-done").style.display = "";

    if (data.succeeded > 0) {
        showToast(`Successfully imported ${data.succeeded} items`, "success");
    }
    if (data.failed > 0) {
        showToast(`${data.failed} items failed to import`, "error");
    }
}
