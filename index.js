require('dotenv').config();
const express = require('express');
const winston = require('winston');
const path = require('path');
const fs = require('fs');
const PerfexService = require('./perfexService');
const WhatsAppService = require('./whatsappService');
const GeminiService = require('./geminiService');

function _asNonEmptyText(value) {
    const text = (value === undefined || value === null) ? '' : String(value);
    const trimmed = text.trim();
    return trimmed.length ? trimmed : null;
}

function sendCobolJson(res, payload) {
    const safePayload = payload && typeof payload === 'object' ? { ...payload } : {};

    const candidateText =
        _asNonEmptyText(safePayload.response) ||
        _asNonEmptyText(safePayload.message) ||
        _asNonEmptyText(safePayload.output) ||
        _asNonEmptyText(safePayload.text) ||
        _asNonEmptyText(safePayload.result) ||
        _asNonEmptyText(safePayload.status) ||
        "OK";

    if (!_asNonEmptyText(safePayload.response)) safePayload.response = candidateText;
    if (!_asNonEmptyText(safePayload.message)) safePayload.message = candidateText;
    if (!_asNonEmptyText(safePayload.output)) safePayload.output = candidateText;
    if (!_asNonEmptyText(safePayload.text)) safePayload.text = candidateText;

    return res.json(safePayload);
}

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
function sendDebug(message) {
    const adminPhone = process.env.ADMIN_WHATSAPP_NUMBER;
    if (adminPhone) {
        // Envío sin esperar (fire and forget) para no retrasar la respuesta al cliente
        whatsapp.sendText(adminPhone, `🛠️ *DEBUG LOG:* ${message}`).catch(() => {});
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

const gemini = new GeminiService(
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_MODEL
);

/**
 * Health Check Endpoint
 * Útil para monitoreo y para validar que el servicio está arriba.
 */
app.get('/health', async (req, res) => {
    const perfexAlive = await perfex.checkHealth().catch(() => false);
    
    return sendCobolJson(res, { 
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
    return sendCobolJson(res.status(200), { status: "error", message: 'Error de autenticación: Las credenciales del webhook no coinciden.' });
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
            const msg = (req.body.data && req.body.data.message) || req.body.message || req.body.text || req.body.body || "";
            const from = (req.body.data && (req.body.data.phone || req.body.data.wid)) || req.body.from;

            if (msg && from) {
                const cleanFrom = String(from).split('@')[0].replace(/\D/g, '');
                logger.info(`💬 Mensaje de ${cleanFrom}: "${msg.substring(0, 30)}..."`);
                
                const lowerMsg = msg.toLowerCase();
                
                // Intentamos identificar al cliente siempre
                const customer = await perfex.getCustomerByPhone(cleanFrom).catch(() => ({ found: false }));
                
                if (customer.found) {
                    const keywordsFactura = ['factura', 'debo', 'pendiente', 'pagos', 'pagar', 'saldo', 'cuenta', 'cobro'];
                    const keywordsProyecto = ['proyecto', 'proyectos', 'obra', 'tarea', 'avance', 'estado'];
                    
                    const wantsInvoices = keywordsFactura.some(k => lowerMsg.includes(k));
                    const wantsProjects = keywordsProyecto.some(k => lowerMsg.includes(k));

                    // Si no detecta palabras clave, igual buscamos datos básicos para que la IA tenga contexto
                    const [invoices, projects] = await Promise.all([
                        (wantsInvoices || lowerMsg.length < 20) ? perfex.getInvoices(customer.customerId, 3).catch(() => []) : Promise.resolve([]),
                        (wantsProjects || lowerMsg.length < 20) ? perfex.getProjects(customer.customerId, 3).catch(() => []) : Promise.resolve([])
                    ]);

                    // Construcción de Respuesta Rígida (Base de Datos)
                    let rigidAnswer = `*DATOS DE TU CUENTA (CRM):*\n`;
                    let hasData = false;

                    if (Array.isArray(invoices) && invoices.length > 0) {
                        const pending = invoices.filter(inv => ['Por pagar', 'Vencida', 'Parcialmente pagada'].includes(inv.status_name));
                        if (pending.length > 0) {
                            rigidAnswer += `\n📄 *Facturas Pendientes:*`;
                            pending.forEach(inv => {
                                rigidAnswer += `\n• ${inv.number}: $${inv.total} (Vence: ${inv.duedate})\n  🔗 Pagar: ${inv.view_url}`;
                            });
                            hasData = true;
                        }
                    }

                    if (Array.isArray(projects) && projects.length > 0) {
                        rigidAnswer += `\n\n🏗️ *Proyectos:*`;
                        projects.forEach(p => {
                            rigidAnswer += `\n• ${p.name} (Estado: ${p.status})`;
                        });
                        hasData = true;
                    }

                    if (!hasData) {
                        rigidAnswer = "✅ No tienes facturas pendientes ni proyectos activos en este momento.";
                    }

                    // Respuesta Natural con Gemini
                    let aiAnswer = null;
                    if (gemini.isReady()) {
                        const prompt = [
                            "Eres un asistente virtual experto de GM Group (CRM Perfex).",
                            `Cliente: ${customer.firstname} ${customer.lastname || ''}`,
                            "Instrucciones: Saluda al cliente por su nombre, sé muy amable y profesional. Responde a su pregunta usando la información del CRM.",
                            "Si el cliente pregunta por algo que NO está en los datos, dile que no lo encuentras pero que un asesor humano lo revisará.",
                            "Mantén la respuesta breve (máximo 3 frases).",
                            "",
                            `PREGUNTA DEL CLIENTE: "${msg}"`,
                            "",
                            "DATOS REALES DEL CRM:",
                            rigidAnswer
                        ].join("\n");

                        try {
                            aiAnswer = await gemini.generateText(prompt);
                        } catch (e) {
                            logger.error(`Error IA Gemini: ${e.message}`);
                        }
                    }

                    // Enviar las dos respuestas por separado (IA primero, luego Rígida)
                    if (aiAnswer) {
                        await whatsapp.sendText(cleanFrom, aiAnswer).catch(e => logger.error(`Error WhatsApp IA: ${e.message}`));
                    }
                    
                    // Solo enviamos la rígida si contiene datos específicos o si la IA falló
                    await whatsapp.sendText(cleanFrom, rigidAnswer).catch(e => logger.error(`Error WhatsApp Rígido: ${e.message}`));

                    const ack = "Procesado correctamente.";
                    return sendCobolJson(res, { 
                        status: "success", 
                        response: ack, 
                        final: true, 
                        stop: true 
                    });
                } else {
                    // Cliente no encontrado por teléfono -> Pedir correo o dejar que la IA maneje la duda
                    let fallbackMsg = "Lo siento, no reconozco este número de teléfono en nuestro sistema. ¿Podrías indicarme tu correo electrónico o el NIT de tu empresa para buscarte?";
                    
                    if (gemini.isReady()) {
                        const aiFallback = await gemini.generateText(`El cliente dice: "${msg}". No lo encontramos por su teléfono. Dile amablemente que no lo ubicamos y pídele su correo o NIT para ayudarle mejor. Sé muy breve.`);
                        if (aiFallback) fallbackMsg = aiFallback;
                    }

                    return sendCobolJson(res, { 
                        status: "success", 
                        response: fallbackMsg, 
                        message: fallbackMsg,
                        final: true,
                        stop: true
                    });
                }
            }
            
            return sendCobolJson(res, { status: "success", message: "Heartbeat processed", stop: true });
        }

        logger.info(`🤖 IA llamando a función: ${action}`, { args });

        switch (action) {
            case 'identifyCustomer':
                const customer = await perfex.getCustomerByPhone(args.phone);
                const idMsg = customer.found ? `Identificado: ${customer.firstname}` : "No encontrado";
                return sendCobolJson(res, { ...customer, response: idMsg, message: idMsg, output: idMsg });
            case 'identifyByEmail':
                const customerByEmail = await perfex.getCustomerByEmail(args.email);
                const emailMsg = customerByEmail.found ? `Identificado: ${customerByEmail.firstname}` : "Email no encontrado";
                return sendCobolJson(res, { ...customerByEmail, response: emailMsg, message: emailMsg, output: emailMsg });
            case 'identifyByVat':
                const customerVat = await perfex.getCustomerByVat(args.vat || args.tax_number);
                const vatMsg = customerVat.found ? `Identificado: ${customerVat.company}` : "NIT no encontrado";
                return sendCobolJson(res, { ...customerVat, response: vatMsg, message: vatMsg, output: vatMsg });
            case 'getInvoices':
                const cidInv = parseInt(args.customerId || args.id || args.customer_id || (args.customer && args.customer.customerId));
                if (!cidInv) return sendCobolJson(res.status(200), { error: true, response: "Falta ID de cliente", message: "Falta ID de cliente", output: "Falta ID de cliente" });
                const invoices = await perfex.getInvoices(cidInv);
                const invResp = `Encontradas ${Array.isArray(invoices) ? invoices.length : 0} facturas.`;
                return sendCobolJson(res, { status: "success", response: invResp, message: invResp, output: invResp, invoices });
            case 'getProjects':
                const cidProj = parseInt(args.customerId || args.id || args.customer_id);
                const projects = cidProj ? await perfex.getProjects(cidProj) : [];
                const projResp = `Encontrados ${projects.length} proyectos.`;
                return sendCobolJson(res, { status: "success", response: projResp, message: projResp, output: projResp, projects });
            case 'getEstimates':
                const cidEst = parseInt(args.customerId || args.id || args.customer_id);
                const estimates = cidEst ? await perfex.getEstimates(cidEst) : [];
                const estResp = `Encontrados ${estimates.length} presupuestos.`;
                return sendCobolJson(res, { status: "success", response: estResp, message: estResp, output: estResp, estimates });
            case 'getProposals':
                const cidProp = parseInt(args.customerId || args.id || args.customer_id);
                const proposals = cidProp ? await perfex.getProposals(cidProp) : [];
                const propMsg = `Encontradas ${proposals.length} propuestas.`;
                return sendCobolJson(res, { status: "success", response: propMsg, message: propMsg, output: propMsg, proposals });
            case 'createContact':
                const newContact = await perfex.createContact(args);
                const contactMsg = newContact.success ? "Contacto creado exitosamente." : "Error al crear contacto.";
                return sendCobolJson(res, { ...newContact, response: contactMsg, message: contactMsg, output: contactMsg });
            case 'getSupportTickets':
                const tickets = args.email ? await perfex.getSupportTickets(args.email) : [];
                const tickMsg = `Encontrados ${tickets.length} tickets.`;
                return sendCobolJson(res, { status: "success", response: tickMsg, message: tickMsg, output: tickMsg, tickets });
            case 'getTime':
            case 'get_time':
                const timezone = args.timezone || "America/Bogota";
                const time = new Date().toLocaleString("en-US", { timeZone: timezone, hour12: true, hour: 'numeric', minute: 'numeric' });
                const timeMsg = `Hora actual: ${time}`;
                return sendCobolJson(res, { current_time: time, timezone, response: timeMsg, message: timeMsg, output: timeMsg });
            case 'createTicket':
                const ticket = await perfex.createTicket(args);
                if (ticket.success && parseInt(args.priority) === 3) {
                    const adminPhone = process.env.ADMIN_WHATSAPP_NUMBER; 
                    if (adminPhone) {
                        await whatsapp.sendText(adminPhone, `🚨 *TICKET URGENTE*\n\n*Asunto:* ${args.subject || 'Sin asunto'}\n*Cliente ID:* ${args.customerId}\n\nRevisar CRM. 🚀`).catch(e => logger.error(`Error alerta admin: ${e.message}`));
                    }
                }
                const ticketMsg = ticket.success ? `Ticket #${ticket.ticketid} creado exitosamente.` : (ticket.error || "Error al crear el ticket.");
                return sendCobolJson(res, { ...ticket, response: ticketMsg, message: ticketMsg, output: ticketMsg });
            default:
                logger.warn(`⚠️ Función no reconocida: ${action}`);
                return sendCobolJson(res.status(200), { error: true, response: `La función ${action} no está implementada.`, message: `La función ${action} no está implementada.`, output: `La función ${action} no está implementada.` });
        }
    } catch (error) {
        const errorMsg = `❌ Fallo crítico en Dispatcher: ${error.message}`;
        logger.error(errorMsg, { stack: error.stack });
        await sendDebug(errorMsg);
        return sendCobolJson(res.status(200), { error: true, response: `Error al procesar la solicitud: ${error.message}` });
    }
}
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
