require('dotenv').config();
const express = require('express');
const PerfexService = require('./perfexService');
const WhatsAppService = require('./whatsappService');

const app = express();
app.use(express.json());

// Inicialización de servicios
const perfex = new PerfexService(
    process.env.PERFEX_BASE_URL,
    process.env.PERFEX_API_TOKEN
);

const whatsapp = new WhatsAppService(
    process.env.WHATSAPP_API_SECRET,
    process.env.WHATSAPP_ACCOUNT_ID
);

/**
 * Health Check Endpoint
 * Útil para monitoreo y para validar que el servicio está arriba.
 */
app.get('/health', async (req, res) => {
    res.json({ 
        status: 'online', 
        timestamp: new Date().toISOString(),
        config: {
            perfex_url: !!process.env.PERFEX_BASE_URL,
            whatsapp_ready: !!process.env.WHATSAPP_API_SECRET
        }
    });
});

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
 * Endpoint Central (Dispatcher)
 * Si la plataforma solo te permite una URL, usa esta: https://wa.gmgroup.com.co/ai/plugin
 */
app.post('/ai/plugin', authenticateWebhook, async (req, res) => {
    // Intentamos obtener el nombre de la función y argumentos de varias formas comunes
    let action = req.body.action || req.body.function || (req.body.calls && req.body.calls[0]?.function?.name);
    let args = req.body.arguments || req.body.params || (req.body.calls && req.body.calls[0]?.function?.arguments) || req.body;

    // Si args llega como un string (común en Gemini Function Calling), lo parseamos
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args);
        } catch (e) {
            console.error("❌ Error parseando argumentos:", e.message);
        }
    }

    console.log(`🤖 IA llamando a función: ${action}`, args);

    try {
        switch (action) {
            case 'identifyCustomer':
                const customer = await perfex.getCustomerByPhone(args.phone);
                return res.json(customer);
            case 'identifyByEmail':
                const customerByEmail = await perfex.getCustomerByEmail(args.email);
                return res.json(customerByEmail);
            case 'identifyByVat':
                const customerByVat = await perfex.getCustomerByVat(args.vat);
                return res.json(customerByVat);
            case 'getInvoices':
                const invoices = await perfex.getInvoices(args.customerId);
                return res.json(invoices);
            case 'createTicket':
                const ticket = await perfex.createTicket(args);
                return res.json(ticket);
            default:
                return res.status(404).json({ error: `Función ${action} no encontrada` });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Endpoint para obtener la hora (getTime)
 * Configurar en Cobol como: https://tudominio.com/ai/get-time
 */
app.post('/ai/get-time', authenticateWebhook, (req, res) => {
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
    // Limpiamos el teléfono y validamos longitud mínima
    if (!phone || phone.replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'Número de teléfono no válido o incompleto' });
    try {
        const data = await perfex.getCustomerByPhone(phone);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Endpoint para identificar por email
 */
app.post('/ai/identify-by-email', authenticateWebhook, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email es requerido' });
    try {
        const data = await perfex.getCustomerByEmail(email);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Endpoint para identificar por NIF/NIT (VAT)
 */
app.post('/ai/identify-by-vat', authenticateWebhook, async (req, res) => {
    const { vat } = req.body;
    if (!vat) return res.status(400).json({ error: 'NIF/NIT es requerido' });
    try {
        const data = await perfex.getCustomerByVat(vat);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Endpoint para crear contacto
 */
app.post('/ai/create-contact', authenticateWebhook, async (req, res) => {
    const { email, phone } = req.body;
    // Validación rigurosa de formato de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email && !emailRegex.test(email)) {
        return res.status(400).json({ error: 'El formato del correo electrónico no es válido' });
    }

    try {
        // Validar si el teléfono es apto para WhatsApp antes de crear en el CRM
        if (phone) {
            const isValid = await whatsapp.validatePhone(phone);
            if (!isValid) console.warn(`⚠️ Intentando crear contacto con teléfono que no parece tener WhatsApp: ${phone}`);
        }

        const data = await perfex.createContact(req.body);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Endpoint para crear ticket
 */
app.post('/ai/create-ticket', authenticateWebhook, async (req, res) => {
    const { priority, subject, customerId } = req.body;
    try {
        const data = await perfex.createTicket(req.body);
        
        // Si el ticket es urgente (Prioridad 3), enviamos WhatsApp al administrador
        if (data.success && priority === 3) {
            const adminPhone = process.env.ADMIN_WHATSAPP_NUMBER; 
            if (adminPhone) {
                const alertMsg = `🚨 *TICKET URGENTE DETECTADO*\n\n*Asunto:* ${subject}\n*Cliente ID:* ${customerId}\n\nLa IA ha categorizado este caso como alta prioridad. Por favor, revisar el CRM. 🚀`;
                await whatsapp.sendText(adminPhone, alertMsg).catch(e => 
                    console.error('Error enviando alerta WhatsApp al admin:', e.message)
                );
            }
        }

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
    // Validamos que el ID sea numérico
    if (!customerId || isNaN(customerId)) return res.status(400).json({ error: 'ID de cliente no válido' });
    
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
    // Validación básica de formato de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) return res.status(400).json({ error: 'Formato de email no válido' });

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
    console.error(`❌ Error en ${req.method} ${req.path}:`, err.message);
    res.status(500).json({ error: 'Error interno en el servidor de IA', details: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook de IA corriendo en puerto ${PORT}`);
    console.log(`🔗 Endpoints listos para configurar en el panel de Cobol`);
});