require('dotenv').config();
const express = require('express');
const winston = require('winston');
const path = require('path');
const fs = require('fs');
const PerfexService = require('./perfexService');
const WhatsAppService = require('./whatsappService');

// Asegurar que la carpeta de logs exista
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

// Configuración de Winston
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
        new winston.transports.File({ filename: path.join(logDir, 'combined.log') }),
        new winston.transports.Console({
            format: winston.format.combine(winston.format.colorize(), winston.format.simple())
        })
    ]
});

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
    const perfexAlive = await perfex.checkHealth().catch(() => false);
    
    res.json({ 
        status: 'online', 
        timestamp: new Date().toISOString(),
        config: {
            perfex_url: !!process.env.PERFEX_BASE_URL,
            whatsapp_ready: !!process.env.WHATSAPP_API_SECRET,
            perfex_connectivity: perfexAlive
        },
        node_version: process.version
    });
});

// Middleware de seguridad para los endpoints de Cobol
const authenticateWebhook = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.WEBHOOK_API_KEY) {
        logger.warn(`🚫 Intento de acceso no autorizado desde: ${req.ip}`);
        return res.status(401).json({ error: 'No autorizado. Falta o es incorrecta la X-API-KEY' });
    }
    next();
};

/**
 * Endpoint Central (Dispatcher)
 * Si la plataforma solo te permite una URL, usa esta: https://wa.gmgroup.com.co/ai/plugin
 */
app.post('/ai/plugin', authenticateWebhook, async (req, res) => {
    // Log crítico para ver qué está enviando la plataforma de Cobol/Gemini
    logger.info('📥 Petición entrante desde Cobol:', { body: req.body });

    // Intentamos obtener el nombre de la función y argumentos de varias formas comunes
    let action = req.body.action || req.body.function || (req.body.calls && req.body.calls[0]?.function?.name);
    let args = req.body.arguments || req.body.params || (req.body.calls && req.body.calls[0]?.function?.arguments) || req.body;

    // Si args llega como un string (común en Gemini Function Calling), lo parseamos
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args);
        } catch (e) {
            logger.error(`❌ Error parseando argumentos: ${e.message}`);
        }
    }

    logger.info(`🤖 IA llamando a función: ${action}`, { args });

    try {
        switch (action) {
            case 'identifyCustomer':
                const customer = await perfex.getCustomerByPhone(args.phone);
                if (!customer.found) {
                    logger.info(`🔍 Cliente no encontrado por teléfono: ${args.phone}`);
                }
                return res.json(customer);
            case 'identifyByEmail':
                const customerByEmail = await perfex.getCustomerByEmail(args.email);
                logger.info(`CRM response for email ${args.email}:`, customerByEmail);
                if (!customerByEmail.found) {
                    logger.info(`🔍 Cliente no encontrado por email: ${args.email}`);
                }
                return res.json(customerByEmail);
            case 'identifyByVat':
                const customerByVat = await perfex.getCustomerByVat(args.vat);
                return res.json(customerByVat);
            case 'getInvoices':
                if (!args.customerId) return res.status(400).json({ error: "Falta customerId" });
                const invoices = await perfex.getInvoices(parseInt(args.customerId));
                logger.info(`CRM found ${invoices.length} invoices for ID ${args.customerId}`);
                return res.json(invoices);
            case 'getProjects':
                if (!args.customerId) return res.status(400).json({ error: "Falta customerId" });
                const projects = await perfex.getProjects(parseInt(args.customerId));
                return res.json(projects);
            case 'getEstimates':
                if (!args.customerId) return res.status(400).json({ error: "Falta customerId" });
                const estimates = await perfex.getEstimates(parseInt(args.customerId));
                return res.json(estimates);
            case 'getProposals':
                if (!args.customerId) return res.status(400).json({ error: "Falta customerId" });
                const proposals = await perfex.getProposals(parseInt(args.customerId));
                return res.json(proposals);
            case 'createContact':
                // Validación de email antes de enviar a Perfex
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (args.email && !emailRegex.test(args.email)) {
                    return res.status(400).json({ error: 'Formato de email no válido' });
                }
                const newContact = await perfex.createContact(args);
                return res.json(newContact);
            case 'getSupportTickets':
                if (!args.email) return res.status(400).json({ error: "Falta email" });
                const tickets = await perfex.getSupportTickets(args.email);
                return res.json(tickets);
            case 'createTicket':
                const ticket = await perfex.createTicket(args);
                
                // Si el ticket es urgente (Prioridad 3), enviamos WhatsApp al administrador (Lógica unificada)
                if (ticket.success && parseInt(args.priority) === 3) {
                    const adminPhone = process.env.ADMIN_WHATSAPP_NUMBER; 
                    if (adminPhone) {
                        const subject = args.subject || 'Sin asunto';
                        const alertMsg = `🚨 *TICKET URGENTE DETECTADO*\n\n*Asunto:* ${subject}\n*Cliente ID:* ${args.customerId}\n\nLa IA ha categorizado este caso como alta prioridad. Por favor, revisar el CRM. 🚀`;
                        await whatsapp.sendText(adminPhone, alertMsg).catch(e => 
                            logger.error(`Error enviando alerta WhatsApp al admin: ${e.message}`)
                        );
                    }
                }
                return res.json(ticket);
            default:
                return res.status(404).json({ error: `Función ${action} no encontrada` });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Eliminación de rutas individuales obsoletas para favorecer el Dispatcher centralizado
// Esto evita inconsistencias y facilita la depuración.

/**
 * Endpoint para la hora (Migrado a estructura de plugin)
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
        res.status(400).json({ error: "Zona horaria no válida" });
    }
});

// Manejador de errores global
app.use((err, req, res, next) => {
    logger.error(`❌ Error en ${req.method} ${req.path}: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno en el servidor de IA', details: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`🚀 Webhook de IA corriendo en puerto ${PORT}`);
    logger.info(`🔗 Endpoints listos para configurar en el panel de Cobol`);
});