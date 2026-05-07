/**
 * Servicio para interactuar con la API de Perfex CRM
 */
const axios = require('axios');

class PerfexService {
    constructor(baseUrl, apiToken) {
        this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
        this.apiToken = apiToken;
        this.headers = {
            'Authorization': `Bearer ${String(apiToken).replace('Bearer ', '').trim()}`
        };
    }

    async _request(method, params = {}, data = null) {
        const config = {
            method,
            url: `${this.baseUrl}/perfex_bridge.php`,
            headers: this.headers,
            params: {
                ...params,
                token: this.apiToken
            },
            timeout: 10000 // Timeout de 10 segundos para no bloquear la IA
        };
        if (data) config.data = data;

        try {
            const response = await axios(config);
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 401) {
                // Agregamos un mensaje específico para depurar el 401
                error.message = `Autenticación fallida con Perfex Bridge (401). Verifica que el token en .env coincida con el $secret_key en PHP.`;
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

    async getInvoices(customerId) {
        return this._request('get', { action: 'get_invoices', customer_id: customerId });
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