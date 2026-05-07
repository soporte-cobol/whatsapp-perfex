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
    (process.env.PERFEX_BASE_URL || '').trim(),
    (process.env.PERFEX_API_TOKEN || '').trim()
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
    try {
        // DEBUG: Log del JSON completo que envía Cobol
        logger.info('📥 JSON Recibido desde Cobol:', { body: req.body });

        // 1. Detección de Acción (Tool Call)
        let action = req.body.action || req.body.function || req.body.name || req.body.method || 
                     req.body.command || req.body.tool || req.body.plugin ||
                     (req.body.data && (req.body.data.action || req.body.data.function || req.body.data.name)) ||
                     (req.body.calls && req.body.calls[0]?.function?.name);

        let args = req.body.arguments || req.body.args || req.body.params || req.body.data ||
                   req.body.input ||
                   (req.body.calls && req.body.calls[0]?.function?.arguments) || req.body;

        // Parseo de argumentos si vienen como string JSON
        if (typeof args === 'string' && args.trim().startsWith('{')) {
            try {
                args = JSON.parse(args);
            } catch (e) {
                logger.error(`❌ Error parseando argumentos: ${e.message}`);
            }
        }

        // 2. Si NO hay acción detectable, es un mensaje directo o heartbeat
        if (!action) {
            // Intentar extraer mensaje y emisor de varias estructuras posibles
            const msg = (req.body.data && req.body.data.message) || req.body.message;
            const from = (req.body.data && (req.body.data.phone || req.body.data.wid)) || req.body.from;

            if (msg && from) {
                logger.info(`💬 Mensaje recibido de ${from}`);
                const lowerMsg = msg.toLowerCase();
                const keywords = ['factura', 'debo', 'pendiente', 'pagos', 'pagar', 'saldo', 'proyecto', 'proyectos'];
                
                if (keywords.some(k => lowerMsg.includes(k))) {
                    const customer = await perfex.getCustomerByPhone(from);
                    if (customer.found) {
                        let fullResponse = `Hola ${customer.firstname || 'cliente'}! He verificado tu información:\n\n`;
                        
                        // Lógica de Facturas
                        if (keywords.slice(0, 6).some(k => lowerMsg.includes(k))) {
                            const invoices = await perfex.getInvoices(customer.customerId);
                            const pending = invoices.filter(inv => ['Por pagar', 'Vencida', 'Parcialmente pagada'].includes(inv.status_name));
                            
                            if (pending.length > 0) {
                                fullResponse += `*Facturas:* Tienes ${pending.length} pendiente(s).\n` + 
                                    pending.map(inv => `• ${inv.number}: $${inv.total} (${inv.status_name})`).join('\n');
                            } else {
                                fullResponse += `*Facturas:* No tienes pagos pendientes actualmente. ✅\n`;
                            }
                        }

                        // Lógica de Proyectos
                        if (lowerMsg.includes('proyecto')) {
                            const projects = await perfex.getProjects(customer.customerId);
                            if (projects.length > 0) {
                                fullResponse += `\n*Proyectos:* Tienes ${projects.length} proyecto(s) activo(s).\n` +
                                    projects.map(p => `• ${p.name}`).join('\n');
                            } else {
                                fullResponse += `\n*Proyectos:* No tienes proyectos asignados actualmente.`;
                            }
                        }

                        await whatsapp.sendText(from, fullResponse);
                        
                        // Devolvemos una respuesta simple a la plataforma para que Gemini no se rompa
                        return res.json({ status: "success", response: "Información enviada correctamente por WhatsApp." });
                    }
                    return res.json({ status: "success", response: "No pude identificarte en el sistema con este número. Por favor, indícame tu correo electrónico." });
                }
                // Si no es una pregunta de factura, simplemente acusamos recibo como texto
                // Retornamos un campo 'response' claro para que el motor de IA tenga contenido
                return res.json({ status: "success", response: "Mensaje recibido. ¿Deseas consultar algo sobre tus facturas o proyectos?" });
            }
            
            return res.json({ status: "success", response: "Heartbeat processed" });
        }

        logger.info(`🤖 IA llamando a función: ${action}`, { args });

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
                return res.json(await perfex.getCustomerByVat(args.vat || args.tax_number));
            case 'getInvoices':
                const cidInv = parseInt(args.customerId || args.id || args.customer_id || (args.customer && args.customer.customerId));
                if (!cidInv) return res.json({ error: true, response: "Falta ID de cliente" });
                const invoices = await perfex.getInvoices(cidInv);
                return res.json({ invoices });
            case 'getProjects':
                const cidProj = parseInt(args.customerId || args.id || args.customer_id);
                return res.json({ projects: cidProj ? await perfex.getProjects(cidProj) : [] });
            case 'getEstimates':
                const cidEst = parseInt(args.customerId || args.id || args.customer_id);
                return res.json({ estimates: cidEst ? await perfex.getEstimates(cidEst) : [] });
            case 'getProposals':
                const cidProp = parseInt(args.customerId || args.id || args.customer_id);
                return res.json({ proposals: cidProp ? await perfex.getProposals(cidProp) : [] });
            case 'createContact':
                return res.json(await perfex.createContact(args));
            case 'getSupportTickets':
                return res.json({ tickets: args.email ? await perfex.getSupportTickets(args.email) : [] });
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
                        await whatsapp.sendText(adminPhone, `🚨 *TICKET URGENTE*\n\n*Asunto:* ${args.subject || 'Sin asunto'}\n*Cliente ID:* ${args.customerId}\n\nRevisar CRM. 🚀`).catch(e => logger.error(`Error alerta admin: ${e.message}`));
                    }
                }
                return res.json(ticket);
            default:
                logger.warn(`⚠️ Función no reconocida: ${action}`);
                return res.status(200).json({ error: true, response: `La función ${action} no está implementada.` });
        }
    } catch (error) {
        logger.error(`❌ Fallo crítico en Dispatcher: ${error.message}`, { stack: error.stack });
        res.status(200).json({ error: true, response: `Error al procesar la solicitud: ${error.message}` });
    }
}

// Manejo de errores fatales para evitar que el log se pierda
process.on('uncaughtException', (error) => {
    logger.error('💥 UNCAUGHT EXCEPTION:', { message: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('💥 UNHANDLED REJECTION:', { reason: reason?.message || reason, stack: reason?.stack });
});

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