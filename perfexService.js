/**
 * Servicio para interactuar con la API de Perfex CRM
 */
const axios = require('axios');

class PerfexService {
    constructor(baseUrl, apiToken) {
        this.baseUrl = baseUrl;
        this.headers = {
            'Authorization': apiToken
        };
    }

    async _request(method, params = {}, data = null) {
        const config = {
            method,
            url: `${this.baseUrl}/perfex_bridge.php`,
            headers: this.headers,
            params,
            timeout: 10000 // Timeout de 10 segundos para no bloquear la IA
        };
        if (data) config.data = data;

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
            // Si el bridge responde, está vivo. El 401 significa que el token es incorrecto pero el archivo existe.
            const response = await axios.get(`${this.baseUrl}/perfex_bridge.php`, { headers: this.headers });
            return response.status === 200;
        } catch (error) {
            // Si el servidor responde con 401, el bridge está cargando correctamente pero el token no coincide
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