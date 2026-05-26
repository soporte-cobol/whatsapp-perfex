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

// Helper para convertir palabras comunes a números
const textToNumber = (text) => {
    const map = { 'un': 1, 'uno': 1, 'una': 1, 'dos': 2, 'tres': 3, 'cuatro': 4, 'cinco': 5, 'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9, 'diez': 10, '0':0, '1':1, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10 };
    const match = String(text).toLowerCase().trim();
    if (map[match]) return map[match];
    return parseInt(match) || 1;
};

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
        // 1. EXTRACCIÓN INMEDIATA (Previene ReferenceError)
        const payload = req.body?.data || req.body || {};
        const fromRaw = String(payload.phone || payload.wid || payload.from || "");
        const digits = fromRaw.split('@')[0].replace(/\D/g, '');
        const cleanFrom = digits ? `+${digits}` : "";
        const rawContent = (payload.message || "").trim();
        const msg = rawContent.replace(/Envía:\s*uno\.cobol\.com\.co/gi, "").trim();

        // 2. LOGS Y CONTROL DE HORARIO
        console.log(`\n📥 WEBHOOK RECIBIDO [${cleanFrom}] - ${new Date().toISOString()}`);
        if (!aiConfig.isBotActive()) {
            console.log(`⏳ [HORARIO LABORAL] Bot desactivado (Tel: ${cleanFrom}).`);
            return res.json({ status: "success", stop: true });
        }

        // 3. SEGURIDAD
        const secret = cleanString(req.body?.secret || req.body?.token || req.headers['x-api-key']);
        if (secret !== cleanString(process.env.WEBHOOK_API_KEY)) {
            return res.status(401).json({ status: "error" });
        }

        if (!msg || !cleanFrom || fromRaw.includes('@g.us')) return res.json({ status: "success" });

        // 4. MEMORIA DE SESIÓN
        if (!sessions[cleanFrom]) sessions[cleanFrom] = { destination: null, adultos: 1, ninos: 0, bebes: 0, email: null, vat: null, name: null };
        const session = sessions[cleanFrom];

        const emailFound = msg.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailFound) session.email = emailFound[0];

        // Detección de NIF/VAT/Documento (7 a 11 dígitos, evita confusiones con PAX)
        const vatMatch = msg.match(/\b\d{7,11}\b/);
        if (vatMatch) session.vat = vatMatch[0];

        // Detección de nombre (si el usuario dice "mi nombre es...")
        const nameMatch = msg.match(/mi nombre es\s+([a-záéíóúñ\s]+)/i);
        if (nameMatch) session.name = nameMatch[1].trim();

        const destinoDetectado = aiConfig.findDestination(msg);
        if (destinoDetectado) session.destination = destinoDetectado;

        // Mejora detección de PAX (Pasajeros)
        const numPattern = "(\\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)";
        
        const aMatch = msg.match(new RegExp(numPattern + '\\s*adultos?', 'i'));
        if (aMatch) session.adultos = textToNumber(aMatch[1]);

        // Detección por lenguaje natural (Acompañantes)
        if (msg.match(/espos[ao]|pareja|novi[ao]/i)) session.adultos = Math.max(session.adultos, 2);
        if (msg.match(/\bhij[ao]\b|\bniñ[ao]\b/i)) session.ninos = Math.max(session.ninos, 1);
        if (msg.match(/\bhij[ao]s\b|\bniñ[ao]s\b/i)) session.ninos = Math.max(session.ninos, 2);

        const nMatch = msg.match(new RegExp(numPattern + '\\s*ni[ñn]os?', 'i'));
        if (nMatch) session.ninos = textToNumber(nMatch[1]);

        // Detección por lenguaje natural (Acompañantes)
        if (msg.match(/espos[ao]|pareja|novi[ao]/i)) session.adultos = Math.max(session.adultos, 2);
        if (msg.match(/\bhij[ao]\b|\bniñ[ao]\b/i)) session.ninos = Math.max(session.ninos, 1);
        if (msg.match(/\bhij[ao]s\b|\bniñ[ao]s\b/i)) session.ninos = Math.max(session.ninos, 2);

        const bMatch = msg.match(new RegExp(numPattern + '\\s*(beb[ée]s?|infantes?)', 'i'));
        if (bMatch) session.bebes = textToNumber(bMatch[1]);

        // Si dice "X personas" o "X pax" y no hay desglose, lo tomamos como adultos
        const tMatch = msg.match(new RegExp(numPattern + '\\s*(personas|pax|viajeros|en total|somos)', 'i'));
        if (tMatch && !aMatch && !nMatch) session.adultos = textToNumber(tMatch[1]);

        // 5. IDENTIFICACIÓN CRM
        const accountKeywords = /factura|saldo|deuda|estado de cuenta|mis viajes|mi cuenta|resumen|pago/i;
        const isAccountInquiry = accountKeywords.test(msg);
        let customer = { found: false };

        if (session.email || isAccountInquiry || session.vat) {
            if (session.vat) customer = await perfex.getCustomerByVat(session.vat);
            if (!customer.found && session.email) customer = await perfex.getCustomerByEmail(session.email);
            if (!customer.found && (isAccountInquiry)) customer = await perfex.getCustomerByPhone(cleanFrom);
        }

        // 6. REGISTRO DE CLIENTE (Aseguramos ID, Nombre, Correo y Teléfono)
        if (session.email && !customer.found) {
            console.log(`👤 REGISTRANDO CLIENTE EN CRM: ${session.email}`);
            try {
                // Formatear nombre: juan.perez -> Juan Perez
                const nameParts = session.email.split('@')[0].split(/[._-]/);
                let formattedName = nameParts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
                
                const clientName = session.name || formattedName;
                
                const res = await perfex.createCustomer({
                    name: clientName,
                    email: session.email,
                    phonenumber: cleanFrom,
                    vat: session.vat || ''
                });
                
                const isSuccess = res && (res.status === 'success' || res.customerId);
                
                if (isSuccess) {
                    customer.customerId = res.customerId;
                    customer.contactId = res.contactId;
                    customer.found = true;
                    customer.firstname = clientName;
                    customer.email = session.email;
                    console.log(`✅ CLIENTE Y CONTACTO CREADOS: ${clientName} (Client: ${customer.customerId}, Contact: ${customer.contactId})`);
                } else {
                    console.warn(`⚠️ El CRM no confirmó creación (Respuesta: ${JSON.stringify(res)}). Intentando rescate...`);
                    if (session.vat) customer = await perfex.getCustomerByVat(session.vat);
                    if (!customer.found && session.email) customer = await perfex.getCustomerByEmail(session.email);
                }
            } catch (e) { console.error("❌ ERROR REGISTRO:", e.message); }
        }

        // 7. CONTEXTO IA
        let destinoContext = "";
        if (session.destination) {
            const p = aiConfig.calcularPrecio(session.destination, session.adultos, session.ninos, session.bebes);
            const fmt = (n) => `$${n.toLocaleString('es-CO')} COP`;
            destinoContext = `\nPLAN: ${session.destination.nombre}\nPASAJEROS: ${session.adultos} adultos, ${session.ninos} niños, ${session.bebes} bebés.\nTOTAL: ${fmt(p.total)}`;
            console.log(`💰 PAX: ${session.adultos}A, ${session.ninos}N, ${session.bebes}B | ${session.destination.nombre}`);
        }

        // 8. GENERACIÓN RESPUESTA
        let aiResponse = "";
        if (customer.found) {
            const [inv, proj, tix] = await Promise.all([
                perfex.getInvoices(customer.customerId).catch(()=>[]), 
                perfex.getProjects(customer.customerId).catch(()=>[]),
                perfex.getTickets(customer.customerId).catch(()=>[])
            ]);
            
            let rigid = `*RESUMEN GM GROUP*\n` + 
                        (inv.length ? `📄 Facturas pendientes: ${inv.length}\n` : `✅ Sin deudas.\n`) +
                        (tix.length ? `🎫 Tickets recientes: ${tix.length}\n` : "");
            
            await whatsapp.sendText(cleanFrom, rigid);
            aiResponse = await gemini.generateText(`${aiConfig.PRE_PROMPT}\nCLIENTE IDENTIFICADO: ${customer.firstname || 'Usuario'}\nCORREO: ${session.email || customer.email}${destinoContext}\nINSTRUCCIÓN: Ya identificamos al cliente. Usa el desglose de pasajeros de destinoContext para el ticket. Si quiere reservar, usa [CREATE_TICKET: 1 | Venta | Resumen]. NO vuelvas a pedir el correo.\nPREGUNTA: "${msg}"\n${aiConfig.POST_PROMPT}`);
        } else {
            const instr = session.email ? `Ya tienes su correo (${session.email}). Si quiere concretar, usa [CREATE_TICKET: 1 | Venta | Detalle].` : "Pide el correo amablemente.";
            aiResponse = await gemini.generateText(`${aiConfig.PRE_PROMPT}\n${destinoContext}\nINSTRUCCIÓN: ${instr}\nPREGUNTA: "${msg}"\n${aiConfig.POST_PROMPT}`);
        }

        // 9. PROCESAMIENTO TICKET (Garantizamos vinculación al Cliente recién creado)
        if (aiResponse) {
            const ticketMatch = aiResponse.match(/\[CREATE_TICKET:\s*(\d+)\s*\|\s*([^|]+)\s*\|\s*([^\]]+)\]/i);
            if (ticketMatch) {
                const deptId = parseInt(ticketMatch[1]);
                const subject = ticketMatch[2].trim();
                const message = ticketMatch[3].trim();
                const fromEmail = session.email || customer.email;
                const deptEmail = aiConfig.DEPT_EMAILS[deptId] || aiConfig.DEPT_EMAILS[1];

                if (customer.customerId) {
                    console.log(`🎫 Creando Ticket DIRECTO para Cliente ID: ${customer.customerId}`);
                    await perfex.createTicket({
                        customerId: customer.customerId,
                        contactId: customer.contactId || 0,
                        subject: subject,
                        message: message,
                        department: deptId,
                        priority: 2
                    }).then(async r => {
                        console.log(`✅ Ticket DB Creado:`, JSON.stringify(r));
                        if (r && (r.status === 'success' || r.ticket_id)) {
                            const tkey = r.ticketkey || '';
                            const ticketUrl = `https://portal.gmgroup.com.co/forms/tickets/${tkey}`;
                            const notification = `🎫 *¡Caso Registrado!*\n\n*Asunto:* ${subject}\n\n🔗 Puedes seguir tu solicitud aquí:\n${ticketUrl}`;
                            await whatsapp.sendText(cleanFrom, notification);
                            console.log(`🔔 Notificación de Ticket Creado (vía Bot) enviada a ${cleanFrom}`);
                        }
                    }).catch(e => console.error(`❌ Error Ticket DB:`, e.message));
                } else if (fromEmail) {
                    console.log(`📧 Simulando correo desde ${fromEmail} hacia ${deptEmail}...`);
                    await perfex.sendPipingEmail({
                        to: deptEmail,
                        from_email: fromEmail,
                        subject: subject,
                        body: `SOLICITUD WHATSAPP\n-----------------\nWhatsApp: ${cleanFrom}\nNIF/VAT: ${session.vat || 'No provisto'}\n\nDetalle:\n${message}\n\n---\nLaura AI`
                    }).then(() => console.log(`✅ Ticket enviado al Piping correctamente.`))
                      .catch(e => console.error(`❌ Error en Simulación Piping:`, e.message));
                } else {
                    console.warn("⚠️ No se pudo simular el correo: Falta el email del cliente.");
                }
            }
            // Enviar respuesta sin los tags técnicos
            const cleanResponse = aiResponse.replace(/\[CREATE_TICKET:.*?\]/g, '').trim();
            await whatsapp.sendText(cleanFrom, cleanResponse);
        }

        return res.json({ status: "success" });

    } catch (error) {
        console.error(`💥 ERROR CRÍTICO:`, error);
        return res.json({ status: "error" });
    }
});

// Endpoint para notificar respuestas del staff (Llamado desde el Plugin en Perfex)
app.post('/ai/staff-reply', async (req, res) => {
    const { ticket_id, staff_name, message, secret } = req.body;
    
    if (secret !== process.env.WEBHOOK_API_KEY) return res.status(401).json({ status: "error" });

    try {
        const ticketData = await perfex.getTicketContactPhone(ticket_id);
        if (ticketData && ticketData.phonenumber) {
            const formattedPhone = `+${ticketData.phonenumber.replace(/\D/g, '')}`;
            const ticketUrl = `https://portal.gmgroup.com.co/forms/tickets/${ticketData.ticketkey}`;
            const notification = `✉️ *Nueva respuesta de ${staff_name}*\n\n"${message.substring(0, 400)}${message.length > 400 ? '...' : ''}"\n\n🔗 Ver respuesta completa:\n${ticketUrl}`;
            await whatsapp.sendText(formattedPhone, notification);
            console.log(`🔔 Notificación de Staff enviada a ${formattedPhone}`);
        }
        return res.json({ status: "success" });
    } catch (e) { return res.json({ status: "error", message: e.message }); }
});

// Endpoint para notificar tickets creados (Llamado desde el Plugin en Perfex)
app.post('/ai/ticket-created', async (req, res) => {
    const { ticket_id, subject, secret } = req.body;

    if (secret !== process.env.WEBHOOK_API_KEY) return res.status(401).json({ status: "error" });

    try {
        const ticketData = await perfex.getTicketContactPhone(ticket_id);
        if (ticketData && ticketData.phonenumber) {
            const formattedPhone = `+${ticketData.phonenumber.replace(/\D/g, '')}`;
            const ticketUrl = `https://portal.gmgroup.com.co/forms/tickets/${ticketData.ticketkey}`;
            const notification = `🎫 *¡Caso Registrado!*\n\n*Asunto:* ${subject}\n\n🔗 Puedes seguir tu solicitud aquí:\n${ticketUrl}`;
            await whatsapp.sendText(formattedPhone, notification);
            console.log(`🔔 Notificación de Ticket Creado enviada a ${formattedPhone}`);
        }
        return res.json({ status: "success" });
    } catch (e) { return res.json({ status: "error", message: e.message }); }
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
