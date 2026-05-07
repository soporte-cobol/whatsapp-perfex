/**
 * Servicio para interactuar con la API de Perfex CRM
 */
const axios = require('axios');

class PerfexService {
    constructor(baseUrl, apiToken) {
        this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
        // Limpieza profunda del token para evitar caracteres invisibles
        this.apiToken = String(apiToken || '').trim();
        this.headers = {
            'Authorization': `Bearer ${this.apiToken}`
        };
    }

    async _request(method, params = {}, data = null) {
        const config = {
            method,
            url: `${this.baseUrl}/perfex_bridge.php`,
            headers: this.headers,
            params: {
                ...params,
                token: this.apiToken // Duplicamos en params por si el server bloquea el header
            },
            timeout: 7000 // Reducido a 7s para mayor estabilidad
        };
        if (data) config.data = data;

        try {
            // Log de depuración antes de enviar
            console.log(`📡 CRM REQ: ${params.action || method} | URL: ${config.url}`);
            const response = await axios(config);
            console.log(`✅ CRM RES: ${response.status} (OK)`);
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 401) {
                const bridgeUrl = `${this.baseUrl}/perfex_bridge.php`;
                console.error(`🚫 CRM AUTH ERROR (401): Revisa el token en .env y bridge.php`);
                error.message = `401 Unauthorized en ${bridgeUrl}. Revisa que el token en .env sea idéntico al $secret_key en PHP y que no haya espacios extras.`;
            }
            // Dejamos que el Dispatcher capture y loguee el error con winston
            throw error;
        }
    }

    async checkHealth() {
        try {
            const url = `${this.baseUrl}/perfex_bridge.php`;
            const response = await axios.get(url, { 
                headers: this.headers,
                params: {
                    token: this.apiToken
                },
                timeout: 5000 
            });
            return response.status === 200 || response.status === 401;
        } catch (error) {
            return error.response && (error.response.status === 200 || error.response.status === 401);
        }
    }

    async getCustomerByPhone(phone) {
        return this._request('get', { action: 'get_customer_by_phone', phone });
    }

    async getCustomerByEmail(email) {
        return this._request('get', { action: 'get_customer_by_email', email });
    }

    async getCustomerByVat(vat) {
        return this._request('get', { action: 'get_customer_by_vat', vat });
    }

    async getInvoices(customerId, limit = 0) {
        return this._request('get', { action: 'get_invoices', customer_id: customerId, limit });
    }

    async getSupportTickets(email) {
        return this._request('get', { action: 'get_tickets', email });
    }

    async getEstimates(customerId) {
        return this._request('get', { action: 'get_estimates', customer_id: customerId });
    }

    async getProjects(customerId) {
        return this._request('get', { action: 'get_projects', customer_id: customerId });
    }

    async getProposals(customerId) {
        return this._request('get', { action: 'get_proposals', customer_id: customerId });
    }

    async createTicket(ticketData) {
        return this._request('post', { action: 'create_ticket' }, ticketData);
    }

    async createContact(contactData) {
        return this._request('post', { action: 'create_contact' }, contactData);
    }
}

module.exports = PerfexService;