/**
 * aiConfig.js - Blindaje de Personalidad Laura GM Group
 * 
 * DESTINOS: Agrega, edita o elimina entradas en el array DESTINATIONS.
 * Cada destino tiene: nombre, alias (palabras clave), precios, duración, incluye y descripción.
 */

const DESTINATIONS = [
    {
        nombre: "Las Aldeas",
        alias: ["las aldeas", "aldeas"],
        precio_adulto: 350000,
        precio_nino: 180000,   // niños de 3 a 11 años
        ninos_gratis_hasta: 2, // edad hasta la que es gratis (0-2 años gratis)
        duracion_dias: 3,
        duracion_noches: 2,
        incluye: "transporte, alojamiento, desayunos y actividades guiadas",
        descripcion: "Un refugio de naturaleza y tranquilidad a solo horas de Bogotá, perfecto para desconectarse."
    },
    {
        nombre: "San Gil",
        alias: ["san gil", "sangil"],
        precio_adulto: 420000,
        precio_nino: 210000,
        ninos_gratis_hasta: 2,
        duracion_dias: 4,
        duracion_noches: 3,
        incluye: "transporte, alojamiento, desayunos y 1 actividad de aventura incluida",
        descripcion: "La capital de aventura de Colombia: rafting, parapente, espeleología y más."
    },
    {
        nombre: "Amanecer de los Venados",
        alias: ["amanecer de los venados", "venados", "amanecer venados"],
        precio_adulto: 380000,
        precio_nino: 190000,
        ninos_gratis_hasta: 2,
        duracion_dias: 3,
        duracion_noches: 2,
        incluye: "transporte, alojamiento ecológico, todas las comidas y avistamiento de fauna",
        descripcion: "Una experiencia ecoturística única en contacto directo con la naturaleza y los venados."
    },
    {
        nombre: "Bosque de la Villa",
        alias: ["bosque de la villa", "bosque villa", "la villa"],
        precio_adulto: 310000,
        precio_nino: 155000,
        ninos_gratis_hasta: 2,
        duracion_dias: 2,
        duracion_noches: 1,
        incluye: "transporte, alojamiento, desayuno y recorrido guiado por el bosque",
        descripcion: "El escape perfecto para un fin de semana: naturaleza, aire puro y descanso total."
    },
    {
        nombre: "Cartagena",
        alias: ["cartagena", "la heroica", "cartagena de indias"],
        precio_adulto: 980000,
        precio_nino: 490000,
        ninos_gratis_hasta: 2,
        duracion_dias: 5,
        duracion_noches: 4,
        incluye: "tiquetes aéreos, hotel frente al mar, desayunos, city tour amurallado y visita a las islas",
        descripcion: "La joya del Caribe colombiano: playas cristalinas, ciudad amurallada declarada Patrimonio de la Humanidad y gastronomía de talla mundial."
    },
    {
        nombre: "Santa Marta",
        alias: ["santa marta", "santamarta", "la perla de america", "ciudad bonita"],
        precio_adulto: 890000,
        precio_nino: 445000,
        ninos_gratis_hasta: 2,
        duracion_dias: 5,
        duracion_noches: 4,
        incluye: "tiquetes aéreos, hotel con vista al mar, desayunos, visita al Parque Tayrona y tour a la Sierra Nevada",
        descripcion: "La ciudad más antigua de Colombia: Parque Tayrona, playas de arena blanca, la Sierra Nevada y el Rodadero, todo en un solo destino."
    },
    {
        nombre: "Barranquilla",
        alias: ["barranquilla", "barranquila", "la arenosa", "curramba"],
        precio_adulto: 750000,
        precio_nino: 375000,
        ninos_gratis_hasta: 2,
        duracion_dias: 4,
        duracion_noches: 3,
        incluye: "tiquetes aéreos, hotel en zona rosa, desayunos, tour cultural y visita al Carnaval (en temporada)",
        descripcion: "La capital de la alegría colombiana: cuna del Carnaval declarado Patrimonio Inmaterial de la Humanidad, gastronomía caribeña y vida nocturna vibrante."
    }
];

// Genera el bloque de texto del catálogo para inyectar al prompt de Gemini
function buildDestinationsCatalog() {
    return DESTINATIONS.map(d => {
        const formatCOP = (n) => `$${n.toLocaleString('es-CO')} COP`;
        return `- *${d.nombre}* (${d.duracion_dias} días / ${d.duracion_noches} noches): Adulto ${formatCOP(d.precio_adulto)} | Niño (3-11 años) ${formatCOP(d.precio_nino)} | Menores de ${d.ninos_gratis_hasta + 1} años GRATIS. Incluye: ${d.incluye}. ${d.descripcion}`;
    }).join('\n');
}

// Busca un destino por nombre o alias en el mensaje del usuario
function findDestination(text) {
    const lower = text.toLowerCase();
    return DESTINATIONS.find(d => d.alias.some(a => lower.includes(a)));
}

// Calcula el precio total estimado dado un destino y número de personas
function calcularPrecio(destino, adultos = 1, ninos = 0, bebes = 0) {
    const totalAdultos = adultos * destino.precio_adulto;
    const totalNinos = ninos * destino.precio_nino;
    // bebés (hasta ninos_gratis_hasta años) son gratis
    const total = totalAdultos + totalNinos;
    return {
        adultos,
        ninos,
        bebes,
        totalAdultos,
        totalNinos,
        total,
        porPersona: Math.round(total / (adultos + ninos || 1))
    };
}

const DEPT_EMAILS = {
    1: "ventas@portal.gmgroup.com.co",
    2: "reservas@portal.gmgroup.com.co",
    3: "asistencia@portal.gmgroup.com.co"
};

/**
 * Determina si el bot debe estar activo basándose en el horario laboral.
 * El bot NO funciona en estos rangos (Horario de oficina):
 * Lunes a Viernes: 8:00 - 17:00
 * Sábados: 8:00 - 14:00
 * Domingos: Libre (El bot funciona todo el día)
 */
function isBotActive() {
    const now = new Date();
    const day = now.getDay(); // 0 (Dom) a 6 (Sab)
    const hour = now.getHours();

    // Lunes (1) a Viernes (5): 8 AM a 5 PM (17:00)
    if (day >= 1 && day <= 5) {
        if (hour >= 8 && hour < 17) return false;
    }
    // Sábado (6): 8 AM a 2 PM (14:00)
    if (day === 6) {
        if (hour >= 8 && hour < 14) return false;
    }

    // Si no es ninguna de las anteriores, el bot está activo
    return true;
}

module.exports = {
    DESTINATIONS,
    findDestination,
    calcularPrecio,
    buildDestinationsCatalog,
    isBotActive,
    DEPT_EMAILS,

    BOT_NAME: "Laura",

    KNOWLEDGE_BASE: `
DESTINOS NACIONALES DISPONIBLES (con precios por persona):
${buildDestinationsCatalog()}

DESTINOS INTERNACIONALES: Más de 100 ciudades y 300,000 hoteles en todo el mundo (cotización personalizada).
PET FRIENDLY: ¡Absolutamente! Amamos a las mascotas.
CANAL HUMANO: WhatsApp +57 300 350 5396.
    `,

    PRE_PROMPT: `ERES LAURA, ASESORA SENIOR DE GM GROUP.
    REGLAS DE ORO:
    1. RESPONDE DIRECTAMENTE AL CLIENTE.
    2. NUNCA DIGAS "Aquí tienes un borrador" O "Soy una IA".
    3. NUNCA USES EL FORMATO "Asunto:".
    4. TU OBJETIVO ES CERRAR LA VENTA: Si el cliente muestra interés y YA TIENES su correo, genera el ticket de venta inmediatamente.
    5. DATOS DE CONTACTO: Si no conoces el correo del cliente, pídelo amablemente. Si ya lo conoces, úsalo para cerrar.
    6. DEPARTAMENTOS PARA TICKETS:
       - ID 1: Ventas (Nuevos planes, cotizaciones, cierres de venta).
       - ID 2: Reservas (Pagos, confirmaciones, cambios de fechas).
       - ID 3: Asistencia (Quejas, problemas técnicos, ayuda inmediata).

    7. ACCIÓN TICKET: Si el cliente requiere seguimiento, USA: [CREATE_TICKET: ID_DEP | ASUNTO | DETALLE]. 
       Incluye siempre en el detalle el resumen de lo solicitado.`,

    POST_PROMPT: `CONFIRMACIÓN DE ESTILO:
    - Usa emojis (✈️🌴✨).
    - Sé breve pero cálida.
    - Usa listas con viñetas, asteriscos o guiones (*, -, •) para presentar información detallada como inclusiones o itinerarios. Mantén los párrafos cortos.
    - Cada párrafo máximo 2 oraciones. Si tienes mucha información, divídela en varios párrafos cortos.
    - Si vas a crear un ticket, avísale al cliente: "No te preocupes, ya estoy abriendo un caso para que lo revisemos de inmediato".`,

    FALLBACK_PROMPT: "¡Hola! Soy Laura de GM Group ✈️. No logro encontrarte en el sistema con este número. ¿Me podrías dar tu correo o NIT? ¡Quiero atenderte súper bien!"
};
