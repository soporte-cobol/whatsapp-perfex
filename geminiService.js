/**
 * Servicio para gestionar la lógica de IA con Google Gemini
 */
const { GoogleGenerativeAI } = require("@google/generative-ai");

class GeminiService {
    constructor(apiKey, perfexService, customConfig = {}) {
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.perfex = perfexService;
        
        // Configuración extraída del dashboard de Cobol
        this.systemInstruction = `
Eres un asistente virtual corporativo inteligente y proactivo. Tu función es actuar como un puente entre el sistema de gestión (CRM) y el cliente a través de WhatsApp.
Tus respuestas deben integrar emojis y formato enriquecido de manera natural y obligatoria en cada mensaje.

Tu objetivo es:
- Proporcionar respuestas claras, precisas y naturales basadas en los datos del CRM.
- Usar un tono profesional pero cercano y amigable.
- Utiliza SIEMPRE emojis de forma estratégica e implícita en el texto de tus respuestas para que viajen en el flujo de datos (JSON/XML). Esto hace la lectura agradable y moderna (🚀, ✅, 📊, 📄, 👋).
- Usa separadores horizontales (---) para dividir tu respuesta natural de los datos técnicos obtenidos del CRM.
- Usa asteriscos (*) para negritas en puntos clave.
- Si los datos muestran deudas o pendientes, informa con cortesía.
- Siempre termina con un llamado a la acción o una pregunta para ayudar más.

ESTRATEGIA DE IDENTIFICACIÓN:
1. Primero intenta con 'getCustomerByPhone'.
2. Si no hay resultados, solicita amablemente el correo electrónico y usa 'getCustomerByEmail'.
3. Si aún no hay resultados, solicita el NIF o NIT (identificación fiscal) y usa 'getCustomerByVat'.

GESTIÓN DE SOPORTE:
Si el cliente solicita algo que no puedes resolver (problemas técnicos, reclamos, solicitudes complejas), DEBES resumir la solicitud y crear un ticket usando 'createTicket'. 
IMPORTANTE: Antes de crear un ticket, asegúrate de haber obtenido el 'customerId' y el 'contactId' mediante los pasos de identificación.

SI NO HAY CONTACTO:
Si identificas la empresa por NIT pero no hay contactos asociados, solicita amablemente el Nombre, Apellido y Correo del cliente. Verifica que el correo tenga un formato válido (ej: usuario@dominio.com) antes de usar 'createContact'.

PRIORIDAD:
Evalúa el mensaje del cliente. Si detectas palabras como "Urgente", "Emergencia", "Grave" o "De inmediato", asigna prioridad 3 (Alta) al ticket. De lo contrario, usa 1 (Baja) o 2 (Media) según tu criterio.
`;

        // Definición de herramientas (herramientas que la IA puede llamar)
        this.tools = [
            {
                functionDeclarations: [
                    {
                        name: "getCustomerByPhone",
                        description: "Busca la identidad y el ID de un cliente en el CRM a partir de su número de teléfono de WhatsApp.",
                        parameters: {
                            type: "object",
                            properties: {
                                phone: { type: "string", description: "El número de teléfono completo del remitente (ej: 573211234567)" }
                            },
                            required: ["phone"]
                        }
                    },
                    {
                        name: "getCustomerByEmail",
                        description: "Busca un cliente por su dirección de correo electrónico.",
                        parameters: {
                            type: "object",
                            properties: {
                                email: { type: "string", description: "El correo electrónico del cliente" }
                            },
                            required: ["email"]
                        }
                    },
                    {
                        name: "getCustomerByVat",
                        description: "Busca un cliente por su NIF o NIT (identificación fiscal).",
                        parameters: {
                            type: "object",
                            properties: {
                                vat: { type: "string", description: "El NIF, NIT o identificación fiscal del cliente" }
                            },
                            required: ["vat"]
                        }
                    },
                    {
                        name: "getInvoices",
                        description: "Consulta las facturas de un cliente específico en Perfex CRM",
                        parameters: {
                            type: "object",
                            properties: {
                                customerId: { type: "integer", description: "El ID del cliente en el CRM" }
                            },
                            required: ["customerId"]
                        }
                    },
                    {
                        name: "getSupportTickets",
                        description: "Obtiene los tickets de soporte asociados a un correo electrónico",
                        parameters: {
                            type: "object",
                            properties: {
                                email: { type: "string", description: "Correo electrónico del cliente" }
                            },
                            required: ["email"]
                        }
                    },
                    {
                        name: "getEstimates",
                        description: "Consulta presupuestos o estimaciones de un cliente",
                        parameters: {
                            type: "object",
                            properties: {
                                customerId: { type: "integer", description: "El ID del cliente" }
                            },
                            required: ["customerId"]
                        }
                    },
                    {
                        name: "getProjects",
                        description: "Consulta los proyectos o servicios activos asociados al cliente",
                        parameters: {
                            type: "object",
                            properties: {
                                customerId: { type: "integer", description: "El ID del cliente" }
                            },
                            required: ["customerId"]
                        }
                    },
                    {
                        name: "getTime",
                        description: "Obtiene la hora actual de una ubicación específica",
                        parameters: {
                            type: "object",
                            properties: {
                                timezone: { type: "string", description: "Identificador de zona horaria (ej: Europe/Rome)" }
                            },
                            required: ["timezone"]
                        }
                    },
                    {
                        name: "createTicket",
                        description: "Crea un ticket de soporte en el CRM cuando el bot no puede resolver la duda.",
                        parameters: {
                            type: "object",
                            properties: {
                                customerId: { type: "integer", description: "El ID del cliente" },
                                contactId: { type: "integer", description: "El ID del contacto (si está disponible)" },
                                subject: { type: "string", description: "Título breve del problema (ej: Fallo técnico en portal)" },
                                message: { type: "string", description: "Resumen ejecutivo y detallado de lo que el cliente solicita, redactado de forma clara para el equipo de soporte." },
                                priority: { type: "integer", description: "Prioridad del ticket (1: Baja, 2: Media, 3: Alta)" }
                            },
                            required: ["customerId", "subject", "message"]
                        }
                    },
                    {
                        name: "createContact",
                        description: "Crea un nuevo contacto asociado a un cliente/empresa existente.",
                        parameters: {
                            type: "object",
                            properties: {
                                customerId: { type: "integer", description: "El ID de la empresa (userid)" },
                                firstname: { type: "string", description: "Nombre del contacto" },
                                lastname: { type: "string", description: "Apellido del contacto" },
                                email: { type: "string", description: "Correo electrónico" },
                                phone: { type: "string", description: "Teléfono de WhatsApp" }
                            },
                            required: ["customerId", "firstname", "lastname", "email"]
                        }
                    }
                ]
            }
        ];

        this.model = this.genAI.getGenerativeModel({
            model: customConfig.model || "gemini-1.5-flash", // Usamos Flash por ser más rápido y económico
            tools: this.tools,
            systemInstruction: this.systemInstruction,
            generationConfig: {
                maxOutputTokens: customConfig.maxTokens || 2048,
            }
        });
    }

    /**
     * Inicia una sesión de chat con el contexto de la agencia de viajes
     */
    startChatSession() {
        return this.model.startChat({
            history: [
                {
                    role: "user",
                    parts: [{ text: "Hola. Necesito que seas mi asistente. Recuerda identificarme siempre, usar emojis en cada respuesta y si no puedes ayudarme con algo técnico, crea un ticket de soporte resumiendo mi caso. ¿Entendido? 🚀" }],
                },
                {
                    role: "model",
                    parts: [{ text: "¡Entendido perfectamente! 🫡 Estoy listo para asistirte. Utilizaré emojis en todas mis respuestas para que la comunicación sea dinámica. 🚀 Primero te identificaré por tu teléfono, correo o NIT, y si surge algo que no pueda resolver directamente, crearé un ticket de soporte detallado por ti. ✅ ¿En qué puedo ayudarte hoy? ✨" }],
                },
            ],
        });
    }
}

module.exports = GeminiService;