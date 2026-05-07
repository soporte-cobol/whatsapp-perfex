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
    // Limpiamos espacios en blanco accidentales de los valores recibidos
    const apiKey = (req.headers['x-api-key'] || req.headers['X-API-KEY'] || '').trim();
    const bodySecret = (req.body.secret || req.body.password || '').trim();

    // Cobol envía el Webhook Secret (3368a6...) tanto en el header como en el body secret
    const expectedWebhookKey = (process.env.WEBHOOK_API_KEY || '').trim();

    const isApiKeyValid = expectedWebhookKey && apiKey === expectedWebhookKey;
    const isBodySecretValid = expectedWebhookKey && bodySecret === expectedWebhookKey;

    if (isApiKeyValid || isBodySecretValid) {
        return next();
    }

    const debugMsg = `🚫 BLOQUEADO: Credenciales incorrectas. IP: ${req.ip}. Recibido: "${bodySecret.substring(0, 8)}...". Esperado: "${expectedWebhookKey.substring(0, 8)}..."`;
    logger.error(debugMsg, { path: req.path, ip: req.ip });
    
    // Devolvemos 200 con error interno para evitar que Gemini rompa por "Empty Content"
    return res.status(200).json({ error: true, message: 'Auth failed' });
};

/**
 * Lógica compartida del Dispatcher (Maneja Plugins y Webhooks)
 */
async function handlePluginRequest(req, res) {
    // 1. Detectar si es una LLAMADA DE FUNCIÓN (Plugin/Tool Call) primero
    let action = req.body.action || req.body.function || req.body.name || req.body.method || 
                 (req.body.data && (req.body.data.action || req.body.data.function || req.body.data.name)) ||
                 (req.body.calls && req.body.calls[0]?.function?.name);

    let args = req.body.arguments || req.body.args || req.body.params || req.body.data ||
               (req.body.calls && req.body.calls[0]?.function?.arguments) || req.body;

    // 2. Si NO hay una acción detectable, verificamos si es una notificación de mensaje o heartbeat
    if (!action) {
        const msg = req.body.message || (req.body.data && req.body.data.message);
        const from = req.body.from || (req.body.data && (req.body.data.phone || req.body.data.wid));

        if (msg && from) {
            logger.info(`💬 Evento de mensaje recibido de ${from}: ${msg.substring(0, 20)}...`);
            return res.status(204).send(); // 204 No Content: evita enviar JSON que confunda a Gemini
        }
        
        logger.info('ℹ️ Heartbeat o petición sin acción detectable');
        return res.status(204).send();
    }

    // Log de ejecución de Plugin
    logger.info(`🤖 IA llamando a función (Raw): ${action}`, { args });

    // Parseo de argumentos si vienen como string JSON
    if (typeof args === 'string' && args.trim().startsWith('{')) {
        try {
            args = JSON.parse(args);
        } catch (e) {
            logger.error(`❌ Error parseando argumentos: ${e.message}`);
        }
    }

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
                const resVat = await perfex.getCustomerByVat(args.vat || args.tax_number);
                logger.info('📤 Respuesta Vat:', resVat);
                return res.json(resVat);
            case 'getInvoices':
                const cidInv = parseInt(args.customerId || args.id || args.customer_id);
                if (!cidInv) return res.json({ error: "ID de cliente no válido o ausente para consultar facturas" });
                const invoices = await perfex.getInvoices(cidInv);
                logger.info(`📤 Enviando ${invoices.length} facturas`);
                return res.json({ invoices });
            case 'getProjects':
                const cidProj = parseInt(args.customerId || args.id || args.customer_id);
                if (!cidProj) return res.json({ error: "ID de cliente no válido para consultar proyectos" });
                const projects = await perfex.getProjects(cidProj);
                logger.info(`📤 Enviando ${projects.length} proyectos`);
                return res.json({ projects });
            case 'getEstimates':
                const cidEst = parseInt(args.customerId || args.id || args.customer_id);
                if (!cidEst) return res.json({ error: "ID de cliente no válido para consultar presupuestos" });
                const estimates = await perfex.getEstimates(cidEst);
                return res.json({ estimates });
            case 'getProposals':
                const cidProp = parseInt(args.customerId || args.id || args.customer_id);
                if (!cidProp) return res.json({ error: "ID de cliente no válido para consultar propuestas" });
                const proposals = await perfex.getProposals(cidProp);
                return res.json({ proposals });
            case 'createContact':
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (args.email && !emailRegex.test(args.email)) return res.json({ error: 'Formato de email no válido' });
                return res.json(await perfex.createContact(args));
            case 'getSupportTickets':
                if (!args.email) return res.json({ error: "Falta email para consultar tickets" });
                const tickets = await perfex.getSupportTickets(args.email);
                return res.json({ tickets });
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
    // Logs de verificación al arrancar para asegurar que el .env cargó bien
    const waSecret = (process.env.WHATSAPP_API_SECRET || 'N/A').trim().substring(0, 8);
    const webKey = (process.env.WEBHOOK_API_KEY || 'N/A').trim().substring(0, 8);
    logger.info(`🔑 WhatsApp API Secret: "${waSecret}..." | Webhook Key: "${webKey}..."`);
    logger.info(`🔗 Endpoints listos para configurar en el panel de Cobol`);
});