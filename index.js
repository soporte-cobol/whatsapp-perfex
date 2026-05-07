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

/**
 * Función auxiliar para enviar alertas de depuración al administrador
 */
async function sendDebug(message) {
    const adminPhone = process.env.ADMIN_WHATSAPP_NUMBER;
    if (adminPhone) {
        await whatsapp.sendText(adminPhone, `🛠️ *DEBUG LOG:* ${message}`).catch(() => {});
    }
}

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

    const debugMsg = `🚫 BLOQUEADO: Credenciales incorrectas. IP: ${req.ip}. Recibido: "${bodySecret.substring(0, 4)}...". Esperado: "${expectedWebhookKey.substring(0, 4)}..."`;
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
        logger.info(`📥 JSON Recibido desde Cobol: ${JSON.stringify(req.body)}`);

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
            const msg = (req.body.data && req.body.data.message) || req.body.message || req.body.text || req.body.body || req.body.query || req.body.body?.data?.message || "";
            const from = (req.body.data && (req.body.data.phone || req.body.data.wid)) || req.body.from;

            if (msg && from) {
                // Limpieza profunda del número: elimina +, @s.whatsapp.net y deja solo dígitos
                const cleanFrom = String(from).split('@')[0].replace(/\D/g, '').substring(0, 15);
                logger.info(`💬 Mensaje recibido de ${cleanFrom}: "${msg.substring(0, 50)}..."`);
                
                const lowerMsg = msg.toLowerCase();
                const keywordsFactura = ['factura', 'debo', 'pendiente', 'pagos', 'pagar', 'saldo'];
                const keywordsProyecto = ['proyecto', 'proyectos', 'obra', 'tarea'];
                
                if (keywordsFactura.some(k => lowerMsg.includes(k)) || keywordsProyecto.some(k => lowerMsg.includes(k))) {
                    logger.info(`🚀 CONSULTA RÍGIDA para: ${cleanFrom}`);
                    await sendDebug(`🚀 Procesando consulta rígida para ${cleanFrom}`);
                    
                    const customer = await perfex.getCustomerByPhone(cleanFrom).catch(async (err) => {
                        await sendDebug(`❌ Error CRM buscando ${cleanFrom}: ${err.message}`);
                        return { found: false };
                    });
                    
                    if (customer.found) {
                        await sendDebug(`✅ Identificado: ${customer.firstname}. Consultando facturas/proyectos...`);
                        const [invoices, projects] = await Promise.all([
                            keywordsFactura.some(k => lowerMsg.includes(k)) ? perfex.getInvoices(customer.customerId).catch(() => []) : Promise.resolve([]),
                            keywordsProyecto.some(k => lowerMsg.includes(k)) ? perfex.getProjects(customer.customerId).catch(() => []) : Promise.resolve([])
                        ]);

                        let fullResponse = `Hola ${customer.firstname}! 🤖 He consultado tu información directamente:\n`;
                        
                        if (Array.isArray(invoices) && invoices.length > 0) {
                            const pending = invoices.filter(inv => ['Por pagar', 'Vencida', 'Parcialmente pagada'].includes(inv.status_name));
                            if (pending.length > 0) {
                                fullResponse += `\n*📄 FACTURAS PENDIENTES:*\n` + 
                                    pending.map(inv => `• ${inv.number}: $${inv.total} (${inv.status_name})\n  🔗 Pagar: ${inv.view_url}`).join('\n\n') + `\n`;
                            } else {
                                fullResponse += `\n✅ No tienes facturas pendientes de pago.\n`;
                            }
                        }

                        if (Array.isArray(projects) && projects.length > 0) {
                            fullResponse += `\n*🏗️ PROYECTOS ACTIVOS:*\n` + 
                                projects.map(p => `• ${p.name} (Estado: ${p.status})`).join('\n');
                        }

                        // Enviamos WhatsApp directamente (Consulta Rígida)
                        await whatsapp.sendText(cleanFrom, fullResponse).catch(e => logger.error(`Error enviando WhatsApp rígido: ${e.message}`));

                        // Retornamos la respuesta completa a la plataforma Cobol. 
                        const ack = "Información enviada correctamente vía WhatsApp.";
                        return res.json({ 
                            status: "success", 
                            response: ack, 
                            message: ack, 
                            text: ack, 
                            output: ack,
                            final: true 
                        });
                    }
                    const notFoundMsg = "Lo siento, no pude encontrar tu número en nuestro sistema. ¿Me podrías dar tu correo electrónico para buscarte mejor?";
                    return res.json({ status: "success", response: notFoundMsg, message: notFoundMsg, text: notFoundMsg });
                }
                // Si no es una pregunta de factura, simplemente acusamos recibo como texto
                // Retornamos un campo 'response' claro para que el motor de IA tenga contenido
                const welcomeMsg = "Hola! Soy tu asistente virtual. ¿En qué puedo ayudarte hoy con tus facturas o proyectos?";
                return res.json({ status: "success", response: welcomeMsg, message: welcomeMsg, text: welcomeMsg });
            }
            
            return res.json({ status: "success", message: "Heartbeat processed", response: "Heartbeat processed", text: "Heartbeat processed" });
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
                if (!cidInv) return res.status(200).json({ error: true, response: "Falta ID de cliente", message: "Falta ID de cliente", output: "Falta ID de cliente" });
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
        const errorMsg = `❌ Fallo crítico en Dispatcher: ${error.message}`;
        logger.error(errorMsg, { stack: error.stack });
        await sendDebug(errorMsg);
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
// Añadir un pequeño retraso antes de iniciar el servidor para mitigar EADDRINUSE en reinicios
setTimeout(() => {
    const PORT = process.env.PORT || 3000;
    const server = app.listen(PORT, () => {
        const pUrl = (process.env.PERFEX_BASE_URL || '').trim();
        const pToken = (process.env.PERFEX_API_TOKEN || '').trim();
        process.stdout.write(`\n🚀 SERVIDOR LISTO EN PUERTO ${PORT}\n`);
        process.stdout.write(`🔗 CRM: ${pUrl}\n`);
        process.stdout.write(`🔑 TOKEN: ${pToken.substring(0, 4)}...\n`);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            process.stderr.write(`\n❌ PUERTO ${PORT} EN USO. Ejecuta: fuser -k ${PORT}/tcp\n`);
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
            setTimeout(() => { process.exit(0); }, 1500); 
        } catch (err) {
            logger.error('❌ Error durante el cierre del servidor:', { message: err.message, stack: err.stack });
            process.exit(1); // Exit with error
        }
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}, 1000); // Retraso aumentado a 1000ms