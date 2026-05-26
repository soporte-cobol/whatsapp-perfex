const axios = require('axios');

class PerfexService {
    constructor(baseUrl, apiToken) {
        this.baseUrl = baseUrl;
        this.apiToken = apiToken;
        // Ahora el token va en la URL base para evitar que el servidor lo borre
        this.client = axios.create({
            baseURL: `${baseUrl}/assets/perfex_bridge.php`,
            params: { token: apiToken } 
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

    async createCustomer(customerData) {
        const res = await this.client.post('', { ...customerData, action: 'create_customer' });
        return res.data;
    }

    async sendPipingEmail(emailData) {
        const res = await this.client.post('', { ...emailData, action: 'send_piping_email' });
        return res.data;
    }

    async createTicket(ticketData) {
        const res = await this.client.post('', { 
            ...ticketData,
            action: 'create_ticket'
        }, {
            params: { token: this.apiToken } // Re-aseguramos el token en POST
        });
        return res.data;
    }
}

module.exports = PerfexService;