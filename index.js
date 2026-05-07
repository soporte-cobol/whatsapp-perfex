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
app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    const apiKey = req.headers['x-api-key'] || req.headers['X-API-KEY'] || '';
    const bodySecret = req.body.secret || req.body.password || '';

    const isApiKeyValid = apiKey && apiKey === process.env.WEBHOOK_API_KEY;
    const isBodySecretValid = bodySecret && bodySecret === process.env.WHATSAPP_API_SECRET;

    if (isApiKeyValid || isBodySecretValid) {
        return next();
    }

    // LOG AGRESIVO: Si esto no sale en combined.log, la petición no está llegando a Node.js
    const debugMsg = `🚫 BLOQUEADO: Credenciales no encontradas o incorrectas. IP: ${req.ip}. Header API-KEY: ${apiKey ? 'SI' : 'NO'}. Body Secret: ${bodySecret ? 'SI' : 'NO'}. Recibido Secret: "${bodySecret.substring(0, 6)}...". Esperado: "${(process.env.WHATSAPP_API_SECRET || '').substring(0, 6)}..."`;
    logger.error(debugMsg, { path: req.path, ip: req.ip });
    
    // Devolvemos 200 con error interno para evitar que Gemini rompa por "Empty Content"
    return res.status(200).json({ error: true, message: 'Auth failed' });
};

/**
 * Lógica compartida del Dispatcher (Maneja Plugins y Webhooks)
 */
async function handlePluginRequest(req, res) {
    // Log de entrada para verificar que el tráfico llega
    logger.info(`📥 Petición recibida en ${req.originalUrl || req.url}`, { action: req.body.action || 'webhook_event' });

    // 1. Detectar si es una notificación de evento de WhatsApp
    if (req.body.message && req.body.from) {
        logger.info(`💬 Mensaje de ${req.body.from}: ${req.body.message.substring(0, 20)}...`);
        return res.status(200).json({ status: 'ok', type: 'event_received' });
    }

    // Intentamos obtener el nombre de la función y argumentos
    let action = req.body.action || req.body.function || (req.body.calls && req.body.calls[0]?.function?.name);
    let args = req.body.arguments || req.body.params || (req.body.calls && req.body.calls[0]?.function?.arguments) || req.body;

    if (!action) {
        logger.info('ℹ️ Petición sin acción detectable (posible heartbeat)');
        return res.status(200).json({ status: 'ok', message: 'No action detected' });
    }

    // Parseo de argumentos si vienen como string JSON
    if (typeof args === 'string' && args.trim().startsWith('{')) {
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
                if (!customer.found) logger.info(`🔍 Cliente no encontrado por teléfono: ${args.phone}`);
                return res.json(customer);
            case 'identifyByEmail':
                const customerByEmail = await perfex.getCustomerByEmail(args.email);
                if (!customerByEmail.found) logger.info(`🔍 Cliente no encontrado por email: ${args.email}`);
                return res.json(customerByEmail);
            case 'identifyByVat':
                return res.json(await perfex.getCustomerByVat(args.vat));
            case 'getInvoices':
                if (!args.customerId) return res.status(400).json({ error: "Falta customerId" });
                return res.json(await perfex.getInvoices(parseInt(args.customerId)));
            case 'getProjects':
                if (!args.customerId) return res.status(400).json({ error: "Falta customerId" });
                return res.json(await perfex.getProjects(parseInt(args.customerId)));
            case 'getEstimates':
                if (!args.customerId) return res.status(400).json({ error: "Falta customerId" });
                return res.json(await perfex.getEstimates(parseInt(args.customerId)));
            case 'getProposals':
                if (!args.customerId) return res.status(400).json({ error: "Falta customerId" });
                return res.json(await perfex.getProposals(parseInt(args.customerId)));
            case 'createContact':
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (args.email && !emailRegex.test(args.email)) return res.status(400).json({ error: 'Formato de email no válido' });
                return res.json(await perfex.createContact(args));
            case 'getSupportTickets':
                if (!args.email) return res.status(400).json({ error: "Falta email" });
                return res.json(await perfex.getSupportTickets(args.email));
            case 'getTime':
            case 'get_time':
                const timezone = args.timezone || "America/Bogota";
                const time = new Date().toLocaleString("en-US", { timeZone: timezone, hour12: true, hour: 'numeric', minute: 'numeric' });
                return res.json({ current_time: time, timezone });
            case 'createTicket':
                const ticket = await perfex.createTicket(args);
                if (ticket.success && parseInt(args.priority) === 3) {
                    const adminPhone = process.env.ADMIN_WHATSAPP_NUMBER; 
                    if (adminPhone) {
                        const subject = args.subject || 'Sin asunto';
                        const alertMsg = `🚨 *TICKET URGENTE*\n\n*Asunto:* ${subject}\n*Cliente ID:* ${args.customerId}\n\nRevisar CRM. 🚀`;
                        await whatsapp.sendText(adminPhone, alertMsg).catch(e => logger.error(`Error alerta admin: ${e.message}`));
                    }
                }
                return res.json(ticket);
            default:
                logger.warn(`⚠️ Función no reconocida: ${action}`);
                return res.status(200).json({ error: true, message: `La función ${action} no está implementada.` });
        }
    } catch (error) {
        logger.error(`❌ Error ejecutando acción ${action}: ${error.message}`);
        res.status(200).json({ error: true, message: `Error CRM: ${error.message}` });
    }
}

/**
 * Rutas de Webhook y Plugin
 */
app.post('/', authenticateWebhook, handlePluginRequest);
app.post('/ai/plugin', authenticateWebhook, handlePluginRequest);

// Eliminación de rutas individuales obsoletas para favorecer el Dispatcher centralizado
// Esto evita inconsistencias y facilita la depuración.

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