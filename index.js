require('dotenv').config();
const express = require('express');
const PerfexService = require('./perfexService');

const app = express();
app.use(express.json());

// Inicialización de servicios
const perfex = new PerfexService(
    process.env.PERFEX_BASE_URL,
    process.env.PERFEX_API_TOKEN
);

// Middleware de seguridad para los endpoints de Cobol
const authenticateWebhook = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.WEBHOOK_API_KEY) {
        console.warn(`🚫 Intento de acceso no autorizado desde: ${req.ip}`);
        return res.status(401).json({ error: 'No autorizado. Falta o es incorrecta la X-API-KEY' });
    }
    next();
};

/**
 * Endpoint para obtener la hora (getTime)
 * Configurar en Cobol como: https://tudominio.com/ai/get-time
 */
app.post('/ai/get-time', (req, res) => {
    const { timezone } = req.body;
    try {
        const time = new Date().toLocaleString("en-US", {
            timeZone: timezone || "America/Bogota",
            hour12: true,
            hour: 'numeric',
            minute: 'numeric'
        });
        res.json({ current_time: time, timezone: timezone || "America/Bogota" });
    } catch (error) {
        res.status(400).json({ error: "Invalid timezone" });
    }
});

/**
 * Endpoint para identificar cliente por teléfono
 */
app.post('/ai/identify-customer', authenticateWebhook, async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone es requerido' });

    try {
        const data = await perfex.getCustomerByPhone(phone);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Endpoint para facturas (getInvoices)
 * Configurar en Cobol como: https://tudominio.com/ai/get-invoices
 */
app.post('/ai/get-invoices', authenticateWebhook, async (req, res) => {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId es requerido' });
    
    try {
        const data = await perfex.getInvoices(customerId);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Endpoint para tickets (getSupportTickets)
 */
app.post('/ai/get-tickets', authenticateWebhook, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email es requerido' });

    try {
        const data = await perfex.getSupportTickets(email);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Endpoint para proyectos (getProjects)
 */
app.post('/ai/get-projects', authenticateWebhook, async (req, res) => {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId es requerido' });

    try {
        const data = await perfex.getProjects(customerId);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Endpoint para presupuestos (getEstimates)
 */
app.post('/ai/get-estimates', authenticateWebhook, async (req, res) => {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId es requerido' });

    try {
        const data = await perfex.getEstimates(customerId);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Endpoint para propuestas (getProposals)
 */
app.post('/ai/get-proposals', authenticateWebhook, async (req, res) => {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId es requerido' });

    try {
        const data = await perfex.getProposals(customerId);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Manejador de errores global
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Algo salió mal en el servidor de IA');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook de IA corriendo en puerto ${PORT}`);
    console.log(`🔗 Endpoints listos para configurar en el panel de Cobol`);
});