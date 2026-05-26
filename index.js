require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const PerfexService = require('./perfexService');
const WhatsAppService = require('./whatsappService');
const GeminiService = require('./geminiService');
const aiConfig = require('./aiConfig');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Memoria temporal de la sesión (se limpia al reiniciar el servidor)
const sessions = {};

// Middleware para capturar errores de JSON mal formado antes de llegar a la ruta
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.error('❌ Error de sintaxis en el JSON recibido:', err.message);
        return res.status(400).send({ status: "error", message: "Invalid JSON" });
    }
    next();
});

const cleanString = (val) => String(val || "").replace(/^["']|["']$/g, "").trim();

const perfex = new PerfexService(cleanString(process.env.PERFEX_BASE_URL), cleanString(process.env.PERFEX_API_TOKEN));
const whatsapp = new WhatsAppService(cleanString(process.env.WHATSAPP_API_SECRET), cleanString(process.env.WHATSAPP_ACCOUNT_ID));
const gemini = new GeminiService(cleanString(process.env.GEMINI_API_KEY), "gemini-3.5-flash");

app.get('/ai/debug', (req, res) => {
    const mask = (val) => {
        if (!val) return '❌ VACÍO';
        const raw = String(val);
        const str = cleanString(raw);
        return `${str.substring(0, 4)}...${str.substring(Math.max(0, str.length - 4))} (Longitud original: ${raw.length}, Sanitizado: ${str.length})`;
    };
    return res.json({
        env_loaded: Boolean(process.env.WEBHOOK_API_KEY),
        WEBHOOK_API_KEY: mask(process.env.WEBHOOK_API_KEY),
        WHATSAPP_API_SECRET: mask(process.env.WHATSAPP_API_SECRET),
        WHATSAPP_ACCOUNT_ID: mask(process.env.WHATSAPP_ACCOUNT_ID),
        GEMINI_API_KEY: mask(process.env.GEMINI_API_KEY),
        GEMINI_MODEL: process.env.GEMINI_MODEL || '❌ NO DEFINIDO',
        node_version: process.version,
        cwd: process.cwd(),
        dirname: __dirname
    });
});

app.post('/ai/plugin', async (req, res) => {
    try {
        const data = req.body?.data || req.body || {};
        const rawMsg = (data.message || "").trim();
        // Eliminar la firma del plan gratuito de la API para que no ensucie el procesamiento
        const msg = rawMsg.replace(/Envía:\s*uno\.cobol\.com\.co/gi, "").trim();
        const from = String(data.phone || data.wid || data.from || "");
        const cleanFrom = from.split('@')[0].replace(/\D/g, '');

        // 1. LOG INMEDIATO: Ver exactamente qué llega al servidor
        console.log(`\n📥 WEBHOOK RECIBIDO - ${new Date().toISOString()}`);
        console.log(`📦 CUERPO (BODY):`, req.body ? JSON.stringify(req.body) : 'VACÍO');

        // Verificar si el bot debe operar según el horario configurado
        if (!aiConfig.isBotActive()) {
            console.log(`⏳ [HORARIO LABORAL] Bot desactivado (Tel: ${cleanFrom}). Ignorando mensaje.`);
            return res.json({ status: "success", message: "Bot inactive during business hours", stop: true });
        }

        if (req.headers['x-api-key']) {
            console.log(`🔑 AUTH: X-API-KEY Detectado`);
        }

        // --- EXTRACCIÓN PREVENTIVA DE DATOS ---
        const emailFound = msg.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        const nitMatch = msg.match(/\d{7,}/);
        const destinoDetectado = aiConfig.findDestination(msg);
        
        // Inicializar o recuperar sesión del usuario
        if (cleanFrom && !sessions[cleanFrom]) {
            sessions[cleanFrom] = { destination: null, adultos: 1, ninos: 0, bebes: 0 };
        }
        const session = sessions[cleanFrom] || { destination: null, adultos: 1, ninos: 0, bebes: 0 };
        if (destinoDetectado) session.destination = destinoDetectado;
        
        const secret = cleanString(req.body?.secret || req.body?.token || req.headers['x-api-key']);
        const configSecret = cleanString(process.env.WEBHOOK_API_KEY);

        if (secret !== configSecret) {
            console.error(`❌ ERROR DE AUTENTICACIÓN: Secret recibido [${secret}] no coincide con configurado.`);
            return res.json({ status: "error", message: "Unauthorized" });
        }

        if (!msg) { console.log("ℹ️ Mensaje vacío, ignorando."); return res.json({ status: "success", stop: true }); }

        if (!cleanFrom) {
            console.warn("⚠️ No se pudo extraer un número de teléfono. Revisa el formato del JSON arriba.");
            return res.json({ status: "success", stop: true });
        }

        // Ignorar grupos (@g.us), canales (@newsletter), listas de difusión (broadcast) e IDs numéricos que excedan los 15 dígitos standard de teléfonos
        const isGroupOrChannel = 
            from.includes('@g.us') || 
            from.includes('@newsletter') || 
            from.toLowerCase().includes('broadcast') || 
            cleanFrom.length > 15;

        if (isGroupOrChannel) {
            console.log(`🚫 Mensaje ignorado (Grupo/Canal/Difusión detectado: ${from})`);
            return res.json({ status: "success", stop: true });
        }

        console.log(`\n-----------------------------------------`);
        console.log(`📩 ORIGINAL: "${rawMsg.substring(0, 60)}${rawMsg.length > 60 ? '...' : ''}"`);
        console.log(`📩 PROCESADO (Sin firma): "${msg}" | TEL: ${cleanFrom}`);

        let isAccountInquiry = false;

        // Keywords that strongly indicate the user wants to check their account/invoices
        const accountKeywords = /factura|saldo|deuda|estado de cuenta|mis viajes|mi cuenta|resumen|pago/i;

        if (emailFound || nitMatch || accountKeywords.test(msg)) {
            isAccountInquiry = true;
        }

        let customer = { found: false };

        if (isAccountInquiry) {
            if (emailFound) {
                console.log(`🔍 Intentando por EMAIL: ${emailFound[0]}`);
                customer = await perfex.getCustomerByEmail(emailFound[0]);
                console.log(`📡 Respuesta Bridge (Email):`, JSON.stringify(customer));
            }
            if (!customer.found && nitMatch) {
                console.log(`🔍 Intentando por NIT: ${nitMatch[0]}`);
                customer = await perfex.getCustomerByVat(nitMatch[0]);
                console.log(`📡 Respuesta Bridge (NIT):`, JSON.stringify(customer));
            }
            // Sólo buscamos por teléfono si explícitamente están pidiendo cuenta/facturas
            if (!customer.found && accountKeywords.test(msg)) {
                console.log(`🔍 Intentando por TELÉFONO: ${cleanFrom}`);
                customer = await perfex.getCustomerByPhone(cleanFrom);
                console.log(`📡 Respuesta Bridge (Tel):`, JSON.stringify(customer));
            }
        }

        if (customer.found) {
            console.log(`✅ IDENTIFICADO: ${customer.firstname} (${customer.company})`);
            
            const [invoices, projects] = await Promise.all([
                perfex.getInvoices(customer.customerId).catch(() => []),
                perfex.getProjects(customer.customerId).catch(() => [])
            ]);

            console.log(`📊 Datos: ${invoices.length} facturas, ${projects.length} viajes.`);

            let rigidMsg = `*RESUMEN DE CUENTA GM GROUP* 🏛️\n`;
            if (invoices.length > 0) {
                rigidMsg += `\n📄 *Facturas Pendientes:*`;
                invoices.forEach(i => rigidMsg += `\n• ${i.number}: $${i.total}\n  🔗 ${i.view_url}`);
            } else {
                rigidMsg += `\n✅ No tienes facturas pendientes.`;
            }

            // También enviamos el contexto a Gemini para que pueda saludar o complementar
            const aiMsg = await gemini.generateText(`${aiConfig.PRE_PROMPT}\n\nCLIENTE: ${customer.firstname}\nVIAJES: ${JSON.stringify(projects)}\nFACTURAS: ${JSON.stringify(invoices)}\n\nINSTRUCCIÓN: El cliente acaba de ser identificado. Salúdalo por su nombre y responde a su mensaje de forma muy breve y amigable.\n\nPREGUNTA: "${msg}"\n\n${aiConfig.POST_PROMPT}`);
            
            await whatsapp.sendText(cleanFrom, rigidMsg);
            if (aiMsg) {
                // --- PROCESAMIENTO DE TICKET ---
                const ticketRegex = /\[CREATE_TICKET:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\]/i;
                const ticketMatch = aiMsg.match(ticketRegex);
                if (ticketMatch) {
                    const [_, deptId, subject, message] = ticketMatch;
                    await perfex.createTicket({
                        customerId: customer.customerId,
                        subject: subject.trim(),
                        message: `${message.trim()}\n\n---\nTel: ${cleanFrom}\nEmail: ${customer.email || 'Identificado por CRM'}`,
                        department: parseInt(deptId) || 1,
                        priority: 2
                    }).then(r => console.log(`✅ Ticket creado:`, r)).catch(e => console.error(`❌ Error Ticket:`, e.message));
                }
                // -------------------------------
                const finalAi = aiMsg.replace(/\[CREATE_TICKET:.*?\]/g, '').trim();
                await whatsapp.sendText(cleanFrom, finalAi);
            }

        } else if (isAccountInquiry && (emailFound || nitMatch || accountKeywords.test(msg))) {
            console.log(`⚠️ FALLÓ IDENTIFICACIÓN TRAS INTENTO EXPLÍCITO`);
            const aiFallback = await gemini.generateText(`Eres Laura de GM Group. El cliente intentó consultar información de su cuenta o facturas, pero NO lo encontramos en el sistema. Pídele amablemente que te confirme su correo electrónico o NIT para buscarlo bien. Mensaje del cliente: "${msg}"`);
            await whatsapp.sendText(cleanFrom, aiFallback || aiConfig.FALLBACK_PROMPT);
        } else {
            console.log(`🤖 RESPUESTA GENERATIVA (Sin forzar identificación)`);

            // Extraer número de personas del mensaje
            const somosMatch   = msg.match(/somos\s+(\d+)/i);
            const adultosMatch = msg.match(/(\d+)\s*adultos?/i);
            const ninosMatch   = msg.match(/(\d+)\s*ni[ñn]os?/i);
            const bebesMatch   = msg.match(/(\d+)\s*beb[eé]s?/i);
            
            if (adultosMatch) session.adultos = parseInt(adultosMatch[1]);
            else if (somosMatch) session.adultos = parseInt(somosMatch[1]);
            if (ninosMatch) session.ninos = parseInt(ninosMatch[1]);
            if (bebesMatch) session.bebes = parseInt(bebesMatch[1]);

            // Registro de Lead si proporciona correo y no existe
            if (emailFound && !customer.found) {
                console.log(`👤 Creando cliente potencial (Lead): ${emailFound[0]}`);
                await perfex.createLead({
                    name: `Cliente WhatsApp ${cleanFrom}`,
                    email: emailFound[0],
                    phonenumber: cleanFrom,
                    description: `Interesado en viajar. Destino actual: ${session.destination ? session.destination.nombre : 'Por definir'}. PAX: ${session.adultos}A, ${session.ninos}N.`
                }).catch(e => console.error("❌ Error Lead:", e.message));
            }

            let destinoContext = '';
            if (session.destination) {
                const precio = aiConfig.calcularPrecio(session.destination, session.adultos, session.ninos, session.bebes);
                const fmt = (n) => `$${n.toLocaleString('es-CO')} COP`;
                console.log(`💰 [MEMORIA] Destino: ${session.destination.nombre} | PAX: ${session.adultos}A, ${session.ninos}N, ${session.bebes}B`);
                destinoContext = `\nDESTINO ACTUAL EN CONVERSACIÓN: ${session.destination.nombre}
DURACION: ${session.destination.duracion_dias} dias / ${session.destination.duracion_noches} noches
INCLUYE: ${session.destination.incluye}
CALCULO DE PRECIOS:
  - Adultos: ${session.adultos} x ${fmt(session.destination.precio_adulto)}
  - Ninos: ${session.ninos} x ${fmt(session.destination.precio_nino)}
  - TOTAL ESTIMADO: ${fmt(precio.total)}
INSTRUCCION ESPECIAL: Presenta este calculo de forma calida. Menciona que incluye y anima a reservar. NO inventes precios.`;
            }

            const instruccion = session.destination
                ? 'Presenta el calculo de precios de forma natural y entusiasta.'
                : 'NO le pidas correo ni NIT a menos que quiera reservar o consultar facturas.';

            const prompt = `${aiConfig.PRE_PROMPT}\n\n${aiConfig.KNOWLEDGE_BASE || ''}${destinoContext}\n\nPREGUNTA DEL CLIENTE: "${msg}"\n\nINSTRUCCION: ${instruccion}\n\n${aiConfig.POST_PROMPT}`;
            const aiMsg = await gemini.generateText(prompt);

            console.log(`🤖 [IA FULL RESPONSE]:\n${aiMsg}\n-------------------------`);

            if (aiMsg) {
                // --- PROCESAMIENTO DE TICKET ---
                const ticketRegex = /\[CREATE_TICKET:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\]/i;
                const ticketMatch = aiMsg.match(ticketRegex);
                if (ticketMatch) {
                    const [_, deptId, subject, message] = ticketMatch;
                    await perfex.createTicket({
                        customerId: 0, // No identificado aún
                        subject: subject.trim(),
                        message: `${message.trim()}\n\n---\nTel: ${cleanFrom}\nEmail: ${emailFound ? emailFound[0] : 'No proporcionado'}`,
                        department: parseInt(deptId) || 1,
                        priority: 2
                    }).then(r => console.log(`✅ Ticket creado (Anónimo):`, r)).catch(e => console.error(`❌ Error Ticket:`, e.message));
                }
                // -------------------------------
                const finalAi = aiMsg.replace(/\[CREATE_TICKET:.*?\]/g, '').trim();
                await whatsapp.sendText(cleanFrom, finalAi);
            } else {
                console.warn(`⚠️ Gemini no generó respuesta. Enviando Fallback.`);
                await whatsapp.sendText(cleanFrom, aiConfig.FALLBACK_PROMPT);
            }
        }

        return res.json({ status: "success" });

    } catch (error) {
        console.error(`💥 ERROR CRÍTICO:`, error);
        return res.json({ status: "error" });
    }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`\n🚀 LAURA (MODO DIOS 3.1) ONLINE | PUERTO ${PORT}`);
    
    // Imprimir resumen de variables cargadas (enmascaradas) para diagnóstico
    const mask = (val) => {
        if (!val) return '❌ NO CARGADO (Vacío)';
        const raw = String(val);
        const str = cleanString(raw);
        let status = `${str.substring(0, 4)}...${str.substring(Math.max(0, str.length - 4))} (Longitud: ${str.length})`;
        if (raw.startsWith('"') || raw.startsWith("'")) {
            status += ' ⚠️ Contiene Comillas!';
        }
        if (raw.includes('\r')) {
            status += ' ⚠️ Contiene Retorno de Carro (CRLF)!';
        }
        return status;
    };
    
    console.log(`🔍 DIAGNÓSTICO DE VARIABLES DE ENTORNO:`);
    console.log(`  - WEBHOOK_API_KEY:     ${mask(process.env.WEBHOOK_API_KEY)}`);
    console.log(`  - WHATSAPP_API_SECRET: ${mask(process.env.WHATSAPP_API_SECRET)}`);
    console.log(`  - WHATSAPP_ACCOUNT_ID: ${mask(process.env.WHATSAPP_ACCOUNT_ID)}`);
    console.log(`  - GEMINI_API_KEY:      ${mask(process.env.GEMINI_API_KEY)}`);
    console.log(`  - GEMINI_MODEL:        ${process.env.GEMINI_MODEL || '❌ NO DEFINIDO'}`);
    console.log(`-----------------------------------------\n`);
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`❌ El puerto ${PORT} ya está en uso. ¿Hay otra instancia corriendo?`);
    else console.error(`❌ Error al iniciar servidor:`, e);
});
