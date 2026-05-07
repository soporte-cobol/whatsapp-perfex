const axios = require('axios');

class PerfexService {
    constructor(baseUrl, apiToken) {
        this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        this.apiToken = apiToken;
        this.bridgeUrl = `${this.baseUrl}/perfex_bridge.php`;
    }

    async _request(action, params = {}) {
        try {
            const response = await axios.get(this.bridgeUrl, {
                params: { ...params, action, token: this.apiToken },
                timeout: 8000
            });
            return response.data;
        } catch (e) {
            console.error(`❌ CRM Error (${action}):`, e.message);
            return null;
        }
    }

    async getCustomerByPhone(phone) { return this._request('get_customer_by_phone', { phone }); }
    async getCustomerByEmail(email) { return this._request('get_customer_by_email', { email }); }
    async getCustomerByVat(vat) { return this._request('get_customer_by_vat', { vat }); }
    
    async getInvoices(customer_id, limit = 5) { return this._request('get_invoices', { customer_id, limit }) || []; }
    async getProjects(customer_id, limit = 3) { return this._request('get_projects', { customer_id, limit }) || []; }
    async getContracts(customer_id, limit = 3) { return this._request('get_contracts', { customer_id, limit }) || []; }
    async getTickets(email, limit = 3) { return this._request('get_tickets', { email, limit }) || []; }
}

module.exports = PerfexService;