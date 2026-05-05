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

    async getCustomerByPhone(phone) {
        try {
            const response = await axios.get(`${this.baseUrl}/perfex_bridge.php`, {
                headers: this.headers,
                params: { action: 'get_customer_by_phone', phone: phone }
            });
            return response.data;
        } catch (error) {
            console.error('Error al identificar cliente en Perfex:', error.message);
            throw error;
        }
    }

    async getInvoices(customerId) {
        try {
            const response = await axios.get(`${this.baseUrl}/perfex_bridge.php`, { 
                headers: this.headers,
                params: { action: 'get_invoices', customer_id: customerId }
            });
            return response.data;
        } catch (error) {
            console.error('Error al consultar facturas en Perfex:', error.message);
            throw error;
        }
    }

    async getSupportTickets(email) {
        try {
            const response = await axios.get(`${this.baseUrl}/perfex_bridge.php`, {
                headers: this.headers,
                params: { action: 'get_tickets', email: email }
            });
            return response.data;
        } catch (error) {
            console.error('Error al consultar tickets en Perfex:', error.message);
            throw error;
        }
    }

    async getEstimates(customerId) {
        try {
            const response = await axios.get(`${this.baseUrl}/perfex_bridge.php`, {
                headers: this.headers,
                params: { action: 'get_estimates', customer_id: customerId }
            });
            return response.data;
        } catch (error) {
            console.error('Error al consultar presupuestos en Perfex:', error.message);
            throw error;
        }
    }

    async getProjects(customerId) {
        try {
            const response = await axios.get(`${this.baseUrl}/perfex_bridge.php`, {
                headers: this.headers,
                params: { action: 'get_projects', customer_id: customerId }
            });
            return response.data;
        } catch (error) {
            console.error('Error al consultar proyectos en Perfex:', error.message);
            throw error;
        }
    }

    async getProposals(customerId) {
        try {
            const response = await axios.get(`${this.baseUrl}/perfex_bridge.php`, {
                headers: this.headers,
                params: { action: 'get_proposals', customer_id: customerId }
            });
            return response.data;
        } catch (error) {
            console.error('Error al consultar propuestas en Perfex:', error.message);
            throw error;
        }
    }
}

module.exports = PerfexService;