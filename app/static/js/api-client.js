export class ApiError extends Error {
    constructor(status, data) {
        super(data.error || data.message || `API error ${status}`);
        this.status = status;
        this.data = data;
    }
}

export async function apiRequest(method, url, body = null) {
    const options = {
        method,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
        },
    };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
        throw new ApiError(response.status, data);
    }
    return data;
}

export const api = {
    get: (url) => apiRequest("GET", url),
    post: (url, body) => apiRequest("POST", url, body),
    put: (url, body) => apiRequest("PUT", url, body),
    delete: (url, body) => apiRequest("DELETE", url, body),
};
