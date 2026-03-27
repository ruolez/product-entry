export function debounce(fn, ms) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

export function formatCurrency(value) {
    const num = parseFloat(value);
    if (isNaN(num)) return "$0.00";
    return "$" + num.toFixed(2);
}

export function parseMoney(str) {
    if (!str) return 0;
    const cleaned = String(str).replace(/[^0-9.\-]/g, "");
    return parseFloat(cleaned) || 0;
}

export function calculateMargin(price, cost) {
    if (!price || price <= 0) return 0;
    return ((price - cost) / price) * 100;
}

export function showToast(message, type = "info", duration = 5000) {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span>${message}</span>
        <button class="toast-dismiss material-icons-round" onclick="this.parentElement.remove()">close</button>
    `;
    container.appendChild(toast);
    if (duration > 0) {
        setTimeout(() => toast.remove(), duration);
    }
}

export function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}
