/**
 * Servicio para interactuar con la API de Perfex CRM
 */
const axios = require('axios');

class PerfexService {
    constructor(baseUrl, apiToken) {
        this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
        this.headers = {
            'Authorization': apiToken
        };
    }

    async _request(method, params = {}, data = null) {
        const config = {
            method,
            url: `${this.baseUrl}/perfex_bridge.php`,
            headers: this.headers,
            params: {
                ...params,
                token: this.headers.Authorization
            },
            timeout: 10000 // Timeout de 10 segundos para no bloquear la IA
        };
        if (data) config.data = data;

        // Debug log para ver la URL final (sin token completo por seguridad)
        const debugToken = (this.headers.Authorization || '').substring(0, 6);
        console.log(`📡 Llamando a Perfex: ${params.action || method} | Token starts with: ${debugToken}`);

        try {
            const response = await axios(config);
            return response.data;
        } catch (error) {
            const errorMsg = error.response?.data?.error || error.message;
            console.error(`❌ Error en PerfexService (${params.action || 'POST'}):`, errorMsg);
            if (error.response?.data?.path_buscado) {
                console.error(`📂 Path buscado en servidor:`, error.response.data.path_buscado);
            }
            throw error;
        }
    }

    async checkHealth() {
        try {
            const url = `${this.baseUrl}/perfex_bridge.php`;
            const response = await axios.get(url, { 
                headers: this.headers,
                params: {
                    token: this.headers.Authorization
                },
                timeout: 5000 
            });
            return response.status === 200 || response.status === 401;
        } catch (error) {
            if (error.response) {
                console.log(`📡 Bridge (${this.baseUrl}) responde con status: ${error.response.status}`);
                return error.response.status === 200 || error.response.status === 401;
            } else {
                console.error(`❌ Error de red en ${this.baseUrl}: ${error.message}`);
                return false;
            }
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