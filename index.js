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
    return res.status(200).json({ status: "error", message: 'Error de autenticación: Las credenciales del webhook no coinciden.' });
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
            const msg = (req.body.data && req.body.data.message) || req.body.message || "";
            const from = (req.body.data && (req.body.data.phone || req.body.data.wid)) || req.body.from;

            if (msg && from) {
                const cleanFrom = String(from).replace(/\D/g, '');
                logger.info(`💬 Mensaje recibido de ${cleanFrom}: "${msg.substring(0, 30)}..."`);
                const lowerMsg = msg.toLowerCase();
                const keywordsFactura = ['factura', 'debo', 'pendiente', 'pagos', 'pagar', 'saldo'];
                const keywordsProyecto = ['proyecto', 'proyectos', 'obra', 'tarea'];
                
                if (keywordsFactura.some(k => lowerMsg.includes(k)) || keywordsProyecto.some(k => lowerMsg.includes(k))) {
                    const customer = await perfex.getCustomerByPhone(cleanFrom);
                    if (customer.found) {
                        let invoices = [];
                        let projects = [];
                        try {
                            // Consulta Rígida: Ejecutamos facturas y proyectos en paralelo para ganar velocidad
                            const results = await Promise.all([
                                keywordsFactura.some(k => lowerMsg.includes(k)) ? perfex.getInvoices(customer.customerId) : Promise.resolve([]),
                                keywordsProyecto.some(k => lowerMsg.includes(k)) ? perfex.getProjects(customer.customerId) : Promise.resolve([])
                            ]);
                            invoices = Array.isArray(results[0]) ? results[0] : [];
                            projects = Array.isArray(results[1]) ? results[1] : [];
                        } catch (e) {
                            logger.error(`❌ Error en consulta rígida a DB: ${e.message}`);
                        }

                        let fullResponse = `Hola ${customer.firstname || 'cliente'}! 🤖 He consultado tu información:\n\n`;
                        
                        if (Array.isArray(invoices) && invoices.length > 0) {
                            const pending = invoices.filter(inv => ['Por pagar', 'Vencida', 'Parcialmente pagada'].includes(inv.status_name));
                            if (pending.length > 0) {
                                fullResponse += `*📄 FACTURAS PENDIENTES:*\n` + 
                                    pending.map(inv => `• ${inv.number}: $${inv.total} (${inv.status_name})\n  🔗 Ver: ${inv.view_url}`).join('\n\n') + `\n\n`;
                            } else if (keywordsFactura.some(k => lowerMsg.includes(k))) {
                                fullResponse += `*Facturas:* No registras pagos pendientes actualmente. ✅\n\n`;
                            }
                        }

                        if (Array.isArray(projects) && projects.length > 0) {
                            fullResponse += `*🏗️ PROYECTOS ACTIVOS:*\n` + 
                                projects.map(p => `• ${p.name} (Estado: ${p.status})`).join('\n') + `\n`;
                        } else if (keywordsProyecto.some(k => lowerMsg.includes(k))) {
                            fullResponse += `*Proyectos:* No tienes proyectos asignados en este momento.\n`;
                        }

                        // Enviamos la respuesta rígida directamente al usuario
                        await whatsapp.sendText(cleanFrom, fullResponse);
                        
                        // Devolvemos el texto bruto a la plataforma para que Gemini tenga contenido y no falle
                        return res.json({ status: "success", response: fullResponse, message: fullResponse, output: fullResponse, final: true });
                    }
                    const notFoundMsg = "Lo siento, no pude encontrar tu número registrado en nuestro sistema. ¿Podrías indicarme tu correo electrónico para buscarte?";
                    return res.json({ status: "success", response: notFoundMsg, message: notFoundMsg, output: notFoundMsg });
                }
                // Si no es una pregunta de factura, simplemente acusamos recibo como texto
                // Retornamos un campo 'response' claro para que el motor de IA tenga contenido
                const welcomeMsg = "Mensaje recibido. ¿Deseas consultar algo sobre tus facturas o proyectos?";
                return res.json({ status: "success", message: welcomeMsg, response: welcomeMsg, output: welcomeMsg });
            }
            
            return res.json({ status: "success", message: "Heartbeat processed", response: "Heartbeat processed", output: "Heartbeat processed" });
        }

        logger.info(`🤖 IA llamando a función: ${action}`, { args });

        switch (action) {
            case 'identifyCustomer':
                const customer = await perfex.getCustomerByPhone(args.phone);
                const idMsg = customer.found ? `Identificado: ${customer.firstname}` : "No encontrado";
                return res.json({ ...customer, response: idMsg, message: idMsg, output: idMsg });
            case 'identifyByEmail':
                const customerByEmail = await perfex.getCustomerByEmail(args.email);
                const emailMsg = customerByEmail.found ? `Identificado: ${customerByEmail.firstname}` : "Email no encontrado";
                return res.json({ ...customerByEmail, response: emailMsg, message: emailMsg, output: emailMsg });
            case 'identifyByVat':
                const customerVat = await perfex.getCustomerByVat(args.vat || args.tax_number);
                const vatMsg = customerVat.found ? `Identificado: ${customerVat.company}` : "NIT no encontrado";
                return res.json({ ...customerVat, response: vatMsg, message: vatMsg, output: vatMsg });
            case 'getInvoices':
                const cidInv = parseInt(args.customerId || args.id || args.customer_id || (args.customer && args.customer.customerId));
                if (!cidInv) return res.status(200).json({ error: true, response: "Falta ID de cliente", message: "Falta ID de cliente" });
                const invoices = await perfex.getInvoices(cidInv);
                const invResp = `Encontradas ${Array.isArray(invoices) ? invoices.length : 0} facturas.`;
                return res.json({ status: "success", response: invResp, message: invResp, output: invResp, invoices });
            case 'getProjects':
                const cidProj = parseInt(args.customerId || args.id || args.customer_id);
                const projects = cidProj ? await perfex.getProjects(cidProj) : [];
                const projResp = `Encontrados ${projects.length} proyectos.`;
                return res.json({ status: "success", response: projResp, message: projResp, output: projResp, projects });
            case 'getEstimates':
                const cidEst = parseInt(args.customerId || args.id || args.customer_id);
                const estimates = cidEst ? await perfex.getEstimates(cidEst) : [];
                const estResp = `Encontrados ${estimates.length} presupuestos.`;
                return res.json({ status: "success", response: estResp, message: estResp, output: estResp, estimates });
            case 'getProposals':
                const cidProp = parseInt(args.customerId || args.id || args.customer_id);
                const proposals = cidProp ? await perfex.getProposals(cidProp) : [];
                const propMsg = `Encontradas ${proposals.length} propuestas.`;
                return res.json({ status: "success", response: propMsg, message: propMsg, output: propMsg, proposals });
            case 'createContact':
                const newContact = await perfex.createContact(args);
                const contactMsg = newContact.success ? "Contacto creado exitosamente." : "Error al crear contacto.";
                return res.json({ ...newContact, response: contactMsg, message: contactMsg, output: contactMsg });
            case 'getSupportTickets':
                const tickets = args.email ? await perfex.getSupportTickets(args.email) : [];
                const tickMsg = `Encontrados ${tickets.length} tickets.`;
                return res.json({ status: "success", response: tickMsg, message: tickMsg, output: tickMsg, tickets });
            case 'getTime':
            case 'get_time':
                const timezone = args.timezone || "America/Bogota";
                const time = new Date().toLocaleString("en-US", { timeZone: timezone, hour12: true, hour: 'numeric', minute: 'numeric' });
                const timeMsg = `Hora actual: ${time}`;
                return res.json({ current_time: time, timezone, response: timeMsg, message: timeMsg, output: timeMsg });
            case 'createTicket':
                const ticket = await perfex.createTicket(args);
                if (ticket.success && parseInt(args.priority) === 3) {
                    const adminPhone = process.env.ADMIN_WHATSAPP_NUMBER; 
                    if (adminPhone) {
                        await whatsapp.sendText(adminPhone, `🚨 *TICKET URGENTE*\n\n*Asunto:* ${args.subject || 'Sin asunto'}\n*Cliente ID:* ${args.customerId}\n\nRevisar CRM. 🚀`).catch(e => logger.error(`Error alerta admin: ${e.message}`));
                    }
                }
                const ticketMsg = ticket.success ? `Ticket #${ticket.ticketid} creado exitosamente.` : (ticket.error || "Error al crear el ticket.");
                return res.json({ ...ticket, response: ticketMsg, message: ticketMsg, output: ticketMsg });
            default:
                logger.warn(`⚠️ Función no reconocida: ${action}`);
                return res.status(200).json({ error: true, response: `La función ${action} no está implementada.`, message: `La función ${action} no está implementada.`, output: `La función ${action} no está implementada.` });
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

// Añadir un pequeño retraso antes de iniciar el servidor para mitigar EADDRINUSE en reinicios
setTimeout(() => {
    const server = app.listen(PORT, () => {
        const waSecret = (process.env.WHATSAPP_API_SECRET || '').trim().substring(0, 6);
        const webKey = (process.env.WEBHOOK_API_KEY || '').trim().substring(0, 6);
        
        process.stdout.write(`🚀 Servidor listo en puerto ${PORT}\n`);
        process.stdout.write(`🔑 WA: ${waSecret}... | WEB: ${webKey}...\n`);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            process.stderr.write(`❌ Error: El puerto ${PORT} ya está en uso. Ejecuta: fuser -k ${PORT}/tcp\n`);
            process.exit(1);
        } else {
            logger.error(`❌ Error al iniciar el servidor: ${err.message}`);
        }
    });

    // Manejo de cierre grácil para liberar el puerto correctamente
    const shutdown = () => {
        logger.info('🛑 Cerrando servidor...');
        try {
            server.close(() => {
                logger.info('👋 Servidor fuera de línea y puerto liberado.');
                process.exit(0); // Exit cleanly after server closes
            });
            // Force exit after a short delay if server.close() hangs
            setTimeout(() => { process.exit(0); }, 1000); 
        } catch (err) {
            logger.error('❌ Error durante el cierre del servidor:', { message: err.message, stack: err.stack });
            process.exit(1); // Exit with error
        }
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}, 500); // Retraso de 500ms