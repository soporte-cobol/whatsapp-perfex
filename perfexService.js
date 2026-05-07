const axios = require('axios');

class PerfexService {
    constructor(baseUrl, apiToken) {
        this.baseUrl = baseUrl;
        this.apiToken = apiToken;
        this.client = axios.create({
            baseURL: `${baseUrl}/assets/perfex_bridge.php`,
            headers: { 'Authorization': `Bearer ${apiToken}` }
        });
    }

    async getCustomerByPhone(phone) {
        const res = await this.client.get('', { params: { action: 'get_customer_by_phone', phone } });
        return res.data;
    }

    async getCustomerByEmail(email) {
        const res = await this.client.get('', { params: { action: 'get_customer_by_email', email } });
        return res.data;
    }

    async getCustomerByVat(vat) {
        const res = await this.client.get('', { params: { action: 'get_customer_by_vat', vat } });
        return res.data;
    }

    async getInvoices(customerId, limit = 5) {
        const res = await this.client.get('', { params: { action: 'get_invoices', customer_id: customerId, limit } });
        return Array.isArray(res.data) ? res.data : [];
    }

    async getProjects(customerId, limit = 3) {
        const res = await this.client.get('', { params: { action: 'get_projects', customer_id: customerId, limit } });
        return Array.isArray(res.data) ? res.data : [];
    }

    async getContracts(customerId, limit = 3) {
        const res = await this.client.get('', { params: { action: 'get_contracts', customer_id: customerId, limit } });
        return Array.isArray(res.data) ? res.data : [];
    }

    async getTickets(email, limit = 3) {
        const res = await this.client.get('', { params: { action: 'get_tickets', email, limit } });
        return Array.isArray(res.data) ? res.data : [];
    }

    async createTicket(ticketData) {
        const res = await this.client.post('', { 
            action: 'create_ticket', 
            ...ticketData 
        });
        return res.data;
    }
}

module.exports = PerfexService;